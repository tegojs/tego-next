import {
  DiagnosticError,
  runtimeDiagnostic,
  type ExecutorKind,
  type JsonValue,
  type PluginComponent,
  type PluginDeployment,
  type RuntimeAuthority,
  type WorkerId,
} from "@tegojs/contracts";
import type { PreparedArtifact } from "../artifacts/prepared-artifact-cache.js";
import type { ReconcileEffect } from "../reconcile/plan.js";

export interface ComponentBinding {
  readonly instanceId: string;
  readonly executor: ExecutorKind;
  readonly workerId?: WorkerId;
  readonly artifact: PreparedArtifact;
  readonly deployment: PluginDeployment;
  readonly component: PluginComponent;
  readonly authority?: RuntimeAuthority;
}

export type ComponentBindingState = "active" | "draining" | "prepared" | "stopping";

export interface RegisteredComponent {
  readonly binding: ComponentBinding;
  readonly state: ComponentBindingState;
  readonly acceptingTasks: boolean;
  readonly hostStopped: boolean;
  readonly artifactReleased: boolean;
}

function lifecycleError(code: `LIFECYCLE_${string}`, message: string, effect: ReconcileEffect) {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "plugin", id: `${effect.pluginId}/${effect.componentId}` },
      details: {
        artifactDigest: effect.artifactDigest,
        deploymentGeneration: effect.deploymentGeneration,
        instanceId: effect.instanceId,
        operationId: effect.operationId,
      },
    }),
  );
}

function sameAuthority(
  left: RuntimeAuthority | undefined,
  right: RuntimeAuthority | undefined,
): boolean {
  return left?.resource === right?.resource && left?.epoch === right?.epoch;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function cloneFrozen<T extends JsonValue>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export class ComponentRegistry {
  readonly #entries = new Map<string, RegisteredComponent>();

  get(instanceId: string): RegisteredComponent | undefined {
    return this.#entries.get(instanceId);
  }

  require(instanceId: string): RegisteredComponent {
    const entry = this.get(instanceId);
    if (entry === undefined) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "LIFECYCLE_INSTANCE_MISSING",
          message: "Component instance is not registered",
          source: { kind: "plugin", id: instanceId },
          details: { instanceId },
        }),
      );
    }
    return entry;
  }

  register(
    effect: ReconcileEffect,
    binding: ComponentBinding,
    authority?: RuntimeAuthority,
  ): RegisteredComponent {
    this.#assertBinding(effect, binding, authority);
    const existing = this.#entries.get(effect.instanceId);
    if (existing !== undefined) {
      this.assertMatches(effect, existing, authority);
      if (
        existing.binding.component.componentId !== binding.component.componentId ||
        existing.binding.component.entrypoint !== binding.component.entrypoint ||
        JSON.stringify(existing.binding.component) !== JSON.stringify(binding.component)
      ) {
        throw lifecycleError(
          "LIFECYCLE_COMPONENT_IDENTITY_MISMATCH",
          "Component descriptor does not match the registered immutable binding",
          effect,
        );
      }
      return existing;
    }
    const stableBinding = deepFreeze({
      instanceId: binding.instanceId,
      executor: binding.executor,
      ...(binding.workerId === undefined ? {} : { workerId: binding.workerId }),
      artifact: binding.artifact,
      deployment: cloneFrozen(binding.deployment),
      component: cloneFrozen(binding.component),
      ...(authority === undefined ? {} : { authority: cloneFrozen(authority) }),
    });
    const entry = Object.freeze({
      binding: stableBinding,
      state: "prepared" as const,
      acceptingTasks: false,
      hostStopped: false,
      artifactReleased: false,
    });
    this.#entries.set(effect.instanceId, entry);
    return entry;
  }

  transition(
    effect: ReconcileEffect,
    current: ComponentBindingState,
    next: ComponentBindingState,
    authority?: RuntimeAuthority,
  ): RegisteredComponent {
    const entry = this.require(effect.instanceId);
    this.assertMatches(effect, entry, authority);
    if (entry.state !== current) {
      throw lifecycleError(
        "LIFECYCLE_TRANSITION_INVALID",
        `Component binding cannot transition from ${entry.state} to ${next}`,
        effect,
      );
    }
    const transitioned = Object.freeze({
      ...entry,
      state: next,
      acceptingTasks: next === "active",
      ...(next === "stopping"
        ? {
            hostStopped: entry.hostStopped,
            artifactReleased: entry.artifactReleased,
          }
        : {}),
    });
    this.#entries.set(effect.instanceId, transitioned);
    return transitioned;
  }

  remove(effect: ReconcileEffect, authority?: RuntimeAuthority): RegisteredComponent {
    const entry = this.require(effect.instanceId);
    this.assertMatches(effect, entry, authority);
    if (entry.state === "stopping" && (!entry.hostStopped || !entry.artifactReleased)) {
      throw lifecycleError(
        "LIFECYCLE_STOP_INCOMPLETE",
        "Component binding cannot be removed before stop cleanup completes",
        effect,
      );
    }
    this.#entries.delete(effect.instanceId);
    return entry;
  }

  updateStopProgress(
    effect: ReconcileEffect,
    progress: { readonly hostStopped?: boolean; readonly artifactReleased?: boolean },
    authority?: RuntimeAuthority,
  ): RegisteredComponent {
    const entry = this.require(effect.instanceId);
    this.assertMatches(effect, entry, authority);
    if (entry.state !== "stopping") {
      throw lifecycleError(
        "LIFECYCLE_TRANSITION_INVALID",
        "Stop progress can only be recorded for a stopping component",
        effect,
      );
    }
    const updated = Object.freeze({
      ...entry,
      hostStopped: entry.hostStopped || progress.hostStopped === true,
      artifactReleased: entry.artifactReleased || progress.artifactReleased === true,
    });
    this.#entries.set(effect.instanceId, updated);
    return updated;
  }

  takeoverStopping(
    effect: ReconcileEffect,
    authority: RuntimeAuthority | undefined,
  ): RegisteredComponent {
    const entry = this.require(effect.instanceId);
    if (entry.state !== "stopping") {
      throw lifecycleError(
        "LIFECYCLE_TRANSITION_INVALID",
        "Only stopping cleanup can be taken over by another authority",
        effect,
      );
    }
    if (!this.#matchesIdentity(effect, entry)) {
      throw lifecycleError(
        "LIFECYCLE_INSTANCE_IDENTITY_MISMATCH",
        "Component effect identity does not match the registered immutable binding",
        effect,
      );
    }
    if (
      entry.binding.authority === undefined ||
      authority === undefined ||
      entry.binding.authority.resource !== authority.resource ||
      BigInt(authority.epoch) <= BigInt(entry.binding.authority.epoch)
    ) {
      throw lifecycleError(
        "LIFECYCLE_INSTANCE_IDENTITY_MISMATCH",
        "Stopping cleanup takeover requires a strictly newer epoch for the registered resource",
        effect,
      );
    }
    const updated = Object.freeze({
      ...entry,
      binding: deepFreeze({
        ...entry.binding,
        authority: cloneFrozen(authority),
      }),
    });
    this.#entries.set(effect.instanceId, updated);
    return updated;
  }

  assertMatches(
    effect: ReconcileEffect,
    entry: RegisteredComponent,
    authority?: RuntimeAuthority,
  ): void {
    if (
      !this.#matchesIdentity(effect, entry) ||
      !sameAuthority(entry.binding.authority, authority)
    ) {
      throw lifecycleError(
        "LIFECYCLE_INSTANCE_IDENTITY_MISMATCH",
        "Component effect identity does not match the registered immutable binding",
        effect,
      );
    }
  }

  #matchesIdentity(effect: ReconcileEffect, entry: RegisteredComponent): boolean {
    const { binding } = entry;
    return (
      binding.instanceId === effect.instanceId &&
      binding.artifact.digest === effect.artifactDigest &&
      binding.deployment.applicationId === effect.applicationId &&
      binding.deployment.pluginId === effect.pluginId &&
      binding.deployment.generation === effect.deploymentGeneration &&
      binding.executor === effect.executor &&
      binding.workerId === effect.workerId &&
      binding.component.componentId === effect.componentId
    );
  }

  #assertBinding(
    effect: ReconcileEffect,
    binding: ComponentBinding,
    authority: RuntimeAuthority | undefined,
  ): void {
    const manifestComponent = binding.artifact.manifest.components.find(
      (component) => component.componentId === effect.componentId,
    );
    if (
      binding.instanceId !== effect.instanceId ||
      binding.executor !== effect.executor ||
      binding.workerId !== effect.workerId ||
      binding.artifact.digest !== effect.artifactDigest ||
      binding.deployment.applicationId !== effect.applicationId ||
      binding.deployment.pluginId !== effect.pluginId ||
      binding.deployment.generation !== effect.deploymentGeneration ||
      binding.deployment.artifactDigest !== effect.artifactDigest ||
      binding.component.componentId !== effect.componentId ||
      manifestComponent === undefined ||
      manifestComponent.entrypoint !== binding.component.entrypoint ||
      JSON.stringify(manifestComponent) !== JSON.stringify(binding.component) ||
      !binding.component.executors.includes(effect.executor) ||
      !sameAuthority(binding.authority, authority)
    ) {
      throw lifecycleError(
        "LIFECYCLE_COMPONENT_IDENTITY_MISMATCH",
        "Component binding does not match the validated effect and artifact identity",
        effect,
      );
    }
  }
}
