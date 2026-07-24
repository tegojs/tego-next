import type { ApplicationId, FencingEpoch, NodeId, RuntimeId } from "./identity.js";
import type { JsonObject } from "./json.js";
import type { WorkerResourceCeilings } from "./permission.js";
import type { DriverHealth } from "./state.js";
import type { RuntimeOperations } from "./operations.js";

export type RuntimeMode = "multi-main" | "single-main";

export interface RuntimeConfiguration extends JsonObject {
  readonly mode: RuntimeMode;
  readonly runtimeId: RuntimeId;
  readonly applicationId: ApplicationId;
  readonly nodeId: NodeId;
}

export type RuntimeLifecycleState =
  | "created"
  | "opening"
  | "recovering"
  | "electing"
  | "running"
  | "draining"
  | "stopping"
  | "stopped"
  | "failed";

export interface RuntimeIdentity extends JsonObject {
  readonly runtimeId: RuntimeId;
  readonly applicationId: ApplicationId;
  readonly nodeId: NodeId;
}

export type RuntimeDriverName = "artifacts" | "coordination" | "processHost" | "secrets" | "state";

export interface RuntimeDriverStatus extends JsonObject {
  readonly name: RuntimeDriverName;
  readonly health: DriverHealth;
}

export interface RuntimeCounts extends JsonObject {
  readonly deployments: number;
  readonly installations: number;
  readonly recoverableOperations: number;
  readonly tasks: number;
  readonly workers: number;
}

export interface RuntimeAuthority extends JsonObject {
  readonly resource: string;
  readonly epoch: FencingEpoch;
}

export interface RuntimePlacementWorker extends JsonObject {
  readonly workerId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly resources: WorkerResourceCeilings;
}

export interface RuntimeTaskLifecycle {
  recover(): Promise<void>;
  setAuthority(authority: RuntimeAuthority | undefined): Promise<void>;
  count(): number;
  close(): Promise<void>;
}

export interface RuntimeWorkerDirectory {
  count(): number;
  placements(): readonly RuntimePlacementWorker[];
  close(): Promise<void>;
}

export interface RuntimeStatus extends JsonObject {
  readonly identity: RuntimeIdentity;
  readonly mode: RuntimeMode;
  readonly lifecycle: RuntimeLifecycleState;
  readonly liveness: boolean;
  readonly readiness: boolean;
  readonly acceptingOperations: boolean;
  readonly drivers: readonly RuntimeDriverStatus[];
  readonly counts: RuntimeCounts;
  readonly authority?: RuntimeAuthority;
}

export interface StopOptions {
  readonly deadlineMs?: number;
}

export interface RuntimeEvent extends JsonObject {
  readonly type: "runtime.lifecycle";
  readonly previous: RuntimeLifecycleState;
  readonly current: RuntimeLifecycleState;
  readonly occurredAt: string;
}

export interface Runtime {
  start(): Promise<void>;
  status(): Promise<RuntimeStatus>;
  stop(options?: StopOptions): Promise<void>;
  readonly operations: RuntimeOperations;
  readonly events: AsyncIterable<RuntimeEvent>;
}
