import { createHash } from "node:crypto";
import {
  assertExecutionBindingMatches,
  type Clock,
  type ComponentCapabilityInvocation,
  DiagnosticError,
  type ExecutionBinding,
  type ExecutorKind,
  type JsonValue,
  type PluginManifest,
  type ProcessHost,
  parseExecutorId,
  parseNodeId,
  parseTaskExecutionTarget,
  runtimeDiagnostic,
  type SecretProvider,
  type TaskExecutionTarget,
} from "@tegojs/contracts";
import {
  type ComponentSandboxSession,
  createProcessComponentSession,
  createThreadComponentSession,
  type ResolvedProcessComponent,
  type ResolvedThreadComponent,
} from "@tegojs/executor-node";
import {
  type ComponentBinding,
  type ComponentBindingPreparation,
  type ComponentInstanceIdentity,
  type ComponentLifecycleHost,
  canonicalJsonBytes,
  createComponentBoundaries,
  parseActivation,
} from "@tegojs/runtime";
import type {
  LocalComponentSessionRegistration,
  LocalComponentSessionRegistry,
} from "./local-component-session-registry.js";

export interface LocalComponentSessionHostOptions {
  readonly nodeId: string;
  readonly runtimeId: string;
  readonly clock: Clock;
  readonly processHost: ProcessHost;
  readonly secretProvider: SecretProvider;
  readonly registry: LocalComponentSessionRegistry;
  readonly resolveExecutionBinding: (
    binding: ComponentBindingPreparation,
    target: TaskExecutionTarget,
  ) => Promise<ExecutionBinding>;
  readonly invokeCapability: (
    consumer: ComponentInstanceIdentity,
    invocation: ComponentCapabilityInvocation,
  ) => Promise<JsonValue>;
}

export function localComponentExecutorId(
  nodeId: string,
  executor: Extract<ExecutorKind, "process" | "thread">,
): string {
  const canonicalNodeId = parseNodeId(nodeId);
  const digest = createHash("sha256").update(canonicalNodeId, "utf8").digest("hex");
  return parseExecutorId(`node-${digest}:${executor}`);
}

export function canonicalJsonEqual(left: JsonValue, right: JsonValue): boolean {
  return Buffer.compare(canonicalJsonBytes(left), canonicalJsonBytes(right)) === 0;
}

export function assertLocalComponentManifestSupported(manifest: PluginManifest): void {
  const service = manifest.components.find((component) => component.kind === "service");
  if (service !== undefined) {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "LIFECYCLE_COMPONENT_KIND_UNSUPPORTED",
        message: "Local service component sessions are not supported in phase 1",
        source: { kind: "plugin", id: `${manifest.pluginId}/${service.componentId}` },
      }),
    );
  }
}

export class LocalComponentSessionHost implements ComponentLifecycleHost {
  readonly #options: LocalComponentSessionHostOptions;

  constructor(options: LocalComponentSessionHostOptions) {
    this.#options = options;
  }

  async prepare(
    binding: ComponentBindingPreparation,
    persisted?: ExecutionBinding,
  ): Promise<ExecutionBinding> {
    const target = this.#target(binding);
    const candidate = persisted ?? (await this.#options.resolveExecutionBinding(binding, target));
    return assertExecutionBindingMatches(
      {
        applicationId: binding.deployment.applicationId,
        pluginId: binding.deployment.pluginId,
        componentId: binding.component.componentId,
        target,
      },
      candidate,
    );
  }

  async start(binding: ComponentBinding): Promise<void> {
    parseActivation(binding.activation);
    assertLocalComponentManifestSupported(binding.artifact.manifest);
    if (binding.executor !== "process" && binding.executor !== "thread") {
      throw new TypeError("Local component sessions support only process and thread executors");
    }
    const target = this.#target(binding);
    const identity = {
      applicationId: binding.deployment.applicationId,
      pluginId: binding.deployment.pluginId,
      componentId: binding.component.componentId,
    };
    const executionBinding = binding.executionBinding;
    const consumer: ComponentInstanceIdentity = {
      ...identity,
      activation: binding.activation,
      target,
      bindingFingerprint: executionBinding.fingerprint,
    };
    const boundaries = createComponentBoundaries({
      invoke: (invocation) => this.#options.invokeCapability(consumer, invocation),
    });
    const capabilityRegistration = boundaries.capability.register(
      executionBinding.capabilityDefinitions,
    );
    if (!capabilityRegistration.ok) {
      boundaries.capability.clear();
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "CAPABILITY_DEFINITION_INVALID",
          message:
            capabilityRegistration.diagnostics[0]?.message ??
            "Component capability definitions are invalid",
          source: { kind: "plugin", id: `${identity.pluginId}/${identity.componentId}` },
        }),
      );
    }
    const component: ResolvedProcessComponent | ResolvedThreadComponent = {
      target,
      artifactDigest: binding.artifact.digest,
      artifactRoot: binding.artifact.root,
      manifest: binding.artifact.manifest,
      runtimeId: this.#options.runtimeId,
      instanceId: binding.instanceId,
      configuration: executionBinding.configuration,
      permissionGrants: executionBinding.permissionGrants,
      capabilityDefinitions: executionBinding.capabilityDefinitions,
    };
    let executor: ComponentSandboxSession | undefined;
    try {
      executor =
        binding.executor === "thread"
          ? await createThreadComponentSession({
              target,
              identity,
              component,
              executorOptions: {
                id: target.executor.id,
                clock: this.#options.clock,
                resolveComponent: async (request) => ({
                  ...component,
                  configuration: structuredClone(request.binding.configuration),
                  permissionGrants: structuredClone(request.binding.permissionGrants),
                  capabilityDefinitions: structuredClone(request.binding.capabilityDefinitions),
                }),
                secretProvider: this.#options.secretProvider,
                capabilityBoundary: boundaries.capability,
              },
            })
          : await createProcessComponentSession({
              target,
              identity,
              component,
              executorOptions: {
                id: target.executor.id,
                clock: this.#options.clock,
                processHost: this.#options.processHost,
                resolveComponent: async (request) => ({
                  ...component,
                  configuration: structuredClone(request.binding.configuration),
                  permissionGrants: structuredClone(request.binding.permissionGrants),
                  capabilityDefinitions: structuredClone(request.binding.capabilityDefinitions),
                }),
                secretProvider: this.#options.secretProvider,
                capabilityBoundary: boundaries.capability,
              },
            });
      if (executor === undefined) throw new Error("Component session creation returned no session");
      const activeExecutor = executor;
      const registration: LocalComponentSessionRegistration = {
        ...identity,
        target,
        executor: activeExecutor,
        drainLifecycle: (options) => activeExecutor.drainLifecycle(options),
        capabilityConsumer: consumer,
        releaseBoundaries: () => boundaries.capability.clear(),
      };
      this.#options.registry.register(registration);
    } catch (error) {
      try {
        await executor?.close();
      } catch (closeError) {
        boundaries.capability.clear();
        throw new AggregateError(
          [error, closeError],
          "Local component session registration rollback failed",
        );
      }
      boundaries.capability.clear();
      throw error;
    }
  }

  async drain(binding: ComponentBinding): Promise<void> {
    const target = this.#target(binding);
    const registration = this.#options.registry.resolveExact(target);
    this.#options.registry.markDraining(target);
    await registration.drainLifecycle({});
  }

  async restoreTermination(
    _binding: ComponentBinding,
    _checkpoint: "draining" | "stopping",
  ): Promise<void> {}

  async stop(binding: ComponentBinding): Promise<void> {
    const target = this.#target(binding);
    const registration = this.#options.registry.findExact(target);
    if (registration === undefined) return;
    await registration.executor.close();
    registration.releaseBoundaries?.();
    this.#options.registry.remove(target);
  }

  #target(binding: ComponentBindingPreparation): TaskExecutionTarget {
    parseActivation(binding.activation);
    if (binding.executor !== "process" && binding.executor !== "thread") {
      throw new TypeError("Local component sessions support only process and thread executors");
    }
    return parseTaskExecutionTarget({
      instanceId: binding.instanceId,
      deploymentGeneration: binding.deployment.generation,
      artifactDigest: binding.artifact.digest,
      executor: {
        id: localComponentExecutorId(this.#options.nodeId, binding.executor),
        type: binding.executor,
      },
    });
  }
}
