import { createHash } from "node:crypto";
import {
  parseMessageId,
  parseOperationId,
  type ArtifactDigest,
  type ApplicationId,
  type ComponentId,
  type ExecutorKind,
  type Generation,
  type JsonObject,
  type MessageId,
  type OperationId,
  type PluginDeployment,
  type PluginId,
  type Revision,
  type RuntimeDiagnostic,
} from "@tegojs/contracts";
import type { ValidatedPluginArtifact } from "../artifacts/artifact-service.js";
import type { ResolutionResult } from "../capabilities/resolver.js";
import type { PermissionDecision } from "../permissions/permission-set.js";
import type { ComponentLifecycleState } from "./component-lifecycle.js";
import {
  planPlacement,
  type ComponentPlacement,
  type PlacementDiagnostic,
  type PlacementWorker,
} from "./placement.js";

export type ReconcileEffectKind = "drain" | "prepare" | "start" | "stop";

export interface ComponentInstance extends JsonObject {
  readonly instanceId: string;
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
}

export interface ReconcileSnapshot {
  readonly deployment: PluginDeployment;
  readonly gate: ArtifactDeploymentGate;
  readonly instances: readonly ComponentInstance[];
  readonly now: string;
  readonly supportedExecutors: readonly ExecutorKind[];
  readonly workers?: readonly PlacementWorker[];
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

function identities(
  deployment: PluginDeployment,
  componentId: ComponentId,
  kind: ReconcileEffectKind,
): {
  readonly instanceId: string;
  readonly operationId: OperationId;
  readonly messageId: MessageId;
} {
  const instanceId = portableStableId([
    deployment.applicationId,
    deployment.pluginId,
    componentId,
    `g${deployment.generation}`,
  ]);
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
): ReconcilePlanStep {
  const identity = identities(deployment, componentId, kind);
  const effect: ReconcileEffect = {
    kind,
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
  };
}

function oldInstanceStep(
  deployment: PluginDeployment,
  instance: ComponentInstance,
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
  if (instance.lifecycle === "draining" || instance.lifecycle === "stopping") {
    return step(
      oldDeployment,
      instance.componentId,
      "stop",
      placement,
      instance.revision,
      instance.lifecycle,
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
  );
}

function currentInstanceStep(
  snapshot: ReconcileSnapshot,
  instance: ComponentInstance | undefined,
  componentId: ComponentId,
  placement: ComponentPlacement,
): ReconcilePlanStep | undefined {
  if (instance === undefined || instance.lifecycle === "stopped") {
    return step(snapshot.deployment, componentId, "prepare", placement, "absent", "created");
  }
  if (instance.lifecycle === "created") {
    return step(
      snapshot.deployment,
      componentId,
      "prepare",
      placement,
      instance.revision,
      instance.lifecycle,
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
      instance.deploymentGeneration !== snapshot.deployment.generation
    ) {
      const obsolete = oldInstanceStep(snapshot.deployment, instance);
      if (obsolete !== undefined) steps.push(obsolete);
    }
  }

  if (snapshot.deployment.state === "active") {
    for (const component of [...snapshot.gate.artifact.manifest.components].sort((left, right) =>
      left.componentId < right.componentId ? -1 : left.componentId > right.componentId ? 1 : 0,
    )) {
      const placement = planPlacement({
        component,
        grantedPermissions: snapshot.gate.permissionDecision.granted ?? [],
        supportedExecutors: snapshot.supportedExecutors,
        ...(snapshot.workers === undefined ? {} : { workers: snapshot.workers }),
      });
      if (!placement.ok || placement.placement === undefined) {
        placementDiagnostics.push(...placement.diagnostics);
        continue;
      }
      const current = instances.find(
        (instance) =>
          instance.componentId === component.componentId &&
          instance.deploymentGeneration === snapshot.deployment.generation,
      );
      const next = currentInstanceStep(
        snapshot,
        current,
        component.componentId,
        placement.placement,
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
