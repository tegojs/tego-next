import { DiagnosticError, runtimeDiagnostic, type RuntimeDiagnostic } from "./diagnostic.js";
import {
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseComponentId,
  parseFencingEpoch,
  parseOperationId,
  parsePluginId,
  parseTaskId,
  type ApplicationId,
  type ArtifactDigest,
  type AttemptId,
  type ComponentId,
  type OperationId,
  type PluginId,
  type TaskId,
} from "./identity.js";
import {
  parseExecutionRequest,
  parseExecutionResult,
  parsePermissionSet,
  parsePluginDeployment,
} from "./schema.js";
import type { ExecutionResult, OrphanPolicy } from "./execution.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { Permission } from "./permission.js";
import type { PluginDeployment, PluginDeploymentIdentity, PluginInstallation } from "./plugin.js";
import type { PersistedOperationJournalEntry } from "./state.js";

export interface ArtifactSignatureEnvelope extends JsonObject {
  readonly algorithm: "Ed25519";
  readonly digest: ArtifactDigest;
  readonly keyId: string;
  readonly signature: string;
}

export interface InstallPluginRequest extends JsonObject {
  readonly digest: ArtifactDigest;
  readonly signature?: ArtifactSignatureEnvelope;
}

export interface DeployPluginRequest extends JsonObject {
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly artifactDigest: ArtifactDigest;
  readonly essential: boolean;
  readonly configuration: JsonValue;
  readonly permissionGrants: readonly Permission[];
  readonly capabilityBindings: Readonly<Record<string, PluginDeploymentIdentity>>;
}

export interface RunTaskRequest extends JsonObject {
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly componentId: ComponentId;
  readonly input: JsonValue;
  readonly deadline: string;
  readonly orphanPolicy: OrphanPolicy;
  readonly operationId?: OperationId;
}

export interface PluginDeploymentStatus extends JsonObject {
  readonly identity: PluginDeploymentIdentity;
  readonly desired?: PluginDeployment;
  readonly observation?: JsonValue;
}

export type TaskRecordState = "accepted" | "running" | "terminal";

export interface TaskExecutorReference extends JsonObject {
  readonly id: string;
  readonly type: "process" | "remote" | "thread";
}

export interface TaskRecord extends JsonObject {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly request: RunTaskRequest;
  readonly state: TaskRecordState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly executor?: TaskExecutorReference;
  readonly authority?: {
    readonly resource: string;
    readonly epoch: string;
  };
  readonly result?: ExecutionResult;
}

function operationError(message: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_OPERATION_INVALID",
      message,
      source: { kind: "protocol", id: "runtime-operation" },
    }),
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw operationError("Runtime operation value must be a plain object");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw operationError("Runtime operation contains a symbol key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw operationError("Runtime operation fields must be enumerable data properties");
    }
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw operationError("Runtime operation fields do not match the contract");
  }
}

function cloneStrictJson<T extends JsonValue>(value: T): T {
  try {
    const parsed = parseExecutionRequest({
      taskId: "validation-task",
      attemptId: "validation-attempt",
      applicationId: "validation-application",
      pluginId: "validation-plugin",
      componentId: "validation-component",
      input: value,
      deadline: "2026-01-01T00:00:00.000Z",
      orphanPolicy: "cancel",
    });
    return structuredClone(parsed.input) as T;
  } catch {
    throw operationError("Runtime operation contains invalid JSON data");
  }
}

function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw operationError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function orphanPolicy(value: unknown): OrphanPolicy {
  if (value !== "cancel" && value !== "finish-and-buffer" && value !== "finish-and-persist") {
    throw operationError("orphanPolicy is invalid");
  }
  return value;
}

function deploymentIdentity(value: unknown): PluginDeploymentIdentity {
  const object = objectValue(value);
  exactKeys(object, ["applicationId", "pluginId"]);
  return {
    applicationId: parseApplicationId(object.applicationId),
    pluginId: parsePluginId(object.pluginId),
  };
}

export function parseInstallPluginRequest(input: unknown): InstallPluginRequest {
  const value = objectValue(input);
  exactKeys(value, ["digest"], ["signature"]);
  const digest = parseArtifactDigest(value.digest);
  if (value.signature === undefined) return { digest };
  const signature = objectValue(value.signature);
  exactKeys(signature, ["algorithm", "digest", "keyId", "signature"]);
  if (
    signature.algorithm !== "Ed25519" ||
    typeof signature.keyId !== "string" ||
    typeof signature.signature !== "string"
  ) {
    throw operationError("Artifact signature envelope is invalid");
  }
  return {
    digest,
    signature: {
      algorithm: "Ed25519",
      digest: parseArtifactDigest(signature.digest),
      keyId: signature.keyId,
      signature: signature.signature,
    },
  };
}

export function parseDeployPluginRequest(input: unknown): DeployPluginRequest {
  const value = objectValue(input);
  exactKeys(value, [
    "applicationId",
    "pluginId",
    "artifactDigest",
    "essential",
    "configuration",
    "permissionGrants",
    "capabilityBindings",
  ]);
  if (typeof value.essential !== "boolean") throw operationError("essential must be boolean");
  const bindings = objectValue(value.capabilityBindings);
  const capabilityBindings: Record<string, PluginDeploymentIdentity> = {};
  for (const key of Object.keys(bindings).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(key)) {
      throw operationError("Capability binding name is invalid");
    }
    capabilityBindings[key] = deploymentIdentity(bindings[key]);
  }
  return {
    applicationId: parseApplicationId(value.applicationId),
    pluginId: parsePluginId(value.pluginId),
    artifactDigest: parseArtifactDigest(value.artifactDigest),
    essential: value.essential,
    configuration: cloneStrictJson(value.configuration as JsonValue),
    permissionGrants: structuredClone(parsePermissionSet(value.permissionGrants)),
    capabilityBindings,
  };
}

export function parseRunTaskRequest(input: unknown): RunTaskRequest {
  const value = objectValue(input);
  exactKeys(
    value,
    ["applicationId", "pluginId", "componentId", "input", "deadline", "orphanPolicy"],
    ["operationId"],
  );
  return {
    applicationId: parseApplicationId(value.applicationId),
    pluginId: parsePluginId(value.pluginId),
    componentId: parseComponentId(value.componentId),
    input: cloneStrictJson(value.input as JsonValue),
    deadline: timestamp(value.deadline, "deadline"),
    orphanPolicy: orphanPolicy(value.orphanPolicy),
    ...(value.operationId === undefined
      ? {}
      : { operationId: parseOperationId(value.operationId) }),
  };
}

export function parsePluginDeploymentIdentity(input: unknown): PluginDeploymentIdentity {
  return structuredClone(deploymentIdentity(input));
}

export function parsePluginDeploymentStatus(input: unknown): PluginDeploymentStatus {
  const value = objectValue(input);
  exactKeys(value, ["identity"], ["desired", "observation"]);
  return {
    identity: deploymentIdentity(value.identity),
    ...(value.desired === undefined
      ? {}
      : { desired: structuredClone(parsePluginDeployment(value.desired)) }),
    ...(value.observation === undefined
      ? {}
      : { observation: cloneStrictJson(value.observation as JsonValue) }),
  };
}

export function parseTaskRecord(input: unknown): TaskRecord {
  const value = objectValue(input);
  exactKeys(
    value,
    ["taskId", "attemptId", "request", "state", "createdAt", "updatedAt"],
    ["executor", "authority", "result"],
  );
  if (value.state !== "accepted" && value.state !== "running" && value.state !== "terminal") {
    throw operationError("Task state is invalid");
  }
  const executor =
    value.executor === undefined
      ? undefined
      : (() => {
          const entry = objectValue(value.executor);
          exactKeys(entry, ["id", "type"]);
          if (
            typeof entry.id !== "string" ||
            (entry.type !== "process" && entry.type !== "remote" && entry.type !== "thread")
          ) {
            throw operationError("Task executor is invalid");
          }
          return {
            id: entry.id,
            type: entry.type as TaskExecutorReference["type"],
          };
        })();
  const authority =
    value.authority === undefined
      ? undefined
      : (() => {
          const entry = objectValue(value.authority);
          exactKeys(entry, ["resource", "epoch"]);
          if (typeof entry.resource !== "string") throw operationError("Task authority is invalid");
          return { resource: entry.resource, epoch: parseFencingEpoch(entry.epoch) };
        })();
  const result =
    value.result === undefined ? undefined : structuredClone(parseExecutionResult(value.result));
  if ((value.state === "terminal") !== (result !== undefined)) {
    throw operationError("Terminal task records must contain exactly one result");
  }
  return {
    taskId: parseTaskId(value.taskId),
    attemptId: parseAttemptId(value.attemptId),
    request: parseRunTaskRequest(value.request),
    state: value.state,
    createdAt: timestamp(value.createdAt, "createdAt"),
    updatedAt: timestamp(value.updatedAt, "updatedAt"),
    ...(executor === undefined ? {} : { executor }),
    ...(authority === undefined ? {} : { authority }),
    ...(result === undefined ? {} : { result }),
  };
}

export interface RuntimeOperations {
  installPlugin(request: InstallPluginRequest): Promise<PluginInstallation>;
  deployPlugin(request: DeployPluginRequest): Promise<PluginDeployment>;
  pluginStatus(identity: PluginDeploymentIdentity): Promise<PluginDeploymentStatus>;
  runTask(request: RunTaskRequest): Promise<TaskRecord>;
  taskStatus(taskId: TaskId): Promise<TaskRecord | undefined>;
  waitTask(taskId: TaskId): Promise<TaskRecord>;
  cancelTask(taskId: TaskId): Promise<TaskRecord>;
  recoveredOperations(): Promise<readonly PersistedOperationJournalEntry[]>;
}

export function indeterminateTaskDiagnostic(
  taskId: TaskId,
  message: string,
  observedAt: string,
): RuntimeDiagnostic & { readonly retryable: false } {
  return runtimeDiagnostic({
    code: "EXECUTOR_RESULT_INDETERMINATE",
    message,
    source: { kind: "executor", id: taskId },
    retryable: false,
    observedAt,
  }) as RuntimeDiagnostic & { readonly retryable: false };
}
