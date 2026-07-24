import {
  DiagnosticError,
  runtimeDiagnostic,
  type ExecutorKind,
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
}

export type ComponentBindingState = "active" | "draining" | "prepared" | "stopping";

export interface RegisteredComponent {
  readonly binding: ComponentBinding;
  readonly state: ComponentBindingState;
  readonly acceptingTasks: boolean;
  readonly authority?: RuntimeAuthority;
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
    const existing = this.#entries.get(effect.instanceId);
    if (existing !== undefined) {
      this.assertMatches(effect, existing, authority);
      return existing;
    }
    const entry = Object.freeze({
      binding: Object.freeze(binding),
      state: "prepared" as const,
      acceptingTasks: false,
      ...(authority === undefined ? {} : { authority: Object.freeze(authority) }),
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
    });
    this.#entries.set(effect.instanceId, transitioned);
    return transitioned;
  }

  remove(effect: ReconcileEffect, authority?: RuntimeAuthority): RegisteredComponent {
    const entry = this.require(effect.instanceId);
    this.assertMatches(effect, entry, authority);
    this.#entries.delete(effect.instanceId);
    return entry;
  }

  assertMatches(
    effect: ReconcileEffect,
    entry: RegisteredComponent,
    authority?: RuntimeAuthority,
  ): void {
    const { binding } = entry;
    if (
      binding.instanceId !== effect.instanceId ||
      binding.artifact.digest !== effect.artifactDigest ||
      binding.deployment.applicationId !== effect.applicationId ||
      binding.deployment.pluginId !== effect.pluginId ||
      binding.deployment.generation !== effect.deploymentGeneration ||
      binding.executor !== effect.executor ||
      binding.workerId !== effect.workerId ||
      !sameAuthority(entry.authority, authority)
    ) {
      throw lifecycleError(
        "LIFECYCLE_INSTANCE_IDENTITY_MISMATCH",
        "Component effect identity does not match the registered immutable binding",
        effect,
      );
    }
  }
}
