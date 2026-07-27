import {
  type ExecutionRequest,
  type JsonObject,
  parseExecutionRequest,
  parseExecutionResult,
  parseWorkerId,
  STATE_QUERY_MAX_LIMIT,
  type StateFencing,
  type StateKey,
  type StateStore,
  type StateTransaction,
  serializeWireValue,
  type WorkerId,
} from "@tegojs/contracts";
import {
  parseAttemptRevision,
  type RemoteAttemptCommitCondition,
  type RemoteAttemptRecovery,
  type RemoteAttemptRecord,
  type RemoteAttemptState,
  type RemoteAttemptStore,
  requestFingerprint,
} from "@tegojs/transport-websocket";

const WORKER_ATTEMPT_COLLECTION = "worker-attempts";
const WORKER_ACTIVE_ATTEMPT_COLLECTION = "worker-active-attempts";
const WORKER_ATTEMPT_METADATA_COLLECTION = "worker-attempt-metadata";
const WORKER_ATTEMPT_STATES = new Set<RemoteAttemptState>([
  "acknowledged",
  "assigned",
  "expired",
  "running",
  "terminal",
  "unknown",
]);
const WORKER_ATTEMPT_FIELDS = new Set([
  "acknowledgedAt",
  "cancellation",
  "epoch",
  "fingerprint",
  "request",
  "result",
  "revision",
  "state",
  "updatedAt",
  "workerId",
]);

interface WorkerAttemptMetadata extends JsonObject {
  readonly highestEpoch: string;
  readonly workerId: WorkerId;
}

function parseAttemptMetadata(value: unknown, workerId: WorkerId): WorkerAttemptMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Persisted Worker attempt metadata must be an object");
  }
  const fields = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(fields).length !== 2 ||
    !Object.hasOwn(fields, "highestEpoch") ||
    !Object.hasOwn(fields, "workerId")
  ) {
    throw new Error("Persisted Worker attempt metadata fields are invalid");
  }
  const persistedWorkerId = parseWorkerId(fields.workerId);
  if (persistedWorkerId !== workerId) {
    throw new Error("Persisted Worker attempt metadata belongs to a different Worker");
  }
  return {
    highestEpoch: parseAttemptRevision(fields.highestEpoch),
    workerId: persistedWorkerId,
  };
}

function attemptStateId(
  workerId: WorkerId,
  taskId: ExecutionRequest["taskId"],
  attemptId: ExecutionRequest["attemptId"],
): string {
  return `${workerId}:${taskId.length}:${taskId}${attemptId}`;
}

function parseAttemptTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`Persisted Worker attempt ${field} is invalid`);
  }
  return value;
}

function parsePersistedAttempt(
  value: unknown,
  options: {
    readonly expectedAttemptId?: ExecutionRequest["attemptId"];
    readonly expectedStateId: string;
    readonly expectedTaskId?: ExecutionRequest["taskId"];
    readonly workerId: WorkerId;
  },
): RemoteAttemptRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Persisted Worker attempt must be an object");
  }
  const fields = value as Readonly<Record<string, unknown>>;
  for (const field of Object.keys(fields)) {
    if (!WORKER_ATTEMPT_FIELDS.has(field)) {
      throw new Error("Persisted Worker attempt contains an unknown field");
    }
  }
  const workerId = parseWorkerId(fields.workerId);
  if (workerId !== options.workerId) {
    throw new Error("Persisted Worker attempt belongs to a different Worker");
  }
  const request = parseExecutionRequest(fields.request);
  if (
    (options.expectedTaskId !== undefined && request.taskId !== options.expectedTaskId) ||
    (options.expectedAttemptId !== undefined && request.attemptId !== options.expectedAttemptId) ||
    attemptStateId(workerId, request.taskId, request.attemptId) !== options.expectedStateId
  ) {
    throw new Error("Persisted Worker attempt identity does not match its state key");
  }
  const fingerprint = requestFingerprint(request);
  if (fields.fingerprint !== fingerprint) {
    throw new Error("Persisted Worker attempt fingerprint does not match its request");
  }
  if (
    typeof fields.state !== "string" ||
    !WORKER_ATTEMPT_STATES.has(fields.state as RemoteAttemptState)
  ) {
    throw new Error("Persisted Worker attempt state is invalid");
  }
  const state = fields.state as RemoteAttemptState;
  const epoch = parseAttemptRevision(fields.epoch);
  const revision = parseAttemptRevision(fields.revision);
  const updatedAt = parseAttemptTimestamp(fields.updatedAt, "updatedAt");
  const result = fields.result === undefined ? undefined : parseExecutionResult(fields.result);
  if (
    result !== undefined &&
    (result.taskId !== request.taskId || result.attemptId !== request.attemptId)
  ) {
    throw new Error("Persisted Worker attempt result identity does not match its request");
  }
  if ((state === "terminal" || state === "expired") !== (result !== undefined)) {
    throw new Error("Persisted Worker attempt state and result are inconsistent");
  }
  const acknowledgedAt =
    fields.acknowledgedAt === undefined
      ? undefined
      : parseAttemptTimestamp(fields.acknowledgedAt, "acknowledgedAt");
  if (acknowledgedAt !== undefined && state !== "terminal" && state !== "expired") {
    throw new Error("Persisted Worker attempt acknowledgement state is invalid");
  }
  const cancellation = fields.cancellation;
  if (cancellation !== undefined && cancellation !== "cancelled" && cancellation !== "timed-out") {
    throw new Error("Persisted Worker attempt cancellation is invalid");
  }
  return {
    workerId,
    request,
    fingerprint,
    state,
    epoch,
    updatedAt,
    revision,
    ...(result === undefined ? {} : { result }),
    ...(acknowledgedAt === undefined ? {} : { acknowledgedAt }),
    ...(cancellation === undefined ? {} : { cancellation }),
  };
}

function cloneRecord(record: RemoteAttemptRecord): RemoteAttemptRecord {
  return serializeWireValue(record) as unknown as RemoteAttemptRecord;
}

function incrementRevision(value: string): string {
  return (BigInt(parseAttemptRevision(value)) + 1n).toString();
}

export interface StateRemoteAttemptStoreOptions {
  readonly fencing?: StateFencing;
  readonly state: StateStore;
  readonly workerId: WorkerId;
}

export class StateRemoteAttemptStore implements RemoteAttemptStore {
  readonly #state: StateStore;
  readonly #transactionOptions: { readonly fencing?: StateFencing };
  readonly #workerId: WorkerId;

  constructor(options: StateRemoteAttemptStoreOptions) {
    this.#state = options.state;
    this.#transactionOptions =
      options.fencing === undefined ? {} : { fencing: structuredClone(options.fencing) };
    this.#workerId = parseWorkerId(options.workerId);
  }

  async save(record: RemoteAttemptRecord): Promise<void> {
    this.#assertWorker(record.workerId);
    const key = this.#key(record.request.taskId, record.request.attemptId);
    const snapshot = parsePersistedAttempt(record, {
      expectedAttemptId: record.request.attemptId,
      expectedStateId: key.id,
      expectedTaskId: record.request.taskId,
      workerId: this.#workerId,
    });
    await this.#state.transact(this.#transactionOptions, async (transaction) => {
      const current = await transaction.get(key);
      await transaction.put(key, snapshot, {
        expectedRevision: current?.revision ?? "absent",
      });
      await this.#writeRecoveryState(transaction, snapshot);
      return null;
    });
  }

  async commit(
    record: RemoteAttemptRecord,
    condition: RemoteAttemptCommitCondition,
  ): Promise<RemoteAttemptRecord | undefined> {
    this.#assertWorker(record.workerId);
    const key = this.#key(record.request.taskId, record.request.attemptId);
    const validated = parsePersistedAttempt(record, {
      expectedAttemptId: record.request.attemptId,
      expectedStateId: key.id,
      expectedTaskId: record.request.taskId,
      workerId: this.#workerId,
    });
    if (condition.expectedRevision !== null) {
      parseAttemptRevision(condition.expectedRevision);
    }
    if (condition.expectedEpoch !== undefined) {
      parseAttemptRevision(condition.expectedEpoch);
    }
    const committed = await this.#state.transact(this.#transactionOptions, async (transaction) => {
      const current = await transaction.get(key);
      const currentRecord =
        current === undefined
          ? undefined
          : parsePersistedAttempt(current.value, {
              expectedAttemptId: record.request.attemptId,
              expectedStateId: key.id,
              expectedTaskId: record.request.taskId,
              workerId: this.#workerId,
            });
      if (
        (condition.expectedRevision === null && current !== undefined) ||
        (condition.expectedRevision !== null &&
          currentRecord?.revision !== condition.expectedRevision) ||
        (condition.expectedEpoch !== undefined &&
          currentRecord !== undefined &&
          currentRecord.epoch !== condition.expectedEpoch)
      ) {
        return null;
      }
      const snapshot = cloneRecord({
        ...validated,
        revision: incrementRevision(currentRecord?.revision ?? "0"),
      });
      await transaction.put(key, snapshot, {
        expectedRevision: current?.revision ?? "absent",
      });
      await this.#writeRecoveryState(transaction, snapshot);
      return snapshot;
    });
    return committed === null ? undefined : cloneRecord(committed);
  }

  async delete(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): Promise<void> {
    const key = this.#key(taskId, attemptId);
    await this.#state.transact(this.#transactionOptions, async (transaction) => {
      const current = await transaction.get(key);
      if (current !== undefined) {
        await transaction.delete(key, { expectedRevision: current.revision });
      }
      const activeKey = this.#activeKey(taskId, attemptId);
      const active = await transaction.get(activeKey);
      if (active !== undefined) {
        await transaction.delete(activeKey, { expectedRevision: active.revision });
      }
      return null;
    });
  }

  async load(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): Promise<RemoteAttemptRecord | undefined> {
    const key = this.#key(taskId, attemptId);
    const record = await this.#state.read(key);
    return record === undefined
      ? undefined
      : parsePersistedAttempt(record.value, {
          expectedAttemptId: attemptId,
          expectedStateId: key.id,
          expectedTaskId: taskId,
          workerId: this.#workerId,
        });
  }

  async list(workerId: WorkerId): Promise<readonly RemoteAttemptRecord[]> {
    if (parseWorkerId(workerId) !== this.#workerId) return [];
    const records: RemoteAttemptRecord[] = [];
    for await (const record of this.#state.scan<RemoteAttemptRecord>({
      namespace: "tego",
      collection: WORKER_ATTEMPT_COLLECTION,
      idPrefix: `${this.#workerId}:`,
    })) {
      records.push(
        parsePersistedAttempt(record.value, {
          expectedStateId: record.key.id,
          workerId: this.#workerId,
        }),
      );
    }
    return records;
  }

  async recover(workerId: WorkerId, limit: number): Promise<RemoteAttemptRecovery> {
    if (parseWorkerId(workerId) !== this.#workerId) {
      return { highestEpoch: "0", records: [] };
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("Remote attempt recovery limit must be a positive safe integer");
    }
    return this.#state.transact(this.#transactionOptions, async (transaction) => {
      const metadata = await transaction.get(this.#metadataKey());
      let highestEpoch =
        metadata === undefined
          ? "0"
          : parseAttemptMetadata(metadata.value, this.#workerId).highestEpoch;
      const records: RemoteAttemptRecord[] = [];
      let afterId: string | undefined;
      while (records.length < limit) {
        const pageLimit = Math.min(limit - records.length, STATE_QUERY_MAX_LIMIT);
        let pageCount = 0;
        for await (const record of transaction.scan<RemoteAttemptRecord>({
          namespace: "tego",
          collection: WORKER_ACTIVE_ATTEMPT_COLLECTION,
          idPrefix: `${this.#workerId}:`,
          ...(afterId === undefined ? {} : { afterId }),
          limit: pageLimit,
        })) {
          pageCount += 1;
          afterId = record.key.id;
          const parsed = parsePersistedAttempt(record.value, {
            expectedStateId: record.key.id,
            workerId: this.#workerId,
          });
          if (parsed.state === "expired") {
            throw new Error("Active Worker attempt index contains an expired tombstone");
          }
          if (BigInt(parsed.epoch) > BigInt(highestEpoch)) highestEpoch = parsed.epoch;
          records.push(parsed);
        }
        if (pageCount < pageLimit) break;
      }
      return {
        highestEpoch,
        records,
      };
    });
  }

  async #writeRecoveryState(
    transaction: StateTransaction,
    snapshot: RemoteAttemptRecord,
  ): Promise<void> {
    const activeKey = this.#activeKey(snapshot.request.taskId, snapshot.request.attemptId);
    const active = await transaction.get(activeKey);
    if (snapshot.state === "expired") {
      if (active !== undefined) {
        await transaction.delete(activeKey, { expectedRevision: active.revision });
      }
    } else {
      await transaction.put(activeKey, snapshot, {
        expectedRevision: active?.revision ?? "absent",
      });
    }
    const metadataKey = this.#metadataKey();
    const currentMetadata = await transaction.get(metadataKey);
    const highestEpoch =
      currentMetadata === undefined
        ? "0"
        : parseAttemptMetadata(currentMetadata.value, this.#workerId).highestEpoch;
    if (BigInt(snapshot.epoch) > BigInt(highestEpoch)) {
      const metadata: WorkerAttemptMetadata = {
        highestEpoch: snapshot.epoch,
        workerId: this.#workerId,
      };
      await transaction.put(metadataKey, metadata, {
        expectedRevision: currentMetadata?.revision ?? "absent",
      });
    }
  }

  #assertWorker(workerId: WorkerId): void {
    if (parseWorkerId(workerId) !== this.#workerId) {
      throw new Error("Remote attempt record belongs to a different Worker");
    }
  }

  #key(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): StateKey<RemoteAttemptRecord> {
    return {
      namespace: "tego",
      collection: WORKER_ATTEMPT_COLLECTION,
      id: attemptStateId(this.#workerId, taskId, attemptId),
    };
  }

  #activeKey(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): StateKey<RemoteAttemptRecord> {
    return {
      namespace: "tego",
      collection: WORKER_ACTIVE_ATTEMPT_COLLECTION,
      id: attemptStateId(this.#workerId, taskId, attemptId),
    };
  }

  #metadataKey(): StateKey<WorkerAttemptMetadata> {
    return {
      namespace: "tego",
      collection: WORKER_ATTEMPT_METADATA_COLLECTION,
      id: this.#workerId,
    };
  }
}
