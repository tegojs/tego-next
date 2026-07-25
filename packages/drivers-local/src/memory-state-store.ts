import { setTimeout as delay } from "node:timers/promises";
import {
  DiagnosticError,
  OUTBOX_PAYLOAD_MAX_BYTES,
  OUTBOX_TOPIC_MAX_LENGTH,
  STATE_QUERY_MAX_LIMIT,
  compareOperationJournalCursors,
  isPortableStateString,
  parseFencingEpoch,
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

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly result: JsonValue;
}

interface IdempotencyIdentity {
  readonly key: string;
  readonly fingerprint: string;
}

interface StoredOutboxMessage {
  message: OutboxMessage;
  enqueueSequence: bigint;
  attempt: number;
  claim?: OutboxClaim;
  acknowledgement?: OutboxAcknowledgement;
  acknowledgedClaim?: OutboxClaim;
}

export interface MemoryStateStoreOptions {
  readonly clock?: Clock;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return serializeWireValue(value) as T;
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

function compareKeys(left: StateKey<JsonValue>, right: StateKey<JsonValue>): number {
  return (
    compareCodeUnits(left.namespace, right.namespace) ||
    compareCodeUnits(left.collection, right.collection) ||
    compareCodeUnits(left.id, right.id)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertStateQuery(query: StateQuery<JsonValue>, clock: Clock): void {
  if (
    !isPortableStateString(query.namespace) ||
    !isPortableStateString(query.collection) ||
    (query.idPrefix !== undefined && !isPortableStateString(query.idPrefix)) ||
    (query.afterId !== undefined && !isPortableStateString(query.afterId)) ||
    (query.limit !== undefined &&
      (!Number.isSafeInteger(query.limit) ||
        query.limit <= 0 ||
        query.limit > STATE_QUERY_MAX_LIMIT))
  ) {
    throw stateError(
      "STATE_QUERY_INVALID",
      `State query strings must be portable and limit must be between 1 and ${STATE_QUERY_MAX_LIMIT}`,
      { limit: query.limit ?? null },
      clock,
    );
  }
}

function assertStateKey(
  key: StateKey<JsonValue>,
  operation: "query" | "write",
  clock: Clock,
): void {
  if (
    isPortableStateString(key.namespace) &&
    isPortableStateString(key.collection) &&
    isPortableStateString(key.id)
  ) {
    return;
  }
  throw stateError(
    operation === "query" ? "STATE_QUERY_INVALID" : "STATE_DATA_INVALID",
    "State keys must not contain NUL or ill-formed Unicode",
    {
      namespace: key.namespace,
      collection: key.collection,
      id: key.id,
    },
    clock,
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
    JSON.stringify(serializeWireValue(left.payload)) ===
      JSON.stringify(serializeWireValue(right.payload))
  );
}

function assertOutboxMessage(message: OutboxMessage, clock: Clock): void {
  if (
    message.topic.length > OUTBOX_TOPIC_MAX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(message.topic) ||
    Buffer.byteLength(JSON.stringify(message.payload), "utf8") > OUTBOX_PAYLOAD_MAX_BYTES
  ) {
    throw stateError(
      "STATE_DATA_INVALID",
      "Outbox topic or payload exceeds the public contract boundary",
      { messageId: message.messageId },
      clock,
    );
  }
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
      source: { kind: "state", id: "memory-state-store" },
      details,
      observedAt: clock.now().toISOString(),
    }),
  );
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

function scannedRecord<T extends JsonValue>(record: StoredRecord): ScannedState<T> {
  return {
    key: cloneKey(record.key) as StateKey<T>,
    value: cloneJson(record.value) as T,
    revision: record.revision,
  };
}

function cloneChange(change: StateChange): StateChange {
  return {
    revision: change.revision,
    key: cloneKey(change.key),
    kind: change.kind,
    ...(change.value === undefined ? {} : { value: cloneJson(change.value) }),
  };
}

class MemoryTransaction implements StateTransaction {
  readonly #snapshot: ReadonlyMap<string, StoredRecord>;
  readonly #clock: Clock;
  readonly #mutations = new Map<string, Mutation>();
  readonly #operations: OperationJournalEntry[] = [];
  readonly #outbox: OutboxMessage[] = [];
  #active = true;

  constructor(snapshot: ReadonlyMap<string, StoredRecord>, clock: Clock) {
    this.#snapshot = snapshot;
    this.#clock = clock;
  }

  async get<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined> {
    this.#assertActive();
    assertStateKey(key, "query", this.#clock);
    const identifier = serializedKey(key);
    const mutation = this.#mutations.get(identifier);
    if (mutation?.kind === "delete") {
      return undefined;
    }
    if (mutation?.kind === "put") {
      return {
        value: cloneJson(mutation.value) as T,
        revision: this.#snapshot.get(identifier)?.revision ?? zeroRevision,
      };
    }

    const record = this.#snapshot.get(identifier);
    return record === undefined
      ? undefined
      : { value: cloneJson(record.value) as T, revision: record.revision };
  }

  async *scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
    this.#assertActive();
    assertStateQuery(query, this.#clock);
    const records = new Map(this.#snapshot);
    for (const [identifier, mutation] of this.#mutations) {
      if (mutation.kind === "delete") {
        records.delete(identifier);
      } else {
        records.set(identifier, {
          key: mutation.key,
          value: mutation.value,
          revision: this.#snapshot.get(identifier)?.revision ?? zeroRevision,
        });
      }
    }

    const matching = [...records.values()]
      .filter(
        (record) =>
          record.key.namespace === query.namespace &&
          record.key.collection === query.collection &&
          (query.idPrefix === undefined || record.key.id.startsWith(query.idPrefix)) &&
          (query.afterId === undefined || compareCodeUnits(record.key.id, query.afterId) > 0),
      )
      .sort((left, right) => compareCodeUnits(left.key.id, right.key.id));
    const limit = query.limit ?? matching.length;
    for (const record of matching.slice(0, limit)) {
      yield scannedRecord<T>(record);
    }
  }

  async put<T extends JsonValue>(
    key: StateKey<T>,
    value: T,
    options: StateWriteOptions,
  ): Promise<void> {
    this.#assertActive();
    assertStateKey(key, "write", this.#clock);
    const storedKey = cloneKey(key) as StateKey<JsonValue>;
    this.#mutations.set(serializedKey(storedKey), {
      kind: "put",
      key: storedKey,
      value: cloneJson(value),
      expectedRevision: options.expectedRevision,
    });
  }

  async delete<T extends JsonValue>(key: StateKey<T>, options: StateWriteOptions): Promise<void> {
    this.#assertActive();
    assertStateKey(key, "write", this.#clock);
    const storedKey = cloneKey(key) as StateKey<JsonValue>;
    this.#mutations.set(serializedKey(storedKey), {
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
      state: cloneJson(entry.state),
      updatedAt: entry.updatedAt,
    });
  }

  async enqueueOutbox(message: OutboxMessage): Promise<void> {
    this.#assertActive();
    this.#outbox.push({
      messageId: message.messageId,
      operationId: message.operationId,
      topic: message.topic,
      payload: cloneJson(message.payload),
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

class MemoryWatchIterator implements AsyncIterator<StateChange>, AsyncIterable<StateChange> {
  readonly #onClose: () => void;
  readonly #queue: StateChange[];
  readonly #waiters: Array<(result: IteratorResult<StateChange>) => void> = [];
  #closed = false;

  constructor(changes: readonly StateChange[], onClose: () => void) {
    this.#queue = changes.map(cloneChange);
    this.#onClose = onClose;
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
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#queue.push(cloneChange(change));
    } else {
      waiter({ done: false, value: cloneChange(change) });
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
    this.#onClose();
  }
}

export class MemoryStateStore implements StateStore {
  readonly scope = "local" as const;
  readonly #clock: Clock;
  readonly #records = new Map<string, StoredRecord>();
  readonly #operations = new Map<string, PersistedOperationJournalEntry>();
  readonly #operationHistory: PersistedOperationJournalEntry[] = [];
  readonly #outbox = new Map<string, StoredOutboxMessage>();
  #outboxSequence = 0n;
  readonly #fences = new Map<string, bigint>();
  readonly #changes: StateChange[] = [];
  readonly #watchers = new Set<MemoryWatchIterator>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #inFlightIdempotency = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<JsonValue> }
  >();
  #revision = 0n;
  #commitTail: Promise<void> = Promise.resolve();
  #lifecycle: "closed" | "created" | "open" = "created";

  constructor(options: MemoryStateStoreOptions = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  async open(): Promise<void> {
    if (this.#lifecycle === "closed") {
      throw this.#closedError();
    }
    this.#lifecycle = "open";
  }

  async transact<T extends JsonValue>(
    options: StateTransactionOptions,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const identity = idempotencyIdentity(options, this.#clock);
    if (identity !== undefined) {
      const replay = this.#idempotency.get(identity.key);
      if (replay !== undefined) {
        this.#assertIdempotencyFingerprint(identity, replay.fingerprint);
        return cloneJson(replay.result) as T;
      }
      const inFlight = this.#inFlightIdempotency.get(identity.key);
      if (inFlight !== undefined) {
        this.#assertIdempotencyFingerprint(identity, inFlight.fingerprint);
        return cloneJson(await inFlight.result) as T;
      }
    }

    if (identity === undefined) {
      return this.#executeTransaction(options, identity, work);
    }

    const deferred = Promise.withResolvers<JsonValue>();
    const inFlight = {
      fingerprint: identity.fingerprint,
      result: deferred.promise,
    };
    this.#inFlightIdempotency.set(identity.key, inFlight);
    const execution = this.#executeTransaction(options, identity, work);
    void execution.then(deferred.resolve, deferred.reject);
    try {
      return cloneJson(await deferred.promise) as T;
    } finally {
      if (this.#inFlightIdempotency.get(identity.key) === inFlight) {
        this.#inFlightIdempotency.delete(identity.key);
      }
    }
  }

  async read<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined> {
    this.#assertOpen();
    assertStateKey(key, "query", this.#clock);
    const record = this.#records.get(serializedKey(key));
    return record === undefined
      ? undefined
      : { value: cloneJson(record.value) as T, revision: record.revision };
  }

  async *scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
    this.#assertOpen();
    assertStateQuery(query, this.#clock);
    const matching = [...this.#records.values()]
      .filter(
        (record) =>
          record.key.namespace === query.namespace &&
          record.key.collection === query.collection &&
          (query.idPrefix === undefined || record.key.id.startsWith(query.idPrefix)) &&
          (query.afterId === undefined || compareCodeUnits(record.key.id, query.afterId) > 0),
      )
      .sort((left, right) => compareCodeUnits(left.key.id, right.key.id));
    const limit = query.limit ?? matching.length;
    for (const record of matching.slice(0, limit)) {
      this.#assertOpen();
      yield scannedRecord<T>(record);
    }
  }

  async *scanOperations(
    query: OperationJournalQuery = {},
  ): AsyncIterable<PersistedOperationJournalEntry> {
    yield* this.#scanOperationJournal(query, false);
  }

  async *scanOperationHistory(
    query: OperationJournalQuery = {},
  ): AsyncIterable<PersistedOperationJournalEntry> {
    this.#assertOpen();
    this.#assertOperationQuery(query);
    const matching = this.#operationHistory
      .filter(
        (entry) =>
          query.after === undefined || compareOperationJournalCursors(entry, query.after) > 0,
      )
      .sort(compareOperationJournalCursors);
    const limit = query.limit ?? matching.length;
    for (const entry of matching.slice(0, limit)) {
      this.#assertOpen();
      yield structuredClone(entry);
    }
  }

  async *scanRecoverableOperations(
    query: OperationJournalQuery = {},
  ): AsyncIterable<PersistedOperationJournalEntry> {
    yield* this.#scanOperationJournal(query, true);
  }

  async *#scanOperationJournal(
    query: OperationJournalQuery,
    recoverableOnly: boolean,
  ): AsyncIterable<PersistedOperationJournalEntry> {
    this.#assertOpen();
    this.#assertOperationQuery(query);
    const matching = [...this.#operations.values()]
      .filter(
        (entry) =>
          (!recoverableOnly || entry.status === "executing" || entry.status === "planned") &&
          (query.after === undefined || compareOperationJournalCursors(entry, query.after) > 0),
      )
      .sort(compareOperationJournalCursors);
    const limit = query.limit ?? matching.length;
    for (const entry of matching.slice(0, limit)) {
      this.#assertOpen();
      yield structuredClone(entry);
    }
  }

  claimOutbox(request: OutboxClaimRequest): Promise<readonly OutboxClaim[]> {
    this.#assertOpen();
    const limit = assertOutboxClaimRequest(request, this.#clock);
    return this.#enqueueCommit(() => {
      this.#assertOpen();
      const advancesFence = this.#assertFence(request.fencing);
      const now = this.#clock.now();
      const claimedAt = now.toISOString();
      const claimed: OutboxClaim[] = [];
      for (const record of [...this.#outbox.values()].sort(
        (left, right) =>
          compareCodeUnits(left.message.availableAt, right.message.availableAt) ||
          (left.enqueueSequence < right.enqueueSequence
            ? -1
            : left.enqueueSequence > right.enqueueSequence
              ? 1
              : compareCodeUnits(left.message.messageId, right.message.messageId)),
      )) {
        if (
          record.acknowledgement?.outcome === "completed" ||
          (request.topic !== undefined && record.message.topic !== request.topic) ||
          Date.parse(record.message.availableAt) > now.getTime() ||
          (record.claim !== undefined && Date.parse(record.claim.expiresAt) > now.getTime())
        ) {
          continue;
        }
        const attempt = record.attempt + 1;
        if (!Number.isSafeInteger(attempt)) {
          throw stateError(
            "STATE_DATA_INVALID",
            "Outbox delivery attempt exceeds the safe integer range",
            { messageId: record.message.messageId },
            this.#clock,
          );
        }
        const claim: OutboxClaim = {
          message: cloneJson(record.message),
          owner: request.owner,
          claimEpoch: parseFencingEpoch(attempt.toString()),
          attempt,
          claimedAt,
          expiresAt: new Date(now.getTime() + request.leaseDurationMs).toISOString(),
        };
        record.attempt = attempt;
        record.claim = claim;
        delete record.acknowledgement;
        delete record.acknowledgedClaim;
        claimed.push(cloneJson(claim));
        if (claimed.length === limit) break;
      }
      if (claimed.length > 0 || advancesFence) {
        this.#revision += 1n;
        this.#advanceFence(request.fencing);
      }
      return claimed;
    });
  }

  acknowledgeOutbox(request: OutboxAcknowledgementRequest): Promise<OutboxAcknowledgement> {
    this.#assertOpen();
    assertOutboxAcknowledgementRequest(request, this.#clock);
    return this.#enqueueCommit(() => {
      this.#assertOpen();
      const advancesFence = this.#assertFence(request.fencing);
      const record = this.#outbox.get(request.messageId);
      if (record === undefined) {
        throw stateError(
          "STATE_QUERY_INVALID",
          "Outbox message does not exist",
          { messageId: request.messageId },
          this.#clock,
        );
      }
      const acknowledgedClaim = record.acknowledgedClaim;
      if (
        record.acknowledgement !== undefined &&
        acknowledgedClaim?.owner === request.owner &&
        acknowledgedClaim.claimEpoch === request.claimEpoch
      ) {
        if (
          record.acknowledgement.outcome !== request.outcome ||
          record.acknowledgement.retryAt !== request.retryAt
        ) {
          throw stateError(
            "STATE_IDEMPOTENCY_CONFLICT",
            "Outbox claim was acknowledged with a different outcome",
            { claimEpoch: request.claimEpoch, messageId: request.messageId },
            this.#clock,
          );
        }
        if (advancesFence) {
          this.#revision += 1n;
          this.#advanceFence(request.fencing);
        }
        return { ...cloneJson(record.acknowledgement), duplicate: true };
      }
      const claim = record.claim;
      if (
        claim === undefined ||
        claim.owner !== request.owner ||
        claim.claimEpoch !== request.claimEpoch
      ) {
        throw stateError(
          "STATE_FENCE_STALE",
          "Outbox acknowledgement claim fence is stale",
          {
            actualClaimEpoch: claim?.claimEpoch ?? null,
            messageId: request.messageId,
            requestedClaimEpoch: request.claimEpoch,
          },
          this.#clock,
        );
      }
      const acknowledgement: OutboxAcknowledgement = {
        messageId: request.messageId,
        outcome: request.outcome,
        attempt: claim.attempt,
        acknowledgedAt: this.#clock.now().toISOString(),
        duplicate: false,
        ...(request.retryAt === undefined ? {} : { retryAt: request.retryAt }),
      };
      record.acknowledgement = acknowledgement;
      record.acknowledgedClaim = claim;
      delete record.claim;
      if (request.outcome === "retry") {
        record.message = {
          ...record.message,
          availableAt: request.retryAt as string,
        };
      }
      this.#revision += 1n;
      if (advancesFence) this.#advanceFence(request.fencing);
      return cloneJson(acknowledgement);
    });
  }

  watch(cursor: Revision): AsyncIterable<StateChange> {
    this.#assertOpen();
    const numericCursor = BigInt(cursor);
    let watcher: MemoryWatchIterator;
    watcher = new MemoryWatchIterator(
      this.#changes.filter((change) => BigInt(change.revision) > numericCursor),
      () => this.#watchers.delete(watcher),
    );
    this.#watchers.add(watcher);
    return watcher;
  }

  async health(): Promise<DriverHealth> {
    this.#assertOpen();
    return {
      status: "healthy",
      checkedAt: this.#clock.now().toISOString(),
    };
  }

  async close(): Promise<void> {
    if (this.#lifecycle === "closed") {
      return;
    }
    this.#lifecycle = "closed";
    for (const watcher of [...this.#watchers]) {
      watcher.close();
    }
    await this.#commitTail;
  }

  async #executeTransaction<T extends JsonValue>(
    options: StateTransactionOptions,
    identity: IdempotencyIdentity | undefined,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction = new MemoryTransaction(new Map(this.#records), this.#clock);
    let result: T;
    try {
      result = cloneJson(await work(transaction));
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
    this.#assertOpen();
    const nextRecords = new Map(this.#records);
    const applied: Mutation[] = [];

    for (const mutation of staged.mutations) {
      const identifier = serializedKey(mutation.key);
      const current = nextRecords.get(identifier);
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
      if (mutation.kind === "delete") {
        if (current !== undefined) {
          nextRecords.delete(identifier);
          applied.push(mutation);
        }
      } else {
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
      const existing = this.#outbox.get(message.messageId);
      if (existing === undefined || existing.acknowledgement?.outcome === "retry") {
        newOutboxById.set(message.messageId, message);
      } else if (!sameOutboxMessage(existing.message, message)) {
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
      const requestedEpoch = BigInt(fencing.epoch);
      const currentEpoch = this.#fences.get(fencing.resource);
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
      const revision = parseRevision((this.#revision + 1n).toString());
      for (const mutation of applied) {
        const identifier = serializedKey(mutation.key);
        if (mutation.kind === "put") {
          nextRecords.set(identifier, {
            key: cloneKey(mutation.key),
            value: cloneJson(mutation.value),
            revision,
          });
        }
      }

      this.#records.clear();
      for (const [identifier, record] of nextRecords) {
        this.#records.set(identifier, record);
      }
      for (const entry of staged.operations) {
        const persisted = {
          ...structuredClone(entry),
          revision,
        };
        this.#operationHistory.push(persisted);
        this.#operations.set(entry.operationId, persisted);
      }
      for (const message of newOutbox) {
        this.#outboxSequence += 1n;
        this.#outbox.set(message.messageId, {
          message: cloneJson(message),
          enqueueSequence: this.#outboxSequence,
          attempt: 0,
        });
      }
      if (fencing !== undefined && advancesFence) {
        this.#fences.set(fencing.resource, BigInt(fencing.epoch));
      }
      this.#revision += 1n;

      for (const mutation of applied) {
        const change: StateChange =
          mutation.kind === "put"
            ? {
                revision,
                key: cloneKey(mutation.key),
                kind: "put",
                value: cloneJson(mutation.value),
              }
            : {
                revision,
                key: cloneKey(mutation.key),
                kind: "delete",
              };
        this.#changes.push(change);
        for (const watcher of this.#watchers) {
          watcher.push(change);
        }
      }
    }

    if (identity !== undefined) {
      this.#idempotency.set(identity.key, {
        fingerprint: identity.fingerprint,
        result: cloneJson(result),
      });
    }
    return cloneJson(result);
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

  #assertFence(fencing: StateTransactionOptions["fencing"]): boolean {
    if (fencing === undefined) return false;
    const requestedEpoch = BigInt(fencing.epoch);
    const currentEpoch = this.#fences.get(fencing.resource);
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

  #advanceFence(fencing: StateTransactionOptions["fencing"]): void {
    if (fencing !== undefined) {
      this.#fences.set(fencing.resource, BigInt(fencing.epoch));
    }
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

  #closedError(): DiagnosticError {
    return stateError(
      "STATE_CLOSED",
      "Memory state store is closed",
      { lifecycle: this.#lifecycle },
      this.#clock,
    );
  }
}
