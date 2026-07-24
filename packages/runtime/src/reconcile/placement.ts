import type {
  ExecutorKind,
  JsonObject,
  Permission,
  PluginComponent,
  WorkerResourceCeilings,
} from "@tegojs/contracts";
import { gatePermission } from "../permissions/gate.js";

export interface PlacementWorker extends JsonObject {
  readonly workerId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly resources: WorkerResourceCeilings;
}

export interface ComponentPlacement extends JsonObject {
  readonly executor: ExecutorKind;
  readonly workerId?: string;
}

export interface PlacementDiagnostic extends JsonObject {
  readonly code: "DEPLOYMENT_EXECUTOR_UNAVAILABLE" | "PERMISSION_GRANT_EXCEEDS_REQUEST";
  readonly message: string;
  readonly componentId: string;
}

export interface PlacementInput {
  readonly component: PluginComponent;
  readonly grantedPermissions: readonly Permission[];
  readonly supportedExecutors: readonly ExecutorKind[];
  readonly workers?: readonly PlacementWorker[];
}

export interface PlacementDecision extends JsonObject {
  readonly ok: boolean;
  readonly diagnostics: readonly PlacementDiagnostic[];
  readonly placement?: ComponentPlacement;
}

const executorPreference: readonly ExecutorKind[] = ["process", "thread", "remote"];

export function planPlacement(input: PlacementInput): PlacementDecision {
  const supported = new Set(input.supportedExecutors);
  let permissionDenied = false;
  for (const executor of executorPreference) {
    if (!input.component.executors.includes(executor) || !supported.has(executor)) continue;
    if (
      !gatePermission(input.grantedPermissions, {
        kind: "executor",
        executor,
      }).allowed
    ) {
      permissionDenied = true;
      continue;
    }
    if (executor !== "remote") {
      return { ok: true, diagnostics: [], placement: { executor } };
    }
    for (const worker of [...(input.workers ?? [])].sort((left, right) =>
      left.workerId < right.workerId ? -1 : left.workerId > right.workerId ? 1 : 0,
    )) {
      if (
        gatePermission(input.grantedPermissions, {
          kind: "worker",
          labels: worker.labels,
          resources: worker.resources,
        }).allowed
      ) {
        return {
          ok: true,
          diagnostics: [],
          placement: { executor, workerId: worker.workerId },
        };
      }
    }
  }
  return {
    ok: false,
    diagnostics: [
      {
        code: permissionDenied
          ? "PERMISSION_GRANT_EXCEEDS_REQUEST"
          : "DEPLOYMENT_EXECUTOR_UNAVAILABLE",
        message: permissionDenied
          ? "No component executor is inside the granted permission envelope"
          : "No supported executor placement is available for the component",
        componentId: input.component.componentId,
      },
    ],
  };
}
