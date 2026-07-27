import { createHash } from "node:crypto";
import {
  type ApplicationId,
  type ArtifactDigest,
  type ComponentId,
  DiagnosticError,
  type ExecutorKind,
  type Generation,
  type JsonObject,
  type MessageId,
  type OperationId,
  type PluginDeployment,
  type PluginId,
  parseMessageId,
  parseOperationId,
  type Revision,
  type RuntimeDiagnostic,
  runtimeDiagnostic,
} from "@tegojs/contracts";
import type { ValidatedPluginArtifact } from "../artifacts/artifact-service.js";
import type { ResolutionResult } from "../capabilities/resolver.js";
import type { PermissionDecision } from "../permissions/permission-set.js";
import type { ComponentLifecycleState } from "./component-lifecycle.js";
import {
  type ComponentPlacement,
  type PlacementDiagnostic,
  type PlacementWorker,
  planPlacement,
} from "./placement.js";

export type ReconcileEffectKind = "drain" | "prepare" | "start" | "stop";
export type Activation = string;

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/u;
const UINT64_MAX = "18446744073709551615";

export function parseActivation(value: unknown): Activation {
  if (
    typeof value !== "string" ||
    !DECIMAL_PATTERN.test(value) ||
    value.length > UINT64_MAX.length ||
    (value.length === UINT64_MAX.length && value > UINT64_MAX)
  ) {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "ACTIVATION_INVALID" as RuntimeDiagnostic["code"],
        message: "Activation is invalid",
        source: { kind: "runtime", id: "activation" },
        details: {
          canonicalFormat: "unsigned decimal string",
          minimum: "0",
          maximum: UINT64_MAX,
        },
      }),
    );
  }
  return value;
}

export interface ComponentInstance extends JsonObject {
  readonly instanceId: string;
  readonly activation: Activation;
  readonly legacyActivation?: boolean;
  readonly hasStarted?: boolean;
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly componentId: ComponentId;
  readonly deploymentGeneration: Generation;
  readonly observedGeneration: Generation;
  readonly lifecycle: ComponentLifecycleState;
  readonly executor: ExecutorKind;
  readonly workerId?: string;
  readonly artifactDigest?: ArtifactDigest;
  readonly attempt?: number;
  readonly retryAt?: string;
  readonly retryEffect?: ReconcileEffectKind;
  readonly diagnostic?: RuntimeDiagnostic;
  readonly completedOperationId?: OperationId;
  readonly completedOperationIds?: readonly OperationId[];
  readonly revision: Revision;
}

export interface ArtifactDeploymentGate {
  readonly artifact: ValidatedPluginArtifact;
  readonly capabilityResolution: ResolutionResult;
  readonly permissionDecision: PermissionDecision;
}

export interface ReconcileEffect extends JsonObject {
  readonly kind: ReconcileEffectKind;
  readonly activation: Activation;
  readonly operationId: OperationId;
  readonly messageId: MessageId;
  readonly instanceId: string;
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly componentId: ComponentId;
  readonly deploymentGeneration: Generation;
  readonly artifactDigest: ArtifactDigest;
  readonly executor: ExecutorKind;
  readonly workerId?: string;
}

export interface ReconcilePlanStep extends JsonObject {
  readonly operationId: OperationId;
  readonly messageId: MessageId;
  readonly instanceId: string;
  readonly deploymentGeneration: Generation;
  readonly effect: ReconcileEffect;
  readonly expectedRevision: Revision | "absent";
  readonly currentLifecycle: ComponentLifecycleState;
  readonly legacyActivation?: boolean;
}

export interface ReconcileSnapshot {
  readonly deployment: PluginDeployment;
  readonly gate: ArtifactDeploymentGate;
  readonly instances: readonly ComponentInstance[];
  readonly now: string;
  readonly supportedExecutors: readonly ExecutorKind[];
  readonly workers?: readonly PlacementWorker[];
  readonly suspended?: boolean;
  readonly activations?: Readonly<Record<string, Activation>>;
}

export interface ReconcilePlan extends JsonObject {
  readonly deploymentGeneration: Generation;
  readonly blocked: boolean;
  readonly diagnostics: readonly JsonObject[];
  readonly steps: readonly ReconcilePlanStep[];
}

function portableStableId(parts: readonly string[]): string {
  const candidate = parts.map((part) => part.replaceAll("_", "_u").replaceAll(".", "_d")).join(".");
  if (candidate.length <= 128) return candidate;
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${candidate.slice(0, 63)}.${digest}`;
}

export function reconcileEffectIdentities(
  deployment: Pick<PluginDeployment, "applicationId" | "generation" | "pluginId">,
  componentId: ComponentId,
  kind: ReconcileEffectKind,
  activation: Activation = "1",
): {
  readonly instanceId: string;
  readonly operationId: OperationId;
  readonly messageId: MessageId;
} {
  const canonicalActivation = parseActivation(activation);
  const instanceId = portableStableId([
    deployment.applicationId,
    deployment.pluginId,
    componentId,
    `g${deployment.generation}`,
    `a${canonicalActivation}`,
  ]);
  const effectId = portableStableId([
    "reconcile",
    deployment.applicationId,
    deployment.pluginId,
    componentId,
    `g${deployment.generation}`,
    `a${canonicalActivation}`,
    kind,
  ]);
  return {
    instanceId,
    operationId: parseOperationId(effectId),
    messageId: parseMessageId(effectId),
  };
}

export function legacyReconcileInstanceId(
  deployment: Pick<PluginDeployment, "applicationId" | "generation" | "pluginId">,
  componentId: ComponentId,
): string {
  return portableStableId([
    deployment.applicationId,
    deployment.pluginId,
    componentId,
    `g${deployment.generation}`,
  ]);
}

export function legacyReconcileEffectIdentities(
  deployment: Pick<PluginDeployment, "applicationId" | "generation" | "pluginId">,
  componentId: ComponentId,
  kind: ReconcileEffectKind,
): {
  readonly instanceId: string;
  readonly operationId: OperationId;
  readonly messageId: MessageId;
} {
  const instanceId = legacyReconcileInstanceId(deployment, componentId);
  const effectId = portableStableId([
    "reconcile",
    deployment.applicationId,
    deployment.pluginId,
    componentId,
    `g${deployment.generation}`,
    kind,
  ]);
  return {
    instanceId,
    operationId: parseOperationId(effectId),
    messageId: parseMessageId(effectId),
  };
}

function step(
  deployment: PluginDeployment,
  componentId: ComponentId,
  kind: ReconcileEffectKind,
  placement: ComponentPlacement,
  expectedRevision: Revision | "absent",
  currentLifecycle: ComponentLifecycleState,
  activation: Activation,
  legacyActivation = false,
): ReconcilePlanStep {
  const identity = legacyActivation
    ? legacyReconcileEffectIdentities(deployment, componentId, kind)
    : reconcileEffectIdentities(deployment, componentId, kind, activation);
  const effect: ReconcileEffect = {
    kind,
    activation,
    operationId: identity.operationId,
    messageId: identity.messageId,
    instanceId: identity.instanceId,
    applicationId: deployment.applicationId,
    pluginId: deployment.pluginId,
    componentId,
    deploymentGeneration: deployment.generation,
    artifactDigest: deployment.artifactDigest,
    executor: placement.executor,
    ...(placement.workerId === undefined ? {} : { workerId: placement.workerId }),
  };
  return {
    operationId: identity.operationId,
    messageId: identity.messageId,
    instanceId: identity.instanceId,
    deploymentGeneration: deployment.generation,
    effect,
    expectedRevision,
    currentLifecycle,
    ...(legacyActivation ? { legacyActivation: true } : {}),
  };
}

function oldInstanceStep(
  deployment: PluginDeployment,
  instance: ComponentInstance,
  now: string,
): ReconcilePlanStep | undefined {
  const oldDeployment = {
    ...deployment,
    generation: instance.deploymentGeneration,
    artifactDigest: instance.artifactDigest ?? deployment.artifactDigest,
  };
  const placement: ComponentPlacement = {
    executor: instance.executor,
    ...(instance.workerId === undefined ? {} : { workerId: instance.workerId }),
  };
  if (instance.lifecycle === "failed") {
    if (
      instance.retryEffect === undefined ||
      (instance.retryAt !== undefined && instance.retryAt > now)
    ) {
      return undefined;
    }
    return step(
      oldDeployment,
      instance.componentId,
      instance.retryEffect,
      placement,
      instance.revision,
      instance.lifecycle,
      instance.activation,
      instance.legacyActivation,
    );
  }
  if (instance.lifecycle === "draining") {
    const drainOperationId = (
      instance.legacyActivation
        ? legacyReconcileEffectIdentities(oldDeployment, instance.componentId, "drain")
        : reconcileEffectIdentities(
            oldDeployment,
            instance.componentId,
            "drain",
            instance.activation,
          )
    ).operationId;
    if (
      instance.completedOperationId !== drainOperationId &&
      !instance.completedOperationIds?.includes(drainOperationId)
    ) {
      return step(
        oldDeployment,
        instance.componentId,
        "drain",
        placement,
        instance.revision,
        instance.lifecycle,
        instance.activation,
        instance.legacyActivation,
      );
    }
  }
  if (instance.lifecycle === "draining" || instance.lifecycle === "stopping") {
    return step(
      oldDeployment,
      instance.componentId,
      "stop",
      placement,
      instance.revision,
      instance.lifecycle,
      instance.activation,
      instance.legacyActivation,
    );
  }
  if (instance.lifecycle === "stopped") return undefined;
  return step(
    oldDeployment,
    instance.componentId,
    "drain",
    placement,
    instance.revision,
    instance.lifecycle,
    instance.activation,
    instance.legacyActivation,
  );
}

function currentInstanceStep(
  snapshot: ReconcileSnapshot,
  instance: ComponentInstance | undefined,
  componentId: ComponentId,
  placement: ComponentPlacement,
  activation: Activation,
): ReconcilePlanStep | undefined {
  if (
    instance?.diagnostic?.code === "LIFECYCLE_RESTORE_FAILED" &&
    instance.retryAt !== undefined &&
    instance.retryAt > snapshot.now
  ) {
    return undefined;
  }
  if (instance === undefined || instance.lifecycle === "stopped") {
    return step(
      snapshot.deployment,
      componentId,
      "prepare",
      placement,
      "absent",
      "created",
      activation,
    );
  }
  if (instance.lifecycle === "created") {
    return step(
      snapshot.deployment,
      componentId,
      "prepare",
      placement,
      instance.revision,
      instance.lifecycle,
      activation,
      instance.legacyActivation,
    );
  }
  if (instance.lifecycle === "preparing" || instance.lifecycle === "starting") {
    return step(
      snapshot.deployment,
      componentId,
      "start",
      placement,
      instance.revision,
      instance.lifecycle,
      activation,
      instance.legacyActivation,
    );
  }
  if (instance.lifecycle === "draining" || instance.lifecycle === "stopping") {
    return step(
      snapshot.deployment,
      componentId,
      "stop",
      placement,
      instance.revision,
      instance.lifecycle,
      activation,
      instance.legacyActivation,
    );
  }
  if (
    instance.lifecycle === "failed" &&
    instance.retryEffect !== undefined &&
    (instance.retryAt === undefined || instance.retryAt <= snapshot.now)
  ) {
    return step(
      snapshot.deployment,
      componentId,
      instance.retryEffect,
      placement,
      instance.revision,
      instance.lifecycle,
      activation,
      instance.legacyActivation,
    );
  }
  return undefined;
}

export function planReconcile(snapshot: ReconcileSnapshot): ReconcilePlan {
  const gateDiagnostics = [
    ...snapshot.gate.capabilityResolution.diagnostics,
    ...snapshot.gate.permissionDecision.diagnostics,
  ];
  if (!snapshot.gate.capabilityResolution.ok || !snapshot.gate.permissionDecision.allowed) {
    return {
      deploymentGeneration: snapshot.deployment.generation,
      blocked: true,
      diagnostics: gateDiagnostics,
      steps: [],
    };
  }

  const steps: ReconcilePlanStep[] = [];
  const placementDiagnostics: PlacementDiagnostic[] = [];
  const instances = snapshot.instances
    .filter((instance) => instance.applicationId === snapshot.deployment.applicationId)
    .sort((left, right) =>
      left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0,
    );
  const inconsistent = snapshot.gate.artifact.manifest.components
    .map((component) => ({
      component,
      live: instances.filter(
        (instance) =>
          instance.componentId === component.componentId &&
          instance.deploymentGeneration === snapshot.deployment.generation &&
          instance.lifecycle !== "failed" &&
          instance.lifecycle !== "stopped",
      ),
    }))
    .filter(({ live }) => live.length > 1)
    .map(
      ({ component, live }): JsonObject => ({
        code: "DEPLOYMENT_INSTANCE_INCONSISTENT",
        message: "One component generation has multiple live instances",
        componentId: component.componentId,
        instanceIds: live.map((instance) => instance.instanceId),
      }),
    );
  if (inconsistent.length > 0) {
    return {
      deploymentGeneration: snapshot.deployment.generation,
      blocked: true,
      diagnostics: inconsistent,
      steps: [],
    };
  }
  for (const instance of instances) {
    if (
      snapshot.deployment.state === "disabled" ||
      instance.deploymentGeneration !== snapshot.deployment.generation ||
      snapshot.suspended === true
    ) {
      const obsolete = oldInstanceStep(snapshot.deployment, instance, snapshot.now);
      if (obsolete !== undefined) steps.push(obsolete);
    }
  }

  if (snapshot.deployment.state === "active" && snapshot.suspended !== true) {
    for (const component of [...snapshot.gate.artifact.manifest.components].sort((left, right) =>
      left.componentId < right.componentId ? -1 : left.componentId > right.componentId ? 1 : 0,
    )) {
      const placement = planPlacement({
        artifactDigest: snapshot.deployment.artifactDigest,
        component,
        grantedPermissions: snapshot.gate.permissionDecision.granted ?? [],
        supportedExecutors: snapshot.supportedExecutors,
        ...(snapshot.workers === undefined ? {} : { workers: snapshot.workers }),
      });
      if (!placement.ok || placement.placement === undefined) {
        placementDiagnostics.push(...placement.diagnostics);
        continue;
      }
      const currentInstances = instances.filter(
        (instance) =>
          instance.componentId === component.componentId &&
          instance.deploymentGeneration === snapshot.deployment.generation,
      );
      const activation =
        snapshot.activations?.[component.componentId] ??
        currentInstances.reduce<Activation | undefined>(
          (highest, instance) =>
            highest === undefined || BigInt(instance.activation) > BigInt(highest)
              ? instance.activation
              : highest,
          undefined,
        ) ??
        "1";
      const current = currentInstances.find((instance) => instance.activation === activation);
      const next = currentInstanceStep(
        snapshot,
        current,
        component.componentId,
        placement.placement,
        activation,
      );
      if (next !== undefined) steps.push(next);
    }
  }

  return {
    deploymentGeneration: snapshot.deployment.generation,
    blocked: placementDiagnostics.length > 0,
    diagnostics: [...gateDiagnostics, ...placementDiagnostics],
    steps: placementDiagnostics.length > 0 ? [] : steps,
  };
}
