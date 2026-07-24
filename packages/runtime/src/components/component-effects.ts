import {
  DiagnosticError,
  parseWorkerId,
  runtimeDiagnostic,
  serializeCause,
  type ExecutorKind,
  type PluginDeployment,
  type RuntimeAuthority,
} from "@tegojs/contracts";
import type { ValidatedPluginArtifact } from "../artifacts/artifact-service.js";
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
  readonly resolveDeployment: (
    effect: ReconcileEffect,
  ) => Promise<ValidatedComponentDeployment | undefined>;
  readonly host: ComponentLifecycleHost;
  readonly authority?: () => RuntimeAuthority | undefined;
}

export interface ValidatedComponentDeployment {
  readonly deployment: PluginDeployment;
  readonly artifact: Pick<ValidatedPluginArtifact, "digest" | "manifest">;
}

interface CachedOperation {
  readonly fingerprint: string;
  readonly result: Promise<void>;
  readonly instanceId: string;
  readonly authority: RuntimeAuthority | undefined;
  status: "pending" | "succeeded";
}

interface OperationFingerprint {
  readonly fingerprint: string;
  readonly instanceId: string;
}

const MAX_STOPPED_OPERATIONS = 256;
const MAX_FAILED_OPERATIONS = 256;

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

function sameAuthority(
  left: RuntimeAuthority | undefined,
  right: RuntimeAuthority | undefined,
): boolean {
  return left?.resource === right?.resource && left?.epoch === right?.epoch;
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
  readonly #fingerprints = new Map<string, OperationFingerprint>();
  readonly #stoppedOperations: string[] = [];
  readonly #failedOperations: string[] = [];

  constructor(options: ComponentEffectsOptions) {
    this.#artifacts = options.artifacts;
    this.#registry = options.registry;
    this.#resolveDeployment = options.resolveDeployment;
    this.#host = options.host;
    this.#authority = options.authority ?? (() => undefined);
    this.supportedExecutors = Object.freeze([...new Set(options.supportedExecutors)]);
  }

  perform(effect: ReconcileEffect): Promise<void> {
    const authority = this.#authority();
    const fingerprint = effectFingerprint(effect);
    const known = this.#fingerprints.get(effect.operationId);
    if (known !== undefined && known.fingerprint !== fingerprint) {
      return Promise.reject(
        effectError(
          "LIFECYCLE_OPERATION_CONFLICT",
          "Lifecycle operation identity was reused with a different payload",
          effect,
        ),
      );
    }
    const existing = this.#operations.get(effect.operationId);
    if (existing !== undefined) {
      if (!sameAuthority(existing.authority, authority)) {
        const completedStop =
          effect.kind === "stop" &&
          existing.status === "succeeded" &&
          this.#registry.get(effect.instanceId) === undefined;
        const stoppingCleanup =
          effect.kind === "stop" &&
          this.#registry.get(effect.instanceId)?.state === "stopping" &&
          existing.status === "pending";
        if (!completedStop && !stoppingCleanup) {
          return Promise.reject(
            effectError(
              "LIFECYCLE_AUTHORITY_LOST",
              "Lifecycle operation cannot replay under another authority",
              effect,
            ),
          );
        }
      }
      return existing.result;
    }
    this.#removeFailedOperation(effect.operationId);
    this.#fingerprints.set(effect.operationId, { fingerprint, instanceId: effect.instanceId });
    const result = this.#perform(effect, authority);
    const operation: CachedOperation = {
      fingerprint,
      result,
      instanceId: effect.instanceId,
      authority,
      status: "pending",
    };
    this.#operations.set(effect.operationId, operation);
    void result.then(
      () => {
        operation.status = "succeeded";
      },
      () => {
        if (this.#operations.get(effect.operationId)?.result === result) {
          this.#operations.delete(effect.operationId);
          this.#retainFailedOperation(effect.operationId);
        }
      },
    );
    return result;
  }

  async #perform(effect: ReconcileEffect, authority: RuntimeAuthority | undefined): Promise<void> {
    if (!this.supportedExecutors.includes(effect.executor)) {
      throw effectError(
        "LIFECYCLE_EXECUTOR_UNSUPPORTED",
        "Lifecycle effect selected an unsupported executor",
        effect,
      );
    }
    this.#assertCurrentAuthority(effect, authority);
    if (effect.kind === "prepare") {
      await this.#prepare(effect, authority);
      return;
    }
    let entry = this.#registry.require(effect.instanceId);
    if (effect.kind === "stop" && entry.state === "stopping") {
      entry = this.#registry.takeoverStopping(effect, authority);
    } else {
      this.#registry.assertMatches(effect, entry, authority);
    }
    if (effect.kind === "start") {
      if (entry.state !== "prepared") {
        throw effectError(
          "LIFECYCLE_TRANSITION_INVALID",
          "Only a prepared component binding can start",
          effect,
        );
      }
      await this.#host.start(entry.binding);
      if (!this.#authorityMatches(authority)) {
        await this.#cleanupAfterAuthorityLoss(effect, entry, authority);
        throw effectError(
          "LIFECYCLE_AUTHORITY_LOST",
          "Leadership authority changed while the component was starting",
          effect,
        );
      }
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
      if (!this.#authorityMatches(authority)) {
        await this.#cleanupAfterAuthorityLoss(effect, entry, authority);
        throw effectError(
          "LIFECYCLE_AUTHORITY_LOST",
          "Leadership authority changed while the component was draining",
          effect,
        );
      }
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
    const resolved = await this.#resolveDeployment(effect);
    if (
      resolved === undefined ||
      resolved.artifact.digest !== effect.artifactDigest ||
      resolved.artifact.manifest.pluginId !== effect.pluginId ||
      resolved.deployment.applicationId !== effect.applicationId ||
      resolved.deployment.pluginId !== effect.pluginId ||
      resolved.deployment.generation !== effect.deploymentGeneration ||
      resolved.deployment.artifactDigest !== effect.artifactDigest
    ) {
      throw effectError(
        "LIFECYCLE_DEPLOYMENT_IDENTITY_MISMATCH",
        "Lifecycle effect does not match the current deployment",
        effect,
      );
    }
    const { deployment } = resolved;
    const artifact = await this.#artifacts.prepare({ digest: effect.artifactDigest });
    try {
      this.#assertCurrentAuthority(effect, authority);
      const validatedComponent = resolved.artifact.manifest.components.find(
        (candidate) => candidate.componentId === effect.componentId,
      );
      const preparedComponent = artifact.manifest.components.find(
        (candidate) => candidate.componentId === effect.componentId,
      );
      if (
        artifact.digest !== effect.artifactDigest ||
        artifact.manifest.pluginId !== effect.pluginId ||
        validatedComponent === undefined ||
        preparedComponent === undefined ||
        JSON.stringify(validatedComponent) !== JSON.stringify(preparedComponent) ||
        !validatedComponent.executors.includes(effect.executor)
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
        component: validatedComponent,
        ...(authority === undefined ? {} : { authority }),
      };
      this.#registry.register(effect, binding, authority);
    } catch (error) {
      try {
        await this.#artifacts.release(effect.artifactDigest);
      } catch (releaseError) {
        throw effectError(
          "LIFECYCLE_PREPARE_ROLLBACK_FAILED",
          "Prepared artifact rollback failed",
          effect,
          { causes: [serializeCause(error), serializeCause(releaseError)] },
        );
      }
      throw error;
    }
  }

  async #stop(
    effect: ReconcileEffect,
    entry: RegisteredComponent,
    authority: RuntimeAuthority | undefined,
  ): Promise<void> {
    if (
      entry.state !== "prepared" &&
      entry.state !== "active" &&
      entry.state !== "draining" &&
      entry.state !== "stopping"
    ) {
      throw effectError(
        "LIFECYCLE_TRANSITION_INVALID",
        "Component binding cannot stop from its current state",
        effect,
      );
    }
    let progress =
      entry.state === "stopping"
        ? entry
        : this.#registry.transition(effect, entry.state, "stopping", authority);
    const failures: unknown[] = [];
    if (!progress.hostStopped) {
      try {
        await this.#host.stop(progress.binding);
        progress = this.#registry.updateStopProgress(effect, { hostStopped: true }, authority);
      } catch (error) {
        failures.push(error);
      }
    }
    if (!progress.artifactReleased) {
      try {
        await this.#artifacts.release(effect.artifactDigest);
        progress = this.#registry.updateStopProgress(effect, { artifactReleased: true }, authority);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw effectError(
        "LIFECYCLE_STOP_FAILED",
        "Component stop completed with cleanup failures",
        effect,
        { causes: failures.map((failure) => serializeCause(failure)) },
      );
    }
    if (!progress.hostStopped || !progress.artifactReleased) {
      throw effectError(
        "LIFECYCLE_STOP_INCOMPLETE",
        "Component stop cleanup is incomplete",
        effect,
      );
    }
    this.#registry.remove(effect, authority);
    this.#forgetInstanceOperations(effect.instanceId, effect.operationId);
  }

  async #cleanupAfterAuthorityLoss(
    effect: ReconcileEffect,
    entry: RegisteredComponent,
    authority: RuntimeAuthority | undefined,
  ): Promise<void> {
    const stopping = this.#registry.transition(effect, entry.state, "stopping", authority);
    const failures: unknown[] = [];
    let progress = stopping;
    try {
      await this.#host.stop(entry.binding);
      progress = this.#registry.updateStopProgress(effect, { hostStopped: true }, authority);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#artifacts.release(effect.artifactDigest);
      progress = this.#registry.updateStopProgress(effect, { artifactReleased: true }, authority);
    } catch (error) {
      failures.push(error);
    }
    if (progress.hostStopped && progress.artifactReleased) {
      this.#registry.remove(effect, authority);
      this.#forgetInstanceOperations(effect.instanceId, effect.operationId);
    }
    if (failures.length > 0) {
      throw effectError(
        "LIFECYCLE_AUTHORITY_CLEANUP_FAILED",
        "Leadership changed and component cleanup failed",
        effect,
        { causes: failures.map((failure) => serializeCause(failure)) },
      );
    }
  }

  #assertCurrentAuthority(effect: ReconcileEffect, expected: RuntimeAuthority | undefined): void {
    if (!this.#authorityMatches(expected)) {
      throw effectError(
        "LIFECYCLE_AUTHORITY_LOST",
        "Leadership authority changed before the component effect",
        effect,
      );
    }
  }

  #authorityMatches(expected: RuntimeAuthority | undefined): boolean {
    const current = this.#authority();
    return current?.resource === expected?.resource && current?.epoch === expected?.epoch;
  }

  #forgetInstanceOperations(instanceId: string, retainedOperationId: string): void {
    for (const [operationId, operation] of this.#operations) {
      if (operation.instanceId === instanceId && operationId !== retainedOperationId) {
        this.#operations.delete(operationId);
        this.#fingerprints.delete(operationId);
      }
    }
    for (const [operationId, operation] of this.#fingerprints) {
      if (operation.instanceId === instanceId && operationId !== retainedOperationId) {
        this.#fingerprints.delete(operationId);
      }
    }
    this.#stoppedOperations.push(retainedOperationId);
    while (this.#stoppedOperations.length > MAX_STOPPED_OPERATIONS) {
      const expired = this.#stoppedOperations.shift();
      if (expired !== undefined) {
        this.#operations.delete(expired);
        this.#fingerprints.delete(expired);
      }
    }
  }

  #retainFailedOperation(operationId: string): void {
    this.#failedOperations.push(operationId);
    while (this.#failedOperations.length > MAX_FAILED_OPERATIONS) {
      const expired = this.#failedOperations.shift();
      if (expired !== undefined && !this.#operations.has(expired)) {
        this.#fingerprints.delete(expired);
      }
    }
  }

  #removeFailedOperation(operationId: string): void {
    const index = this.#failedOperations.indexOf(operationId);
    if (index >= 0) this.#failedOperations.splice(index, 1);
  }
}
