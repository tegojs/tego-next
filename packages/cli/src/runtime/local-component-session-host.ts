import { createHash } from "node:crypto";
import {
  DiagnosticError,
  parseExecutorId,
  parseNodeId,
  parseTaskExecutionTarget,
  runtimeDiagnostic,
  type Clock,
  type ExecutorKind,
  type JsonValue,
  type PluginManifest,
  type ProcessHost,
  type SecretProvider,
  type TaskExecutionTarget,
} from "@tegojs/contracts";
import {
  createProcessComponentSession,
  createThreadComponentSession,
  type ResolvedProcessComponent,
  type ResolvedThreadComponent,
} from "@tegojs/executor-node";
import {
  canonicalJsonBytes,
  type ComponentBinding,
  type ComponentLifecycleHost,
  parseActivation,
} from "@tegojs/runtime";
import type {
  LocalComponentSessionRegistry,
  LocalComponentSessionRegistration,
} from "./local-component-session-registry.js";

export interface LocalComponentSessionHostOptions {
  readonly nodeId: string;
  readonly runtimeId: string;
  readonly clock: Clock;
  readonly processHost: ProcessHost;
  readonly secretProvider: SecretProvider;
  readonly registry: LocalComponentSessionRegistry;
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
  if (manifest.capabilities.provides.length > 0 || manifest.capabilities.requires.length > 0) {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "CAPABILITY_DEFINITION_UNAVAILABLE",
        message:
          "Local component sessions require durable capability schemas and token definitions",
        source: { kind: "artifact", id: manifest.pluginId },
      }),
    );
  }
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
    const component: ResolvedProcessComponent | ResolvedThreadComponent = {
      target,
      artifactDigest: binding.artifact.digest,
      artifactRoot: binding.artifact.root,
      manifest: binding.artifact.manifest,
      runtimeId: this.#options.runtimeId,
      instanceId: binding.instanceId,
      configuration: binding.deployment.configuration,
      permissionGrants: binding.deployment.permissionGrants,
      capabilityDefinitions: [],
    };
    const executor =
      binding.executor === "thread"
        ? await createThreadComponentSession({
            target,
            identity,
            component,
            executorOptions: {
              id: target.executor.id,
              clock: this.#options.clock,
              resolveComponent: async () => component,
              secretProvider: this.#options.secretProvider,
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
              resolveComponent: async () => component,
              secretProvider: this.#options.secretProvider,
            },
          });
    const registration: LocalComponentSessionRegistration = {
      ...identity,
      target,
      executor,
      drainLifecycle: (options) => executor.drainLifecycle(options),
    };
    try {
      this.#options.registry.register(registration);
    } catch (error) {
      try {
        await executor.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Local component session registration rollback failed",
        );
      }
      throw error;
    }
  }

  async drain(binding: ComponentBinding): Promise<void> {
    const target = this.#target(binding);
    const registration = this.#options.registry.resolveExact(target);
    this.#options.registry.markDraining(target);
    await registration.drainLifecycle({});
  }

  async stop(binding: ComponentBinding): Promise<void> {
    const target = this.#target(binding);
    const registration = this.#options.registry.findExact(target);
    if (registration === undefined) return;
    await registration.executor.close();
    this.#options.registry.remove(target);
  }

  #target(binding: ComponentBinding): TaskExecutionTarget {
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
