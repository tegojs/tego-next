import type { RuntimeDiagnostic } from "./diagnostic.js";
import type {
  ApplicationId,
  AttemptId,
  ComponentId,
  PluginId,
  TaskId,
  WorkerId,
} from "./identity.js";
import type { JsonObject, JsonValue } from "./json.js";

export type OrphanPolicy = "cancel" | "finish-and-buffer" | "finish-and-persist";

export interface ExecutionRequest {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly componentId: ComponentId;
  readonly input: JsonValue;
  readonly deadline: string;
  readonly orphanPolicy: OrphanPolicy;
}

export type ExecutionTerminalStatus =
  | "cancelled"
  | "failed"
  | "rejected"
  | "succeeded"
  | "timed-out";

export interface ExecutionResult {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly status: ExecutionTerminalStatus;
  readonly output?: JsonValue;
  readonly diagnostic?: RuntimeDiagnostic;
  readonly executor: {
    readonly kind: "process" | "remote" | "thread";
    readonly workerId?: WorkerId;
    readonly metadata?: JsonObject;
  };
  readonly startedAt: string;
  readonly completedAt: string;
}
