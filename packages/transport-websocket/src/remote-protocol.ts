import { createHash } from "node:crypto";
import {
  DiagnosticError,
  parseExecutionRequest,
  parseExecutionResult,
  runtimeDiagnostic,
  serializeWireValue,
  type ExecutionRequest,
  type ExecutionResult,
  type JsonObject,
  type JsonValue,
  type RuntimeDiagnostic,
  type WorkerMessageType,
  type WorkerId,
} from "@tegojs/contracts";

export const REMOTE_ASSIGN = "task.assign";
export const REMOTE_ACK = "task.acknowledge";
export const REMOTE_CANCEL = "task.cancel";
export const REMOTE_CANCEL_ACK = REMOTE_ACK;
export const REMOTE_INVENTORY = "session.reconcile";
export const REMOTE_INVENTORY_RESULT = REMOTE_INVENTORY;
export const REMOTE_RESULT = "task.result";
export const REMOTE_RESULT_ACK = REMOTE_ACK;

export interface RemoteSessionMessage {
  readonly messageId: string;
  readonly correlationId?: string;
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
  readonly revision?: number;
}

export interface RemoteAttemptCommitCondition {
  readonly expectedRevision: number | null;
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

export class MemoryRemoteAttemptStore implements RemoteAttemptStore {
  readonly #records = new Map<string, RemoteAttemptRecord>();
  readonly #onSave: ((record: RemoteAttemptRecord) => void) | undefined;

  constructor(options: MemoryRemoteAttemptStoreOptions = {}) {
    this.#onSave = options.onSave;
  }

  async save(record: RemoteAttemptRecord): Promise<void> {
    const key = attemptKey(record.request.taskId, record.request.attemptId);
    const current = this.#records.get(key);
    const snapshot = cloneJson({
      ...record,
      revision: record.revision ?? (current?.revision ?? 0) + 1,
    }) as unknown as RemoteAttemptRecord;
    this.#records.set(key, snapshot);
    this.#onSave?.(snapshot);
  }

  async commit(
    record: RemoteAttemptRecord,
    condition: RemoteAttemptCommitCondition,
  ): Promise<RemoteAttemptRecord | undefined> {
    const key = attemptKey(record.request.taskId, record.request.attemptId);
    const current = this.#records.get(key);
    const currentRevision = current?.revision ?? 0;
    if (
      (condition.expectedRevision === null && current !== undefined) ||
      (condition.expectedRevision !== null && currentRevision !== condition.expectedRevision) ||
      (condition.expectedEpoch !== undefined &&
        current !== undefined &&
        current.epoch !== condition.expectedEpoch)
    ) {
      return undefined;
    }
    const snapshot = cloneJson({
      ...record,
      revision: currentRevision + 1,
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
