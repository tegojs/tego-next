import {
  DiagnosticError,
  diagnosticCode,
  parseApplicationId,
  parseArtifactDigest,
  parseCapabilityName,
  parseComponentId,
  parseGeneration,
  parseMessageId,
  parseOperationId,
  parsePluginId,
  parsePluginDeployment,
  parsePluginInstallation,
  runtimeDiagnostic,
  serializeCause,
  type ArtifactDigest,
  type ApplicationId,
  type Clock,
  type ExecutorKind,
  type JsonObject,
  type OperationId,
  type OutboxClaim,
  type PluginDeployment,
  type PluginInstallation,
  type RuntimeAuthority,
  type RuntimeDiagnostic,
  type StateKey,
  type StateStore,
} from "@tegojs/contracts";
import type {
  ArtifactService,
  ValidatedPluginArtifact,
  ValidateArtifactRequest,
} from "../artifacts/artifact-service.js";
import {
  resolveCapabilities,
  type CapabilityResolutionDeployment,
  type PreviousCapabilityBinding,
} from "../capabilities/resolver.js";
import { validatePermissionGrant } from "../permissions/permission-set.js";
import { transitionComponentLifecycle } from "./component-lifecycle.js";
import {
  planReconcile,
  reconcileEffectIdentities,
  type ArtifactDeploymentGate,
  type ComponentInstance,
  type ReconcileEffect,
  type ReconcileEffectKind,
  type ReconcilePlanStep,
} from "./plan.js";
import type { PlacementWorker } from "./placement.js";
import { planPlacement } from "./placement.js";
import { deterministicRetryDelay } from "./retry.js";

const namespace = "tego";
const claimLeaseMs = 30_000;

export interface ComponentEffectExecutor {
  readonly supportedExecutors: readonly ExecutorKind[];
  perform(effect: ReconcileEffect): Promise<void>;
}

export interface ReconcileArtifactGate {
  validate(request: ValidateArtifactRequest): Promise<ValidatedPluginArtifact>;
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

function deploymentKey(deployment: PluginDeployment): string {
  return `${deployment.applicationId}/${deployment.pluginId}`;
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

function observationKey(deployment: PluginDeployment): StateKey<DeploymentObservation> {
  return {
    namespace,
    collection: "deployment-observations",
    id: deploymentKey(deployment),
  };
}

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
  readonly #diagnosticsByDeployment = new Map<string, readonly RuntimeDiagnostic[]>();
  readonly #readyDeployments = new Set<string>();
  #deployments: readonly PluginDeployment[] = [];
  #running = false;
  #tail: Promise<void> = Promise.resolve();
  #interrupted = false;
  #lastCommitAuthority: RuntimeAuthority | undefined;
  #replanCount = 0;

  constructor(options: ReconcilerOptions) {
    this.#options = options;
    this.#owner = options.owner ?? "reconciler";
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
    await this.wake();
  }

  wake(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    const pass = this.#tail.then(() => this.#reconcilePass());
    this.#tail = pass.catch(() => undefined);
    return pass;
  }

  async stop(): Promise<void> {
    this.#running = false;
    await this.#tail;
  }

  diagnostics(): readonly RuntimeDiagnostic[] {
    return [...this.#diagnosticsByDeployment.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap(([, diagnostics]) => diagnostics);
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

  async #reconcilePass(): Promise<void> {
    if (!this.#running) return;
    let [deployments, installations, loadedInstances] = await Promise.all([
      this.#loadDeployments(),
      this.#loadInstallations(),
      this.#loadInstances(),
    ]);
    this.#deployments = deployments;
    this.#diagnosticsByDeployment.clear();
    this.#readyDeployments.clear();

    const existingClaim = await this.#claimNext();
    if (existingClaim !== undefined) {
      await this.#executeClaim(existingClaim);
      [deployments, installations, loadedInstances] = await Promise.all([
        this.#loadDeployments(),
        this.#loadInstallations(),
        this.#loadInstances(),
      ]);
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
      .filter(isCanonicalInstance)
      .map((record) => record.value);
    const invalidByDeployment = new Map<string, readonly ComponentInstance[]>();
    const gates = new Map<string, ArtifactDeploymentGate | DiagnosticError>();
    const orderRanks = new Map<string, number>();
    for (const deployment of lexicalDeployments) {
      const invalidInstances = loadedInstances
        .filter(
          (record) =>
            record.value.applicationId === deployment.applicationId &&
            record.value.pluginId === deployment.pluginId &&
            !isCanonicalInstance(record),
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
      );
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
              message: "Persisted component instance identity is not canonical",
              source: { kind: "deployment", id: deploymentKey(deployment) },
              details: {
                applicationId: instance.applicationId,
                componentId: instance.componentId,
                deploymentGeneration: instance.deploymentGeneration,
                instanceId: instance.instanceId,
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
        await this.#persistStep(deployment, step);
      }
    }

    if (existingClaim === undefined) {
      const claim = await this.#claimNext();
      if (claim !== undefined) await this.#executeClaim(claim);
    }
    await this.#refreshReadiness();
  }

  async #claimNext(): Promise<OutboxClaim | undefined> {
    const claims = await this.#options.state.claimOutbox({
      owner: this.#owner,
      leaseDurationMs: claimLeaseMs,
      limit: 1,
      topic: "component.lifecycle",
      ...(this.#options.authority === undefined ? {} : { fencing: this.#options.authority }),
    });
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

  async #gateDeployment(
    deployment: PluginDeployment,
    deployments: readonly PluginDeployment[],
    installations: readonly PluginInstallation[],
    instances: readonly ComponentInstance[],
  ): Promise<ArtifactDeploymentGate | DiagnosticError> {
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
                instance.componentId === component.componentId && instance.lifecycle === "ready",
            ),
          ),
        provides: candidateInstallation.manifest.capabilities.provides,
        requires: candidateInstallation.manifest.capabilities.requires,
        bindings: candidate.capabilityBindings,
      });
    }
    const previousBindings: PreviousCapabilityBinding[] = deployments.flatMap((candidate) =>
      Object.entries(candidate.capabilityBindings).map(([capability, provider]) => ({
        consumer: {
          applicationId: candidate.applicationId,
          pluginId: candidate.pluginId,
        },
        capability: parseCapabilityName(capability),
        provider,
      })),
    );
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
    const permissionDecision = validatePermissionGrant(
      artifact.manifest.permissions,
      deployment.permissionGrants,
    );
    return { artifact, capabilityResolution, permissionDecision };
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
      if (conflictCode(error) !== "STATE_REVISION_CONFLICT") throw error;
      this.#replanCount += 1;
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

  async #executeClaim(claim: OutboxClaim): Promise<void> {
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
    const instances = loadedInstances.filter(isCanonicalInstance).map((record) => record.value);
    let currentGate: ArtifactDeploymentGate | DiagnosticError | undefined;
    if (desired !== undefined) {
      currentGate = await this.#gateDeployment(desired, deployments, installations, instances);
    }
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
        const placement = planPlacement({
          component,
          grantedPermissions: currentGate.permissionDecision.granted ?? [],
          supportedExecutors: this.#options.effects.supportedExecutors,
          ...(this.#options.workers === undefined ? {} : { workers: this.#options.workers }),
        });
        if (
          !placement.ok ||
          placement.placement === undefined ||
          placement.placement.executor !== effect.executor ||
          placement.placement.workerId !== effect.workerId
        ) {
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
    if (instance.lifecycle !== expectedLifecycle) {
      this.#replanCount += 1;
      await this.#acknowledge(claim, "completed");
      return;
    }
    await this.#options.state.transact(this.#transactionOptions(), async (transaction) => {
      await transaction.appendOperation({
        operationId: effect.operationId,
        kind: "component.lifecycle",
        status: "executing",
        state: effect,
        updatedAt: this.#options.clock.now().toISOString(),
      });
      return null;
    });
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
      .filter(isCanonicalInstance)
      .map((record) => record.value);
    for (const deployment of this.#deployments) {
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
      const deploymentInstances = instances.filter(
        (instance) =>
          instance.applicationId === deployment.applicationId &&
          instance.pluginId === deployment.pluginId &&
          instance.deploymentGeneration === deployment.generation,
      );
      const failedDiagnostics = deploymentInstances.flatMap((instance) =>
        instance.diagnostic === undefined ? [] : [instance.diagnostic],
      );
      if (failedDiagnostics.length > 0) {
        this.#diagnosticsByDeployment.set(deploymentKey(deployment), failedDiagnostics);
        await this.#recordObservation(deployment, "failed", failedDiagnostics);
      }
      const installation = (await this.#loadInstallations()).find(
        (candidate) =>
          candidate.pluginId === deployment.pluginId &&
          candidate.digest === deployment.artifactDigest,
      );
      if (installation === undefined) continue;
      const ready = installation.manifest.components.every((component) =>
        deploymentInstances.some(
          (instance) =>
            instance.componentId === component.componentId && instance.lifecycle === "ready",
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
    await this.#options.state.acknowledgeOutbox({
      messageId: claim.message.messageId,
      owner: claim.owner,
      claimEpoch: claim.claimEpoch,
      outcome: "retry",
      retryAt: new Date(this.#options.clock.now().getTime() + 60_000).toISOString(),
      ...(this.#options.authority === undefined ? {} : { fencing: this.#options.authority }),
    });
  }
}
