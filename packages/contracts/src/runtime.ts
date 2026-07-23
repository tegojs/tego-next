import type { ApplicationId, NodeId, RuntimeId } from "./identity.js";

export type RuntimeMode = "multi-main" | "single-main";

export interface RuntimeConfiguration {
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
