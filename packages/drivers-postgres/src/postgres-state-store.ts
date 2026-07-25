import {
  type DriverHealth,
  type ExpectedRevision,
  type JsonValue,
  type OperationJournalEntry,
  type OperationJournalQuery,
  OUTBOX_PAYLOAD_MAX_BYTES,
  OUTBOX_TOPIC_MAX_LENGTH,
  STATE_QUERY_MAX_LIMIT,
  type OutboxAcknowledgement,
  type OutboxAcknowledgementRequest,
  type OutboxClaim,
  type OutboxClaimRequest,
  type OutboxMessage,
  type PersistedOperationJournalEntry,
  parseFencingEpoch,
  parseMessageId,
  parseOperationId,
  parseRevision,
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
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  canonicalJson,
  cloneJson,
  createPool,
  decimal,
  isoTimestamp,
  jsonValue,
  monitorPostgresClient,
  openPool,
  type PostgresConnectionOptions,
  postgresError,
  postgresPoolHealth,
} from "./shared.js";

interface IdempotencyIdentity {
  readonly key: string;
  readonly fingerprint: string;
}

interface StoredRecord {
  readonly key: StateKey<JsonValue>;
  readonly value: JsonValue;
  readonly revision: Revision;
}

interface TransactionControl {
  readonly closedError: () => Error;
  readonly isClosed: () => boolean;
  readonly isReleased: (client: PoolClient) => boolean;
  readonly release: (client: PoolClient, destroy: boolean) => void;
  readonly startAcquiring: (client: PoolClient) => void;
  readonly stopAcquiring: (client: PoolClient) => void;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertStateQuery(query: StateQuery<JsonValue>): void {
  if (
    query.limit !== undefined &&
    (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > STATE_QUERY_MAX_LIMIT)
  ) {
    throw postgresError(
      "STATE_QUERY_INVALID",
      `State query limit must be a positive safe integer no greater than ${STATE_QUERY_MAX_LIMIT}`,
      "state",
      { limit: query.limit },
    );
  }
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

async function withPostgresTransaction<T>(
  pool: Pool,
  isolation: "READ COMMITTED" | "REPEATABLE READ",
  sessionLocks: readonly string[],
  control: TransactionControl,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const monitor = monitorPostgresClient(client, pool);
  const acquiredLocks: string[] = [];
  let failure: unknown;
  let failed = false;
  let result: T | undefined;
  let transactionStarted = false;
  control.startAcquiring(client);
  try {
    if (control.isClosed()) throw control.closedError();
    for (const lock of [...new Set(sessionLocks)].sort(compareCodeUnits)) {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lock]);
      acquiredLocks.push(lock);
    }
    control.stopAcquiring(client);
    if (control.isClosed()) throw control.closedError();
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    transactionStarted = true;
    result = await work(client);
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
      transactionStarted = false;
    }
    failed = true;
    failure = normalizeTransactionError(error, control.isClosed(), monitor.failure());
  }

  control.stopAcquiring(client);
  let cleanupFailure: unknown;
  if (!control.isReleased(client)) {
    for (const lock of acquiredLocks.reverse()) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
          [lock],
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          throw new Error("PostgreSQL did not release an acquired advisory lock");
        }
      } catch (error) {
        cleanupFailure = error;
        break;
      }
    }
    control.release(client, cleanupFailure !== undefined || monitor.failure() !== undefined);
  }
  monitor.close();

  if (failed) throw failure;
  if (cleanupFailure !== undefined) {
    throw postgresError(
      "STATE_BACKEND_FAILURE",
      "PostgreSQL failed to release a state transaction lock",
      "state",
    );
  }
  return result as T;
}

function normalizeTransactionError(
  error: unknown,
  closed: boolean,
  connectionFailure: Error | undefined,
): unknown {
  if (closed) {
    return postgresError("STATE_CLOSED", "PostgreSQL StateStore is closed", "state");
  }
  if (connectionFailure !== undefined) {
    return postgresError(
      "STATE_BACKEND_FAILURE",
      "PostgreSQL state transaction lost its backend connection",
      "state",
    );
  }
  const sqlState =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  if (sqlState === "40001" || sqlState === "40P01") {
    return postgresError(
      "STATE_REVISION_CONFLICT",
      "Concurrent PostgreSQL state transaction must be replanned",
      "state",
      { sqlState },
    );
  }
  if (
    sqlState?.startsWith("08") === true ||
    sqlState === "57P01" ||
    sqlState === "57P02" ||
    sqlState === "57P03"
  ) {
    return postgresError(
      "STATE_BACKEND_FAILURE",
      "PostgreSQL state transaction lost its backend connection",
      "state",
    );
  }
  return error;
}

function idempotencyLock(namespace: string, key: string): string {
  return `tego:state:idempotency:${namespace}:${key}`;
}

function fenceLock(namespace: string, resource: string): string {
  return `tego:state:fence:${namespace}:${resource}`;
}

function expectedMatches(actual: Revision | undefined, expected: ExpectedRevision): boolean {
  return (
    expected === undefined || (expected === "absent" ? actual === undefined : actual === expected)
  );
}

function idempotencyIdentity(options: StateTransactionOptions): IdempotencyIdentity | undefined {
  const key = options.idempotencyKey;
  const fingerprint = options.idempotencyFingerprint;
  if (key === undefined && fingerprint === undefined) return undefined;
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    typeof fingerprint !== "string" ||
    fingerprint.length === 0
  ) {
    throw postgresError(
      "STATE_IDEMPOTENCY_CONFLICT",
      "Idempotent transactions require a non-empty key and fingerprint",
      "state",
      {
        idempotencyFingerprint: typeof fingerprint === "string" ? fingerprint : null,
        idempotencyKey: typeof key === "string" ? key : null,
      },
    );
  }
  return { key, fingerprint };
}

function assertSameFingerprint(identity: IdempotencyIdentity, fingerprint: string): void {
  if (identity.fingerprint !== fingerprint) {
    throw postgresError(
      "STATE_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for a different transaction",
      "state",
      {
        committedFingerprint: fingerprint,
        idempotencyKey: identity.key,
        requestedFingerprint: identity.fingerprint,
      },
    );
  }
}

function assertOutboxMessage(message: OutboxMessage): void {
  if (
    message.topic.length > OUTBOX_TOPIC_MAX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(message.topic) ||
    Buffer.byteLength(canonicalJson(message.payload), "utf8") > OUTBOX_PAYLOAD_MAX_BYTES ||
    !validTimestamp(message.createdAt) ||
    !validTimestamp(message.availableAt)
  ) {
    throw postgresError(
      "STATE_DATA_INVALID",
      "Outbox message exceeds the public contract boundary",
      "state",
      { messageId: message.messageId },
    );
  }
}

function sameOutbox(left: OutboxMessage, right: OutboxMessage): boolean {
  return (
    left.messageId === right.messageId &&
    left.operationId === right.operationId &&
    left.topic === right.topic &&
    canonicalJson(left.payload) === canonicalJson(right.payload)
  );
}

function assertClaimRequest(request: OutboxClaimRequest): number {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.owner) ||
    (request.topic !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.topic)) ||
    !Number.isSafeInteger(request.leaseDurationMs) ||
    request.leaseDurationMs <= 0 ||
    request.leaseDurationMs > 86_400_000 ||
    (request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) || request.limit <= 0 || request.limit > 100))
  ) {
    throw postgresError("STATE_QUERY_INVALID", "Outbox claim request is invalid", "state", {
      leaseDurationMs: request.leaseDurationMs,
      limit: request.limit ?? null,
      owner: request.owner,
      topic: request.topic ?? null,
    });
  }
  return request.limit ?? 1;
}

function stateRecord(row: QueryResultRow): StoredRecord {
  return {
    key: {
      namespace: String(row.namespace),
      collection: String(row.collection_name),
      id: String(row.record_id),
    },
    value: jsonValue(row, "value_json"),
    revision: parseRevision(decimal(row.revision, "revision")),
  };
}

async function allocateRevision(client: PoolClient, namespace: string): Promise<Revision> {
  const result = await client.query<{ revision: string }>(
    `
      INSERT INTO tego_state_revisions(driver_namespace, revision)
      VALUES ($1, 1)
      ON CONFLICT(driver_namespace) DO UPDATE
        SET revision = tego_state_revisions.revision + 1
      RETURNING revision::text
    `,
    [namespace],
  );
  return parseRevision(decimal(result.rows[0]?.revision, "revision"));
}

async function verifyFence(
  client: PoolClient,
  namespace: string,
  fencing: StateTransactionOptions["fencing"],
): Promise<boolean> {
  if (fencing === undefined) return false;
  const authority = await client.query<{ epoch: string }>(
    `
      SELECT epoch::text
      FROM tego_coordination_epochs
      WHERE driver_namespace = $1 AND resource = $2
      FOR SHARE
    `,
    [namespace, fencing.resource],
  );
  const stored = await client.query<{ epoch: string }>(
    `
      SELECT epoch::text
      FROM tego_fences
      WHERE driver_namespace = $1 AND resource = $2
      FOR UPDATE
    `,
    [namespace, fencing.resource],
  );
  const authorityEpoch = authority.rows[0]?.epoch;
  const storedEpoch = stored.rows[0]?.epoch;
  const requested = BigInt(fencing.epoch);
  const current =
    authorityEpoch === undefined && storedEpoch === undefined
      ? undefined
      : [authorityEpoch, storedEpoch]
          .filter((value): value is string => value !== undefined)
          .map(BigInt)
          .reduce((left, right) => (left > right ? left : right));
  if (
    (current !== undefined && requested < current) ||
    (authorityEpoch !== undefined && requested !== BigInt(authorityEpoch))
  ) {
    throw postgresError("STATE_FENCE_STALE", "State transaction fencing epoch is stale", "state", {
      currentEpoch: current?.toString() ?? null,
      requestedEpoch: fencing.epoch,
      resource: fencing.resource,
    });
  }
  return storedEpoch === undefined || requested > BigInt(storedEpoch);
}

async function advanceFence(
  client: PoolClient,
  namespace: string,
  fencing: StateTransactionOptions["fencing"],
): Promise<void> {
  if (fencing === undefined) return;
  await client.query(
    `
      INSERT INTO tego_fences(driver_namespace, resource, epoch)
      VALUES ($1, $2, $3)
      ON CONFLICT(driver_namespace, resource) DO UPDATE SET epoch = EXCLUDED.epoch
      WHERE tego_fences.epoch < EXCLUDED.epoch
    `,
    [namespace, fencing.resource, fencing.epoch],
  );
}

class PostgresTransaction implements StateTransaction {
  readonly #client: PoolClient;
  readonly #namespace: string;
  #revision: Revision | undefined;
  #active = true;

  constructor(client: PoolClient, namespace: string) {
    this.#client = client;
    this.#namespace = namespace;
  }

  async get<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined> {
    this.#assertActive();
    const result = await this.#client.query(
      `
        SELECT namespace, collection_name, record_id, value_json, revision::text
        FROM tego_records
        WHERE driver_namespace = $1
          AND namespace = $2 AND collection_name = $3 AND record_id = $4
      `,
      [this.#namespace, key.namespace, key.collection, key.id],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const record = stateRecord(row);
    return { value: record.value as T, revision: record.revision };
  }

  async *scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
    this.#assertActive();
    assertStateQuery(query);
    const result = await this.#client.query(
      `
        SELECT namespace, collection_name, record_id, value_json, revision::text
        FROM tego_records
        WHERE driver_namespace = $1
          AND namespace = $2 AND collection_name = $3
          AND ($4::text IS NULL OR starts_with(record_id, $4))
      `,
      [this.#namespace, query.namespace, query.collection, query.idPrefix ?? null],
    );
    const matching = result.rows
      .filter(
        (row) =>
          query.afterId === undefined || compareCodeUnits(String(row.record_id), query.afterId) > 0,
      )
      .sort((left, right) => compareCodeUnits(String(left.record_id), String(right.record_id)));
    const rows = query.limit === undefined ? matching : matching.slice(0, query.limit);
    for (const row of rows) {
      this.#assertActive();
      const record = stateRecord(row);
      yield { key: record.key as StateKey<T>, value: record.value as T, revision: record.revision };
    }
  }

  async put<T extends JsonValue>(
    key: StateKey<T>,
    value: T,
    options: StateWriteOptions,
  ): Promise<void> {
    this.#assertActive();
    const current = await this.#lockedRevision(key);
    if (!expectedMatches(current, options.expectedRevision)) {
      throw this.#revisionConflict(key, options.expectedRevision, current);
    }
    const revision = await this.#writeRevision();
    const cloned = cloneJson(value);
    await this.#client.query(
      `
        INSERT INTO tego_records(
          driver_namespace, namespace, collection_name, record_id, value_json, revision
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        ON CONFLICT(driver_namespace, namespace, collection_name, record_id) DO UPDATE SET
          value_json = EXCLUDED.value_json,
          revision = EXCLUDED.revision
      `,
      [this.#namespace, key.namespace, key.collection, key.id, canonicalJson(cloned), revision],
    );
    await this.#client.query(
      `
        INSERT INTO tego_state_changes(
          driver_namespace, revision, namespace, collection_name, record_id, kind, value_json
        ) VALUES ($1, $2, $3, $4, $5, 'put', $6::jsonb)
      `,
      [this.#namespace, revision, key.namespace, key.collection, key.id, canonicalJson(cloned)],
    );
  }

  async delete<T extends JsonValue>(key: StateKey<T>, options: StateWriteOptions): Promise<void> {
    this.#assertActive();
    const current = await this.#lockedRevision(key);
    if (!expectedMatches(current, options.expectedRevision)) {
      throw this.#revisionConflict(key, options.expectedRevision, current);
    }
    if (current === undefined) return;
    const revision = await this.#writeRevision();
    await this.#client.query(
      `
        DELETE FROM tego_records
        WHERE driver_namespace = $1
          AND namespace = $2 AND collection_name = $3 AND record_id = $4
      `,
      [this.#namespace, key.namespace, key.collection, key.id],
    );
    await this.#client.query(
      `
        INSERT INTO tego_state_changes(
          driver_namespace, revision, namespace, collection_name, record_id, kind
        ) VALUES ($1, $2, $3, $4, $5, 'delete')
      `,
      [this.#namespace, revision, key.namespace, key.collection, key.id],
    );
  }

  async appendOperation(entry: OperationJournalEntry): Promise<void> {
    this.#assertActive();
    if (!validTimestamp(entry.updatedAt)) {
      throw postgresError("STATE_DATA_INVALID", "Operation timestamp is invalid", "state", {
        operationId: entry.operationId,
      });
    }
    const revision = await this.#writeRevision();
    await this.#client.query(
      `
        INSERT INTO tego_operations(
          driver_namespace, operation_id, kind, status, state_json, updated_at, revision
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
        ON CONFLICT(driver_namespace, operation_id) DO UPDATE SET
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          state_json = EXCLUDED.state_json,
          updated_at = EXCLUDED.updated_at,
          revision = EXCLUDED.revision
      `,
      [
        this.#namespace,
        entry.operationId,
        entry.kind,
        entry.status,
        canonicalJson(entry.state),
        entry.updatedAt,
        revision,
      ],
    );
  }

  async enqueueOutbox(message: OutboxMessage): Promise<void> {
    this.#assertActive();
    assertOutboxMessage(message);
    const cloned: OutboxMessage = { ...message, payload: cloneJson(message.payload) };
    const existing = await this.#client.query(
      `
        SELECT operation_id, topic, payload_json, created_at, available_at,
          acknowledgement_outcome
        FROM tego_outbox
        WHERE driver_namespace = $1 AND message_id = $2
        FOR UPDATE
      `,
      [this.#namespace, message.messageId],
    );
    const row = existing.rows[0];
    if (row !== undefined && row.acknowledgement_outcome !== "retry") {
      const persisted: OutboxMessage = {
        messageId: message.messageId,
        operationId: parseOperationId(String(row.operation_id)),
        topic: String(row.topic),
        payload: jsonValue(row, "payload_json"),
        createdAt: isoTimestamp(row.created_at, "created_at"),
        availableAt: isoTimestamp(row.available_at, "available_at"),
      };
      if (!sameOutbox(persisted, cloned)) {
        throw postgresError(
          "STATE_IDEMPOTENCY_CONFLICT",
          "Outbox message identity was reused with different content",
          "state",
          { messageId: message.messageId },
        );
      }
      return;
    }
    const revision = await this.#writeRevision();
    const enqueueSequence = await this.#nextEnqueueSequence();
    await this.#client.query(
      `
        INSERT INTO tego_outbox(
          driver_namespace, message_id, operation_id, topic, payload_json,
          created_at, available_at, enqueue_sequence, revision
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
        ON CONFLICT(driver_namespace, message_id) DO UPDATE SET
          operation_id = EXCLUDED.operation_id,
          topic = EXCLUDED.topic,
          payload_json = EXCLUDED.payload_json,
          created_at = EXCLUDED.created_at,
          available_at = EXCLUDED.available_at,
          enqueue_sequence = EXCLUDED.enqueue_sequence,
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
          revision = EXCLUDED.revision
      `,
      [
        this.#namespace,
        cloned.messageId,
        cloned.operationId,
        cloned.topic,
        canonicalJson(cloned.payload),
        cloned.createdAt,
        cloned.availableAt,
        enqueueSequence.toString(),
        revision,
      ],
    );
  }

  finish(): Revision | undefined {
    this.#assertActive();
    this.#active = false;
    return this.#revision;
  }

  abort(): void {
    this.#active = false;
  }

  async #lockedRevision<T extends JsonValue>(key: StateKey<T>): Promise<Revision | undefined> {
    const result = await this.#client.query<{ revision: string }>(
      `
        SELECT revision::text
        FROM tego_records
        WHERE driver_namespace = $1
          AND namespace = $2 AND collection_name = $3 AND record_id = $4
        FOR UPDATE
      `,
      [this.#namespace, key.namespace, key.collection, key.id],
    );
    const revision = result.rows[0]?.revision;
    return revision === undefined ? undefined : parseRevision(decimal(revision, "revision"));
  }

  async #writeRevision(): Promise<Revision> {
    this.#revision ??= await allocateRevision(this.#client, this.#namespace);
    return this.#revision;
  }

  async #nextEnqueueSequence(): Promise<bigint> {
    const result = await this.#client.query<{ value: string }>(
      `
        SELECT nextval(
          pg_get_serial_sequence('tego_state_changes', 'sequence')
        )::text AS value
      `,
    );
    return BigInt(decimal(result.rows[0]?.value, "enqueue_sequence"));
  }

  #revisionConflict<T extends JsonValue>(
    key: StateKey<T>,
    expected: ExpectedRevision,
    actual: Revision | undefined,
  ) {
    return postgresError(
      "STATE_REVISION_CONFLICT",
      "State record revision does not match",
      "state",
      {
        actualRevision: actual ?? null,
        expectedRevision: expected ?? null,
        key: { collection: key.collection, id: key.id, namespace: key.namespace },
      },
    );
  }

  #assertActive(): void {
    if (!this.#active) {
      throw postgresError("STATE_CLOSED", "State transaction is no longer active", "state");
    }
  }
}

class StateWatchIterator implements AsyncIterator<StateChange>, AsyncIterable<StateChange> {
  readonly #read: (cursor: Revision) => Promise<readonly StateChange[]>;
  readonly #onClose: () => void;
  readonly #queue: StateChange[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<StateChange>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  readonly #closeSignal = Promise.withResolvers<void>();
  #cursor: Revision;
  #closed = false;
  #failure: unknown;
  #reading: Promise<void> | undefined;

  constructor(
    cursor: Revision,
    read: (cursor: Revision) => Promise<readonly StateChange[]>,
    onClose: () => void,
  ) {
    this.#cursor = cursor;
    this.#read = read;
    this.#onClose = onClose;
  }

  [Symbol.asyncIterator](): AsyncIterator<StateChange> {
    return this;
  }

  async next(): Promise<IteratorResult<StateChange>> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return { done: false, value: queued };
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed) return { done: true, value: undefined };
    await Promise.race([this.#fill(), this.#closeSignal.promise]);
    const change = this.#queue.shift();
    if (change !== undefined) return { done: false, value: change };
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed) return { done: true, value: undefined };
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<StateChange>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  wake(): void {
    void this.#fill().catch((error: unknown) => this.#fail(error));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeSignal.resolve();
    this.#queue.length = 0;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
    this.#onClose();
  }

  async #fill(): Promise<void> {
    if (this.#closed) return;
    if (this.#reading !== undefined) return this.#reading;
    const reading = (async () => {
      const changes = await this.#read(this.#cursor);
      for (const change of changes) {
        if (this.#closed) return;
        this.#cursor = change.revision;
        const waiter = this.#waiters.shift();
        if (waiter === undefined) this.#queue.push(change);
        else waiter.resolve({ done: false, value: change });
      }
    })();
    this.#reading = reading;
    try {
      await reading;
    } finally {
      if (this.#reading === reading) this.#reading = undefined;
    }
  }

  #fail(error: unknown): void {
    if (this.#closed || this.#failure !== undefined) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    this.close();
  }
}

export class PostgresStateStore implements StateStore {
  readonly scope = "shared" as const;
  readonly #namespace: string;
  readonly #pool: Pool;
  readonly #inFlightIdempotency = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<JsonValue> }
  >();
  readonly #acquiringClients = new Set<PoolClient>();
  readonly #executions = new Set<Promise<unknown>>();
  readonly #releasedClients = new WeakSet<PoolClient>();
  readonly #watchers = new Set<StateWatchIterator>();
  #lifecycle: "closed" | "created" | "open" | "opening" = "created";
  #openPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: PostgresConnectionOptions) {
    this.#namespace = options.namespace;
    this.#pool = createPool(options, "state");
  }

  open(): Promise<void> {
    if (this.#lifecycle === "closed") return Promise.reject(this.#closedError());
    if (this.#lifecycle === "open") return Promise.resolve();
    if (this.#openPromise !== undefined) return this.#openPromise;
    this.#lifecycle = "opening";
    const opening = openPool(this.#pool).then(
      () => {
        if (this.#lifecycle === "closed") throw this.#closedError();
        this.#lifecycle = "open";
      },
      (error: unknown) => {
        if (this.#lifecycle === "opening") this.#lifecycle = "created";
        throw error;
      },
    );
    this.#openPromise = opening;
    const clearOpening = () => {
      if (this.#openPromise === opening) this.#openPromise = undefined;
    };
    void opening.then(clearOpening, clearOpening);
    return opening;
  }

  async transact<T extends JsonValue>(
    options: StateTransactionOptions,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const identity = idempotencyIdentity(options);
    if (identity !== undefined) {
      const inFlight = this.#inFlightIdempotency.get(identity.key);
      if (inFlight !== undefined) {
        assertSameFingerprint(identity, inFlight.fingerprint);
        return cloneJson((await inFlight.result) as T);
      }
    }
    if (identity === undefined) {
      return this.#trackExecution(this.#executeTransaction(options, identity, work));
    }
    const deferred = Promise.withResolvers<JsonValue>();
    const inFlight = { fingerprint: identity.fingerprint, result: deferred.promise };
    this.#inFlightIdempotency.set(identity.key, inFlight);
    const execute = this.#trackExecution(this.#executeTransaction(options, identity, work));
    void execute.then(deferred.resolve, deferred.reject);
    try {
      return cloneJson((await deferred.promise) as T);
    } finally {
      if (this.#inFlightIdempotency.get(identity.key) === inFlight) {
        this.#inFlightIdempotency.delete(identity.key);
      }
    }
  }

  async read<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined> {
    this.#assertOpen();
    const result = await this.#pool.query(
      `
        SELECT namespace, collection_name, record_id, value_json, revision::text
        FROM tego_records
        WHERE driver_namespace = $1
          AND namespace = $2 AND collection_name = $3 AND record_id = $4
      `,
      [this.#namespace, key.namespace, key.collection, key.id],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const record = stateRecord(row);
    return { value: record.value as T, revision: record.revision };
  }

  async *scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
    this.#assertOpen();
    assertStateQuery(query);
    const result = await this.#pool.query(
      `
        SELECT namespace, collection_name, record_id, value_json, revision::text
        FROM tego_records
        WHERE driver_namespace = $1
          AND namespace = $2 AND collection_name = $3
          AND ($4::text IS NULL OR starts_with(record_id, $4))
      `,
      [this.#namespace, query.namespace, query.collection, query.idPrefix ?? null],
    );
    const matching = result.rows
      .filter(
        (row) =>
          query.afterId === undefined || compareCodeUnits(String(row.record_id), query.afterId) > 0,
      )
      .sort((left, right) => compareCodeUnits(String(left.record_id), String(right.record_id)));
    const rows = query.limit === undefined ? matching : matching.slice(0, query.limit);
    for (const row of rows) {
      this.#assertOpen();
      const record = stateRecord(row);
      yield { key: record.key as StateKey<T>, value: record.value as T, revision: record.revision };
    }
  }

  watch(cursor: Revision): AsyncIterable<StateChange> {
    this.#assertOpen();
    let watcher: StateWatchIterator;
    let polling: ReturnType<typeof setInterval> | undefined;
    watcher = new StateWatchIterator(
      cursor,
      (from) => this.#readChanges(from),
      () => {
        if (polling !== undefined) clearInterval(polling);
        this.#watchers.delete(watcher);
      },
    );
    this.#watchers.add(watcher);
    polling = setInterval(() => watcher.wake(), 25);
    polling.unref();
    watcher.wake();
    return watcher;
  }

  async *scanRecoverableOperations(
    query: OperationJournalQuery = {},
  ): AsyncIterable<PersistedOperationJournalEntry> {
    yield* this.#scanOperationJournal(query, true);
  }

  async *scanOperations(
    query: OperationJournalQuery = {},
  ): AsyncIterable<PersistedOperationJournalEntry> {
    yield* this.#scanOperationJournal(query, false);
  }

  async *#scanOperationJournal(
    query: OperationJournalQuery,
    recoverableOnly: boolean,
  ): AsyncIterable<PersistedOperationJournalEntry> {
    this.#assertOpen();
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) {
      throw postgresError(
        "STATE_QUERY_INVALID",
        "Operation journal query limit must be positive",
        "state",
        { limit: query.limit },
      );
    }
    const result = await this.#pool.query(
      `
        SELECT operation_id, kind, status, state_json, updated_at, revision::text
        FROM tego_operations
        WHERE driver_namespace = $1
          ${recoverableOnly ? "AND status IN ('executing', 'planned')" : ""}
      `,
      [this.#namespace],
    );
    const after = query.after;
    const orderedRows = result.rows
      .map((row) => ({
        row,
        operationId: String(row.operation_id),
        revision: decimal(row.revision, "revision"),
      }))
      .filter(({ operationId, revision }) => {
        if (after === undefined) return true;
        const revisionOrder = BigInt(revision) - BigInt(after.revision);
        return (
          revisionOrder > 0n ||
          (revisionOrder === 0n && compareCodeUnits(operationId, after.operationId) > 0)
        );
      })
      .sort(
        (left, right) =>
          (BigInt(left.revision) < BigInt(right.revision)
            ? -1
            : BigInt(left.revision) > BigInt(right.revision)
              ? 1
              : 0) || compareCodeUnits(left.operationId, right.operationId),
      );
    const rows = query.limit === undefined ? orderedRows : orderedRows.slice(0, query.limit);
    for (const { row } of rows) {
      this.#assertOpen();
      yield {
        operationId: parseOperationId(String(row.operation_id)),
        kind: String(row.kind),
        status: row.status as PersistedOperationJournalEntry["status"],
        state: jsonValue(row, "state_json"),
        updatedAt: isoTimestamp(row.updated_at, "updated_at"),
        revision: parseRevision(decimal(row.revision, "revision")),
      };
    }
  }

  async claimOutbox(request: OutboxClaimRequest): Promise<readonly OutboxClaim[]> {
    this.#assertOpen();
    const limit = assertClaimRequest(request);
    const locks =
      request.fencing === undefined ? [] : [fenceLock(this.#namespace, request.fencing.resource)];
    return this.#trackExecution(
      this.#withTransaction("READ COMMITTED", locks, async (client) => {
        const advancesFence = await verifyFence(client, this.#namespace, request.fencing);
        const result = await client.query(
          `
          SELECT message_id, operation_id, topic, payload_json, created_at, available_at, attempt,
            clock_timestamp() AS claimed_at
          FROM tego_outbox
          WHERE driver_namespace = $1
            AND acknowledgement_outcome IS DISTINCT FROM 'completed'
            AND ($2::text IS NULL OR topic = $2)
            AND available_at <= clock_timestamp()
            AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp())
          ORDER BY available_at, enqueue_sequence, message_id COLLATE "C"
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        `,
          [this.#namespace, request.topic ?? null, limit],
        );
        if (result.rows.length === 0 && !advancesFence) return [];
        const revision = await allocateRevision(client, this.#namespace);
        if (advancesFence) await advanceFence(client, this.#namespace, request.fencing);
        const claims: OutboxClaim[] = [];
        for (const row of result.rows) {
          const storedAttempt = Number(row.attempt);
          if (
            !Number.isSafeInteger(storedAttempt) ||
            storedAttempt < 0 ||
            storedAttempt >= Number.MAX_SAFE_INTEGER
          ) {
            throw postgresError(
              "STATE_DATA_INVALID",
              "PostgreSQL outbox contains an invalid delivery attempt",
              "state",
              { messageId: String(row.message_id) },
            );
          }
          const attempt = storedAttempt + 1;
          const claimedAt = isoTimestamp(row.claimed_at, "claimed_at");
          const expiresAt = new Date(Date.parse(claimedAt) + request.leaseDurationMs).toISOString();
          const claim: OutboxClaim = {
            message: {
              messageId: parseMessageId(String(row.message_id)),
              operationId: parseOperationId(String(row.operation_id)),
              topic: String(row.topic),
              payload: jsonValue(row, "payload_json"),
              createdAt: isoTimestamp(row.created_at, "created_at"),
              availableAt: isoTimestamp(row.available_at, "available_at"),
            },
            owner: request.owner,
            claimEpoch: parseFencingEpoch(String(attempt)),
            attempt,
            claimedAt,
            expiresAt,
          };
          claims.push(claim);
          await client.query(
            `
            UPDATE tego_outbox SET
              attempt = $3, claim_owner = $4, claim_epoch = $5,
              claimed_at = $6, claim_expires_at = $7,
              acknowledgement_outcome = NULL, acknowledgement_owner = NULL,
              acknowledgement_claim_epoch = NULL, acknowledgement_retry_at = NULL,
              acknowledged_at = NULL, revision = $8
            WHERE driver_namespace = $1 AND message_id = $2
          `,
            [
              this.#namespace,
              claim.message.messageId,
              claim.attempt,
              claim.owner,
              claim.claimEpoch,
              claim.claimedAt,
              claim.expiresAt,
              revision,
            ],
          );
        }
        return claims;
      }),
    );
  }

  async acknowledgeOutbox(request: OutboxAcknowledgementRequest): Promise<OutboxAcknowledgement> {
    this.#assertOpen();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.owner) ||
      (request.outcome === "retry" &&
        (request.retryAt === undefined || !validTimestamp(request.retryAt))) ||
      (request.outcome === "completed" && request.retryAt !== undefined)
    ) {
      throw postgresError(
        "STATE_QUERY_INVALID",
        "Outbox acknowledgement request is invalid",
        "state",
      );
    }
    const locks =
      request.fencing === undefined ? [] : [fenceLock(this.#namespace, request.fencing.resource)];
    return this.#trackExecution(
      this.#withTransaction("READ COMMITTED", locks, async (client) => {
        const advancesFence = await verifyFence(client, this.#namespace, request.fencing);
        const result = await client.query(
          `
          SELECT attempt, claim_owner, claim_epoch::text, acknowledgement_outcome,
            acknowledgement_owner, acknowledgement_claim_epoch::text,
            acknowledgement_retry_at, acknowledged_at
          FROM tego_outbox
          WHERE driver_namespace = $1 AND message_id = $2
          FOR UPDATE
        `,
          [this.#namespace, request.messageId],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw postgresError("STATE_QUERY_INVALID", "Outbox message does not exist", "state", {
            messageId: request.messageId,
          });
        }
        const sameAcknowledgedClaim =
          (row.acknowledgement_outcome === "completed" ||
            row.acknowledgement_outcome === "retry") &&
          row.acknowledgement_owner === request.owner &&
          row.acknowledgement_claim_epoch === request.claimEpoch;
        if (sameAcknowledgedClaim) {
          const retryAt =
            row.acknowledgement_retry_at === null
              ? undefined
              : isoTimestamp(row.acknowledgement_retry_at, "retry_at");
          if (row.acknowledgement_outcome !== request.outcome || retryAt !== request.retryAt) {
            throw postgresError(
              "STATE_IDEMPOTENCY_CONFLICT",
              "Outbox claim was acknowledged with a different outcome",
              "state",
              { claimEpoch: request.claimEpoch, messageId: request.messageId },
            );
          }
          if (advancesFence) {
            await allocateRevision(client, this.#namespace);
            await advanceFence(client, this.#namespace, request.fencing);
          }
          return {
            messageId: request.messageId,
            outcome: request.outcome,
            attempt: this.#outboxAttempt(row.attempt, request.messageId),
            acknowledgedAt: isoTimestamp(row.acknowledged_at, "acknowledged_at"),
            duplicate: true,
            ...(retryAt === undefined ? {} : { retryAt }),
          };
        }
        if (row.claim_owner !== request.owner || row.claim_epoch !== request.claimEpoch) {
          throw postgresError(
            "STATE_FENCE_STALE",
            "Outbox acknowledgement claim fence is stale",
            "state",
            {
              actualClaimEpoch: typeof row.claim_epoch === "string" ? row.claim_epoch : null,
              messageId: request.messageId,
              requestedClaimEpoch: request.claimEpoch,
            },
          );
        }
        const attempt = this.#outboxAttempt(row.attempt, request.messageId);
        const revision = await allocateRevision(client, this.#namespace);
        if (advancesFence) await advanceFence(client, this.#namespace, request.fencing);
        const updated = await client.query<{ acknowledged_at: Date }>(
          `
          UPDATE tego_outbox SET
            acknowledgement_outcome = $3,
            acknowledgement_owner = $4,
            acknowledgement_claim_epoch = $5,
            acknowledgement_retry_at = $6,
            acknowledged_at = clock_timestamp(),
            available_at = CASE WHEN $3 = 'retry' THEN $6 ELSE available_at END,
            claim_owner = NULL,
            claim_epoch = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            revision = $7
          WHERE driver_namespace = $1 AND message_id = $2
          RETURNING acknowledged_at
        `,
          [
            this.#namespace,
            request.messageId,
            request.outcome,
            request.owner,
            request.claimEpoch,
            request.retryAt ?? null,
            revision,
          ],
        );
        return {
          messageId: request.messageId,
          outcome: request.outcome,
          attempt,
          acknowledgedAt: isoTimestamp(updated.rows[0]?.acknowledged_at, "acknowledged_at"),
          duplicate: false,
          ...(request.retryAt === undefined ? {} : { retryAt: request.retryAt }),
        };
      }),
    );
  }

  async health(): Promise<DriverHealth> {
    this.#assertOpen();
    return postgresPoolHealth(this.#pool);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#lifecycle === "closed") return Promise.resolve();
    this.#lifecycle = "closed";
    const closing = (async () => {
      await this.#openPromise?.catch(() => undefined);
      for (const watcher of [...this.#watchers]) watcher.close();
      for (const client of [...this.#acquiringClients]) this.#releaseClient(client, true);
      this.#acquiringClients.clear();
      await Promise.allSettled([...this.#executions]);
      await this.#pool.end();
    })();
    this.#closePromise = closing;
    return closing;
  }

  async #executeTransaction<T extends JsonValue>(
    options: StateTransactionOptions,
    identity: IdempotencyIdentity | undefined,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    const sessionLocks = [
      ...(identity === undefined ? [] : [idempotencyLock(this.#namespace, identity.key)]),
      ...(options.fencing === undefined
        ? []
        : [fenceLock(this.#namespace, options.fencing.resource)]),
    ];
    return this.#withTransaction("REPEATABLE READ", sessionLocks, async (client) => {
      if (identity !== undefined) {
        const replay = await client.query<{ fingerprint: string; result_json: JsonValue }>(
          `
            SELECT fingerprint, result_json
            FROM tego_idempotency
            WHERE driver_namespace = $1 AND idempotency_key = $2
            FOR UPDATE
          `,
          [this.#namespace, identity.key],
        );
        const row = replay.rows[0];
        if (row !== undefined) {
          assertSameFingerprint(identity, row.fingerprint);
          return cloneJson(row.result_json as T);
        }
      }
      const advancesFence = await verifyFence(client, this.#namespace, options.fencing);
      const transaction = new PostgresTransaction(client, this.#namespace);
      let result: T;
      try {
        result = cloneJson(await work(transaction));
      } catch (error) {
        transaction.abort();
        throw error;
      }
      const revision = transaction.finish();
      if (advancesFence) {
        if (revision === undefined) await allocateRevision(client, this.#namespace);
        await advanceFence(client, this.#namespace, options.fencing);
      }
      if (identity !== undefined) {
        await client.query(
          `
            INSERT INTO tego_idempotency(
              driver_namespace, idempotency_key, fingerprint, result_json
            ) VALUES ($1, $2, $3, $4::jsonb)
          `,
          [this.#namespace, identity.key, identity.fingerprint, canonicalJson(result)],
        );
      }
      if (revision !== undefined) {
        await client.query("SELECT pg_notify('tego_state_changes', $1)", [this.#namespace]);
      }
      return cloneJson(result);
    }).then((result) => {
      for (const watcher of this.#watchers) watcher.wake();
      return result;
    });
  }

  #withTransaction<T>(
    isolation: "READ COMMITTED" | "REPEATABLE READ",
    sessionLocks: readonly string[],
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return withPostgresTransaction(
      this.#pool,
      isolation,
      sessionLocks,
      this.#transactionControl(),
      work,
    );
  }

  #transactionControl(): TransactionControl {
    return {
      closedError: () => this.#closedError(),
      isClosed: () => this.#lifecycle === "closed",
      isReleased: (client) => this.#releasedClients.has(client),
      release: (client, destroy) => this.#releaseClient(client, destroy),
      startAcquiring: (client) => {
        this.#releasedClients.delete(client);
        this.#acquiringClients.add(client);
      },
      stopAcquiring: (client) => this.#acquiringClients.delete(client),
    };
  }

  #releaseClient(client: PoolClient, destroy: boolean): void {
    if (this.#releasedClients.has(client)) return;
    this.#releasedClients.add(client);
    client.release(destroy);
  }

  async #trackExecution<T>(execution: Promise<T>): Promise<T> {
    this.#executions.add(execution);
    try {
      return await execution;
    } finally {
      this.#executions.delete(execution);
    }
  }

  #outboxAttempt(value: unknown, messageId: string): number {
    const attempt = Number(value);
    if (!Number.isSafeInteger(attempt) || attempt <= 0) {
      throw postgresError(
        "STATE_DATA_INVALID",
        "PostgreSQL outbox contains an invalid delivery attempt",
        "state",
        { messageId },
      );
    }
    return attempt;
  }

  async #readChanges(cursor: Revision): Promise<readonly StateChange[]> {
    if (this.#lifecycle !== "open") return [];
    const result = await this.#pool.query(
      `
        SELECT sequence::text, revision::text, namespace, collection_name, record_id, kind,
          value_json
        FROM tego_state_changes
        WHERE driver_namespace = $1 AND revision > $2
      `,
      [this.#namespace, cursor],
    );
    const rows = result.rows.sort((left, right) => {
      const leftRevision = BigInt(decimal(left.revision, "revision"));
      const rightRevision = BigInt(decimal(right.revision, "revision"));
      return (
        (leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0) ||
        compareCodeUnits(String(left.namespace), String(right.namespace)) ||
        compareCodeUnits(String(left.collection_name), String(right.collection_name)) ||
        compareCodeUnits(String(left.record_id), String(right.record_id)) ||
        (BigInt(decimal(left.sequence, "sequence")) < BigInt(decimal(right.sequence, "sequence"))
          ? -1
          : BigInt(decimal(left.sequence, "sequence")) > BigInt(decimal(right.sequence, "sequence"))
            ? 1
            : 0)
      );
    });
    return rows.map(
      (row): StateChange => ({
        revision: parseRevision(decimal(row.revision, "revision")),
        key: {
          namespace: String(row.namespace),
          collection: String(row.collection_name),
          id: String(row.record_id),
        },
        kind: row.kind as StateChange["kind"],
        ...(row.kind === "put" ? { value: jsonValue(row, "value_json") } : {}),
      }),
    );
  }

  #assertOpen(): void {
    if (this.#lifecycle !== "open") throw this.#closedError();
  }

  #closedError() {
    return postgresError("STATE_CLOSED", "PostgreSQL state store is closed", "state");
  }
}
