import type { RuntimeDiagnostic } from "./diagnostic.js";
import type {
  ApplicationId,
  ArtifactDigest,
  AttemptId,
  ComponentId,
  Generation,
  PluginId,
  TaskId,
  WorkerId,
} from "./identity.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { DriverHealth } from "./state.js";

export type OrphanPolicy = "cancel" | "finish-and-buffer" | "finish-and-persist";

export interface TaskExecutionTarget extends JsonObject {
  readonly instanceId: string;
  readonly deploymentGeneration: Generation;
  readonly artifactDigest: ArtifactDigest;
  readonly executor: {
    readonly id: string;
    readonly type: "process" | "remote" | "thread";
    readonly workerId?: WorkerId;
  };
}

export interface ExecutionRequest extends JsonObject {
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
  | "indeterminate"
  | "rejected"
  | "succeeded"
  | "timed-out";

export interface ExecutionExecutor extends JsonObject {
  readonly kind: "process" | "remote" | "thread";
  readonly workerId?: WorkerId;
  readonly metadata?: JsonObject;
}

interface ExecutionResultBase extends JsonObject {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly executor: ExecutionExecutor;
  readonly startedAt: string;
  readonly completedAt: string;
}

type DeterminateExecutionStatus = Exclude<ExecutionTerminalStatus, "indeterminate">;

export type ExecutionResult =
  | (ExecutionResultBase & {
      readonly status: "indeterminate";
      readonly output?: never;
      readonly diagnostic: RuntimeDiagnostic & { readonly retryable: false };
    })
  | (ExecutionResultBase & {
      readonly status: DeterminateExecutionStatus;
      readonly output?: JsonValue;
      readonly diagnostic?: RuntimeDiagnostic;
    });

export interface ExecutorCapabilities extends JsonObject {
  readonly id: string;
  readonly type: ExecutionExecutor["kind"];
  readonly available: boolean;
  readonly maxConcurrency: number;
  readonly availableCapacity: number;
  readonly securityIsolation: boolean;
}

export interface ExecutionHandle {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly result: Promise<ExecutionResult>;
}

export type AttemptState = "accepted" | "running" | "terminal";

export type AttemptStatus =
  | {
      readonly state: "accepted" | "running";
    }
  | {
      readonly state: "terminal";
      readonly result: ExecutionResult;
    };

export interface ExecutorHealth extends DriverHealth {
  readonly id: string;
  readonly type: ExecutionExecutor["kind"];
  readonly accepting: boolean;
  readonly active: number;
  readonly queued: number;
  readonly retainedAttempts: number;
}

export interface DrainOptions {
  readonly deadline?: string;
}

/**
 * Executor implementations own execution deduplication and lifecycle. Artifact
 * resolution is an injected bootstrap concern and is intentionally absent from
 * this public command surface.
 */
export interface Executor {
  readonly id: string;
  readonly type: ExecutionExecutor["kind"];
  probe(): Promise<ExecutorCapabilities>;
  submit(request: ExecutionRequest): Promise<ExecutionHandle>;
  observe(taskId: TaskId, attemptId: AttemptId): Promise<AttemptStatus | undefined>;
  cancel(taskId: TaskId, attemptId: AttemptId): Promise<void>;
  drain(options: DrainOptions): Promise<void>;
  health(): Promise<ExecutorHealth>;
  close(): Promise<void>;
}
