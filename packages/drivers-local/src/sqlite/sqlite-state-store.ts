import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  DiagnosticError,
  OUTBOX_PAYLOAD_MAX_BYTES,
  OUTBOX_TOPIC_MAX_LENGTH,
  parseFencingEpoch,
  parseMessageId,
  parseOperationId,
  parseRevision,
  runtimeDiagnostic,
  serializeWireValue,
  type Clock,
  type DriverHealth,
  type ExpectedRevision,
  type JsonValue,
  type OperationJournalEntry,
  type OperationJournalQuery,
  type OutboxAcknowledgement,
  type OutboxAcknowledgementRequest,
  type OutboxClaim,
  type OutboxClaimRequest,
  type OutboxMessage,
  type PersistedOperationJournalEntry,
  type Revision,
  type ScannedState,
  type StateChange,
  type StateKey,
  type StateQuery,
  type StateStore,
  type StateTransaction,
  type StateTransactionOptions,
  type StateWriteOptions,
  type Versioned,
} from "@tegojs/contracts";
import { applySqliteMigrations } from "./migrations.js";

const zeroRevision = parseRevision("0");

const systemClock: Clock = {
  now: () => new Date(),
  sleep: async (delayMs, signal) => {
    await delay(delayMs, undefined, signal === undefined ? undefined : { signal });
  },
};

interface StoredRecord {
  readonly key: StateKey<JsonValue>;
  readonly value: JsonValue;
  readonly revision: Revision;
}

interface PutMutation {
  readonly kind: "put";
  readonly key: StateKey<JsonValue>;
  readonly value: JsonValue;
  readonly expectedRevision: ExpectedRevision;
}

interface DeleteMutation {
  readonly kind: "delete";
  readonly key: StateKey<JsonValue>;
  readonly expectedRevision: ExpectedRevision;
}

type Mutation = DeleteMutation | PutMutation;

interface StagedTransaction {
  readonly mutations: readonly Mutation[];
  readonly operations: readonly OperationJournalEntry[];
  readonly outbox: readonly OutboxMessage[];
}

interface IdempotencyIdentity {
  readonly key: string;
  readonly fingerprint: string;
}

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly result: JsonValue;
}

export interface SqliteStateStoreOptions {
  readonly databasePath: string;
  readonly clock?: Clock;
}

function stateError(
  code:
    | "STATE_CLOSED"
    | "STATE_DATA_INVALID"
    | "STATE_FENCE_STALE"
    | "STATE_IDEMPOTENCY_CONFLICT"
    | "STATE_QUERY_INVALID"
    | "STATE_REVISION_CONFLICT",
  message: string,
  details: JsonValue,
  clock: Clock,
): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "state", id: "sqlite-state-store" },
      details,
      observedAt: clock.now().toISOString(),
    }),
  );
}

function cloneKey<T extends JsonValue>(key: StateKey<T>): StateKey<T> {
  return {
    namespace: key.namespace,
    collection: key.collection,
    id: key.id,
  };
}

function serializedKey(key: StateKey<JsonValue>): string {
  return JSON.stringify([key.namespace, key.collection, key.id]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareKeys(left: StateKey<JsonValue>, right: StateKey<JsonValue>): number {
  return (
    compareCodeUnits(left.namespace, right.namespace) ||
    compareCodeUnits(left.collection, right.collection) ||
    compareCodeUnits(left.id, right.id)
  );
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function assertOutboxClaimRequest(request: OutboxClaimRequest, clock: Clock): number {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.owner) ||
    (request.topic !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.topic)) ||
    !Number.isSafeInteger(request.leaseDurationMs) ||
    request.leaseDurationMs <= 0 ||
    request.leaseDurationMs > 86_400_000 ||
    (request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) || request.limit <= 0 || request.limit > 100))
  ) {
    throw stateError(
      "STATE_QUERY_INVALID",
      "Outbox claim request is invalid",
      {
        leaseDurationMs: request.leaseDurationMs,
        limit: request.limit ?? null,
        owner: request.owner,
        topic: request.topic ?? null,
      },
      clock,
    );
  }
  return request.limit ?? 1;
}

function assertOutboxAcknowledgementRequest(
  request: OutboxAcknowledgementRequest,
  clock: Clock,
): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.owner) ||
    (request.outcome === "retry" &&
      (request.retryAt === undefined || !validTimestamp(request.retryAt))) ||
    (request.outcome === "completed" && request.retryAt !== undefined)
  ) {
    throw stateError(
      "STATE_QUERY_INVALID",
      "Outbox acknowledgement request is invalid",
      {
        messageId: request.messageId,
        outcome: request.outcome,
        owner: request.owner,
        retryAt: request.retryAt ?? null,
      },
      clock,
    );
  }
}

function sameOutboxMessage(left: OutboxMessage, right: OutboxMessage): boolean {
  return (
    left.messageId === right.messageId &&
    left.operationId === right.operationId &&
    left.topic === right.topic &&
    canonicalJson(left.payload) === canonicalJson(right.payload)
  );
}

function assertOutboxMessage(message: OutboxMessage, clock: Clock): void {
  if (
    message.topic.length > OUTBOX_TOPIC_MAX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(message.topic) ||
    Buffer.byteLength(canonicalJson(message.payload), "utf8") > OUTBOX_PAYLOAD_MAX_BYTES
  ) {
    throw stateError(
      "STATE_DATA_INVALID",
      "Outbox topic or payload exceeds the public contract boundary",
      { messageId: message.messageId },
      clock,
    );
  }
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(serializeWireValue(value));
}

function decodeJson(text: string, location: JsonValue, clock: Clock): JsonValue {
  try {
    return serializeWireValue(JSON.parse(text) as unknown);
  } catch {
    throw stateError(
      "STATE_DATA_INVALID",
      "SQLite state contains invalid JSON data",
      { location },
      clock,
    );
  }
}

function cloneJson<T extends JsonValue>(value: T, clock: Clock): T {
  return decodeJson(canonicalJson(value), { target: "transaction-value" }, clock) as T;
}

function requiredText(
  row: Readonly<Record<string, SQLOutputValue>>,
  column: string,
  clock: Clock,
): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw stateError(
      "STATE_DATA_INVALID",
      "SQLite state contains a non-text value",
      { column, valueType: typeof value },
      clock,
    );
  }
  return value;
}

function revisionValue(
  row: Readonly<Record<string, SQLOutputValue>>,
  column: string,
  clock: Clock,
): Revision {
  const value = row[column];
  if (typeof value !== "bigint" && typeof value !== "number") {
    throw stateError(
      "STATE_DATA_INVALID",
      "SQLite state contains an invalid revision",
      { column, valueType: typeof value },
      clock,
    );
  }
  return parseRevision(value.toString());
}

function idempotencyIdentity(
  options: StateTransactionOptions,
  clock: Clock,
): IdempotencyIdentity | undefined {
  const key = options.idempotencyKey;
  const fingerprint = options.idempotencyFingerprint;
  if (key === undefined && fingerprint === undefined) {
    return undefined;
  }
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    typeof fingerprint !== "string" ||
    fingerprint.length === 0
  ) {
    throw stateError(
      "STATE_IDEMPOTENCY_CONFLICT",
      "Idempotent transactions require a non-empty key and fingerprint",
      {
        idempotencyKey: typeof key === "string" ? key : null,
        idempotencyFingerprint: typeof fingerprint === "string" ? fingerprint : null,
      },
      clock,
    );
  }
  return { key, fingerprint };
}

function matchesExpectedRevision(
  record: StoredRecord | undefined,
  expected: ExpectedRevision,
): boolean {
  if (expected === undefined) {
    return true;
  }
  if (expected === "absent") {
    return record === undefined;
  }
  return record?.revision === expected;
}

function cloneChange(change: StateChange, clock: Clock): StateChange {
  return {
    revision: change.revision,
    key: cloneKey(change.key),
    kind: change.kind,
    ...(change.value === undefined ? {} : { value: cloneJson(change.value, clock) }),
  };
}

class SqliteTransaction implements StateTransaction {
  readonly #readRecord: (key: StateKey<JsonValue>) => StoredRecord | undefined;
  readonly #scanRecords: (query: StateQuery<JsonValue>) => readonly StoredRecord[];
  readonly #clock: Clock;
  readonly #mutations = new Map<string, Mutation>();
  readonly #operations: OperationJournalEntry[] = [];
  readonly #outbox: OutboxMessage[] = [];
  #active = true;

  constructor(
    readRecord: (key: StateKey<JsonValue>) => StoredRecord | undefined,
    scanRecords: (query: StateQuery<JsonValue>) => readonly StoredRecord[],
    clock: Clock,
  ) {
    this.#readRecord = readRecord;
    this.#scanRecords = scanRecords;
    this.#clock = clock;
  }

  async get<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined> {
    this.#assertActive();
    const mutation = this.#mutations.get(serializedKey(key));
    if (mutation?.kind === "delete") {
      return undefined;
    }
    if (mutation?.kind === "put") {
      return {
        value: cloneJson(mutation.value, this.#clock) as T,
        revision: this.#readRecord(mutation.key)?.revision ?? zeroRevision,
      };
    }
    const record = this.#readRecord(key);
    return record === undefined
      ? undefined
      : {
          value: cloneJson(record.value, this.#clock) as T,
          revision: record.revision,
        };
  }

  async *scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
    this.#assertActive();
    const records = new Map(
      this.#scanRecords(query).map((record) => [serializedKey(record.key), record]),
    );
    for (const [identifier, mutation] of this.#mutations) {
      if (
        mutation.key.namespace !== query.namespace ||
        mutation.key.collection !== query.collection ||
        (query.idPrefix !== undefined && !mutation.key.id.startsWith(query.idPrefix))
      ) {
        continue;
      }
      if (mutation.kind === "delete") {
        records.delete(identifier);
      } else {
        records.set(identifier, {
          key: mutation.key,
          value: mutation.value,
          revision: this.#readRecord(mutation.key)?.revision ?? zeroRevision,
        });
      }
    }
    const matching = [...records.values()].sort((left, right) =>
      compareCodeUnits(left.key.id, right.key.id),
    );
    for (const record of matching) {
      this.#assertActive();
      yield {
        key: cloneKey(record.key) as StateKey<T>,
        value: cloneJson(record.value, this.#clock) as T,
        revision: record.revision,
      };
    }
  }

  async put<T extends JsonValue>(
    key: StateKey<T>,
    value: T,
    options: StateWriteOptions,
  ): Promise<void> {
    this.#assertActive();
    const storedKey = cloneKey(key) as StateKey<JsonValue>;
    this.#mutations.set(serializedKey(key), {
      kind: "put",
      key: storedKey,
      value: cloneJson(value, this.#clock),
      expectedRevision: options.expectedRevision,
    });
  }

  async delete<T extends JsonValue>(key: StateKey<T>, options: StateWriteOptions): Promise<void> {
    this.#assertActive();
    const storedKey = cloneKey(key) as StateKey<JsonValue>;
    this.#mutations.set(serializedKey(key), {
      kind: "delete",
      key: storedKey,
      expectedRevision: options.expectedRevision,
    });
  }

  async appendOperation(entry: OperationJournalEntry): Promise<void> {
    this.#assertActive();
    this.#operations.push({
      operationId: entry.operationId,
      kind: entry.kind,
      status: entry.status,
      state: cloneJson(entry.state, this.#clock),
      updatedAt: entry.updatedAt,
    });
  }

  async enqueueOutbox(message: OutboxMessage): Promise<void> {
    this.#assertActive();
    this.#outbox.push({
      messageId: message.messageId,
      operationId: message.operationId,
      topic: message.topic,
      payload: cloneJson(message.payload, this.#clock),
      createdAt: message.createdAt,
      availableAt: message.availableAt,
    });
  }

  finish(): StagedTransaction {
    this.#assertActive();
    this.#active = false;
    return {
      mutations: [...this.#mutations.values()].sort((left, right) =>
        compareKeys(left.key, right.key),
      ),
      operations: this.#operations,
      outbox: this.#outbox,
    };
  }

  abort(): void {
    this.#active = false;
  }

  #assertActive(): void {
    if (!this.#active) {
      throw stateError(
        "STATE_CLOSED",
        "State transaction is no longer active",
        { target: "transaction" },
        this.#clock,
      );
    }
  }
}

const watchersByDatabase = new Map<string, Set<SqliteWatchIterator>>();

class SqliteWatchIterator implements AsyncIterator<StateChange>, AsyncIterable<StateChange> {
  readonly #databaseIdentity: string;
  readonly #clock: Clock;
  readonly #onClose: () => void;
  readonly #queue: StateChange[];
  readonly #waiters: Array<(result: IteratorResult<StateChange>) => void> = [];
  #closed = false;

  constructor(
    databaseIdentity: string,
    changes: readonly StateChange[],
    clock: Clock,
    onClose: () => void,
  ) {
    this.#databaseIdentity = databaseIdentity;
    this.#queue = changes.map((change) => cloneChange(change, clock));
    this.#clock = clock;
    this.#onClose = onClose;
    const watchers = watchersByDatabase.get(databaseIdentity) ?? new Set<SqliteWatchIterator>();
    watchers.add(this);
    watchersByDatabase.set(databaseIdentity, watchers);
  }

  [Symbol.asyncIterator](): AsyncIterator<StateChange> {
    return this;
  }

  next(): Promise<IteratorResult<StateChange>> {
    const change = this.#queue.shift();
    if (change !== undefined) {
      return Promise.resolve({ done: false, value: change });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  return(): Promise<IteratorResult<StateChange>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(change: StateChange): void {
    if (this.#closed) {
      return;
    }
    const cloned = cloneChange(change, this.#clock);
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#queue.push(cloned);
    } else {
      waiter({ done: false, value: cloned });
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#queue.length = 0;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
    const watchers = watchersByDatabase.get(this.#databaseIdentity);
    watchers?.delete(this);
    if (watchers?.size === 0) {
      watchersByDatabase.delete(this.#databaseIdentity);
    }
    this.#onClose();
  }
}

function broadcastChanges(databaseIdentity: string, changes: readonly StateChange[]): void {
  const watchers = watchersByDatabase.get(databaseIdentity);
  if (watchers === undefined) {
    return;
  }
  for (const change of changes) {
    for (const watcher of [...watchers]) {
      watcher.push(change);
    }
  }
}

export class SqliteStateStore implements StateStore {
  readonly scope = "local" as const;
  readonly #databasePath: string;
  readonly #databaseIdentity: string;
  readonly #clock: Clock;
  readonly #watchers = new Set<SqliteWatchIterator>();
  readonly #inFlightIdempotency = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<JsonValue> }
  >();
  readonly #executions = new Set<Promise<unknown>>();
  #commitTail: Promise<void> = Promise.resolve();
  #databaseConnection: DatabaseSync | undefined;
  #openPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #lifecycle: "closed" | "closing" | "created" | "open" | "opening" = "created";

  constructor(options: SqliteStateStoreOptions) {
    this.#databasePath = options.databasePath;
    this.#databaseIdentity =
      options.databasePath === ":memory:"
        ? `:memory:${crypto.randomUUID()}`
        : resolve(options.databasePath);
    this.#clock = options.clock ?? systemClock;
  }

  open(): Promise<void> {
    if (this.#lifecycle === "closed" || this.#lifecycle === "closing") {
      return Promise.reject(this.#closedError());
    }
    if (this.#lifecycle === "open") {
      return Promise.resolve();
    }
    if (this.#lifecycle === "opening") {
      return this.#openPromise ?? Promise.reject(this.#closedError());
    }
    this.#lifecycle = "opening";
    const opening = this.#openDatabase();
    this.#openPromise = opening;
    const clearOpening = () => {
      if (this.#openPromise === opening) this.#openPromise = undefined;
    };
    void opening.then(clearOpening, clearOpening);
    return opening;
  }

  async #openDatabase(): Promise<void> {
    let database: DatabaseSync | undefined;
    try {
      if (this.#databasePath !== ":memory:") {
        await mkdir(dirname(this.#databasePath), { recursive: true });
      }
      database = new DatabaseSync(this.#databasePath);
      applySqliteMigrations(database, this.#clock.now());
      if (this.#lifecycle !== "opening") {
        throw this.#closedError();
      }
      this.#databaseConnection = database;
      this.#lifecycle = "open";
    } catch (error) {
      database?.close();
      if (this.#lifecycle === "opening") {
        this.#lifecycle = "created";
      }
      throw error;
    }
  }

  async transact<T extends JsonValue>(
    options: StateTransactionOptions,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const identity = idempotencyIdentity(options, this.#clock);
    if (identity !== undefined) {
      const replay = this.#readIdempotency(identity.key);
      if (replay !== undefined) {
        this.#assertIdempotencyFingerprint(identity, replay.fingerprint);
        return cloneJson(replay.result, this.#clock) as T;
      }
      const inFlight = this.#inFlightIdempotency.get(identity.key);
      if (inFlight !== undefined) {
        this.#assertIdempotencyFingerprint(identity, inFlight.fingerprint);
        return cloneJson(await inFlight.result, this.#clock) as T;
      }
    }

    const execute = () => this.#executeTransaction(options, identity, work);
    if (identity === undefined) {
      return this.#trackExecution(execute());
    }

    const deferred = Promise.withResolvers<JsonValue>();
    const inFlight = {
      fingerprint: identity.fingerprint,
      result: deferred.promise,
    };
    this.#inFlightIdempotency.set(identity.key, inFlight);
    const execution = this.#trackExecution(execute());
    void execution.then(deferred.resolve, deferred.reject);
    try {
      return cloneJson(await deferred.promise, this.#clock) as T;
    } finally {
      if (this.#inFlightIdempotency.get(identity.key) === inFlight) {
        this.#inFlightIdempotency.delete(identity.key);
      }
    }
  }

  async read<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined> {
    this.#assertOpen();
    const record = this.#readRecord(key);
    return record === undefined
      ? undefined
      : {
          value: cloneJson(record.value, this.#clock) as T,
          revision: record.revision,
        };
  }

  async *scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
    this.#assertOpen();
    for (const record of this.#scanRecords(query)) {
      this.#assertOpen();
      yield {
        key: cloneKey(record.key) as StateKey<T>,
        value: cloneJson(record.value, this.#clock) as T,
        revision: record.revision,
      };
    }
  }

  watch(cursor: Revision): AsyncIterable<StateChange> {
    this.#assertOpen();
    let watcher: SqliteWatchIterator;
    watcher = new SqliteWatchIterator(
      this.#databaseIdentity,
      this.#readChanges(cursor),
      this.#clock,
      () => this.#watchers.delete(watcher),
    );
    this.#watchers.add(watcher);
    return watcher;
  }

  async health(): Promise<DriverHealth> {
    this.#assertOpen();
    this.#database().prepare("SELECT 1").get();
    return {
      status: "healthy",
      checkedAt: this.#clock.now().toISOString(),
    };
  }

  async *scanRecoverableOperations(
    query: OperationJournalQuery = {},
  ): AsyncIterable<PersistedOperationJournalEntry> {
    this.#assertOpen();
    this.#assertOperationQuery(query);
    const columns = "operation_id, kind, status, state_json, updated_at, revision";
    const after = query.after;
    const rows =
      after === undefined
        ? this.#database()
            .prepare(
              `
                SELECT ${columns}
                FROM operations
                WHERE status IN ('executing', 'planned')
                ORDER BY revision, operation_id
                ${query.limit === undefined ? "" : "LIMIT ?"}
              `,
              { readBigInts: true },
            )
            .all(...(query.limit === undefined ? [] : [query.limit]))
        : this.#database()
            .prepare(
              `
                SELECT ${columns}
                FROM operations
                WHERE status IN ('executing', 'planned')
                  AND (revision > ? OR (revision = ? AND operation_id > ?))
                ORDER BY revision, operation_id
                ${query.limit === undefined ? "" : "LIMIT ?"}
              `,
              { readBigInts: true },
            )
            .all(
              BigInt(after.revision),
              BigInt(after.revision),
              after.operationId,
              ...(query.limit === undefined ? [] : [query.limit]),
            );
    for (const row of rows) {
      this.#assertOpen();
      yield this.#decodeOperation(row);
    }
  }

  claimOutbox(request: OutboxClaimRequest): Promise<readonly OutboxClaim[]> {
    this.#assertOpen();
    const limit = assertOutboxClaimRequest(request, this.#clock);
    return this.#trackExecution(
      this.#enqueueCommit(() => {
        this.#assertCommitAllowed();
        const database = this.#database();
        database.exec("BEGIN IMMEDIATE");
        try {
          const advancesFence = this.#assertFence(database, request.fencing);
          const now = this.#clock.now();
          const claimedAt = now.toISOString();
          const rows = database
            .prepare(
              `
                SELECT
                  message_id,
                  operation_id,
                  topic,
                  payload_json,
                  created_at,
                  available_at,
                  attempt
                FROM outbox
                WHERE acknowledgement_outcome IS NOT 'completed'
                  AND (? IS NULL OR topic = ?)
                  AND available_at <= ?
                  AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
                ORDER BY available_at, enqueue_sequence, message_id
                LIMIT ?
              `,
              { readBigInts: true },
            )
            .all(request.topic ?? null, request.topic ?? null, claimedAt, claimedAt, limit);
          const claimed = rows.map((row): OutboxClaim => {
            const messageId = parseMessageId(requiredText(row, "message_id", this.#clock));
            const attemptValue = row.attempt;
            if (
              typeof attemptValue !== "bigint" ||
              attemptValue < 0n ||
              attemptValue >= BigInt(Number.MAX_SAFE_INTEGER)
            ) {
              throw stateError(
                "STATE_DATA_INVALID",
                "SQLite outbox contains an invalid delivery attempt",
                { messageId },
                this.#clock,
              );
            }
            const attempt = Number(attemptValue + 1n);
            const claimEpoch = parseFencingEpoch(attempt.toString());
            const expiresAt = new Date(now.getTime() + request.leaseDurationMs).toISOString();
            const message: OutboxMessage = {
              messageId,
              operationId: parseOperationId(requiredText(row, "operation_id", this.#clock)),
              topic: requiredText(row, "topic", this.#clock),
              payload: decodeJson(
                requiredText(row, "payload_json", this.#clock),
                { messageId },
                this.#clock,
              ),
              createdAt: requiredText(row, "created_at", this.#clock),
              availableAt: requiredText(row, "available_at", this.#clock),
            };
            return {
              message,
              owner: request.owner,
              claimEpoch,
              attempt,
              claimedAt,
              expiresAt,
            };
          });

          if (claimed.length > 0 || advancesFence) {
            const revisionInsert = database
              .prepare("INSERT INTO revisions DEFAULT VALUES", { readBigInts: true })
              .run();
            const revision = revisionInsert.lastInsertRowid;
            const update = database.prepare(`
              UPDATE outbox SET
                attempt = ?,
                claim_owner = ?,
                claim_epoch = ?,
                claimed_at = ?,
                claim_expires_at = ?,
                acknowledgement_outcome = NULL,
                acknowledgement_owner = NULL,
                acknowledgement_claim_epoch = NULL,
                acknowledgement_retry_at = NULL,
                acknowledged_at = NULL,
                revision = ?
              WHERE message_id = ?
            `);
            for (const claim of claimed) {
              update.run(
                claim.attempt,
                claim.owner,
                claim.claimEpoch,
                claim.claimedAt,
                claim.expiresAt,
                revision,
                claim.message.messageId,
              );
            }
            if (advancesFence) this.#advanceFence(database, request.fencing);
          }
          database.exec("COMMIT");
          return claimed.map((claim) => cloneJson(claim, this.#clock));
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }),
    );
  }

  acknowledgeOutbox(request: OutboxAcknowledgementRequest): Promise<OutboxAcknowledgement> {
    this.#assertOpen();
    assertOutboxAcknowledgementRequest(request, this.#clock);
    return this.#trackExecution(
      this.#enqueueCommit(() => {
        this.#assertCommitAllowed();
        const database = this.#database();
        database.exec("BEGIN IMMEDIATE");
        try {
          const advancesFence = this.#assertFence(database, request.fencing);
          const row = database
            .prepare(
              `
                SELECT
                  attempt,
                  claim_owner,
                  claim_epoch,
                  acknowledgement_outcome,
                  acknowledgement_owner,
                  acknowledgement_claim_epoch,
                  acknowledgement_retry_at,
                  acknowledged_at
                FROM outbox
                WHERE message_id = ?
              `,
              { readBigInts: true },
            )
            .get(request.messageId);
          if (row === undefined) {
            throw stateError(
              "STATE_QUERY_INVALID",
              "Outbox message does not exist",
              { messageId: request.messageId },
              this.#clock,
            );
          }
          const acknowledgementOutcome = row.acknowledgement_outcome;
          const acknowledgementOwner = row.acknowledgement_owner;
          const acknowledgementClaimEpoch = row.acknowledgement_claim_epoch;
          if (
            (acknowledgementOutcome === "completed" || acknowledgementOutcome === "retry") &&
            acknowledgementOwner === request.owner &&
            acknowledgementClaimEpoch === request.claimEpoch
          ) {
            const retryAt =
              row.acknowledgement_retry_at === null
                ? undefined
                : requiredText(row, "acknowledgement_retry_at", this.#clock);
            if (acknowledgementOutcome !== request.outcome || retryAt !== request.retryAt) {
              throw stateError(
                "STATE_IDEMPOTENCY_CONFLICT",
                "Outbox claim was acknowledged with a different outcome",
                { claimEpoch: request.claimEpoch, messageId: request.messageId },
                this.#clock,
              );
            }
            const attempt = row.attempt;
            if (typeof attempt !== "bigint" || attempt > BigInt(Number.MAX_SAFE_INTEGER)) {
              throw stateError(
                "STATE_DATA_INVALID",
                "SQLite outbox contains an invalid delivery attempt",
                { messageId: request.messageId },
                this.#clock,
              );
            }
            const duplicate: OutboxAcknowledgement = {
              messageId: request.messageId,
              outcome: acknowledgementOutcome,
              attempt: Number(attempt),
              acknowledgedAt: requiredText(row, "acknowledged_at", this.#clock),
              duplicate: true,
              ...(retryAt === undefined ? {} : { retryAt }),
            };
            if (advancesFence) {
              database.prepare("INSERT INTO revisions DEFAULT VALUES", { readBigInts: true }).run();
              this.#advanceFence(database, request.fencing);
            }
            database.exec("COMMIT");
            return duplicate;
          }

          const claimOwner = row.claim_owner;
          const claimEpoch = row.claim_epoch;
          if (claimOwner !== request.owner || claimEpoch !== request.claimEpoch) {
            throw stateError(
              "STATE_FENCE_STALE",
              "Outbox acknowledgement claim fence is stale",
              {
                actualClaimEpoch: typeof claimEpoch === "string" ? claimEpoch : null,
                messageId: request.messageId,
                requestedClaimEpoch: request.claimEpoch,
              },
              this.#clock,
            );
          }
          const attemptValue = row.attempt;
          if (
            typeof attemptValue !== "bigint" ||
            attemptValue <= 0n ||
            attemptValue > BigInt(Number.MAX_SAFE_INTEGER)
          ) {
            throw stateError(
              "STATE_DATA_INVALID",
              "SQLite outbox contains an invalid delivery attempt",
              { messageId: request.messageId },
              this.#clock,
            );
          }
          const acknowledgedAt = this.#clock.now().toISOString();
          const revisionInsert = database
            .prepare("INSERT INTO revisions DEFAULT VALUES", { readBigInts: true })
            .run();
          database
            .prepare(
              `
                UPDATE outbox SET
                  available_at = ?,
                  claim_owner = NULL,
                  claim_epoch = NULL,
                  claimed_at = NULL,
                  claim_expires_at = NULL,
                  acknowledgement_outcome = ?,
                  acknowledgement_owner = ?,
                  acknowledgement_claim_epoch = ?,
                  acknowledgement_retry_at = ?,
                  acknowledged_at = ?,
                  revision = ?
                WHERE message_id = ?
              `,
            )
            .run(
              request.retryAt ?? acknowledgedAt,
              request.outcome,
              request.owner,
              request.claimEpoch,
              request.retryAt ?? null,
              acknowledgedAt,
              revisionInsert.lastInsertRowid,
              request.messageId,
            );
          if (advancesFence) this.#advanceFence(database, request.fencing);
          database.exec("COMMIT");
          return {
            messageId: request.messageId,
            outcome: request.outcome,
            attempt: Number(attemptValue),
            acknowledgedAt,
            duplicate: false,
            ...(request.retryAt === undefined ? {} : { retryAt: request.retryAt }),
          };
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }),
    );
  }

  #decodeOperation(row: Readonly<Record<string, SQLOutputValue>>): PersistedOperationJournalEntry {
    const status = requiredText(row, "status", this.#clock);
    if (!["completed", "executing", "failed", "planned"].includes(status)) {
      throw stateError(
        "STATE_DATA_INVALID",
        "SQLite state contains an invalid operation status",
        { operationId: requiredText(row, "operation_id", this.#clock), status },
        this.#clock,
      );
    }
    const operationId = parseOperationId(requiredText(row, "operation_id", this.#clock));
    return {
      operationId,
      kind: requiredText(row, "kind", this.#clock),
      status: status as OperationJournalEntry["status"],
      state: decodeJson(requiredText(row, "state_json", this.#clock), { operationId }, this.#clock),
      updatedAt: requiredText(row, "updated_at", this.#clock),
      revision: revisionValue(row, "revision", this.#clock),
    };
  }

  close(): Promise<void> {
    if (this.#lifecycle === "closed") {
      return Promise.resolve();
    }
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    const closing = this.#closeStore();
    this.#closePromise = closing;
    const clearClosing = () => {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    };
    void closing.then(clearClosing, clearClosing);
    return closing;
  }

  async #closeStore(): Promise<void> {
    this.#lifecycle = "closing";
    await this.#openPromise?.catch(() => undefined);
    for (const watcher of [...this.#watchers]) {
      watcher.close();
    }
    await Promise.allSettled([...this.#executions]);
    await this.#commitTail;
    this.#databaseConnection?.close();
    this.#databaseConnection = undefined;
    this.#lifecycle = "closed";
  }

  async #trackExecution<T>(execution: Promise<T>): Promise<T> {
    this.#executions.add(execution);
    try {
      return await execution;
    } finally {
      this.#executions.delete(execution);
    }
  }

  async #executeTransaction<T extends JsonValue>(
    options: StateTransactionOptions,
    identity: IdempotencyIdentity | undefined,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.#snapshotRecords();
    const transaction = new SqliteTransaction(
      (key) => snapshot.get(serializedKey(key)),
      (query) =>
        [...snapshot.values()]
          .filter(
            (record) =>
              record.key.namespace === query.namespace &&
              record.key.collection === query.collection &&
              (query.idPrefix === undefined || record.key.id.startsWith(query.idPrefix)),
          )
          .sort((left, right) => compareCodeUnits(left.key.id, right.key.id)),
      this.#clock,
    );
    let result: T;
    try {
      result = cloneJson(await work(transaction), this.#clock);
    } catch (error) {
      transaction.abort();
      throw error;
    }
    const staged = transaction.finish();
    return this.#enqueueCommit(() => this.#commit(options, identity, staged, result));
  }

  #enqueueCommit<T>(commit: () => T): Promise<T> {
    const result = this.#commitTail.then(commit);
    this.#commitTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #commit<T extends JsonValue>(
    options: StateTransactionOptions,
    identity: IdempotencyIdentity | undefined,
    staged: StagedTransaction,
    result: T,
  ): T {
    this.#assertCommitAllowed();
    const database = this.#database();
    database.exec("BEGIN IMMEDIATE");
    const committedChanges: StateChange[] = [];
    try {
      if (identity !== undefined) {
        const replay = this.#readIdempotency(identity.key);
        if (replay !== undefined) {
          this.#assertIdempotencyFingerprint(identity, replay.fingerprint);
          database.exec("COMMIT");
          return cloneJson(replay.result, this.#clock) as T;
        }
      }

      const applied: Mutation[] = [];
      for (const mutation of staged.mutations) {
        const current = this.#readRecord(mutation.key);
        if (!matchesExpectedRevision(current, mutation.expectedRevision)) {
          throw stateError(
            "STATE_REVISION_CONFLICT",
            "State record revision does not match",
            {
              key: {
                namespace: mutation.key.namespace,
                collection: mutation.key.collection,
                id: mutation.key.id,
              },
              expectedRevision: mutation.expectedRevision ?? null,
              actualRevision: current?.revision ?? null,
            },
            this.#clock,
          );
        }
        if (mutation.kind === "put" || current !== undefined) {
          applied.push(mutation);
        }
      }

      const newOutboxById = new Map<string, OutboxMessage>();
      for (const message of staged.outbox) {
        assertOutboxMessage(message, this.#clock);
        if (!validTimestamp(message.createdAt) || !validTimestamp(message.availableAt)) {
          throw stateError(
            "STATE_DATA_INVALID",
            "Outbox timestamps must be canonical ISO timestamps",
            { messageId: message.messageId },
            this.#clock,
          );
        }
        const stagedExisting = newOutboxById.get(message.messageId);
        if (stagedExisting !== undefined) {
          if (!sameOutboxMessage(stagedExisting, message)) {
            throw stateError(
              "STATE_IDEMPOTENCY_CONFLICT",
              "Outbox message identity was reused with different content",
              { messageId: message.messageId },
              this.#clock,
            );
          }
          continue;
        }
        const row = database
          .prepare(
            `
              SELECT
                operation_id,
                topic,
                payload_json,
                created_at,
                available_at,
                acknowledgement_outcome
              FROM outbox
              WHERE message_id = ?
            `,
          )
          .get(message.messageId);
        if (row === undefined) {
          newOutboxById.set(message.messageId, message);
          continue;
        }
        if (row.acknowledgement_outcome === "retry") {
          newOutboxById.set(message.messageId, message);
          continue;
        }
        const existing: OutboxMessage = {
          messageId: message.messageId,
          operationId: parseOperationId(requiredText(row, "operation_id", this.#clock)),
          topic: requiredText(row, "topic", this.#clock),
          payload: decodeJson(
            requiredText(row, "payload_json", this.#clock),
            { messageId: message.messageId },
            this.#clock,
          ),
          createdAt: requiredText(row, "created_at", this.#clock),
          availableAt: requiredText(row, "available_at", this.#clock),
        };
        if (!sameOutboxMessage(existing, message)) {
          throw stateError(
            "STATE_IDEMPOTENCY_CONFLICT",
            "Outbox message identity was reused with different content",
            { messageId: message.messageId },
            this.#clock,
          );
        }
      }
      const newOutbox = [...newOutboxById.values()];

      let advancesFence = false;
      const fencing = options.fencing;
      if (fencing !== undefined) {
        const row = database
          .prepare("SELECT epoch FROM fences WHERE resource = ?")
          .get(fencing.resource);
        const currentEpoch =
          row === undefined ? undefined : BigInt(requiredText(row, "epoch", this.#clock));
        const requestedEpoch = BigInt(fencing.epoch);
        if (currentEpoch !== undefined && requestedEpoch < currentEpoch) {
          throw stateError(
            "STATE_FENCE_STALE",
            "State transaction fencing epoch is stale",
            {
              resource: fencing.resource,
              requestedEpoch: fencing.epoch,
              currentEpoch: currentEpoch.toString(),
            },
            this.#clock,
          );
        }
        advancesFence = currentEpoch === undefined || requestedEpoch > currentEpoch;
      }

      const mutates =
        applied.length > 0 || staged.operations.length > 0 || newOutbox.length > 0 || advancesFence;
      if (mutates) {
        const revisionInsert = database
          .prepare("INSERT INTO revisions DEFAULT VALUES", { readBigInts: true })
          .run();
        const revision = parseRevision(revisionInsert.lastInsertRowid.toString());
        const revisionInteger = BigInt(revision);

        for (const mutation of applied) {
          if (mutation.kind === "put") {
            database
              .prepare(
                `
                  INSERT INTO records(namespace, collection_name, record_id, value_json, revision)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(namespace, collection_name, record_id)
                  DO UPDATE SET value_json = excluded.value_json, revision = excluded.revision
                `,
              )
              .run(
                mutation.key.namespace,
                mutation.key.collection,
                mutation.key.id,
                canonicalJson(mutation.value),
                revisionInteger,
              );
          } else {
            database
              .prepare(
                "DELETE FROM records WHERE namespace = ? AND collection_name = ? AND record_id = ?",
              )
              .run(mutation.key.namespace, mutation.key.collection, mutation.key.id);
          }
          const valueJson = mutation.kind === "put" ? canonicalJson(mutation.value) : null;
          database
            .prepare(
              `
                INSERT INTO changes(
                  revision, namespace, collection_name, record_id, kind, value_json
                ) VALUES (?, ?, ?, ?, ?, ?)
              `,
            )
            .run(
              revisionInteger,
              mutation.key.namespace,
              mutation.key.collection,
              mutation.key.id,
              mutation.kind,
              valueJson,
            );
          committedChanges.push({
            revision,
            key: cloneKey(mutation.key),
            kind: mutation.kind,
            ...(mutation.kind === "put" ? { value: cloneJson(mutation.value, this.#clock) } : {}),
          });
        }

        for (const operation of staged.operations) {
          database
            .prepare(
              `
                INSERT INTO operations(
                  operation_id, kind, status, state_json, updated_at, revision
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(operation_id) DO UPDATE SET
                  kind = excluded.kind,
                  status = excluded.status,
                  state_json = excluded.state_json,
                  updated_at = excluded.updated_at,
                  revision = excluded.revision
              `,
            )
            .run(
              operation.operationId,
              operation.kind,
              operation.status,
              canonicalJson(operation.state),
              operation.updatedAt,
              revisionInteger,
            );
        }

        const maximumSequence = database
          .prepare("SELECT MAX(enqueue_sequence) AS value FROM outbox", { readBigInts: true })
          .get()?.value;
        let enqueueSequence = typeof maximumSequence === "bigint" ? maximumSequence : 0n;
        for (const message of newOutbox) {
          enqueueSequence += 1n;
          database
            .prepare(
              `
                INSERT INTO outbox(
                  message_id,
                  operation_id,
                  topic,
                  payload_json,
                  created_at,
                  available_at,
                  enqueue_sequence,
                  revision
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(message_id) DO UPDATE SET
                  operation_id = excluded.operation_id,
                  topic = excluded.topic,
                  payload_json = excluded.payload_json,
                  created_at = excluded.created_at,
                  available_at = excluded.available_at,
                  attempt = 0,
                  claim_owner = NULL,
                  claim_epoch = NULL,
                  claimed_at = NULL,
                  claim_expires_at = NULL,
                  acknowledgement_outcome = NULL,
                  acknowledgement_owner = NULL,
                  acknowledgement_claim_epoch = NULL,
                  acknowledgement_retry_at = NULL,
                  acknowledged_at = NULL,
                  enqueue_sequence = excluded.enqueue_sequence,
                  revision = excluded.revision
              `,
            )
            .run(
              message.messageId,
              message.operationId,
              message.topic,
              canonicalJson(message.payload),
              message.createdAt,
              message.availableAt,
              enqueueSequence,
              revisionInteger,
            );
        }

        if (fencing !== undefined && advancesFence) {
          database
            .prepare(
              `
                INSERT INTO fences(resource, epoch) VALUES (?, ?)
                ON CONFLICT(resource) DO UPDATE SET epoch = excluded.epoch
              `,
            )
            .run(fencing.resource, fencing.epoch);
        }
      }

      if (identity !== undefined) {
        database
          .prepare(
            "INSERT INTO idempotency(idempotency_key, fingerprint, result_json) VALUES (?, ?, ?)",
          )
          .run(identity.key, identity.fingerprint, canonicalJson(result));
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    broadcastChanges(this.#databaseIdentity, committedChanges);
    return cloneJson(result, this.#clock);
  }

  #readRecord(key: StateKey<JsonValue>): StoredRecord | undefined {
    const row = this.#database()
      .prepare(
        `
          SELECT namespace, collection_name, record_id, value_json, revision
          FROM records
          WHERE namespace = ? AND collection_name = ? AND record_id = ?
        `,
        { readBigInts: true },
      )
      .get(key.namespace, key.collection, key.id);
    return row === undefined ? undefined : this.#decodeRecord(row);
  }

  #scanRecords(query: StateQuery<JsonValue>): readonly StoredRecord[] {
    return this.#database()
      .prepare(
        `
          SELECT namespace, collection_name, record_id, value_json, revision
          FROM records
          WHERE namespace = ? AND collection_name = ?
        `,
        { readBigInts: true },
      )
      .all(query.namespace, query.collection)
      .map((row) => this.#decodeRecord(row))
      .filter((record) => query.idPrefix === undefined || record.key.id.startsWith(query.idPrefix))
      .sort((left, right) => compareCodeUnits(left.key.id, right.key.id));
  }

  #snapshotRecords(): ReadonlyMap<string, StoredRecord> {
    const records = this.#database()
      .prepare("SELECT namespace, collection_name, record_id, value_json, revision FROM records", {
        readBigInts: true,
      })
      .all()
      .map((row) => this.#decodeRecord(row));
    return new Map(records.map((record) => [serializedKey(record.key), record]));
  }

  #decodeRecord(row: Readonly<Record<string, SQLOutputValue>>): StoredRecord {
    const key: StateKey<JsonValue> = {
      namespace: requiredText(row, "namespace", this.#clock),
      collection: requiredText(row, "collection_name", this.#clock),
      id: requiredText(row, "record_id", this.#clock),
    };
    return {
      key,
      value: decodeJson(
        requiredText(row, "value_json", this.#clock),
        {
          key: {
            namespace: key.namespace,
            collection: key.collection,
            id: key.id,
          },
        },
        this.#clock,
      ),
      revision: revisionValue(row, "revision", this.#clock),
    };
  }

  #readChanges(cursor: Revision): readonly StateChange[] {
    return this.#database()
      .prepare(
        `
          SELECT revision, namespace, collection_name, record_id, kind, value_json
          FROM changes
          WHERE revision > ?
          ORDER BY revision, sequence
        `,
        { readBigInts: true },
      )
      .all(BigInt(cursor))
      .map((row): StateChange => {
        const kind = requiredText(row, "kind", this.#clock);
        if (kind !== "delete" && kind !== "put") {
          throw stateError(
            "STATE_DATA_INVALID",
            "SQLite state contains an invalid change kind",
            { kind },
            this.#clock,
          );
        }
        const key: StateKey<JsonValue> = {
          namespace: requiredText(row, "namespace", this.#clock),
          collection: requiredText(row, "collection_name", this.#clock),
          id: requiredText(row, "record_id", this.#clock),
        };
        return {
          revision: revisionValue(row, "revision", this.#clock),
          key,
          kind,
          ...(kind === "put"
            ? {
                value: decodeJson(
                  requiredText(row, "value_json", this.#clock),
                  {
                    key: {
                      namespace: key.namespace,
                      collection: key.collection,
                      id: key.id,
                    },
                  },
                  this.#clock,
                ),
              }
            : {}),
        };
      });
  }

  #readIdempotency(key: string): IdempotencyRecord | undefined {
    const row = this.#database()
      .prepare("SELECT fingerprint, result_json FROM idempotency WHERE idempotency_key = ?")
      .get(key);
    return row === undefined
      ? undefined
      : {
          fingerprint: requiredText(row, "fingerprint", this.#clock),
          result: decodeJson(
            requiredText(row, "result_json", this.#clock),
            { idempotencyKey: key },
            this.#clock,
          ),
        };
  }

  #assertIdempotencyFingerprint(identity: IdempotencyIdentity, committed: string): void {
    if (identity.fingerprint !== committed) {
      throw stateError(
        "STATE_IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used for a different transaction",
        {
          idempotencyKey: identity.key,
          requestedFingerprint: identity.fingerprint,
          committedFingerprint: committed,
        },
        this.#clock,
      );
    }
  }

  #assertFence(database: DatabaseSync, fencing: StateTransactionOptions["fencing"]): boolean {
    if (fencing === undefined) return false;
    const row = database
      .prepare("SELECT epoch FROM fences WHERE resource = ?")
      .get(fencing.resource);
    const currentEpoch =
      row === undefined ? undefined : BigInt(requiredText(row, "epoch", this.#clock));
    const requestedEpoch = BigInt(fencing.epoch);
    if (currentEpoch !== undefined && requestedEpoch < currentEpoch) {
      throw stateError(
        "STATE_FENCE_STALE",
        "State transaction fencing epoch is stale",
        {
          resource: fencing.resource,
          requestedEpoch: fencing.epoch,
          currentEpoch: currentEpoch.toString(),
        },
        this.#clock,
      );
    }
    return currentEpoch === undefined || requestedEpoch > currentEpoch;
  }

  #advanceFence(database: DatabaseSync, fencing: StateTransactionOptions["fencing"]): void {
    if (fencing === undefined) return;
    database
      .prepare(
        `
          INSERT INTO fences(resource, epoch) VALUES (?, ?)
          ON CONFLICT(resource) DO UPDATE SET epoch = excluded.epoch
        `,
      )
      .run(fencing.resource, fencing.epoch);
  }

  #database(): DatabaseSync {
    const database = this.#databaseConnection;
    if (database === undefined) {
      throw this.#closedError();
    }
    return database;
  }

  #assertOpen(): void {
    if (this.#lifecycle !== "open") {
      throw this.#closedError();
    }
  }

  #assertOperationQuery(query: OperationJournalQuery): void {
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) {
      throw stateError(
        "STATE_QUERY_INVALID",
        "Operation journal query limit must be a positive safe integer",
        { limit: query.limit },
        this.#clock,
      );
    }
  }

  #assertCommitAllowed(): void {
    if (this.#lifecycle !== "open" && this.#lifecycle !== "closing") {
      throw this.#closedError();
    }
  }

  #closedError(): DiagnosticError {
    return stateError(
      "STATE_CLOSED",
      "SQLite state store is closed",
      { lifecycle: this.#lifecycle },
      this.#clock,
    );
  }
}
