import { setTimeout as delay } from "node:timers/promises";
import {
  DiagnosticError,
  parseRevision,
  runtimeDiagnostic,
  type Clock,
  type DriverHealth,
  type ExpectedRevision,
  type JsonValue,
  type OperationJournalEntry,
  type OutboxMessage,
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
  readonly signature: string;
  readonly result: JsonValue;
}

export interface MemoryStateStoreOptions {
  readonly clock?: Clock;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value) as T;
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
    left.namespace.localeCompare(right.namespace) ||
    left.collection.localeCompare(right.collection) ||
    left.id.localeCompare(right.id)
  );
}

function stateError(
  code:
    | "STATE_CLOSED"
    | "STATE_FENCE_STALE"
    | "STATE_IDEMPOTENCY_CONFLICT"
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

function idempotencySignature(options: StateTransactionOptions): string {
  return JSON.stringify(options.fencing ?? null);
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
          (query.idPrefix === undefined || record.key.id.startsWith(query.idPrefix)),
      )
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    for (const record of matching) {
      yield scannedRecord<T>(record);
    }
  }

  async put<T extends JsonValue>(
    key: StateKey<T>,
    value: T,
    options: StateWriteOptions,
  ): Promise<void> {
    this.#assertActive();
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
    const storedKey = cloneKey(key) as StateKey<JsonValue>;
    this.#mutations.set(serializedKey(storedKey), {
      kind: "delete",
      key: storedKey,
      expectedRevision: options.expectedRevision,
    });
  }

  async appendOperation(entry: OperationJournalEntry): Promise<void> {
    this.#assertActive();
    this.#operations.push(structuredClone(entry));
  }

  async enqueueOutbox(message: OutboxMessage): Promise<void> {
    this.#assertActive();
    this.#outbox.push(structuredClone(message));
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
  readonly #clock: Clock;
  readonly #records = new Map<string, StoredRecord>();
  readonly #operations = new Map<string, OperationJournalEntry>();
  readonly #outbox = new Map<string, OutboxMessage>();
  readonly #fences = new Map<string, bigint>();
  readonly #changes: StateChange[] = [];
  readonly #watchers = new Set<MemoryWatchIterator>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #inFlightIdempotency = new Map<
    string,
    { readonly signature: string; readonly result: Promise<JsonValue> }
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
    const idempotencyKey = options.idempotencyKey;
    const signature = idempotencySignature(options);
    if (idempotencyKey !== undefined) {
      const replay = this.#idempotency.get(idempotencyKey);
      if (replay !== undefined) {
        this.#assertIdempotencySignature(idempotencyKey, signature, replay.signature);
        return cloneJson(replay.result) as T;
      }
      const inFlight = this.#inFlightIdempotency.get(idempotencyKey);
      if (inFlight !== undefined) {
        this.#assertIdempotencySignature(idempotencyKey, signature, inFlight.signature);
        return cloneJson(await inFlight.result) as T;
      }
    }

    const execution = this.#executeTransaction(options, work);
    if (idempotencyKey === undefined) {
      return execution;
    }

    this.#inFlightIdempotency.set(idempotencyKey, {
      signature,
      result: execution as Promise<JsonValue>,
    });
    try {
      return await execution;
    } finally {
      this.#inFlightIdempotency.delete(idempotencyKey);
    }
  }

  async read<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined> {
    this.#assertOpen();
    const record = this.#records.get(serializedKey(key));
    return record === undefined
      ? undefined
      : { value: cloneJson(record.value) as T, revision: record.revision };
  }

  async *scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
    this.#assertOpen();
    const matching = [...this.#records.values()]
      .filter(
        (record) =>
          record.key.namespace === query.namespace &&
          record.key.collection === query.collection &&
          (query.idPrefix === undefined || record.key.id.startsWith(query.idPrefix)),
      )
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    for (const record of matching) {
      this.#assertOpen();
      yield scannedRecord<T>(record);
    }
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
    return this.#enqueueCommit(() => this.#commit(options, staged, result));
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
      applied.length > 0 ||
      staged.operations.length > 0 ||
      staged.outbox.length > 0 ||
      advancesFence;
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
        this.#operations.set(entry.operationId, structuredClone(entry));
      }
      for (const message of staged.outbox) {
        this.#outbox.set(message.messageId, structuredClone(message));
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

    if (options.idempotencyKey !== undefined) {
      this.#idempotency.set(options.idempotencyKey, {
        signature: idempotencySignature(options),
        result: cloneJson(result),
      });
    }
    return cloneJson(result);
  }

  #assertIdempotencySignature(idempotencyKey: string, requested: string, committed: string): void {
    if (requested !== committed) {
      throw stateError(
        "STATE_IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used for a different transaction",
        { idempotencyKey },
        this.#clock,
      );
    }
  }

  #assertOpen(): void {
    if (this.#lifecycle !== "open") {
      throw this.#closedError();
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
