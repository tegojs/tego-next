import { DiagnosticError, runtimeDiagnostic, type RuntimeDiagnostic } from "./diagnostic.js";
import {
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseComponentId,
  parseComponentInstanceId,
  parseFencingEpoch,
  parseExecutorId,
  parseGeneration,
  parseOperationId,
  parsePluginId,
  parseTaskId,
  type ApplicationId,
  type ArtifactDigest,
  type AttemptId,
  type ComponentId,
  type Generation,
  type OperationId,
  type PluginId,
  type TaskId,
} from "./identity.js";
import {
  createExecutionBinding,
  parseExecutionRequest,
  assertExecutionBindingMatches,
  parseExecutionResult,
  parsePermissionSet,
  parsePluginDeployment,
  parsePluginDeploymentObservation,
  parseRuntimeDiagnostic,
} from "./schema.js";
import {
  type ExecutionBinding,
  type ExecutionResult,
  type OrphanPolicy,
  parseTaskExecutionTarget,
  type TaskExecutionTarget,
} from "./execution.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { Permission } from "./permission.js";
import type { PluginDeployment, PluginDeploymentIdentity, PluginInstallation } from "./plugin.js";
import type { RuntimeSnapshotRequest, RuntimeSnapshotResponse } from "./runtime-snapshot.js";
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
  readonly observation?: PluginDeploymentObservation;
}

export type PluginDeploymentObservationStatus =
  | "blocked"
  | "degraded"
  | "disabled"
  | "failed"
  | "ready"
  | "reconciling"
  | "suspended";

export interface PluginDeploymentObservation extends JsonObject {
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly generation: Generation;
  readonly status: PluginDeploymentObservationStatus;
  readonly diagnostics: readonly RuntimeDiagnostic[];
  readonly updatedAt: string;
}

export type TaskRecordState = "accepted" | "running" | "terminal";

export interface TaskExecutorReference extends JsonObject {
  readonly id: string;
  readonly type: "process" | "remote" | "thread";
}

export interface TaskCancellationIntent extends JsonObject {
  readonly requestedAt: string;
  readonly authority: {
    readonly resource: string;
    readonly epoch: string;
  };
}

export interface TaskRecord extends JsonObject {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly request: RunTaskRequest;
  readonly state: TaskRecordState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly target?: TaskExecutionTarget;
  readonly binding?: ExecutionBinding;
  readonly executor?: TaskExecutorReference;
  readonly authority?: {
    readonly resource: string;
    readonly epoch: string;
  };
  readonly cancellation?: TaskCancellationIntent;
  readonly diagnostic?: RuntimeDiagnostic;
  readonly result?: ExecutionResult;
}

export const runtimeOperationMaxBytes = 1_048_576;

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
    const identity = {
      target: {
        instanceId: parseComponentInstanceId("validation-instance"),
        deploymentGeneration: parseGeneration("0"),
        artifactDigest: parseArtifactDigest(
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        ),
        executor: { id: "validation-executor", type: "thread" as const },
      },
      applicationId: parseApplicationId("validation-application"),
      pluginId: parsePluginId("validation-plugin"),
      componentId: parseComponentId("validation-component"),
    };
    const parsed = parseExecutionRequest({
      taskId: "validation-task",
      attemptId: "validation-attempt",
      ...identity,
      binding: createExecutionBinding(identity, {
        configuration: null,
        permissionGrants: [],
        capabilityDefinitions: [],
        capabilityBindings: [],
      }),
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
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw operationError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function assertSerializedLimit(value: JsonValue): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > runtimeOperationMaxBytes) {
    throw operationError("Runtime operation exceeds the serialized size limit");
  }
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
  if (value.signature === undefined) {
    const parsed = { digest };
    assertSerializedLimit(parsed);
    return parsed;
  }
  const signature = objectValue(value.signature);
  exactKeys(signature, ["algorithm", "digest", "keyId", "signature"]);
  if (
    signature.algorithm !== "Ed25519" ||
    typeof signature.keyId !== "string" ||
    typeof signature.signature !== "string"
  ) {
    throw operationError("Artifact signature envelope is invalid");
  }
  const parsed: InstallPluginRequest = {
    digest,
    signature: {
      algorithm: "Ed25519",
      digest: parseArtifactDigest(signature.digest),
      keyId: signature.keyId,
      signature: signature.signature,
    },
  };
  assertSerializedLimit(parsed);
  return parsed;
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
  const parsed: DeployPluginRequest = {
    applicationId: parseApplicationId(value.applicationId),
    pluginId: parsePluginId(value.pluginId),
    artifactDigest: parseArtifactDigest(value.artifactDigest),
    essential: value.essential,
    configuration: cloneStrictJson(value.configuration as JsonValue),
    permissionGrants: structuredClone(parsePermissionSet(value.permissionGrants)),
    capabilityBindings,
  };
  assertSerializedLimit(parsed);
  return parsed;
}

export function parseRunTaskRequest(input: unknown): RunTaskRequest {
  const value = objectValue(input);
  exactKeys(
    value,
    ["applicationId", "pluginId", "componentId", "input", "deadline", "orphanPolicy"],
    ["operationId"],
  );
  const parsed: RunTaskRequest = {
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
  assertSerializedLimit(parsed);
  return parsed;
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
      : { observation: structuredClone(parsePluginDeploymentObservation(value.observation)) }),
  };
}

export function parseTaskRecord(input: unknown): TaskRecord {
  const value = objectValue(input);
  exactKeys(
    value,
    ["taskId", "attemptId", "request", "state", "createdAt", "updatedAt"],
    ["target", "binding", "executor", "authority", "cancellation", "diagnostic", "result"],
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
          if (entry.type !== "process" && entry.type !== "remote" && entry.type !== "thread") {
            throw operationError("Task executor is invalid");
          }
          return {
            id: parseExecutorId(entry.id),
            type: entry.type as TaskExecutorReference["type"],
          };
        })();
  const request = parseRunTaskRequest(value.request);
  const target = value.target === undefined ? undefined : parseTaskExecutionTarget(value.target);
  const binding =
    value.binding === undefined
      ? undefined
      : target === undefined
        ? (() => {
            throw operationError("Task execution binding requires an immutable target");
          })()
        : structuredClone(
            assertExecutionBindingMatches(
              {
                applicationId: request.applicationId,
                pluginId: request.pluginId,
                componentId: request.componentId,
                target,
              },
              value.binding,
            ),
          );
  if (
    target !== undefined &&
    executor !== undefined &&
    (target.executor.id !== executor.id || target.executor.type !== executor.type)
  ) {
    throw operationError("Task target and legacy executor bindings must match exactly");
  }
  const authority =
    value.authority === undefined
      ? undefined
      : (() => {
          const entry = objectValue(value.authority);
          exactKeys(entry, ["resource", "epoch"]);
          if (typeof entry.resource !== "string") throw operationError("Task authority is invalid");
          return { resource: entry.resource, epoch: parseFencingEpoch(entry.epoch) };
        })();
  const cancellation =
    value.cancellation === undefined
      ? undefined
      : (() => {
          const entry = objectValue(value.cancellation);
          exactKeys(entry, ["requestedAt", "authority"]);
          const cancellationAuthority = objectValue(entry.authority);
          exactKeys(cancellationAuthority, ["resource", "epoch"]);
          if (typeof cancellationAuthority.resource !== "string") {
            throw operationError("Task cancellation authority is invalid");
          }
          return {
            requestedAt: timestamp(entry.requestedAt, "cancellation.requestedAt"),
            authority: {
              resource: cancellationAuthority.resource,
              epoch: parseFencingEpoch(cancellationAuthority.epoch),
            },
          };
        })();
  const result =
    value.result === undefined ? undefined : structuredClone(parseExecutionResult(value.result));
  const diagnostic =
    value.diagnostic === undefined
      ? undefined
      : structuredClone(parseRuntimeDiagnostic(value.diagnostic));
  if ((value.state === "terminal") !== (result !== undefined)) {
    throw operationError("Terminal task records must contain exactly one result");
  }
  const taskId = parseTaskId(value.taskId);
  const attemptId = parseAttemptId(value.attemptId);
  const createdAt = timestamp(value.createdAt, "createdAt");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw operationError("updatedAt must not precede createdAt");
  }
  if (
    result !== undefined &&
    (result.taskId !== taskId ||
      result.attemptId !== attemptId ||
      (target !== undefined && result.executor.kind !== target.executor.type) ||
      (target === undefined && executor !== undefined && result.executor.kind !== executor.type) ||
      (target?.executor.type === "remote" &&
        result.executor.workerId !== target.executor.workerId) ||
      (target !== undefined &&
        target.executor.type !== "remote" &&
        result.executor.workerId !== undefined))
  ) {
    throw operationError("Task result identity or executor does not match its record");
  }
  const parsed: TaskRecord = {
    taskId,
    attemptId,
    request,
    state: value.state as TaskRecordState,
    createdAt,
    updatedAt,
    ...(target === undefined ? {} : { target }),
    ...(binding === undefined ? {} : { binding }),
    ...(executor === undefined ? {} : { executor }),
    ...(authority === undefined ? {} : { authority }),
    ...(cancellation === undefined ? {} : { cancellation }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(result === undefined ? {} : { result }),
  };
  assertSerializedLimit(parsed);
  return parsed;
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
  snapshot(request: RuntimeSnapshotRequest): Promise<RuntimeSnapshotResponse>;
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
