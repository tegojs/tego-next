import type { ApplicationId, NodeId, RuntimeId } from "./identity.js";
import type { JsonObject } from "./json.js";

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
