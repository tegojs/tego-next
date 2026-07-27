import { createHash } from "node:crypto";
import {
  type ApplicationId,
  assertExecutionBindingMatches,
  type CapabilityBinding,
  type CapabilityDefinition,
  type ComponentCapabilityInvocation,
  type ComponentId,
  DiagnosticError,
  type ExecutionRequest,
  type ExecutionResult,
  type JsonObject,
  type JsonValue,
  type Permission,
  type PluginId,
  parseApplicationId,
  parseComponentId,
  parseExecutionRequest,
  parseExecutionResult,
  parsePluginId,
  parseSequence,
  parseTaskExecutionTarget,
  type RuntimeDiagnostic,
  runtimeDiagnostic,
  serializeWireValue,
  type TaskExecutionTarget,
  type WorkerId,
  type WorkerMessageType,
} from "@tegojs/contracts";

export const REMOTE_ASSIGN = "task.assign";
export const REMOTE_ACK = "task.acknowledge";
export const REMOTE_CANCEL = "task.cancel";
export const REMOTE_CANCEL_ACK = REMOTE_ACK;
export const REMOTE_INVENTORY = "session.reconcile";
export const REMOTE_INVENTORY_RESULT = REMOTE_INVENTORY;
export const REMOTE_RESULT = "task.result";
export const REMOTE_RESULT_ACK = REMOTE_ACK;
export const REMOTE_CAPABILITY_INVOKE = "capability.invoke";
export const REMOTE_COMPONENT_ACTIVATE = "component.activate";
export const REMOTE_COMPONENT_ACTIVATED = "component.activated";
export const REMOTE_COMPONENT_DRAIN = "component.drain";
export const REMOTE_COMPONENT_STOP = "component.stop";

export interface RemoteSessionMessage {
  readonly messageId: string;
  readonly correlationId: string;
  readonly type: WorkerMessageType;
  readonly payload: JsonValue;
  readonly binary?: Uint8Array;
}

export type RemoteSessionState = "authenticating" | "closed" | "ready" | "unavailable";

export interface RemoteSession {
  readonly epoch: string;
  readonly state: RemoteSessionState;
  readonly available: boolean;
  readonly acceptingAssignments: boolean;
  onMessage(listener: (message: RemoteSessionMessage) => void): () => void;
  onStateChange(listener: (state: RemoteSessionState) => void): () => void;
  send(
    type: WorkerMessageType,
    payload: JsonValue,
    options?: { readonly correlationId?: string; readonly binary?: Uint8Array },
  ): Promise<string>;
  request(
    type: WorkerMessageType,
    payload: JsonValue,
    options?: { readonly binary?: Uint8Array },
  ): Promise<RemoteSessionMessage>;
}

export interface RemoteAttemptIdentity extends JsonObject {
  readonly taskId: ExecutionRequest["taskId"];
  readonly attemptId: ExecutionRequest["attemptId"];
}

export interface RemoteCapabilityInvocation extends JsonObject {
  readonly invocationId: string;
  readonly bindingFingerprint: string;
  readonly target: TaskExecutionTarget;
  readonly invocation: ComponentCapabilityInvocation;
}

export interface RemoteCapabilityInvocationResponse extends JsonObject {
  readonly invocationId: string;
  readonly fingerprint: string;
  readonly ok: boolean;
  readonly value?: JsonValue;
  readonly error?: {
    readonly code: `CAPABILITY_${string}` | `PROTOCOL_${string}`;
    readonly message: string;
  };
}

export interface RemoteComponentActivationIdentity extends JsonObject {
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly componentId: ComponentId;
}

export interface RemoteComponentActivation extends JsonObject {
  readonly identity: RemoteComponentActivationIdentity;
  readonly target: TaskExecutionTarget;
  readonly configuration: JsonValue;
  readonly permissionGrants: readonly Permission[];
  readonly capabilityDefinitions: readonly CapabilityDefinition[];
  readonly capabilityBindings: readonly CapabilityBinding[];
  readonly bindingFingerprint: string;
}

export interface RemoteComponentLifecycleResponse extends JsonObject {
  readonly ok: boolean;
  readonly target: TaskExecutionTarget;
  readonly bindingFingerprint?: string;
  readonly error?: {
    readonly code: `LIFECYCLE_${string}` | `PROTOCOL_${string}`;
    readonly message: string;
  };
}

export type RemoteAttemptState =
  | "acknowledged"
  | "assigned"
  | "expired"
  | "running"
  | "terminal"
  | "unknown";

export interface RemoteAttemptRecord extends JsonObject {
  readonly workerId: WorkerId;
  readonly request: ExecutionRequest;
  readonly fingerprint: string;
  readonly state: RemoteAttemptState;
  readonly epoch: string;
  readonly updatedAt: string;
  readonly result?: ExecutionResult;
  readonly acknowledgedAt?: string;
  readonly cancellation?: "cancelled" | "timed-out";
  readonly revision: string;
}

export interface RemoteAttemptCommitCondition {
  readonly expectedRevision: string | null;
  readonly expectedEpoch?: string;
}

export interface RemoteAttemptStore {
  save(record: RemoteAttemptRecord): Promise<void>;
  commit(
    record: RemoteAttemptRecord,
    condition: RemoteAttemptCommitCondition,
  ): Promise<RemoteAttemptRecord | undefined>;
  delete?(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): Promise<void>;
  load(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): Promise<RemoteAttemptRecord | undefined>;
  list(workerId: WorkerId): Promise<readonly RemoteAttemptRecord[]>;
}

export interface MemoryRemoteAttemptStoreOptions {
  readonly onSave?: (record: RemoteAttemptRecord) => void;
}

const MAXIMUM_UNSIGNED_64 = 18_446_744_073_709_551_615n;

export class RemoteAttemptRevisionError extends RangeError {
  constructor(message = "Remote attempt revision is not a valid unsigned 64-bit decimal string") {
    super(message);
    this.name = "RemoteAttemptRevisionError";
  }
}

export function isRemoteAttemptRevisionError(error: unknown): error is RemoteAttemptRevisionError {
  return error instanceof RemoteAttemptRevisionError;
}

export class MemoryRemoteAttemptStore implements RemoteAttemptStore {
  readonly #records = new Map<string, RemoteAttemptRecord>();
  readonly #onSave: ((record: RemoteAttemptRecord) => void) | undefined;

  constructor(options: MemoryRemoteAttemptStoreOptions = {}) {
    this.#onSave = options.onSave;
  }

  async save(record: RemoteAttemptRecord): Promise<void> {
    const key = attemptKey(record.request.taskId, record.request.attemptId);
    const snapshot = cloneJson({
      ...record,
      revision: parseAttemptRevision(record.revision),
    }) as unknown as RemoteAttemptRecord;
    this.#records.set(key, snapshot);
    this.#onSave?.(snapshot);
  }

  async commit(
    record: RemoteAttemptRecord,
    condition: RemoteAttemptCommitCondition,
  ): Promise<RemoteAttemptRecord | undefined> {
    parseAttemptRevision(record.revision);
    const key = attemptKey(record.request.taskId, record.request.attemptId);
    const current = this.#records.get(key);
    const currentRevision = current?.revision;
    if (
      (condition.expectedRevision === null && current !== undefined) ||
      (condition.expectedRevision !== null &&
        (currentRevision === undefined ||
          parseAttemptRevision(currentRevision) !==
            parseAttemptRevision(condition.expectedRevision))) ||
      (condition.expectedEpoch !== undefined &&
        current !== undefined &&
        current.epoch !== condition.expectedEpoch)
    ) {
      return undefined;
    }
    const snapshot = cloneJson({
      ...record,
      revision: incrementRevision(currentRevision ?? "0"),
    }) as unknown as RemoteAttemptRecord;
    this.#records.set(key, snapshot);
    this.#onSave?.(snapshot);
    return cloneJson(snapshot) as unknown as RemoteAttemptRecord;
  }

  async load(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): Promise<RemoteAttemptRecord | undefined> {
    const record = this.#records.get(attemptKey(taskId, attemptId));
    return record === undefined ? undefined : (cloneJson(record) as unknown as RemoteAttemptRecord);
  }

  async delete(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): Promise<void> {
    this.#records.delete(attemptKey(taskId, attemptId));
  }

  async list(workerId: WorkerId): Promise<readonly RemoteAttemptRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.workerId === workerId)
      .map((record) => cloneJson(record) as unknown as RemoteAttemptRecord);
  }
}

function incrementRevision(revision: string): string {
  const current = BigInt(parseAttemptRevision(revision));
  if (current === MAXIMUM_UNSIGNED_64) {
    throw new RemoteAttemptRevisionError(
      "Remote attempt revision exhausted its unsigned 64-bit range",
    );
  }
  return (current + 1n).toString();
}

export function parseAttemptRevision(revision: unknown): string {
  if (typeof revision !== "string") {
    throw new RemoteAttemptRevisionError();
  }
  let parsed: string;
  try {
    parsed = parseSequence(revision);
  } catch {
    throw new RemoteAttemptRevisionError();
  }
  if (BigInt(parsed) > MAXIMUM_UNSIGNED_64) {
    throw new RemoteAttemptRevisionError(
      "Remote attempt revision exceeds the unsigned 64-bit limit",
    );
  }
  return parsed;
}

export interface RemoteResultStore {
  readonly durable: boolean;
  put(result: ExecutionResult): Promise<void>;
  delete(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): Promise<void>;
  list(): Promise<readonly ExecutionResult[]>;
}

export interface MemoryRemoteResultStoreOptions {
  readonly durable?: boolean;
}

export class MemoryRemoteResultStore implements RemoteResultStore {
  readonly durable = false;
  readonly #results = new Map<string, ExecutionResult>();

  constructor(options: MemoryRemoteResultStoreOptions = {}) {
    if (options.durable === true) {
      throw new TypeError("MemoryRemoteResultStore cannot claim crash durability");
    }
  }

  async put(result: ExecutionResult): Promise<void> {
    this.#results.set(
      attemptKey(result.taskId, result.attemptId),
      cloneJson(result) as unknown as ExecutionResult,
    );
  }

  async delete(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): Promise<void> {
    this.#results.delete(attemptKey(taskId, attemptId));
  }

  async list(): Promise<readonly ExecutionResult[]> {
    return [...this.#results.values()].map(
      (result) => cloneJson(result) as unknown as ExecutionResult,
    );
  }
}

export function attemptKey(
  taskId: ExecutionRequest["taskId"],
  attemptId: ExecutionRequest["attemptId"],
): string {
  return `${taskId.length}:${taskId}${attemptId}`;
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return serializeWireValue(value) as T;
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

export function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function requestFingerprint(request: ExecutionRequest): string {
  return jsonFingerprint(request);
}

export function jsonFingerprint(value: JsonValue): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function capabilityInvocationFingerprint(request: RemoteCapabilityInvocation): string {
  return jsonFingerprint({
    bindingFingerprint: request.bindingFingerprint,
    target: request.target,
    invocation: request.invocation,
  });
}

export function parseRemoteCapabilityInvocation(value: unknown): RemoteCapabilityInvocation {
  const object = asUnknownObject(value, "Remote capability invocation");
  const invocationId = boundedIdentity(object.invocationId, "Capability invocation id");
  const bindingFingerprint = sha256Fingerprint(object.bindingFingerprint);
  const target = parseTaskExecutionTarget(object.target);
  const invocationObject = asUnknownObject(object.invocation, "Capability invocation");
  const nestedInvocationId = boundedIdentity(
    invocationObject.invocationId,
    "Nested capability invocation id",
  );
  if (nestedInvocationId !== invocationId) {
    throw new TypeError("Capability invocation identities must match");
  }
  const identity = asUnknownObject(invocationObject.identity, "Capability identity");
  const name = boundedIdentity(identity.name, "Capability name");
  const protocolVersion = boundedIdentity(identity.protocolVersion, "Capability protocol version");
  const method = boundedIdentity(invocationObject.method, "Capability method");
  const input = serializeWireValue(invocationObject.input);
  return {
    invocationId,
    bindingFingerprint,
    target,
    invocation: {
      invocationId,
      identity: { name, protocolVersion },
      method,
      input,
    },
  };
}

export function parseRemoteCapabilityResponse(value: unknown): RemoteCapabilityInvocationResponse {
  const object = asUnknownObject(value, "Remote capability response");
  const invocationId = boundedIdentity(object.invocationId, "Capability invocation id");
  const fingerprint = sha256Fingerprint(object.fingerprint);
  if (typeof object.ok !== "boolean") {
    throw new TypeError("Remote capability response ok must be a boolean");
  }
  if (object.ok) {
    if (object.error !== undefined) {
      throw new TypeError("Successful remote capability response must not include an error");
    }
    return {
      invocationId,
      fingerprint,
      ok: true,
      value: serializeWireValue(object.value),
    };
  }
  const error = asUnknownObject(object.error, "Remote capability response error");
  const code = boundedIdentity(error.code, "Remote capability error code");
  if (!/^(?:CAPABILITY|PROTOCOL)_[A-Z0-9_]+$/u.test(code)) {
    throw new TypeError("Remote capability response error code is invalid");
  }
  return {
    invocationId,
    fingerprint,
    ok: false,
    error: {
      code: code as `CAPABILITY_${string}` | `PROTOCOL_${string}`,
      message: boundedText(error.message, "Remote capability error message"),
    },
  };
}

export function parseRemoteComponentActivation(value: unknown): RemoteComponentActivation {
  const object = asUnknownObject(value, "Remote component activation");
  const identityObject = asUnknownObject(object.identity, "Remote component activation identity");
  const identity = {
    applicationId: parseApplicationId(identityObject.applicationId),
    pluginId: parsePluginId(identityObject.pluginId),
    componentId: parseComponentId(identityObject.componentId),
  };
  const target = parseTaskExecutionTarget(object.target);
  const binding = assertExecutionBindingMatches(
    { ...identity, target },
    {
      configuration: object.configuration,
      permissionGrants: object.permissionGrants,
      capabilityDefinitions: object.capabilityDefinitions,
      capabilityBindings: object.capabilityBindings,
      fingerprint: object.bindingFingerprint,
    },
  );
  return {
    identity,
    target,
    configuration: binding.configuration,
    permissionGrants: binding.permissionGrants,
    capabilityDefinitions: binding.capabilityDefinitions,
    capabilityBindings: binding.capabilityBindings,
    bindingFingerprint: binding.fingerprint,
  };
}

export function parseRemoteComponentLifecycleResponse(
  value: unknown,
): RemoteComponentLifecycleResponse {
  const object = asUnknownObject(value, "Remote component lifecycle response");
  if (typeof object.ok !== "boolean") {
    throw new TypeError("Remote component lifecycle response ok must be a boolean");
  }
  const target = parseTaskExecutionTarget(object.target);
  const bindingFingerprint =
    object.bindingFingerprint === undefined
      ? undefined
      : sha256Fingerprint(object.bindingFingerprint);
  if (object.ok) {
    if (object.error !== undefined) {
      throw new TypeError("Successful component lifecycle response must not include an error");
    }
    return {
      ok: true,
      target,
      ...(bindingFingerprint === undefined ? {} : { bindingFingerprint }),
    };
  }
  const error = asUnknownObject(object.error, "Remote component lifecycle error");
  const code = boundedIdentity(error.code, "Remote component lifecycle error code");
  if (!/^(?:LIFECYCLE|PROTOCOL)_[A-Z0-9_]+$/u.test(code)) {
    throw new TypeError("Remote component lifecycle response error code is invalid");
  }
  return {
    ok: false,
    target,
    ...(bindingFingerprint === undefined ? {} : { bindingFingerprint }),
    error: {
      code: code as `LIFECYCLE_${string}` | `PROTOCOL_${string}`,
      message: boundedText(error.message, "Remote component lifecycle error message"),
    },
  };
}

function asUnknownObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedIdentity(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function boundedText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function sha256Fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Remote capability fingerprint must be a SHA-256 hex digest");
  }
  return value;
}

export function parseRemoteRequest(value: unknown): ExecutionRequest {
  return parseExecutionRequest(value);
}

export function parseRemoteResult(value: unknown): ExecutionResult {
  return parseExecutionResult(value);
}

export function remoteDiagnostic(
  code: RuntimeDiagnostic["code"],
  message: string,
  id: string,
  observedAt: string,
  details?: JsonValue,
): RuntimeDiagnostic {
  return runtimeDiagnostic({
    code,
    message,
    source: { kind: "executor", id },
    observedAt,
    ...(details === undefined ? {} : { details }),
  });
}

export function remoteError(
  code: RuntimeDiagnostic["code"],
  message: string,
  id: string,
  observedAt: string,
  details?: JsonValue,
): DiagnosticError {
  return new DiagnosticError(remoteDiagnostic(code, message, id, observedAt, details));
}

export function asObject(value: JsonValue, name: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

export function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return limit;
}
