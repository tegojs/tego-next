import { createHash } from "node:crypto";
import type { CapabilityBinding, CapabilityDefinition } from "./capability.js";
import { DiagnosticError, runtimeDiagnostic, type RuntimeDiagnostic } from "./diagnostic.js";
import {
  parseArtifactDigest,
  parseComponentInstanceId,
  parseExecutorId,
  parseGeneration,
  parseWorkerId,
  type ApplicationId,
  type ArtifactDigest,
  type AttemptId,
  type ComponentId,
  type ComponentInstanceId,
  type Generation,
  type PluginId,
  type TaskId,
  type WorkerId,
} from "./identity.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { Permission } from "./permission.js";
import type { DriverHealth } from "./state.js";

export type OrphanPolicy = "cancel" | "finish-and-buffer" | "finish-and-persist";

export interface TaskExecutionTarget extends JsonObject {
  readonly instanceId: ComponentInstanceId;
  readonly deploymentGeneration: Generation;
  readonly artifactDigest: ArtifactDigest;
  readonly executor:
    | {
        readonly id: string;
        readonly type: "remote";
        readonly workerId: WorkerId;
      }
    | {
        readonly id: string;
        readonly type: "process" | "thread";
        readonly workerId?: never;
      };
}

export interface ExecutionBindingContent extends JsonObject {
  readonly configuration: JsonValue;
  readonly permissionGrants: readonly Permission[];
  readonly capabilityDefinitions: readonly CapabilityDefinition[];
  readonly capabilityBindings: readonly CapabilityBinding[];
}

export interface ExecutionBinding extends ExecutionBindingContent {
  readonly fingerprint: string;
}

export interface ExecutionBindingIdentity extends JsonObject {
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly componentId: ComponentId;
  readonly target: TaskExecutionTarget;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key] as JsonValue)}`)
    .join(",")}}`;
}

export function executionBindingFingerprint(
  identity: ExecutionBindingIdentity,
  binding: ExecutionBindingContent,
): string {
  return createHash("sha256")
    .update(
      canonical({
        domain: "tego.execution-binding/1.0",
        identity,
        binding,
      }),
      "utf8",
    )
    .digest("hex");
}

function targetError(message: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_EXECUTION_TARGET_INVALID",
      message,
      source: { kind: "protocol", id: "task-execution-target" },
    }),
  );
}

function targetObject(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw targetError("Task execution target must be a plain object");
  }
  return value as Record<string, unknown>;
}

function targetKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw targetError("Task execution target fields do not match the contract");
  }
}

export function parseTaskExecutionTarget(input: unknown): TaskExecutionTarget {
  const value = targetObject(input);
  targetKeys(value, ["instanceId", "deploymentGeneration", "artifactDigest", "executor"]);
  const executor = targetObject(value.executor);
  targetKeys(executor, ["id", "type"], ["workerId"]);
  if (executor.type !== "process" && executor.type !== "remote" && executor.type !== "thread") {
    throw targetError("Task execution target executor is invalid");
  }
  if (
    (executor.type === "remote" && executor.workerId === undefined) ||
    (executor.type !== "remote" && executor.workerId !== undefined)
  ) {
    throw targetError("Task execution target worker binding is invalid");
  }
  const targetExecutor: TaskExecutionTarget["executor"] =
    executor.type === "remote"
      ? {
          id: parseExecutorId(executor.id),
          type: "remote" as const,
          workerId: parseWorkerId(executor.workerId),
        }
      : {
          id: parseExecutorId(executor.id),
          type: executor.type,
        };
  return {
    instanceId: parseComponentInstanceId(value.instanceId),
    deploymentGeneration: parseGeneration(value.deploymentGeneration),
    artifactDigest: parseArtifactDigest(value.artifactDigest),
    executor: targetExecutor,
  };
}

export interface ExecutionRequest extends JsonObject {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly target: TaskExecutionTarget;
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly componentId: ComponentId;
  readonly binding: ExecutionBinding;
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
