import {
  DiagnosticError,
  parseWorkerId,
  runtimeDiagnostic,
  serializeCause,
  type ExecutorKind,
  type PluginDeployment,
  type RuntimeAuthority,
} from "@tegojs/contracts";
import type { PreparedArtifactCache } from "../artifacts/prepared-artifact-cache.js";
import type { ComponentEffectExecutor } from "../reconcile/reconciler.js";
import type { ReconcileEffect } from "../reconcile/plan.js";
import type {
  ComponentRegistry,
  ComponentBinding,
  RegisteredComponent,
} from "./component-registry.js";

export interface ComponentLifecycleHost {
  start(binding: ComponentBinding): Promise<void>;
  drain(binding: ComponentBinding): Promise<void>;
  stop(binding: ComponentBinding): Promise<void>;
}

export interface ComponentEffectsOptions {
  readonly artifacts: Pick<PreparedArtifactCache, "prepare" | "release">;
  readonly registry: ComponentRegistry;
  readonly supportedExecutors: readonly ExecutorKind[];
  readonly resolveDeployment: (effect: ReconcileEffect) => Promise<PluginDeployment | undefined>;
  readonly host: ComponentLifecycleHost;
  readonly authority?: () => RuntimeAuthority | undefined;
}

interface CachedOperation {
  readonly fingerprint: string;
  readonly result: Promise<void>;
}

function effectFingerprint(effect: ReconcileEffect): string {
  return JSON.stringify([
    effect.kind,
    effect.instanceId,
    effect.applicationId,
    effect.pluginId,
    effect.componentId,
    effect.deploymentGeneration,
    effect.artifactDigest,
    effect.executor,
    effect.workerId ?? null,
    effect.messageId,
  ]);
}

function effectError(
  code: `LIFECYCLE_${string}`,
  message: string,
  effect: ReconcileEffect,
  details: Record<string, unknown> = {},
) {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "plugin", id: `${effect.pluginId}/${effect.componentId}` },
      details: {
        deploymentGeneration: effect.deploymentGeneration,
        instanceId: effect.instanceId,
        operationId: effect.operationId,
        ...details,
      },
    }),
  );
}

export class ComponentEffects implements ComponentEffectExecutor {
  readonly supportedExecutors: readonly ExecutorKind[];
  readonly #artifacts: Pick<PreparedArtifactCache, "prepare" | "release">;
  readonly #registry: ComponentRegistry;
  readonly #resolveDeployment: ComponentEffectsOptions["resolveDeployment"];
  readonly #host: ComponentLifecycleHost;
  readonly #authority: () => RuntimeAuthority | undefined;
  readonly #operations = new Map<string, CachedOperation>();

  constructor(options: ComponentEffectsOptions) {
    this.#artifacts = options.artifacts;
    this.#registry = options.registry;
    this.#resolveDeployment = options.resolveDeployment;
    this.#host = options.host;
    this.#authority = options.authority ?? (() => undefined);
    this.supportedExecutors = Object.freeze([...new Set(options.supportedExecutors)]);
  }

  perform(effect: ReconcileEffect): Promise<void> {
    const fingerprint = effectFingerprint(effect);
    const existing = this.#operations.get(effect.operationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          effectError(
            "LIFECYCLE_OPERATION_CONFLICT",
            "Lifecycle operation identity was reused with a different payload",
            effect,
          ),
        );
      }
      return existing.result;
    }
    const result = this.#perform(effect);
    this.#operations.set(effect.operationId, { fingerprint, result });
    return result;
  }

  async #perform(effect: ReconcileEffect): Promise<void> {
    if (!this.supportedExecutors.includes(effect.executor)) {
      throw effectError(
        "LIFECYCLE_EXECUTOR_UNSUPPORTED",
        "Lifecycle effect selected an unsupported executor",
        effect,
      );
    }
    const authority = this.#authority();
    if (effect.kind === "prepare") {
      await this.#prepare(effect, authority);
      return;
    }
    const entry = this.#registry.require(effect.instanceId);
    this.#registry.assertMatches(effect, entry, authority);
    if (effect.kind === "start") {
      if (entry.state !== "prepared") {
        throw effectError(
          "LIFECYCLE_TRANSITION_INVALID",
          "Only a prepared component binding can start",
          effect,
        );
      }
      await this.#host.start(entry.binding);
      this.#registry.transition(effect, "prepared", "active", authority);
      return;
    }
    if (effect.kind === "drain") {
      if (entry.state !== "active") {
        throw effectError(
          "LIFECYCLE_TRANSITION_INVALID",
          "Only an active component binding can drain",
          effect,
        );
      }
      await this.#host.drain(entry.binding);
      this.#registry.transition(effect, "active", "draining", authority);
      return;
    }
    await this.#stop(effect, entry, authority);
  }

  async #prepare(effect: ReconcileEffect, authority: RuntimeAuthority | undefined): Promise<void> {
    const current = this.#registry.get(effect.instanceId);
    if (current !== undefined) {
      this.#registry.assertMatches(effect, current, authority);
      return;
    }
    const deployment = await this.#resolveDeployment(effect);
    if (
      deployment === undefined ||
      deployment.applicationId !== effect.applicationId ||
      deployment.pluginId !== effect.pluginId ||
      deployment.generation !== effect.deploymentGeneration ||
      deployment.artifactDigest !== effect.artifactDigest
    ) {
      throw effectError(
        "LIFECYCLE_DEPLOYMENT_IDENTITY_MISMATCH",
        "Lifecycle effect does not match the current deployment",
        effect,
      );
    }
    const artifact = await this.#artifacts.prepare({ digest: effect.artifactDigest });
    try {
      const component = artifact.manifest.components.find(
        (candidate) => candidate.componentId === effect.componentId,
      );
      if (
        artifact.digest !== effect.artifactDigest ||
        artifact.manifest.pluginId !== effect.pluginId ||
        component === undefined ||
        !component.executors.includes(effect.executor)
      ) {
        throw effectError(
          "LIFECYCLE_ARTIFACT_IDENTITY_MISMATCH",
          "Prepared artifact does not contain the selected component binding",
          effect,
        );
      }
      const binding: ComponentBinding = {
        instanceId: effect.instanceId,
        executor: effect.executor,
        ...(effect.workerId === undefined ? {} : { workerId: parseWorkerId(effect.workerId) }),
        artifact,
        deployment,
      };
      this.#registry.register(effect, binding, authority);
    } catch (error) {
      await this.#artifacts.release(effect.artifactDigest).catch(() => undefined);
      throw error;
    }
  }

  async #stop(
    effect: ReconcileEffect,
    entry: RegisteredComponent,
    authority: RuntimeAuthority | undefined,
  ): Promise<void> {
    if (entry.state !== "prepared" && entry.state !== "active" && entry.state !== "draining") {
      throw effectError(
        "LIFECYCLE_TRANSITION_INVALID",
        "Component binding cannot stop from its current state",
        effect,
      );
    }
    this.#registry.transition(effect, entry.state, "stopping", authority);
    const failures: unknown[] = [];
    try {
      await this.#host.stop(entry.binding);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#artifacts.release(effect.artifactDigest);
    } catch (error) {
      failures.push(error);
    }
    this.#registry.remove(effect, authority);
    if (failures.length > 0) {
      throw effectError(
        "LIFECYCLE_STOP_FAILED",
        "Component stop completed with cleanup failures",
        effect,
        { causes: failures.map((failure) => serializeCause(failure)) },
      );
    }
  }
}
