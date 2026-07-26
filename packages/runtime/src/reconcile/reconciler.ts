import {
  type ApplicationId,
  type ArtifactDigest,
  type CapabilityName,
  type Clock,
  DiagnosticError,
  diagnosticCode,
  type ExecutorKind,
  type Generation,
  type JsonObject,
  type OperationId,
  type OutboxClaim,
  type PluginDeployment,
  type PluginDeploymentIdentity,
  type PluginInstallation,
  parseApplicationId,
  parseArtifactDigest,
  parseCapabilityName,
  parseComponentId,
  parseGeneration,
  parseMessageId,
  parseOperationId,
  parsePluginDeployment,
  parsePluginId,
  parsePluginInstallation,
  type Revision,
  type RuntimeAuthority,
  type RuntimeDiagnostic,
  runtimeDiagnostic,
  type StateKey,
  type StateStore,
  serializeCause,
} from "@tegojs/contracts";
import type {
  ArtifactService,
  ValidateArtifactRequest,
  ValidatedPluginArtifact,
} from "../artifacts/artifact-service.js";
import {
  type CapabilityResolutionDeployment,
  type PreviousCapabilityBinding,
  type ResolvedCapabilityBinding,
  resolveCapabilities,
} from "../capabilities/resolver.js";
import { validatePermissionGrant } from "../permissions/permission-set.js";
import { transitionComponentLifecycle } from "./component-lifecycle.js";
import type { PlacementWorker } from "./placement.js";
import { placementIsEligible } from "./placement.js";
import {
  type ArtifactDeploymentGate,
  type ComponentInstance,
  planReconcile,
  type ReconcileEffect,
  type ReconcileEffectKind,
  type ReconcilePlanStep,
  reconcileEffectIdentities,
} from "./plan.js";
import { deterministicRetryDelay } from "./retry.js";

const namespace = "tego";
const claimLeaseMs = 30_000;
const defaultMaxConvergencePasses = 10_000;

export interface ComponentEffectExecutor {
  readonly supportedExecutors: readonly ExecutorKind[];
  perform(effect: ReconcileEffect): Promise<void>;
  restore?(instance: ComponentInstance, authority?: RuntimeAuthority): Promise<void>;
  isLive?(instance: ComponentInstance, authority?: RuntimeAuthority): boolean;
  close?(authority?: RuntimeAuthority): Promise<void>;
}

export interface ReconcileArtifactGate {
  validate(request: ValidateArtifactRequest): Promise<ValidatedPluginArtifact>;
}

interface PersistedCapabilityBinding extends JsonObject {
  readonly consumer: PluginDeploymentIdentity;
  readonly capability: CapabilityName;
  readonly provider: PluginDeploymentIdentity;
  readonly source: "automatic" | "explicit";
  readonly deploymentGeneration: Generation;
  readonly updatedAt: string;
}

interface LoadedCapabilityBinding {
  readonly key: StateKey<PersistedCapabilityBinding>;
  readonly value: PersistedCapabilityBinding;
  readonly revision: Revision;
}

interface ComponentLifecycleExecutor {
  restore(instance: ComponentInstance, authority?: RuntimeAuthority): Promise<void>;
  isLive(instance: ComponentInstance, authority?: RuntimeAuthority): boolean;
  close(authority?: RuntimeAuthority): Promise<void>;
}

function componentLifecycle(
  effects: ComponentEffectExecutor,
): ComponentLifecycleExecutor | undefined {
  const { close, isLive, restore } = effects;
  if (restore === undefined && isLive === undefined && close === undefined) return undefined;
  if (restore === undefined || isLive === undefined || close === undefined) {
    throw new TypeError(
      "Component lifecycle capability requires restore, isLive, and close methods together",
    );
  }
  return {
    restore: restore.bind(effects),
    isLive: isLive.bind(effects),
    close: close.bind(effects),
  };
}

function restorationOperationId(
  instance: Pick<
    ComponentInstance,
    "applicationId" | "componentId" | "deploymentGeneration" | "pluginId"
  >,
): OperationId {
  const prepareOperationId = reconcileEffectIdentities(
    {
      applicationId: instance.applicationId,
      generation: instance.deploymentGeneration,
      pluginId: instance.pluginId,
    },
    instance.componentId,
    "prepare",
  ).operationId;
  return parseOperationId(`${prepareOperationId.slice(0, -"prepare".length)}restore`);
}

export interface ReconcilerOptions {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly effects: ComponentEffectExecutor;
  readonly artifactGate: ReconcileArtifactGate | Pick<ArtifactService, "validate">;
  readonly authority?: RuntimeAuthority;
  readonly workers?: readonly PlacementWorker[];
  readonly owner?: string;
  readonly loadDeployments?: () => Promise<readonly PluginDeployment[]>;
  readonly loadInstallations?: () => Promise<readonly PluginInstallation[]>;
  readonly interruptAfterEffect?: boolean;
  readonly maxConvergencePasses?: number;
  readonly onBackgroundError?: (error: unknown) => void | Promise<void>;
}

interface PersistedComponentInstance extends JsonObject {
  readonly instanceId: string;
  readonly applicationId: ApplicationId;
  readonly pluginId: ComponentInstance["pluginId"];
  readonly componentId: ComponentInstance["componentId"];
  readonly deploymentGeneration: ComponentInstance["deploymentGeneration"];
  readonly observedGeneration: ComponentInstance["observedGeneration"];
  readonly lifecycle: ComponentInstance["lifecycle"];
  readonly executor: ComponentInstance["executor"];
  readonly workerId?: string;
  readonly artifactDigest?: ArtifactDigest;
  readonly attempt?: number;
  readonly retryAt?: string;
  readonly retryEffect?: ReconcileEffectKind;
  readonly diagnostic?: RuntimeDiagnostic;
  readonly completedOperationId?: OperationId;
  readonly completedOperationIds?: readonly OperationId[];
}

interface LoadedComponentInstance {
  readonly storageId: string;
  readonly value: ComponentInstance;
}

interface DeploymentObservation extends JsonObject {
  readonly applicationId: PluginDeployment["applicationId"];
  readonly pluginId: PluginDeployment["pluginId"];
  readonly generation: PluginDeployment["generation"];
  readonly status:
    | "blocked"
    | "converging"
    | "degraded"
    | "failed"
    | "inconsistent"
    | "ready"
    | "unavailable";
  readonly diagnostics: readonly JsonObject[];
  readonly updatedAt: string;
}

function deploymentKey(identity: PluginDeploymentIdentity): string {
  return `${identity.applicationId}/${identity.pluginId}`;
}

function deploymentStateKey(identity: PluginDeploymentIdentity): StateKey<PluginDeployment> {
  return {
    namespace,
    collection: "deployments",
    id: deploymentKey(identity),
  };
}

function instanceKey(instanceId: string): StateKey<PersistedComponentInstance> {
  return {
    namespace,
    collection: "component-instances",
    id: instanceId,
  };
}

function isCanonicalInstance(record: LoadedComponentInstance): boolean {
  const instance = record.value;
  return (
    record.storageId === instance.instanceId &&
    reconcileEffectIdentities(
      {
        applicationId: instance.applicationId,
        generation: instance.deploymentGeneration,
        pluginId: instance.pluginId,
      },
      instance.componentId,
      "prepare",
    ).instanceId === instance.instanceId
  );
}

function isInstanceContextConsistent(
  record: LoadedComponentInstance,
  deployments: readonly PluginDeployment[],
): boolean {
  if (!isCanonicalInstance(record)) return false;
  const instance = record.value;
  const current = deployments.find(
    (deployment) =>
      deployment.applicationId === instance.applicationId &&
      deployment.pluginId === instance.pluginId &&
      deployment.generation === instance.deploymentGeneration,
  );
  return (
    current === undefined ||
    (instance.artifactDigest === current.artifactDigest &&
      instance.observedGeneration === current.generation)
  );
}

function observationKey(deployment: PluginDeployment): StateKey<DeploymentObservation> {
  return {
    namespace,
    collection: "deployment-observations",
    id: deploymentKey(deployment),
  };
}

function capabilityBindingKey(
  consumer: PluginDeploymentIdentity,
  capability: CapabilityName,
): StateKey<PersistedCapabilityBinding> {
  return {
    namespace,
    collection: "capability-bindings",
    id: `${consumer.applicationId}/${consumer.pluginId}/${capability}`,
  };
}

const capabilityBindingConflict = Symbol("capability-binding-conflict");

function conflictCode(error: unknown): string | undefined {
  return (
    diagnosticCode(error) ??
    (typeof error === "object" &&
    error !== null &&
    "diagnostic" in error &&
    typeof (error as { diagnostic?: { code?: unknown } }).diagnostic?.code === "string"
      ? (error as { diagnostic: { code: string } }).diagnostic.code
      : undefined)
  );
}

function observationDiagnosticsFingerprint(diagnostics: readonly JsonObject[]): string {
  return JSON.stringify(
    diagnostics.map((diagnostic) => {
      const { observedAt: _observedAt, ...stable } = diagnostic;
      void _observedAt;
      return stable;
    }),
  );
}

function effectDiagnostic(
  effect: ReconcileEffect,
  error: unknown,
  observedAt: string,
): RuntimeDiagnostic {
  return runtimeDiagnostic({
    code:
      effect.kind === "start"
        ? "LIFECYCLE_START_FAILED"
        : (`LIFECYCLE_${effect.kind.toUpperCase()}_FAILED` as `LIFECYCLE_${string}`),
    message: `Component ${effect.kind} effect failed`,
    source: {
      kind: "plugin",
      id: `${effect.pluginId}/${effect.componentId}`,
    },
    retryable: true,
    details: {
      componentId: effect.componentId,
      deploymentGeneration: effect.deploymentGeneration,
      instanceId: effect.instanceId,
      operationId: effect.operationId,
      pluginId: effect.pluginId,
    },
    cause: serializeCause(error),
    observedAt,
  });
}

function invalidMessageDiagnostic(claim: OutboxClaim, error: unknown, observedAt: string) {
  return runtimeDiagnostic({
    code: "PROTOCOL_MESSAGE_INVALID",
    message: "Lifecycle outbox message payload is invalid",
    source: { kind: "runtime", id: claim.message.messageId },
    details: {
      messageId: claim.message.messageId,
      operationId: claim.message.operationId,
      topic: claim.message.topic,
    },
    cause: serializeCause(error),
    observedAt,
  });
}

function parseReconcileEffect(claim: OutboxClaim): ReconcileEffect {
  const payload = claim.message.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TypeError("Lifecycle payload must be an object");
  }
  const value = payload as Record<string, unknown>;
  if (
    value.kind !== "prepare" &&
    value.kind !== "start" &&
    value.kind !== "drain" &&
    value.kind !== "stop"
  ) {
    throw new TypeError("Lifecycle effect kind is invalid");
  }
  if (typeof value.instanceId !== "string" || value.instanceId.length === 0) {
    throw new TypeError("Lifecycle instance identity is invalid");
  }
  if (value.executor !== "process" && value.executor !== "thread" && value.executor !== "remote") {
    throw new TypeError("Lifecycle executor is invalid");
  }
  if (value.workerId !== undefined && typeof value.workerId !== "string") {
    throw new TypeError("Lifecycle worker identity is invalid");
  }
  const effect: ReconcileEffect = {
    kind: value.kind,
    applicationId: parseApplicationId(value.applicationId),
    artifactDigest: parseArtifactDigest(value.artifactDigest),
    componentId: parseComponentId(value.componentId),
    deploymentGeneration: parseGeneration(value.deploymentGeneration),
    executor: value.executor,
    instanceId: value.instanceId,
    messageId: parseMessageId(value.messageId),
    operationId: parseOperationId(value.operationId),
    pluginId: parsePluginId(value.pluginId),
    ...(value.workerId === undefined ? {} : { workerId: value.workerId }),
  };
  if (
    effect.messageId !== claim.message.messageId ||
    effect.operationId !== claim.message.operationId
  ) {
    throw new TypeError("Lifecycle payload identity does not match its envelope");
  }
  return effect;
}

export class Reconciler {
  readonly #options: ReconcilerOptions;
  readonly #owner: string;
  readonly #componentLifecycle: ComponentLifecycleExecutor | undefined;
  readonly #maxConvergencePasses: number;
  readonly #diagnosticsByDeployment = new Map<string, readonly RuntimeDiagnostic[]>();
  readonly #readyDeployments = new Set<string>();
  #deployments: readonly PluginDeployment[] = [];
  #running = false;
  #starting = false;
  #stopRequested = false;
  #fatalReported = false;
  #fatalError: unknown;
  #tail: Promise<void> = Promise.resolve();
  #interrupted = false;
  #lastCommitAuthority: RuntimeAuthority | undefined;
  #replanCount = 0;
  #nextWakeAt: number | undefined;
  #fatalDiagnostic: RuntimeDiagnostic | undefined;
  #deferredWake:
    | {
        readonly at: number;
        readonly controller: AbortController;
        readonly promise: Promise<void>;
      }
    | undefined;

  constructor(options: ReconcilerOptions) {
    this.#options = options;
    this.#owner = options.owner ?? "reconciler";
    this.#componentLifecycle = componentLifecycle(options.effects);
    this.#maxConvergencePasses = options.maxConvergencePasses ?? defaultMaxConvergencePasses;
    if (!Number.isSafeInteger(this.#maxConvergencePasses) || this.#maxConvergencePasses < 1) {
      throw new RangeError("maxConvergencePasses must be a positive safe integer");
    }
  }

  get kernelRunning(): boolean {
    return this.#running;
  }

  get lastCommitAuthority(): RuntimeAuthority | undefined {
    return this.#lastCommitAuthority;
  }

  get replanCount(): number {
    return this.#replanCount;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#starting = true;
    try {
      await this.wake();
      await Promise.resolve();
      if (!this.#running && !this.#stopRequested) {
        throw this.#fatalError ?? new Error("Reconciler startup failed");
      }
    } catch (error) {
      const cleanupRequired = this.#running;
      this.#running = false;
      this.#cancelDeferredWake();
      if (cleanupRequired) {
        try {
          await this.#componentLifecycle?.close(this.#options.authority);
        } catch (closeError) {
          throw new AggregateError([error, closeError], "Reconciler startup cleanup failed");
        }
      }
      throw error;
    } finally {
      this.#starting = false;
    }
  }

  wake(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    const preservedWakeAt = this.#deferredWake?.at;
    this.#cancelDeferredWake();
    const pass = this.#tail.then(async () => {
      if (!this.#running) return;
      try {
        await this.#reconcileUntilQuiescent(preservedWakeAt);
      } catch (error) {
        this.#running = false;
        this.#cancelDeferredWake();
        let failure = error;
        try {
          await this.#componentLifecycle?.close(this.#options.authority);
        } catch (closeError) {
          failure = new AggregateError([error, closeError], "Reconciler failure cleanup failed");
        }
        if (!this.#starting) await this.#reportFatalFailure(failure);
        throw failure;
      }
    });
    this.#tail = pass.catch(() => undefined);
    return pass;
  }

  async stop(): Promise<void> {
    this.#stopRequested = true;
    this.#running = false;
    this.#cancelDeferredWake();
    await this.#tail;
    await this.#componentLifecycle?.close(this.#options.authority);
  }

  diagnostics(): readonly RuntimeDiagnostic[] {
    const diagnostics = [...this.#diagnosticsByDeployment.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap(([, diagnostics]) => diagnostics);
    return this.#fatalDiagnostic === undefined
      ? diagnostics
      : [...diagnostics, this.#fatalDiagnostic];
  }

  applicationReady(): boolean {
    for (const deployment of this.#deployments) {
      if (
        deployment.state === "active" &&
        deployment.essential &&
        !this.#readyDeployments.has(deploymentKey(deployment))
      ) {
        return false;
      }
    }
    return true;
  }

  async #reconcileUntilQuiescent(preservedWakeAt?: number): Promise<void> {
    this.#diagnosticsByDeployment.clear();
    this.#nextWakeAt =
      preservedWakeAt !== undefined && preservedWakeAt > this.#options.clock.now().getTime()
        ? preservedWakeAt
        : undefined;
    for (let pass = 0; pass < this.#maxConvergencePasses; pass += 1) {
      if (!this.#running) return;
      const pending = await this.#reconcilePass();
      if (!this.#running || this.#interrupted) return;
      if (!pending) {
        this.#deferUntil(this.#options.clock.now().getTime() + claimLeaseMs);
        this.#armDeferredWake();
        return;
      }
    }
    if (!this.#running) return;
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "LIFECYCLE_RECONCILE_DID_NOT_CONVERGE",
        message: `Reconciler did not converge within ${this.#maxConvergencePasses} pass${this.#maxConvergencePasses === 1 ? "" : "es"}`,
        source: { kind: "runtime", id: this.#owner },
        details: { maxConvergencePasses: this.#maxConvergencePasses },
        observedAt: this.#options.clock.now().toISOString(),
      }),
    );
  }

  async #reconcilePass(): Promise<boolean> {
    if (!this.#running) return false;
    const replanCount = this.#replanCount;
    let [deployments, installations, loadedInstances, capabilityBindings] = await Promise.all([
      this.#loadDeployments(),
      this.#loadInstallations(),
      this.#loadInstances(),
      this.#loadCapabilityBindings(),
    ]);
    if (!this.#running) return false;
    if (!(await this.#cleanupCapabilityBindings(deployments, capabilityBindings))) return true;
    capabilityBindings = capabilityBindings.filter((record) =>
      this.#isCurrentCapabilityBinding(record, deployments),
    );
    await this.#restorePersistedComponents(deployments, installations, loadedInstances);
    if (!this.#running) return false;
    loadedInstances = await this.#loadInstances();
    this.#deferRetries(loadedInstances);
    this.#deployments = deployments;
    this.#readyDeployments.clear();

    const existingClaim = await this.#claimNext();
    let performedImmediateWork = existingClaim !== undefined;
    if (existingClaim !== undefined) {
      if ((await this.#executeClaim(existingClaim)) === capabilityBindingConflict) return true;
      if (!this.#running || this.#interrupted) return false;
      [deployments, installations, loadedInstances, capabilityBindings] = await Promise.all([
        this.#loadDeployments(),
        this.#loadInstallations(),
        this.#loadInstances(),
        this.#loadCapabilityBindings(),
      ]);
      if (!this.#running) return false;
      if (!(await this.#cleanupCapabilityBindings(deployments, capabilityBindings))) return true;
      capabilityBindings = capabilityBindings.filter((record) =>
        this.#isCurrentCapabilityBinding(record, deployments),
      );
      this.#deferRetries(loadedInstances);
      this.#deployments = deployments;
    }

    const lexicalDeployments = [...deployments].sort((left, right) =>
      deploymentKey(left) < deploymentKey(right)
        ? -1
        : deploymentKey(left) > deploymentKey(right)
          ? 1
          : 0,
    );
    const canonicalInstances = loadedInstances
      .filter((record) => isInstanceContextConsistent(record, deployments))
      .map((record) => record.value);
    const invalidByDeployment = new Map<string, readonly ComponentInstance[]>();
    const gates = new Map<string, ArtifactDeploymentGate | DiagnosticError>();
    const orderRanks = new Map<string, number>();
    const currentDeploymentKeys = new Set(lexicalDeployments.map(deploymentKey));
    for (const key of this.#diagnosticsByDeployment.keys()) {
      if (!key.startsWith("outbox/") && !currentDeploymentKeys.has(key)) {
        this.#diagnosticsByDeployment.delete(key);
      }
    }
    for (const deployment of lexicalDeployments) {
      this.#diagnosticsByDeployment.delete(deploymentKey(deployment));
      const invalidInstances = loadedInstances
        .filter(
          (record) =>
            record.value.applicationId === deployment.applicationId &&
            record.value.pluginId === deployment.pluginId &&
            !isInstanceContextConsistent(record, deployments),
        )
        .map((record) => record.value);
      if (invalidInstances.length > 0) {
        invalidByDeployment.set(deploymentKey(deployment), invalidInstances);
        continue;
      }
      const gate = await this.#gateDeployment(
        deployment,
        deployments,
        installations,
        canonicalInstances,
        capabilityBindings,
      );
      if (!this.#running) return false;
      if (gate === capabilityBindingConflict) return true;
      gates.set(deploymentKey(deployment), gate);
      if (!(gate instanceof DiagnosticError)) {
        for (const [index, identity] of (gate.capabilityResolution.order ?? []).entries()) {
          const key = `${identity.applicationId}/${identity.pluginId}`;
          if (!orderRanks.has(key)) orderRanks.set(key, index);
        }
      }
    }
    const orderedDeployments = lexicalDeployments.sort((left, right) => {
      if (left.applicationId !== right.applicationId) {
        return left.applicationId < right.applicationId ? -1 : 1;
      }
      const leftRank = orderRanks.get(deploymentKey(left));
      const rightRank = orderRanks.get(deploymentKey(right));
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        if (leftRank !== rightRank) return leftRank - rightRank;
      }
      return deploymentKey(left) < deploymentKey(right)
        ? -1
        : deploymentKey(left) > deploymentKey(right)
          ? 1
          : 0;
    });

    for (const deployment of orderedDeployments) {
      const deploymentInstances = canonicalInstances.filter(
        (instance) =>
          instance.applicationId === deployment.applicationId &&
          instance.pluginId === deployment.pluginId,
      );
      const invalidInstances = invalidByDeployment.get(deploymentKey(deployment)) ?? [];
      if (invalidInstances.length > 0) {
        await this.#recordBlocked(
          deployment,
          invalidInstances.map((instance) =>
            runtimeDiagnostic({
              code: "DEPLOYMENT_INSTANCE_INCONSISTENT",
              message:
                "Persisted component instance identity or deployment context is inconsistent",
              source: { kind: "deployment", id: deploymentKey(deployment) },
              details: {
                applicationId: instance.applicationId,
                artifactDigest: instance.artifactDigest ?? null,
                componentId: instance.componentId,
                deploymentGeneration: instance.deploymentGeneration,
                instanceId: instance.instanceId,
                observedGeneration: instance.observedGeneration,
                pluginId: instance.pluginId,
              },
              observedAt: this.#options.clock.now().toISOString(),
            }),
          ),
        );
        continue;
      }
      const gate = gates.get(deploymentKey(deployment));
      if (gate === undefined) continue;
      if (gate instanceof DiagnosticError) {
        await this.#recordBlocked(deployment, [gate.diagnostic]);
        continue;
      }
      const plan = planReconcile({
        deployment,
        gate,
        instances: deploymentInstances,
        now: this.#options.clock.now().toISOString(),
        supportedExecutors: this.#options.effects.supportedExecutors,
        ...(this.#options.workers === undefined ? {} : { workers: this.#options.workers }),
      });
      if (plan.blocked) {
        const diagnostics = plan.diagnostics.map((diagnostic) =>
          runtimeDiagnostic({
            code: diagnostic.code as
              | `DEPLOYMENT_${string}`
              | `PERMISSION_${string}`
              | `CAPABILITY_${string}`,
            message:
              typeof diagnostic.message === "string"
                ? diagnostic.message
                : "Deployment pre-execution gate rejected the deployment",
            source: { kind: "deployment", id: deploymentKey(deployment) },
            details: diagnostic,
            observedAt: this.#options.clock.now().toISOString(),
          }),
        );
        await this.#recordBlocked(deployment, diagnostics);
        continue;
      }
      for (const step of plan.steps) {
        if (!this.#running) return false;
        await this.#persistStep(deployment, step);
      }
    }

    if (existingClaim === undefined) {
      const claim = await this.#claimNext();
      if (claim !== undefined) {
        performedImmediateWork = true;
        if ((await this.#executeClaim(claim)) === capabilityBindingConflict) return true;
      }
    }
    if (!this.#running || this.#interrupted) return false;
    await this.#refreshReadiness();
    if (!this.#running) return false;
    const latestInstances = await this.#loadInstances();
    this.#deferRetries(latestInstances);
    const canonicalLatestInstances = latestInstances.filter((record) =>
      isInstanceContextConsistent(record, this.#deployments),
    );
    const needsImmediateReconcile = canonicalLatestInstances.some(
      (record) =>
        !this.#isDeploymentPlanningBlocked(record.value) &&
        this.#needsImmediateReconcile(record.value),
    );
    const hasUnsettledDeployment = this.#deployments.some(
      (deployment) =>
        deployment.state === "active" &&
        !this.#readyDeployments.has(deploymentKey(deployment)) &&
        !this.#diagnosticsByDeployment
          .get(deploymentKey(deployment))
          ?.some(
            (diagnostic) =>
              diagnostic.code.startsWith("ARTIFACT_") ||
              diagnostic.code.startsWith("CAPABILITY_") ||
              diagnostic.code.startsWith("DEPLOYMENT_") ||
              diagnostic.code.startsWith("PERMISSION_"),
          ),
    );
    const hasDeferredCapabilityResolution = this.diagnostics().some((diagnostic) =>
      diagnostic.code.startsWith("CAPABILITY_"),
    );
    return (
      (performedImmediateWork || this.#replanCount !== replanCount) &&
      (needsImmediateReconcile || hasUnsettledDeployment || hasDeferredCapabilityResolution)
    );
  }

  async #claimNext(): Promise<OutboxClaim | undefined> {
    if (!this.#running) return undefined;
    const claims = await this.#options.state.claimOutbox({
      owner: this.#owner,
      leaseDurationMs: claimLeaseMs,
      limit: 1,
      topic: "component.lifecycle",
      ...(this.#options.authority === undefined ? {} : { fencing: this.#options.authority }),
    });
    if (!this.#running) return undefined;
    return claims[0];
  }

  async #loadDeployments(): Promise<readonly PluginDeployment[]> {
    if (this.#options.loadDeployments !== undefined) {
      return this.#options.loadDeployments();
    }
    const deployments: PluginDeployment[] = [];
    for await (const record of this.#options.state.scan({
      namespace,
      collection: "deployments",
    })) {
      deployments.push(parsePluginDeployment(record.value));
    }
    return deployments;
  }

  async #loadInstallations(): Promise<readonly PluginInstallation[]> {
    if (this.#options.loadInstallations !== undefined) {
      return this.#options.loadInstallations();
    }
    const installations: PluginInstallation[] = [];
    for await (const record of this.#options.state.scan({
      namespace,
      collection: "installations",
    })) {
      installations.push(parsePluginInstallation(record.value));
    }
    return installations;
  }

  async #loadInstances(): Promise<readonly LoadedComponentInstance[]> {
    const instances: LoadedComponentInstance[] = [];
    for await (const record of this.#options.state.scan<PersistedComponentInstance>({
      namespace,
      collection: "component-instances",
    })) {
      instances.push({
        storageId: record.key.id,
        value: { ...record.value, revision: record.revision },
      });
    }
    return instances;
  }

  async #loadCapabilityBindings(): Promise<readonly LoadedCapabilityBinding[]> {
    const bindings: LoadedCapabilityBinding[] = [];
    for await (const record of this.#options.state.scan<PersistedCapabilityBinding>({
      namespace,
      collection: "capability-bindings",
    })) {
      bindings.push({ key: record.key, value: record.value, revision: record.revision });
    }
    return bindings.sort((left, right) => {
      const leftKey = left.key.id;
      const rightKey = right.key.id;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }

  #isCurrentCapabilityBinding(
    record: LoadedCapabilityBinding,
    deployments: readonly PluginDeployment[],
  ): boolean {
    return deployments.some(
      (deployment) =>
        deployment.applicationId === record.value.consumer.applicationId &&
        deployment.pluginId === record.value.consumer.pluginId &&
        deployment.generation === record.value.deploymentGeneration,
    );
  }

  async #cleanupCapabilityBindings(
    deployments: readonly PluginDeployment[],
    loadedBindings: readonly LoadedCapabilityBinding[],
  ): Promise<boolean> {
    if (this.#options.loadDeployments !== undefined) return true;
    const staleBindings = loadedBindings.filter(
      (record) => !this.#isCurrentCapabilityBinding(record, deployments),
    );
    if (staleBindings.length === 0) return true;
    try {
      await this.#options.state.transact(this.#transactionOptions(), async (transaction) => {
        for (const record of staleBindings) {
          const currentDeployment = await transaction.get(
            deploymentStateKey(record.value.consumer),
          );
          if (
            currentDeployment !== undefined &&
            parsePluginDeployment(currentDeployment.value).generation ===
              record.value.deploymentGeneration
          ) {
            continue;
          }
          await transaction.delete(record.key, { expectedRevision: record.revision });
        }
        return null;
      });
      this.#lastCommitAuthority = this.#options.authority;
      return true;
    } catch (error) {
      if (conflictCode(error) !== "STATE_REVISION_CONFLICT") throw error;
      this.#replanCount += 1;
      return false;
    }
  }

  async #restorePersistedComponents(
    loadedDeployments?: readonly PluginDeployment[],
    loadedInstallations?: readonly PluginInstallation[],
    loadedInstances?: readonly LoadedComponentInstance[],
  ): Promise<void> {
    if (this.#componentLifecycle === undefined) return;
    const [deployments, installations, instances] = await Promise.all([
      loadedDeployments ?? this.#loadDeployments(),
      loadedInstallations ?? this.#loadInstallations(),
      loadedInstances ?? this.#loadInstances(),
    ]);
    const now = this.#options.clock.now().toISOString();
    const restorable = instances
      .filter((record) => isInstanceContextConsistent(record, deployments))
      .map((record) => record.value)
      .filter(
        (instance) =>
          (instance.lifecycle === "preparing" || instance.lifecycle === "ready") &&
          (instance.retryAt === undefined || instance.retryAt <= now) &&
          (instance.workerId === undefined ||
            this.#options.workers?.some((worker) => worker.workerId === instance.workerId) ===
              true) &&
          instance.artifactDigest !== undefined &&
          this.#options.effects.supportedExecutors.includes(instance.executor) &&
          deployments.some(
            (deployment) =>
              deployment.state === "active" &&
              deployment.applicationId === instance.applicationId &&
              deployment.pluginId === instance.pluginId &&
              deployment.generation === instance.deploymentGeneration &&
              deployment.artifactDigest === instance.artifactDigest,
          ),
      )
      .sort((left, right) =>
        left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0,
      );
    for (const instance of restorable) {
      if (
        instance.executor === "remote" &&
        !(await this.#isPersistedRemotePlacementEligible(instance, deployments, installations))
      ) {
        continue;
      }
      if (
        instance.lifecycle === "ready" &&
        this.#componentLifecycle.isLive(instance, this.#options.authority)
      ) {
        await this.#clearRestorationFailure(instance);
        continue;
      }
      try {
        await this.#componentLifecycle.restore(instance, this.#options.authority);
        if (
          instance.lifecycle === "ready" &&
          !this.#componentLifecycle.isLive(instance, this.#options.authority)
        ) {
          throw new Error("Restored component session did not become live");
        }
        await this.#clearRestorationFailure(instance);
      } catch (error) {
        await this.#recordRestorationFailure(instance, error);
      }
    }
  }

  async #isPersistedRemotePlacementEligible(
    instance: ComponentInstance,
    deployments: readonly PluginDeployment[],
    installations: readonly PluginInstallation[],
  ): Promise<boolean> {
    if (instance.workerId === undefined || instance.artifactDigest === undefined) return false;
    const deployment = deployments.find(
      (candidate) =>
        candidate.state === "active" &&
        candidate.applicationId === instance.applicationId &&
        candidate.pluginId === instance.pluginId &&
        candidate.generation === instance.deploymentGeneration &&
        candidate.artifactDigest === instance.artifactDigest,
    );
    if (deployment === undefined) return false;
    const installation = installations.find(
      (candidate) =>
        candidate.pluginId === deployment.pluginId &&
        candidate.version === deployment.version &&
        candidate.digest === deployment.artifactDigest,
    );
    if (installation === undefined) return false;
    let artifact: ValidatedPluginArtifact;
    try {
      artifact = await this.#options.artifactGate.validate({
        digest: deployment.artifactDigest,
      });
    } catch {
      return false;
    }
    const component = artifact.manifest.components.find(
      (candidate) => candidate.componentId === instance.componentId,
    );
    if (component === undefined) return false;
    const permissionDecision = validatePermissionGrant(
      artifact.manifest.permissions,
      deployment.permissionGrants,
    );
    if (!permissionDecision.allowed) return false;
    return placementIsEligible(
      {
        artifactDigest: deployment.artifactDigest,
        component,
        grantedPermissions: permissionDecision.granted ?? [],
        supportedExecutors: this.#options.effects.supportedExecutors,
        ...(this.#options.workers === undefined ? {} : { workers: this.#options.workers }),
      },
      { executor: "remote", workerId: instance.workerId },
    );
  }

  async #recordRestorationFailure(instance: ComponentInstance, error: unknown): Promise<void> {
    const observedAt = this.#options.clock.now().toISOString();
    const operationId = restorationOperationId(instance);
    const diagnostic = runtimeDiagnostic({
      code: "LIFECYCLE_RESTORE_FAILED",
      message: "Persisted component session restoration failed",
      source: { kind: "plugin", id: `${instance.pluginId}/${instance.componentId}` },
      retryable: true,
      details: {
        instanceId: instance.instanceId,
        deploymentGeneration: instance.deploymentGeneration,
      },
      cause: serializeCause(error),
      observedAt,
    });
    const key = instanceKey(instance.instanceId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.#options.state.read(key);
      if (current === undefined) return;
      const nextAttempt = (current.value.attempt ?? 0) + 1;
      const retryAt = new Date(
        this.#options.clock.now().getTime() +
          deterministicRetryDelay({
            attempt: nextAttempt,
            baseDelayMs: 1_000,
            maxDelayMs: 60_000,
            operationId,
          }),
      ).toISOString();
      try {
        await this.#options.state.transact(this.#transactionOptions(), async (transaction) => {
          const { retryEffect: _retryEffect, ...stable } = current.value;
          void _retryEffect;
          await transaction.put(
            key,
            {
              ...stable,
              attempt: nextAttempt,
              retryAt,
              diagnostic,
            },
            { expectedRevision: current.revision },
          );
          await transaction.appendOperation({
            operationId,
            kind: "component.lifecycle",
            status: "failed",
            state: { diagnostic, retryAt, recovery: "restore" },
            updatedAt: observedAt,
          });
          return null;
        });
        this.#lastCommitAuthority = this.#options.authority;
        return;
      } catch (commitError) {
        if (conflictCode(commitError) !== "STATE_REVISION_CONFLICT") throw commitError;
        this.#replanCount += 1;
      }
    }
  }

  async #clearRestorationFailure(instance: ComponentInstance): Promise<void> {
    if (instance.diagnostic?.code !== "LIFECYCLE_RESTORE_FAILED") return;
    const key = instanceKey(instance.instanceId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.#options.state.read(key);
      if (current === undefined || current.value.diagnostic?.code !== "LIFECYCLE_RESTORE_FAILED") {
        return;
      }
      const {
        attempt: _attempt,
        diagnostic: _diagnostic,
        retryAt: _retryAt,
        retryEffect: _retryEffect,
        ...stable
      } = current.value;
      void _attempt;
      void _diagnostic;
      void _retryAt;
      void _retryEffect;
      try {
        await this.#options.state.transact(this.#transactionOptions(), async (transaction) => {
          await transaction.put(key, stable, { expectedRevision: current.revision });
          await transaction.appendOperation({
            operationId: restorationOperationId(current.value),
            kind: "component.lifecycle",
            status: "completed",
            state: {
              instanceId: current.value.instanceId,
              lifecycle: current.value.lifecycle,
              recovery: "restore",
            },
            updatedAt: this.#options.clock.now().toISOString(),
          });
          return null;
        });
        this.#lastCommitAuthority = this.#options.authority;
        return;
      } catch (error) {
        if (conflictCode(error) !== "STATE_REVISION_CONFLICT") throw error;
        this.#replanCount += 1;
      }
    }
  }

  #isReadyAndLive(instance: ComponentInstance): boolean {
    return (
      instance.lifecycle === "ready" &&
      (this.#componentLifecycle?.isLive(instance, this.#options.authority) ?? false)
    );
  }

  async #gateDeployment(
    deployment: PluginDeployment,
    deployments: readonly PluginDeployment[],
    installations: readonly PluginInstallation[],
    instances: readonly ComponentInstance[],
    loadedCapabilityBindings?: readonly LoadedCapabilityBinding[],
  ): Promise<ArtifactDeploymentGate | DiagnosticError | typeof capabilityBindingConflict> {
    const persistedCapabilityBindings =
      loadedCapabilityBindings ?? (await this.#loadCapabilityBindings());
    const installation = installations.find(
      (candidate) =>
        candidate.pluginId === deployment.pluginId &&
        candidate.version === deployment.version &&
        candidate.digest === deployment.artifactDigest,
    );
    if (installation === undefined && deployment.state === "disabled") {
      return {
        artifact: {
          digest: deployment.artifactDigest,
          files: { schemaVersion: "1.0", files: [] },
          manifest: {
            schemaVersion: "1.0",
            pluginId: deployment.pluginId,
            version: deployment.version,
            contractRange: ">=0.0.0",
            nodeRange: ">=0.0.0",
            moduleFormat: "esm",
            components: [],
            permissions: [],
            capabilities: { provides: [], requires: [] },
          },
        },
        capabilityResolution: {
          ok: true,
          diagnostics: [],
          providerLossActions: [],
          bindings: [],
          order: [],
        },
        permissionDecision: {
          allowed: true,
          diagnostics: [],
          requested: [],
          granted: deployment.permissionGrants,
        },
      };
    }
    if (installation === undefined) {
      return new DiagnosticError(
        runtimeDiagnostic({
          code: "DEPLOYMENT_INSTALLATION_MISSING",
          message: "Deployment does not reference an installed artifact",
          source: { kind: "deployment", id: deploymentKey(deployment) },
          details: {
            artifactDigest: deployment.artifactDigest,
            pluginId: deployment.pluginId,
            version: deployment.version,
          },
          observedAt: this.#options.clock.now().toISOString(),
        }),
      );
    }

    let artifact: ValidatedPluginArtifact;
    if (deployment.state === "active") {
      try {
        artifact = await this.#options.artifactGate.validate({
          digest: deployment.artifactDigest,
        });
      } catch (error) {
        if (error instanceof DiagnosticError) return error;
        return new DiagnosticError(
          runtimeDiagnostic({
            code: "ARTIFACT_VALIDATION_FAILED",
            message: "Deployment artifact validation failed",
            source: { kind: "artifact", id: deployment.artifactDigest },
            cause: serializeCause(error),
            observedAt: this.#options.clock.now().toISOString(),
          }),
        );
      }
    } else {
      artifact = {
        digest: installation.digest,
        files: { schemaVersion: "1.0", files: [] },
        manifest: installation.manifest,
        ...(installation.signature === undefined ? {} : { signature: installation.signature }),
      };
      if (
        !(await this.#persistResolvedBindings(
          deployment,
          installation.manifest.capabilities.requires,
          [],
          persistedCapabilityBindings,
        ))
      ) {
        return capabilityBindingConflict;
      }
      return {
        artifact,
        capabilityResolution: {
          ok: true,
          diagnostics: [],
          providerLossActions: [],
          bindings: [],
          order: [],
        },
        permissionDecision: {
          allowed: true,
          diagnostics: [],
          requested: installation.manifest.permissions,
          granted: deployment.permissionGrants,
        },
      };
    }

    const capabilityDeployments: CapabilityResolutionDeployment[] = [];
    for (const candidate of deployments) {
      const candidateInstallation =
        candidate.pluginId === deployment.pluginId
          ? installation
          : installations.find(
              (installed) =>
                installed.pluginId === candidate.pluginId &&
                installed.version === candidate.version &&
                installed.digest === candidate.artifactDigest,
            );
      if (candidateInstallation === undefined) continue;
      const candidateInstances = instances.filter(
        (instance) =>
          instance.applicationId === candidate.applicationId &&
          instance.pluginId === candidate.pluginId &&
          instance.deploymentGeneration === candidate.generation,
      );
      capabilityDeployments.push({
        identity: {
          applicationId: candidate.applicationId,
          pluginId: candidate.pluginId,
        },
        ready:
          candidate.state === "active" &&
          candidateInstallation.manifest.components.every((component) =>
            candidateInstances.some(
              (instance) =>
                instance.componentId === component.componentId && this.#isReadyAndLive(instance),
            ),
          ),
        provides: candidateInstallation.manifest.capabilities.provides,
        requires: candidateInstallation.manifest.capabilities.requires,
        bindings: candidate.capabilityBindings,
      });
    }
    const previousByRequirement = new Map<string, PreviousCapabilityBinding>();
    for (const record of persistedCapabilityBindings) {
      const candidate = deployments.find(
        (desired) =>
          desired.applicationId === record.value.consumer.applicationId &&
          desired.pluginId === record.value.consumer.pluginId,
      );
      if (candidate?.generation !== record.value.deploymentGeneration) continue;
      previousByRequirement.set(
        `${record.value.consumer.applicationId}/${record.value.consumer.pluginId}/${record.value.capability}`,
        {
          consumer: record.value.consumer,
          capability: record.value.capability,
          provider: record.value.provider,
        },
      );
    }
    for (const candidate of deployments) {
      for (const [capability, provider] of Object.entries(candidate.capabilityBindings)) {
        const consumer = {
          applicationId: candidate.applicationId,
          pluginId: candidate.pluginId,
        };
        const name = parseCapabilityName(capability);
        previousByRequirement.set(`${candidate.applicationId}/${candidate.pluginId}/${name}`, {
          consumer,
          capability: name,
          provider,
        });
      }
    }
    const previousBindings = [...previousByRequirement.values()].sort((left, right) => {
      const leftKey = capabilityBindingKey(left.consumer, left.capability).id;
      const rightKey = capabilityBindingKey(right.consumer, right.capability).id;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const globalCapabilityResolution = resolveCapabilities({
      deployments: capabilityDeployments,
      previousBindings,
    });
    const matchesDeployment = (identity: {
      readonly applicationId: string;
      readonly pluginId: string;
    }): boolean =>
      identity.applicationId === deployment.applicationId &&
      identity.pluginId === deployment.pluginId;
    const diagnostics = globalCapabilityResolution.diagnostics.filter(
      (diagnostic) =>
        (diagnostic.consumer !== null && matchesDeployment(diagnostic.consumer)) ||
        (diagnostic.consumer === null &&
          diagnostic.candidates.some((candidate) => matchesDeployment(candidate))),
    );
    const capabilityResolution = {
      ok: diagnostics.length === 0,
      diagnostics,
      providerLossActions: globalCapabilityResolution.providerLossActions.filter((decision) =>
        matchesDeployment(decision.consumer),
      ),
      ...(globalCapabilityResolution.bindings === undefined
        ? {}
        : {
            bindings: globalCapabilityResolution.bindings.filter((binding) =>
              matchesDeployment(binding.consumer),
            ),
          }),
      ...(globalCapabilityResolution.order === undefined
        ? {}
        : { order: globalCapabilityResolution.order }),
    };
    if (
      !(await this.#persistResolvedBindings(
        deployment,
        artifact.manifest.capabilities.requires,
        capabilityResolution.bindings ?? [],
        persistedCapabilityBindings,
      ))
    ) {
      return capabilityBindingConflict;
    }
    const permissionDecision = validatePermissionGrant(
      artifact.manifest.permissions,
      deployment.permissionGrants,
    );
    return { artifact, capabilityResolution, permissionDecision };
  }

  async #persistResolvedBindings(
    deployment: PluginDeployment,
    requirements: readonly { readonly name: string }[],
    resolvedBindings: readonly ResolvedCapabilityBinding[],
    loadedBindings: readonly LoadedCapabilityBinding[],
  ): Promise<boolean> {
    if (this.#options.loadDeployments !== undefined) return true;
    const consumer = {
      applicationId: deployment.applicationId,
      pluginId: deployment.pluginId,
    };
    const requirementNames = new Set(requirements.map((requirement) => requirement.name));
    const resolvedByCapability = new Map<
      CapabilityName,
      ResolvedCapabilityBinding & {
        readonly provider: NonNullable<ResolvedCapabilityBinding["provider"]>;
      }
    >();
    for (const binding of resolvedBindings) {
      if (binding.provider !== null) {
        resolvedByCapability.set(binding.requirement.name, {
          ...binding,
          provider: binding.provider,
        });
      }
    }
    const currentByCapability = new Map(
      loadedBindings
        .filter(
          (record) =>
            record.value.consumer.applicationId === consumer.applicationId &&
            record.value.consumer.pluginId === consumer.pluginId,
        )
        .map((record) => [record.value.capability, record] as const),
    );
    const mutations: Array<
      | {
          readonly kind: "delete";
          readonly key: StateKey<PersistedCapabilityBinding>;
          readonly expectedRevision: Revision;
        }
      | {
          readonly kind: "put";
          readonly key: StateKey<PersistedCapabilityBinding>;
          readonly value: PersistedCapabilityBinding;
          readonly expectedRevision: Revision | "absent";
        }
    > = [];
    const updatedAt = this.#options.clock.now().toISOString();

    for (const [capability, current] of currentByCapability) {
      const resolved = resolvedByCapability.get(capability);
      const stale =
        current.value.deploymentGeneration !== deployment.generation ||
        !requirementNames.has(capability);
      if (resolved === undefined) {
        if (stale) {
          mutations.push({
            kind: "delete",
            key: current.key,
            expectedRevision: current.revision,
          });
        }
        continue;
      }
      const source = Object.hasOwn(deployment.capabilityBindings, capability)
        ? "explicit"
        : "automatic";
      const value: PersistedCapabilityBinding = {
        consumer,
        capability: resolved.requirement.name,
        provider: resolved.provider.deployment,
        source,
        deploymentGeneration: deployment.generation,
        updatedAt,
      };
      if (
        !stale &&
        current.value.provider.applicationId === value.provider.applicationId &&
        current.value.provider.pluginId === value.provider.pluginId &&
        current.value.source === value.source
      ) {
        resolvedByCapability.delete(capability);
        continue;
      }
      mutations.push({
        kind: "put",
        key: capabilityBindingKey(consumer, resolved.requirement.name),
        value,
        expectedRevision: current.revision,
      });
      resolvedByCapability.delete(capability);
    }

    for (const [capability, resolved] of resolvedByCapability) {
      const source = Object.hasOwn(deployment.capabilityBindings, capability)
        ? "explicit"
        : "automatic";
      mutations.push({
        kind: "put",
        key: capabilityBindingKey(consumer, resolved.requirement.name),
        value: {
          consumer,
          capability: resolved.requirement.name,
          provider: resolved.provider.deployment,
          source,
          deploymentGeneration: deployment.generation,
          updatedAt,
        },
        expectedRevision: "absent",
      });
    }
    if (mutations.length === 0) return true;
    mutations.sort((left, right) =>
      left.key.id < right.key.id ? -1 : left.key.id > right.key.id ? 1 : 0,
    );
    try {
      const committed = await this.#options.state.transact(
        this.#transactionOptions(),
        async (transaction) => {
          const currentDeployment = await transaction.get(deploymentStateKey(deployment));
          if (
            currentDeployment === undefined ||
            parsePluginDeployment(currentDeployment.value).generation !== deployment.generation
          ) {
            return false;
          }
          for (const mutation of mutations) {
            if (mutation.kind === "delete") {
              await transaction.delete(mutation.key, {
                expectedRevision: mutation.expectedRevision,
              });
            } else {
              await transaction.put(mutation.key, mutation.value, {
                expectedRevision: mutation.expectedRevision,
              });
            }
          }
          return true;
        },
      );
      if (!committed) {
        this.#replanCount += 1;
        return false;
      }
      this.#lastCommitAuthority = this.#options.authority;
      return true;
    } catch (error) {
      if (conflictCode(error) !== "STATE_REVISION_CONFLICT") throw error;
      this.#replanCount += 1;
      return false;
    }
  }

  async #recordBlocked(
    deployment: PluginDeployment,
    diagnostics: readonly RuntimeDiagnostic[],
  ): Promise<void> {
    this.#diagnosticsByDeployment.set(deploymentKey(deployment), diagnostics);
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    const status: DeploymentObservation["status"] = codes.some((code) =>
      code.includes("INCONSISTENT"),
    )
      ? "inconsistent"
      : codes.some(
            (code) =>
              code.includes("UNAVAILABLE") ||
              code === "DEPLOYMENT_INSTALLATION_MISSING" ||
              code === "DEPLOYMENT_EXECUTOR_UNAVAILABLE",
          )
        ? "unavailable"
        : "blocked";
    await this.#recordObservation(deployment, status, diagnostics);
  }

  async #recordObservation(
    deployment: PluginDeployment,
    status: DeploymentObservation["status"],
    diagnostics: readonly RuntimeDiagnostic[],
  ): Promise<void> {
    const key = observationKey(deployment);
    const current = await this.#options.state.read(key);
    if (
      current?.value.applicationId === deployment.applicationId &&
      current.value.pluginId === deployment.pluginId &&
      current.value.generation === deployment.generation &&
      current.value.status === status &&
      observationDiagnosticsFingerprint(current.value.diagnostics) ===
        observationDiagnosticsFingerprint(diagnostics)
    ) {
      return;
    }
    await this.#options.state.transact(this.#transactionOptions(), async (transaction) => {
      await transaction.put(
        key,
        {
          applicationId: deployment.applicationId,
          pluginId: deployment.pluginId,
          generation: deployment.generation,
          status,
          diagnostics,
          updatedAt: this.#options.clock.now().toISOString(),
        },
        { expectedRevision: current?.revision ?? "absent" },
      );
      return null;
    });
  }

  async #persistStep(deployment: PluginDeployment, step: ReconcilePlanStep): Promise<void> {
    if (!this.#running) return;
    const desired = (await this.#loadDeployments()).find(
      (candidate) =>
        candidate.applicationId === deployment.applicationId &&
        candidate.pluginId === deployment.pluginId,
    );
    if (
      desired === undefined ||
      desired.generation !== deployment.generation ||
      desired.state !== deployment.state ||
      desired.artifactDigest !== deployment.artifactDigest
    ) {
      this.#replanCount += 1;
      return;
    }
    const key = instanceKey(step.instanceId);
    const current = await this.#options.state.read(key);
    if (
      (step.expectedRevision === "absent" && current !== undefined) ||
      (step.expectedRevision !== "absent" && current?.revision !== step.expectedRevision)
    ) {
      this.#replanCount += 1;
      return;
    }
    let instance: PersistedComponentInstance;
    if (current === undefined) {
      instance = {
        instanceId: step.instanceId,
        applicationId: step.effect.applicationId,
        pluginId: step.effect.pluginId,
        componentId: step.effect.componentId,
        deploymentGeneration: step.effect.deploymentGeneration,
        observedGeneration: step.effect.deploymentGeneration,
        lifecycle: "created",
        executor: step.effect.executor,
        artifactDigest: step.effect.artifactDigest,
        ...(step.effect.workerId === undefined ? {} : { workerId: step.effect.workerId }),
      };
    } else {
      instance = current.value;
      if (
        step.effect.kind === "prepare" &&
        (instance.lifecycle === "created" || instance.lifecycle === "failed")
      ) {
        const { workerId: _workerId, ...stable } = instance;
        void _workerId;
        instance = {
          ...stable,
          artifactDigest: step.effect.artifactDigest,
          executor: step.effect.executor,
          ...(step.effect.workerId === undefined ? {} : { workerId: step.effect.workerId }),
        };
      }
      const next = this.#preEffectLifecycle(step.effect.kind, instance);
      if (next !== instance.lifecycle) instance = { ...instance, lifecycle: next };
    }
    const now = this.#options.clock.now().toISOString();
    if (!this.#running) return;
    try {
      await this.#options.state.transact(this.#transactionOptions(), async (transaction) => {
        await transaction.put(key, instance, {
          expectedRevision: current?.revision ?? "absent",
        });
        await transaction.appendOperation({
          operationId: step.operationId,
          kind: "component.lifecycle",
          status: "planned",
          state: step.effect,
          updatedAt: now,
        });
        await transaction.enqueueOutbox({
          messageId: step.messageId,
          operationId: step.operationId,
          topic: "component.lifecycle",
          payload: step.effect,
          createdAt: now,
          availableAt: now,
        });
        return null;
      });
    } catch (error) {
      const code = conflictCode(error);
      if (code !== "STATE_REVISION_CONFLICT" && code !== "STATE_IDEMPOTENCY_CONFLICT") throw error;
      if (code === "STATE_REVISION_CONFLICT") this.#replanCount += 1;
    }
    void deployment;
  }

  #preEffectLifecycle(
    kind: ReconcileEffectKind,
    instance: PersistedComponentInstance,
  ): PersistedComponentInstance["lifecycle"] {
    if (kind === "start") {
      if (instance.lifecycle === "starting") return "starting";
      return transitionComponentLifecycle({
        pluginId: instance.pluginId,
        componentId: instance.componentId,
        current: instance.lifecycle,
        next: "starting",
        observedAt: this.#options.clock.now().toISOString(),
      });
    }
    if (kind === "drain") {
      if (instance.lifecycle === "draining") return "draining";
      return transitionComponentLifecycle({
        pluginId: instance.pluginId,
        componentId: instance.componentId,
        current: instance.lifecycle,
        next: "draining",
        observedAt: this.#options.clock.now().toISOString(),
      });
    }
    if (kind === "stop") {
      if (instance.lifecycle === "stopping") return "stopping";
      return transitionComponentLifecycle({
        pluginId: instance.pluginId,
        componentId: instance.componentId,
        current: instance.lifecycle,
        next: "stopping",
        observedAt: this.#options.clock.now().toISOString(),
      });
    }
    return instance.lifecycle;
  }

  async #executeClaim(claim: OutboxClaim): Promise<undefined | typeof capabilityBindingConflict> {
    if (!this.#running) return;
    let effect: ReconcileEffect;
    try {
      effect = parseReconcileEffect(claim);
    } catch (error) {
      await this.#rejectInvalidClaim(claim, error);
      return;
    }
    const canonical = reconcileEffectIdentities(
      {
        applicationId: effect.applicationId,
        generation: effect.deploymentGeneration,
        pluginId: effect.pluginId,
      },
      effect.componentId,
      effect.kind,
    );
    if (
      effect.instanceId !== canonical.instanceId ||
      effect.operationId !== canonical.operationId ||
      effect.messageId !== canonical.messageId
    ) {
      await this.#rejectInvalidClaim(
        claim,
        new TypeError("Lifecycle effect identity is not canonical for its deployment tuple"),
      );
      return;
    }
    const current = await this.#options.state.read(instanceKey(effect.instanceId));
    if (current === undefined) {
      this.#replanCount += 1;
      await this.#acknowledge(claim, "completed");
      return;
    }
    const instance = current.value;
    if (
      instance.instanceId !== effect.instanceId ||
      instance.applicationId !== effect.applicationId ||
      instance.pluginId !== effect.pluginId ||
      instance.componentId !== effect.componentId ||
      instance.deploymentGeneration !== effect.deploymentGeneration ||
      instance.observedGeneration !== effect.deploymentGeneration ||
      instance.artifactDigest !== effect.artifactDigest ||
      instance.executor !== effect.executor ||
      instance.workerId !== effect.workerId
    ) {
      await this.#rejectInvalidClaim(
        claim,
        new TypeError("Lifecycle effect tuple does not match its persisted component instance"),
      );
      return;
    }
    if (
      instance.completedOperationId === effect.operationId ||
      instance.completedOperationIds?.includes(effect.operationId)
    ) {
      await this.#acknowledge(claim, "completed");
      return;
    }
    const deployments = await this.#loadDeployments();
    const desired = deployments.find(
      (candidate) =>
        candidate.applicationId === effect.applicationId && candidate.pluginId === effect.pluginId,
    );
    const [installations, loadedInstances] = await Promise.all([
      this.#loadInstallations(),
      this.#loadInstances(),
    ]);
    const instances = loadedInstances
      .filter((record) => isInstanceContextConsistent(record, deployments))
      .map((record) => record.value);
    let currentGate:
      | ArtifactDeploymentGate
      | DiagnosticError
      | typeof capabilityBindingConflict
      | undefined;
    if (desired !== undefined) {
      currentGate = await this.#gateDeployment(desired, deployments, installations, instances);
    }
    if (!this.#running) return;
    if (currentGate === capabilityBindingConflict) return capabilityBindingConflict;
    if (effect.kind === "prepare" || effect.kind === "start") {
      if (
        desired === undefined ||
        desired.state !== "active" ||
        desired.generation !== effect.deploymentGeneration ||
        desired.artifactDigest !== effect.artifactDigest
      ) {
        this.#replanCount += 1;
        await this.#acknowledge(claim, "completed");
        return;
      }
      if (currentGate === undefined) {
        this.#replanCount += 1;
        await this.#acknowledge(claim, "completed");
        return;
      }
      if (
        currentGate instanceof DiagnosticError ||
        !currentGate.capabilityResolution.ok ||
        !currentGate.permissionDecision.allowed
      ) {
        this.#replanCount += 1;
        const diagnostics =
          currentGate instanceof DiagnosticError
            ? [currentGate.diagnostic]
            : [
                ...currentGate.capabilityResolution.diagnostics,
                ...currentGate.permissionDecision.diagnostics,
              ].map((diagnostic) =>
                runtimeDiagnostic({
                  code: diagnostic.code as `CAPABILITY_${string}` | `PERMISSION_${string}`,
                  message: diagnostic.message,
                  source: { kind: "deployment", id: deploymentKey(desired) },
                  details: diagnostic,
                  observedAt: this.#options.clock.now().toISOString(),
                }),
              );
        await this.#recordBlocked(desired, diagnostics);
        await this.#retryClaim(claim);
        return;
      }
    } else if (
      desired !== undefined &&
      desired.state === "active" &&
      desired.generation === effect.deploymentGeneration &&
      desired.artifactDigest === effect.artifactDigest
    ) {
      this.#replanCount += 1;
      await this.#acknowledge(claim, "completed");
      return;
    }
    if (
      (effect.kind === "prepare" || effect.kind === "start") &&
      currentGate !== undefined &&
      !(currentGate instanceof DiagnosticError)
    ) {
      const component = currentGate.artifact.manifest.components.find(
        (candidate) => candidate.componentId === effect.componentId,
      );
      if (component === undefined) {
        this.#replanCount += 1;
        await this.#acknowledge(claim, "completed");
        return;
      }
      if (component !== undefined) {
        const eligible = placementIsEligible(
          {
            artifactDigest: effect.artifactDigest,
            component,
            grantedPermissions: currentGate.permissionDecision.granted ?? [],
            supportedExecutors: this.#options.effects.supportedExecutors,
            ...(this.#options.workers === undefined ? {} : { workers: this.#options.workers }),
          },
          {
            executor: effect.executor,
            ...(effect.workerId === undefined ? {} : { workerId: effect.workerId }),
          },
        );
        if (!eligible) {
          this.#replanCount += 1;
          await this.#retryClaim(claim);
          return;
        }
      }
    }
    const expectedLifecycle: PersistedComponentInstance["lifecycle"] =
      effect.kind === "prepare"
        ? "created"
        : effect.kind === "start"
          ? "starting"
          : effect.kind === "drain"
            ? "draining"
            : "stopping";
    const retryableFailure =
      instance.lifecycle === "failed" &&
      instance.retryEffect === effect.kind &&
      (instance.retryAt === undefined ||
        instance.retryAt <= this.#options.clock.now().toISOString());
    if (instance.lifecycle !== expectedLifecycle && !retryableFailure) {
      this.#replanCount += 1;
      await this.#acknowledge(claim, "completed");
      return;
    }
    const retryPreState =
      retryableFailure && (effect.kind === "start" || effect.kind === "stop")
        ? expectedLifecycle
        : undefined;
    if (!this.#running) return;
    try {
      await this.#options.state.transact(this.#transactionOptions(), async (transaction) => {
        if (retryPreState !== undefined) {
          await transaction.put(
            instanceKey(effect.instanceId),
            {
              ...instance,
              lifecycle: retryPreState,
            },
            { expectedRevision: current.revision },
          );
        }
        await transaction.appendOperation({
          operationId: effect.operationId,
          kind: "component.lifecycle",
          status: "executing",
          state: effect,
          updatedAt: this.#options.clock.now().toISOString(),
        });
        return null;
      });
      if (retryPreState !== undefined) this.#lastCommitAuthority = this.#options.authority;
    } catch (error) {
      if (conflictCode(error) !== "STATE_REVISION_CONFLICT") throw error;
      this.#replanCount += 1;
      const latest = await this.#options.state.read(instanceKey(effect.instanceId));
      if (
        latest?.value.completedOperationId === effect.operationId ||
        latest?.value.completedOperationIds?.includes(effect.operationId)
      ) {
        await this.#acknowledge(claim, "completed");
      } else {
        await this.#retryClaim(claim);
      }
      return;
    }
    if (!this.#running) return;
    try {
      await this.#options.effects.perform(effect);
    } catch (error) {
      await this.#commitFailedEffect(effect, claim, error);
      return;
    }
    if (this.#options.interruptAfterEffect && !this.#interrupted) {
      this.#interrupted = true;
      return;
    }
    await this.#commitEffect(effect, claim, "completed");
  }

  async #commitEffect(
    effect: ReconcileEffect,
    claim: OutboxClaim,
    outcome: "completed",
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const key = instanceKey(effect.instanceId);
      const current = await this.#options.state.read(key);
      if (current === undefined) return;
      const lifecycle = this.#successfulLifecycle(effect.kind, current.value);
      try {
        await this.#options.state.transact(this.#transactionOptions(), async (transaction) => {
          const {
            attempt: _attempt,
            diagnostic: _diagnostic,
            retryAt: _retryAt,
            retryEffect: _retryEffect,
            ...stable
          } = current.value;
          void _attempt;
          void _diagnostic;
          void _retryAt;
          void _retryEffect;
          const completedOperationIds = [
            ...(current.value.completedOperationIds ?? []),
            effect.operationId,
          ].filter((operationId, index, all) => all.indexOf(operationId) === index);
          await transaction.put(
            key,
            {
              ...stable,
              lifecycle,
              observedGeneration: effect.deploymentGeneration,
              completedOperationId: effect.operationId,
              completedOperationIds,
            },
            { expectedRevision: current.revision },
          );
          await transaction.appendOperation({
            operationId: effect.operationId,
            kind: "component.lifecycle",
            status: "completed",
            state: {
              effect,
              lifecycle,
            },
            updatedAt: this.#options.clock.now().toISOString(),
          });
          return null;
        });
        this.#lastCommitAuthority = this.#options.authority;
        await this.#acknowledge(claim, outcome);
        return;
      } catch (error) {
        if (conflictCode(error) !== "STATE_REVISION_CONFLICT") throw error;
        this.#replanCount += 1;
      }
    }
  }

  #successfulLifecycle(
    kind: ReconcileEffectKind,
    instance: PersistedComponentInstance,
  ): PersistedComponentInstance["lifecycle"] {
    const next =
      kind === "prepare"
        ? "preparing"
        : kind === "start"
          ? "ready"
          : kind === "stop"
            ? "stopped"
            : "draining";
    if (instance.lifecycle === next) return next;
    return transitionComponentLifecycle({
      pluginId: instance.pluginId,
      componentId: instance.componentId,
      current: instance.lifecycle,
      next,
      observedAt: this.#options.clock.now().toISOString(),
    });
  }

  async #commitFailedEffect(
    effect: ReconcileEffect,
    claim: OutboxClaim,
    error: unknown,
  ): Promise<void> {
    const key = instanceKey(effect.instanceId);
    const observedAt = this.#options.clock.now().toISOString();
    const diagnostic = effectDiagnostic(effect, error, observedAt);
    const retryDelay = deterministicRetryDelay({
      attempt: claim.attempt,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      operationId: effect.operationId,
    });
    const retryAt = new Date(this.#options.clock.now().getTime() + retryDelay).toISOString();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.#options.state.read(key);
      if (current === undefined) return;
      try {
        await this.#options.state.transact(this.#transactionOptions(), async (transaction) => {
          const lifecycle =
            current.value.lifecycle === "failed"
              ? "failed"
              : transitionComponentLifecycle({
                  pluginId: current.value.pluginId,
                  componentId: current.value.componentId,
                  current: current.value.lifecycle,
                  next: "failed",
                  observedAt,
                });
          await transaction.put(
            key,
            {
              ...current.value,
              lifecycle,
              attempt: claim.attempt,
              retryAt,
              retryEffect: effect.kind,
              diagnostic,
            },
            { expectedRevision: current.revision },
          );
          await transaction.appendOperation({
            operationId: effect.operationId,
            kind: "component.lifecycle",
            status: "failed",
            state: { diagnostic, effect, retryAt },
            updatedAt: observedAt,
          });
          return null;
        });
        this.#lastCommitAuthority = this.#options.authority;
        const deployment = this.#deployments.find(
          (candidate) =>
            candidate.applicationId === effect.applicationId &&
            candidate.pluginId === effect.pluginId,
        );
        this.#diagnosticsByDeployment.set(
          deployment === undefined ? `unknown/${effect.pluginId}` : deploymentKey(deployment),
          [diagnostic],
        );
        await this.#options.state.acknowledgeOutbox({
          messageId: claim.message.messageId,
          owner: claim.owner,
          claimEpoch: claim.claimEpoch,
          outcome: "retry",
          retryAt,
          ...(this.#options.authority === undefined ? {} : { fencing: this.#options.authority }),
        });
        return;
      } catch (commitError) {
        if (conflictCode(commitError) !== "STATE_REVISION_CONFLICT") throw commitError;
        this.#replanCount += 1;
      }
    }
  }

  async #refreshReadiness(): Promise<void> {
    const instances = (await this.#loadInstances())
      .filter((record) => isInstanceContextConsistent(record, this.#deployments))
      .map((record) => record.value);
    for (const deployment of this.#deployments) {
      const allDeploymentInstances = instances.filter(
        (instance) =>
          instance.applicationId === deployment.applicationId &&
          instance.pluginId === deployment.pluginId,
      );
      const deploymentInstances = allDeploymentInstances.filter(
        (instance) =>
          deployment.state === "disabled" ||
          instance.deploymentGeneration === deployment.generation,
      );
      const failedDiagnostics = allDeploymentInstances.flatMap((instance) =>
        instance.diagnostic === undefined ? [] : [instance.diagnostic],
      );
      if (failedDiagnostics.length > 0) {
        this.#diagnosticsByDeployment.set(deploymentKey(deployment), failedDiagnostics);
        await this.#recordObservation(deployment, "failed", failedDiagnostics);
      }
      if (deployment.state !== "active") continue;
      const existingDiagnostics = this.#diagnosticsByDeployment.get(deploymentKey(deployment));
      if (
        existingDiagnostics?.some(
          (diagnostic) =>
            diagnostic.code.startsWith("ARTIFACT_") ||
            diagnostic.code.startsWith("CAPABILITY_") ||
            diagnostic.code.startsWith("DEPLOYMENT_") ||
            diagnostic.code.startsWith("PERMISSION_"),
        )
      ) {
        continue;
      }
      if (failedDiagnostics.length > 0) continue;
      const installation = (await this.#loadInstallations()).find(
        (candidate) =>
          candidate.pluginId === deployment.pluginId &&
          candidate.digest === deployment.artifactDigest,
      );
      if (installation === undefined) continue;
      const ready = installation.manifest.components.every((component) =>
        deploymentInstances.some(
          (instance) =>
            instance.componentId === component.componentId && this.#isReadyAndLive(instance),
        ),
      );
      if (ready) {
        this.#readyDeployments.add(deploymentKey(deployment));
        this.#diagnosticsByDeployment.delete(deploymentKey(deployment));
        await this.#recordObservation(deployment, "ready", []);
      } else if (
        failedDiagnostics.length === 0 &&
        deploymentInstances.some((instance) => instance.lifecycle === "degraded")
      ) {
        await this.#recordObservation(deployment, "degraded", []);
      } else if (failedDiagnostics.length === 0) {
        await this.#recordObservation(deployment, "converging", []);
      }
    }
  }

  #needsImmediateReconcile(instance: PersistedComponentInstance): boolean {
    if (
      instance.diagnostic?.code === "LIFECYCLE_RESTORE_FAILED" &&
      instance.retryAt !== undefined &&
      instance.retryAt > this.#options.clock.now().toISOString()
    ) {
      return false;
    }
    if (
      instance.lifecycle === "created" ||
      instance.lifecycle === "preparing" ||
      instance.lifecycle === "starting" ||
      instance.lifecycle === "draining" ||
      instance.lifecycle === "stopping"
    ) {
      return true;
    }
    return (
      instance.lifecycle === "failed" &&
      instance.retryEffect !== undefined &&
      (instance.retryAt === undefined ||
        instance.retryAt <= this.#options.clock.now().toISOString())
    );
  }

  #isDeploymentPlanningBlocked(instance: PersistedComponentInstance): boolean {
    return (
      this.#diagnosticsByDeployment
        .get(`${instance.applicationId}/${instance.pluginId}`)
        ?.some(
          (diagnostic) =>
            diagnostic.code.startsWith("ARTIFACT_") ||
            diagnostic.code.startsWith("CAPABILITY_") ||
            diagnostic.code.startsWith("DEPLOYMENT_") ||
            diagnostic.code.startsWith("PERMISSION_"),
        ) ?? false
    );
  }

  #deferRetries(instances: readonly LoadedComponentInstance[]): void {
    const now = this.#options.clock.now().getTime();
    for (const { value } of instances) {
      if (
        value.retryAt === undefined ||
        (value.diagnostic?.code !== "LIFECYCLE_RESTORE_FAILED" &&
          (value.lifecycle !== "failed" || value.retryEffect === undefined))
      ) {
        continue;
      }
      const retryAt = Date.parse(value.retryAt);
      if (Number.isFinite(retryAt) && retryAt > now) this.#deferUntil(retryAt);
    }
  }

  #deferUntil(at: number): void {
    if (!this.#running || !Number.isFinite(at)) return;
    this.#nextWakeAt = this.#nextWakeAt === undefined ? at : Math.min(this.#nextWakeAt, at);
  }

  #armDeferredWake(): void {
    const at = this.#nextWakeAt;
    if (!this.#running || at === undefined) return;
    if (this.#deferredWake !== undefined && this.#deferredWake.at <= at) return;
    this.#cancelDeferredWake();
    const controller = new AbortController();
    const delay = Math.max(0, at - this.#options.clock.now().getTime());
    const promise = this.#options.clock
      .sleep(delay, controller.signal)
      .then(async () => {
        if (
          controller.signal.aborted ||
          !this.#running ||
          this.#deferredWake?.controller !== controller
        ) {
          return;
        }
        this.#deferredWake = undefined;
        if (this.#options.clock.now().getTime() < at) return;
        await this.wake();
      })
      .catch(async (error: unknown) => {
        if (controller.signal.aborted) return;
        if (this.#deferredWake?.controller === controller) this.#deferredWake = undefined;
        let failure = error;
        if (this.#running) {
          this.#running = false;
          this.#cancelDeferredWake();
          try {
            await this.#componentLifecycle?.close(this.#options.authority);
          } catch (closeError) {
            failure = new AggregateError(
              [error, closeError],
              "Reconciler background failure cleanup failed",
            );
          }
        }
        await this.#reportFatalFailure(failure);
      });
    this.#deferredWake = { at, controller, promise };
  }

  #cancelDeferredWake(): void {
    const deferred = this.#deferredWake;
    if (deferred === undefined) return;
    this.#deferredWake = undefined;
    deferred.controller.abort("reconciler-deferred-wake-cancelled");
  }

  async #reportFatalFailure(error: unknown): Promise<void> {
    if (this.#fatalReported) return;
    this.#fatalReported = true;
    this.#fatalError = error;
    this.#fatalDiagnostic =
      error instanceof DiagnosticError
        ? error.diagnostic
        : runtimeDiagnostic({
            code: "LIFECYCLE_RECONCILE_BACKGROUND_FAILED",
            message: "Background reconciliation failed",
            source: { kind: "runtime", id: this.#owner },
            cause: serializeCause(error),
            observedAt: this.#options.clock.now().toISOString(),
          });
    if (this.#starting) return;
    try {
      await this.#options.onBackgroundError?.(error);
    } catch {
      // The reconciler is already failed closed; error reporting must not resurrect it.
    }
  }

  #transactionOptions(): {
    readonly fencing?: RuntimeAuthority;
  } {
    return this.#options.authority === undefined ? {} : { fencing: this.#options.authority };
  }

  async #acknowledge(claim: OutboxClaim, outcome: "completed"): Promise<void> {
    await this.#options.state.acknowledgeOutbox({
      messageId: claim.message.messageId,
      owner: claim.owner,
      claimEpoch: claim.claimEpoch,
      outcome,
      ...(this.#options.authority === undefined ? {} : { fencing: this.#options.authority }),
    });
  }

  async #rejectInvalidClaim(claim: OutboxClaim, error: unknown): Promise<void> {
    const observedAt = this.#options.clock.now().toISOString();
    const diagnostic = invalidMessageDiagnostic(claim, error, observedAt);
    this.#diagnosticsByDeployment.set(`outbox/${claim.message.messageId}`, [diagnostic]);
    await this.#options.state.transact(this.#transactionOptions(), async (transaction) => {
      await transaction.appendOperation({
        operationId: claim.message.operationId,
        kind: "component.lifecycle",
        status: "failed",
        state: { diagnostic },
        updatedAt: observedAt,
      });
      return null;
    });
    await this.#retryClaim(claim);
  }

  async #retryClaim(claim: OutboxClaim): Promise<void> {
    const retryAt = this.#options.clock.now().getTime() + 60_000;
    await this.#options.state.acknowledgeOutbox({
      messageId: claim.message.messageId,
      owner: claim.owner,
      claimEpoch: claim.claimEpoch,
      outcome: "retry",
      retryAt: new Date(retryAt).toISOString(),
      ...(this.#options.authority === undefined ? {} : { fencing: this.#options.authority }),
    });
    this.#deferUntil(retryAt);
  }
}
