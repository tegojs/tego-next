import {
  parseCapabilityDefinition,
  parseTaskExecutionTarget,
  type Clock,
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
import type { ComponentBinding, ComponentLifecycleHost } from "@tegojs/runtime";
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

function capabilityDefinitions(binding: ComponentBinding) {
  return binding.artifact.manifest.capabilities.provides.map((provided) =>
    parseCapabilityDefinition({
      identity: {
        name: provided.name,
        protocolVersion: provided.protocolVersion,
      },
      requestSchema: {},
      responseSchema: {},
    }),
  );
}

export class LocalComponentSessionHost implements ComponentLifecycleHost {
  readonly #options: LocalComponentSessionHostOptions;

  constructor(options: LocalComponentSessionHostOptions) {
    this.#options = options;
  }

  async start(binding: ComponentBinding): Promise<void> {
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
      capabilityDefinitions: capabilityDefinitions(binding),
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
    await registration.executor.drain({});
  }

  async stop(binding: ComponentBinding): Promise<void> {
    const target = this.#target(binding);
    const registration = this.#options.registry.findExact(target);
    if (registration === undefined) return;
    await registration.executor.close();
    this.#options.registry.remove(target);
  }

  #target(binding: ComponentBinding): TaskExecutionTarget {
    if (binding.executor !== "process" && binding.executor !== "thread") {
      throw new TypeError("Local component sessions support only process and thread executors");
    }
    return parseTaskExecutionTarget({
      instanceId: binding.instanceId,
      deploymentGeneration: binding.deployment.generation,
      artifactDigest: binding.artifact.digest,
      executor: {
        id: `${this.#options.nodeId}:${binding.executor}`,
        type: binding.executor,
      },
    });
  }
}
