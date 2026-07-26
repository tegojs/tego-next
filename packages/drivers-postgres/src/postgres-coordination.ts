import {
  type CampaignRequest,
  type CasResult,
  type CompareAndSetRequest,
  type CoordinationChange,
  type CoordinationProvider,
  type CoordinationWatchRequest,
  type DriverHealth,
  type FencingEpoch,
  type JsonValue,
  type Leadership,
  type LeadershipHandle,
  type Lease,
  type LeaseRequest,
  parseFencingEpoch,
  parseRevision,
  type Revision,
  runtimeDiagnostic,
  type RuntimeDiagnostic,
  serializeCause,
} from "@tegojs/contracts";
import type { Notification, Pool, PoolClient, QueryResultRow } from "pg";
import {
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

const NOTIFICATION_CHANNEL = "tego_coordination_changes";
const WATCH_POLL_INTERVAL_MS = 50;
const WATCH_BATCH_SIZE = 100;

interface EpochRow extends QueryResultRow {
  readonly epoch: string;
}

interface LeaseRow extends QueryResultRow {
  readonly owner: string;
  readonly epoch: string;
  readonly acquired_at: Date;
  readonly expires_at: Date;
}

interface RecordRow extends QueryResultRow {
  readonly value_json: unknown;
  readonly revision: string;
}

interface ChangeRow extends QueryResultRow {
  readonly record_key: string;
  readonly value_json: unknown;
  readonly revision: string;
}

interface LeadershipSession {
  readonly client: PoolClient;
  readonly leadership: Leadership;
  readonly resolveLost: (diagnostic: RuntimeDiagnostic) => void;
  readonly onError: (error: Error) => void;
  readonly onEnd: () => void;
  releasePromise?: Promise<void>;
}

interface PendingNext {
  readonly resolve: (result: IteratorResult<CoordinationChange>) => void;
  readonly reject: (error: unknown) => void;
}

class PostgresCoordinationWatch
  implements AsyncIterable<CoordinationChange>, AsyncIterator<CoordinationChange>
{
  readonly #scanChanges: (cursor: Revision) => Promise<readonly CoordinationChange[]>;
  readonly #onClose: () => void;
  readonly #queue: CoordinationChange[] = [];
  readonly #pending: PendingNext[] = [];
  #cursor: Revision;
  #closed = false;
  #pumping = false;
  #wake: (() => void) | undefined;

  constructor(
    cursor: Revision,
    scanChanges: (cursor: Revision) => Promise<readonly CoordinationChange[]>,
    onClose: () => void,
  ) {
    this.#cursor = cursor;
    this.#scanChanges = scanChanges;
    this.#onClose = onClose;
  }

  [Symbol.asyncIterator](): AsyncIterator<CoordinationChange> {
    return this;
  }

  next(): Promise<IteratorResult<CoordinationChange>> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return Promise.resolve({ done: false, value: queued });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    const result = new Promise<IteratorResult<CoordinationChange>>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
    });
    this.#startPump();
    return result;
  }

  return(): Promise<IteratorResult<CoordinationChange>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  wake(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    this.wake();
    for (const pending of this.#pending.splice(0)) {
      pending.resolve({ done: true, value: undefined });
    }
    this.#onClose();
  }

  #startPump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    void this.#pump().then(
      () => {
        this.#pumping = false;
      },
      (error: unknown) => {
        this.#pumping = false;
        for (const pending of this.#pending.splice(0)) pending.reject(error);
      },
    );
  }

  async #pump(): Promise<void> {
    while (!this.#closed && this.#pending.length > 0) {
      const changes = await this.#scanChanges(this.#cursor);
      if (this.#closed) return;
      if (changes.length === 0) {
        await this.#waitForWake();
        continue;
      }

      for (const change of changes) {
        this.#cursor = change.revision;
        const pending = this.#pending.shift();
        if (pending === undefined) {
          this.#queue.push(change);
        } else {
          pending.resolve({ done: false, value: change });
        }
      }
    }
  }

  #waitForWake(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#wake === wake) this.#wake = undefined;
        resolve();
      }, WATCH_POLL_INTERVAL_MS);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.#wake = wake;
    });
  }
}

export class PostgresCoordinationProvider implements CoordinationProvider {
  readonly scope = "distributed" as const;
  readonly #options: PostgresConnectionOptions;
  readonly #pool: Pool;
  readonly #campaigns = new Map<string, Promise<LeadershipHandle>>();
  readonly #leadership = new Map<string, LeadershipSession>();
  readonly #acquiringClients = new Set<PoolClient>();
  readonly #releasedClients = new WeakSet<PoolClient>();
  readonly #watches = new Set<PostgresCoordinationWatch>();
  #listener: PoolClient | undefined;
  #listenerPromise: Promise<void> | undefined;
  #openPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #lifecycle: "closed" | "created" | "open" = "created";

  constructor(options: PostgresConnectionOptions) {
    this.#options = options;
    this.#pool = createPool(options, "coordination", 20);
  }

  open(): Promise<void> {
    if (this.#lifecycle === "closed") return Promise.reject(this.#closedError());
    if (this.#lifecycle === "open") return Promise.resolve();
    if (this.#openPromise !== undefined) return this.#openPromise;
    const opening = (async () => {
      await openPool(this.#pool);
      if (this.#lifecycle === "closed") throw this.#closedError();
      await this.#ensureListener();
      if (this.#isClosed()) throw this.#closedError();
      this.#lifecycle = "open";
    })();
    this.#openPromise = opening;
    void opening.catch(() => {
      if (this.#openPromise === opening) this.#openPromise = undefined;
    });
    return opening;
  }

  campaign(request: CampaignRequest): Promise<LeadershipHandle> {
    this.#assertOpen();
    this.#assertResource(request.resource);
    const existing = this.#campaigns.get(request.resource);
    if (existing !== undefined) return existing;

    const campaign = this.#acquireLeadership(request.resource);
    this.#campaigns.set(request.resource, campaign);
    void campaign.catch(() => {
      if (this.#campaigns.get(request.resource) === campaign) {
        this.#campaigns.delete(request.resource);
      }
    });
    return campaign;
  }

  async acquireLease(request: LeaseRequest): Promise<Lease> {
    this.#assertOpen();
    this.#assertResource(request.resource);
    if (request.owner.length === 0) {
      throw this.#requestError("Lease owner must not be empty", { owner: request.owner });
    }
    if (!Number.isFinite(request.durationMs) || request.durationMs <= 0) {
      throw this.#requestError("Lease duration must be a positive finite number", {
        durationMs: request.durationMs,
      });
    }

    const client = await this.#pool.connect();
    const monitor = monitorPostgresClient(client, this.#pool);
    try {
      await client.query("BEGIN");
      await this.#lockEpochRow(client, request.resource);
      const current = await client.query<LeaseRow>(
        `SELECT owner, epoch::text, acquired_at, expires_at
           FROM tego_coordination_leases
          WHERE driver_namespace = $1 AND resource = $2
          FOR UPDATE`,
        [this.#options.namespace, request.resource],
      );
      const nowResult = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = nowResult.rows[0]?.now;
      if (now === undefined) throw new Error("PostgreSQL did not return provider time");
      const active = current.rows[0];
      const activeExpiresAt =
        active === undefined ? undefined : isoTimestamp(active.expires_at, "lease expiry");
      if (
        active !== undefined &&
        activeExpiresAt !== undefined &&
        Date.parse(activeExpiresAt) > now.getTime()
      ) {
        if (active.owner !== request.owner) {
          throw postgresError(
            "COORDINATION_LEASE_HELD",
            "Coordination lease is held by another owner",
            "coordination",
            {
              resource: request.resource,
              owner: active.owner,
              expiresAt: activeExpiresAt,
            },
          );
        }
        const renewed = await client.query<LeaseRow>(
          `UPDATE tego_coordination_leases
              SET expires_at =
                $3::timestamptz + ($4::double precision * interval '1 millisecond')
            WHERE driver_namespace = $1 AND resource = $2
          RETURNING owner, epoch::text, acquired_at, expires_at`,
          [this.#options.namespace, request.resource, now, request.durationMs],
        );
        await client.query("COMMIT");
        return this.#decodeLease(request.resource, renewed.rows[0]);
      }

      const epoch = await this.#incrementEpoch(client, request.resource);
      const inserted = await client.query<LeaseRow>(
        `INSERT INTO tego_coordination_leases(
           driver_namespace, resource, owner, epoch, acquired_at, expires_at
         )
         VALUES (
           $1,
           $2,
           $3,
           $4,
           $5::timestamptz,
           $5::timestamptz + ($6::double precision * interval '1 millisecond')
         )
         ON CONFLICT (driver_namespace, resource) DO UPDATE SET
           owner = EXCLUDED.owner,
           epoch = EXCLUDED.epoch,
           acquired_at = EXCLUDED.acquired_at,
           expires_at = EXCLUDED.expires_at
         RETURNING owner, epoch::text, acquired_at, expires_at`,
        [this.#options.namespace, request.resource, request.owner, epoch, now, request.durationMs],
      );
      await client.query("COMMIT");
      return this.#decodeLease(request.resource, inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      const destroy = monitor.failure() !== undefined;
      monitor.close();
      client.release(destroy);
    }
  }

  async nextEpoch(resource: string): Promise<FencingEpoch> {
    this.#assertOpen();
    this.#assertResource(resource);
    const client = await this.#pool.connect();
    const monitor = monitorPostgresClient(client, this.#pool);
    try {
      await client.query("BEGIN");
      const epoch = await this.#incrementEpoch(client, resource);
      await client.query("COMMIT");
      return epoch;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      const destroy = monitor.failure() !== undefined;
      monitor.close();
      client.release(destroy);
    }
  }

  async compareAndSet<T extends JsonValue>(
    request: CompareAndSetRequest<T>,
  ): Promise<CasResult<T>> {
    this.#assertOpen();
    if (request.key.length === 0) {
      throw this.#requestError("Compare-and-set key must not be empty", { key: request.key });
    }

    const client = await this.#pool.connect();
    const monitor = monitorPostgresClient(client, this.#pool);
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO tego_coordination_revisions(driver_namespace, revision)
         VALUES ($1, 0)
         ON CONFLICT (driver_namespace) DO NOTHING`,
        [this.#options.namespace],
      );
      await client.query(
        `SELECT revision
           FROM tego_coordination_revisions
          WHERE driver_namespace = $1
          FOR UPDATE`,
        [this.#options.namespace],
      );
      const currentResult = await client.query<RecordRow>(
        `SELECT value_json, revision::text
           FROM tego_coordination_records
          WHERE driver_namespace = $1 AND record_key = $2
          FOR UPDATE`,
        [this.#options.namespace, request.key],
      );
      const current = currentResult.rows[0];
      const currentRevision =
        current === undefined ? undefined : parseRevision(decimal(current.revision, "revision"));
      const matches =
        request.expectedRevision === undefined ||
        (request.expectedRevision === "absent"
          ? current === undefined
          : currentRevision === request.expectedRevision);
      if (!matches) {
        await client.query("COMMIT");
        return current === undefined
          ? { applied: false }
          : {
              applied: false,
              value: jsonValue(current, "value_json") as T,
              revision: currentRevision as Revision,
            };
      }

      const revisionResult = await client.query<{ revision: string }>(
        `UPDATE tego_coordination_revisions
            SET revision = revision + 1
          WHERE driver_namespace = $1
        RETURNING revision::text`,
        [this.#options.namespace],
      );
      const revision = parseRevision(
        decimal(revisionResult.rows[0]?.revision, "coordination revision"),
      );
      const value = cloneJson(request.value);
      await client.query(
        `INSERT INTO tego_coordination_records(
           driver_namespace, record_key, value_json, revision
         )
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (driver_namespace, record_key) DO UPDATE SET
           value_json = EXCLUDED.value_json,
           revision = EXCLUDED.revision`,
        [this.#options.namespace, request.key, JSON.stringify(value), revision],
      );
      await client.query(
        `INSERT INTO tego_coordination_changes(
           driver_namespace, record_key, value_json, revision
         )
         VALUES ($1, $2, $3::jsonb, $4)`,
        [this.#options.namespace, request.key, JSON.stringify(value), revision],
      );
      await client.query("SELECT pg_notify($1, $2)", [
        NOTIFICATION_CHANNEL,
        this.#options.namespace,
      ]);
      await client.query("COMMIT");
      return { applied: true, value: cloneJson(value), revision };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      const destroy = monitor.failure() !== undefined;
      monitor.close();
      client.release(destroy);
    }
  }

  watch(request: CoordinationWatchRequest): AsyncIterable<CoordinationChange> {
    this.#assertOpen();
    let watch: PostgresCoordinationWatch;
    watch = new PostgresCoordinationWatch(
      parseRevision(request.cursor),
      (cursor) => this.#scanChanges(cursor),
      () => this.#watches.delete(watch),
    );
    this.#watches.add(watch);
    return watch;
  }

  async health(): Promise<DriverHealth> {
    this.#assertOpen();
    return postgresPoolHealth(this.#pool);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#lifecycle === "closed") return Promise.resolve();
    this.#lifecycle = "closed";
    const closing = this.#closeProvider();
    this.#closePromise = closing;
    return closing;
  }

  async #scanChanges(cursor: Revision): Promise<readonly CoordinationChange[]> {
    if (this.#lifecycle === "closed") return [];
    const result = await this.#pool.query<ChangeRow>(
      `SELECT record_key, value_json, revision::text
         FROM tego_coordination_changes
        WHERE driver_namespace = $1 AND revision > $2
        ORDER BY revision, sequence
        LIMIT $3`,
      [this.#options.namespace, cursor, WATCH_BATCH_SIZE],
    );
    if (this.#listener === undefined && this.#lifecycle === "open") {
      await this.#ensureListener().catch(() => undefined);
    }
    return result.rows.map((row) => ({
      key: row.record_key,
      revision: parseRevision(decimal(row.revision, "coordination revision")),
      value: jsonValue(row, "value_json"),
    }));
  }

  async #acquireLeadership(resource: string): Promise<LeadershipHandle> {
    const client = await this.#pool.connect();
    if (this.#isClosed()) {
      this.#releaseClient(client, true);
      throw this.#closedError();
    }
    let session: LeadershipSession | undefined;
    const onError = (error: Error) => {
      this.#acquiringClients.delete(client);
      if (session !== undefined) {
        this.#loseLeadership(session, "backend-error", error);
      } else {
        this.#releaseClient(client, true);
      }
    };
    const onEnd = () => {
      this.#acquiringClients.delete(client);
      if (session !== undefined) {
        this.#loseLeadership(session, "backend-close");
      } else {
        this.#releaseClient(client, true);
      }
    };
    client.on("error", onError);
    client.on("end", onEnd);
    this.#acquiringClients.add(client);
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        `tego:${this.#options.namespace}:leadership:${resource}`,
      ]);
      this.#assertOpen();
      await client.query("BEGIN");
      const epoch = await this.#incrementEpoch(client, resource);
      await client.query("COMMIT");
      const leadership: Leadership = { resource, epoch };
      let resolveLost!: (diagnostic: RuntimeDiagnostic) => void;
      const lost = new Promise<RuntimeDiagnostic>((resolve) => {
        resolveLost = resolve;
      });
      const handle: LeadershipHandle = {
        leadership,
        lost,
        release: () => this.#releaseLeadership(session as LeadershipSession),
      };
      session = { client, leadership, resolveLost, onError, onEnd };
      this.#leadership.set(resource, session);
      this.#acquiringClients.delete(client);
      return handle;
    } catch (error) {
      this.#acquiringClients.delete(client);
      await client.query("ROLLBACK").catch(() => undefined);
      client.removeListener("error", onError);
      client.removeListener("end", onEnd);
      this.#releaseClient(client, true);
      throw error;
    }
  }

  #releaseLeadership(session: LeadershipSession): Promise<void> {
    if (session.releasePromise !== undefined) {
      return session.releasePromise;
    }
    const releasing = Promise.resolve().then(async () => {
      let failure: unknown;
      try {
        await session.client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
          `tego:${this.#options.namespace}:leadership:${session.leadership.resource}`,
        ]);
      } catch (error) {
        failure = error;
      } finally {
        this.#finishLeadership(
          session,
          this.#leadershipLost(session.leadership.resource, "released", failure),
          failure !== undefined,
        );
      }
      if (failure !== undefined) throw failure;
    });
    session.releasePromise = releasing;
    return releasing;
  }

  #loseLeadership(
    session: LeadershipSession,
    reason: "backend-close" | "backend-error" | "provider-close",
    cause?: unknown,
  ): void {
    if (session.releasePromise === undefined) {
      session.releasePromise = Promise.resolve();
    }
    this.#finishLeadership(
      session,
      this.#leadershipLost(session.leadership.resource, reason, cause),
      true,
    );
  }

  #finishLeadership(
    session: LeadershipSession,
    diagnostic: RuntimeDiagnostic,
    destroy: boolean,
  ): void {
    if (this.#leadership.get(session.leadership.resource) !== session) return;
    this.#leadership.delete(session.leadership.resource);
    this.#campaigns.delete(session.leadership.resource);
    session.client.removeListener("error", session.onError);
    session.client.removeListener("end", session.onEnd);
    session.resolveLost(diagnostic);
    this.#releaseClient(session.client, destroy);
  }

  #leadershipLost(
    resource: string,
    reason: "backend-close" | "backend-error" | "provider-close" | "released",
    cause?: unknown,
  ): RuntimeDiagnostic {
    return runtimeDiagnostic({
      code: "COORDINATION_LEADERSHIP_LOST",
      message: "PostgreSQL coordination leadership was lost",
      source: { kind: "coordination", id: "postgres-coordination" },
      retryable: true,
      details: { resource, reason },
      ...(cause === undefined ? {} : { cause: serializeCause(cause) }),
    });
  }

  async #incrementEpoch(client: PoolClient, resource: string): Promise<FencingEpoch> {
    const result = await client.query<EpochRow>(
      `INSERT INTO tego_coordination_epochs(driver_namespace, resource, epoch)
       VALUES ($1, $2, 1)
       ON CONFLICT (driver_namespace, resource) DO UPDATE
         SET epoch = tego_coordination_epochs.epoch + 1
       RETURNING epoch::text`,
      [this.#options.namespace, resource],
    );
    const epoch = parseFencingEpoch(decimal(result.rows[0]?.epoch, "fencing epoch"));
    await client.query(
      `INSERT INTO tego_fences(driver_namespace, resource, epoch)
       VALUES ($1, $2, $3)
       ON CONFLICT (driver_namespace, resource) DO UPDATE
         SET epoch = EXCLUDED.epoch`,
      [this.#options.namespace, resource, epoch],
    );
    return epoch;
  }

  async #lockEpochRow(client: PoolClient, resource: string): Promise<void> {
    await client.query(
      `INSERT INTO tego_coordination_epochs(driver_namespace, resource, epoch)
       VALUES ($1, $2, 0)
       ON CONFLICT (driver_namespace, resource) DO NOTHING`,
      [this.#options.namespace, resource],
    );
    await client.query(
      `SELECT epoch
         FROM tego_coordination_epochs
        WHERE driver_namespace = $1 AND resource = $2
        FOR UPDATE`,
      [this.#options.namespace, resource],
    );
  }

  #decodeLease(resource: string, row: LeaseRow | undefined): Lease {
    if (row === undefined) throw new Error("PostgreSQL did not return the acquired lease");
    return {
      resource,
      owner: row.owner,
      epoch: parseFencingEpoch(decimal(row.epoch, "lease epoch")),
      acquiredAt: isoTimestamp(row.acquired_at, "lease acquisition"),
      expiresAt: isoTimestamp(row.expires_at, "lease expiry"),
    };
  }

  async #ensureListener(): Promise<void> {
    if (this.#listener !== undefined || this.#lifecycle === "closed") return;
    if (this.#listenerPromise !== undefined) return this.#listenerPromise;
    const connecting = (async () => {
      const client = await this.#pool.connect();
      if (this.#lifecycle === "closed") {
        this.#releaseClient(client, true);
        return;
      }
      const onNotification = (notification: Notification) => {
        if (notification.payload === this.#options.namespace) this.#wakeWatches();
      };
      const onError = () => {
        if (this.#listener === client) this.#listener = undefined;
        this.#releaseClient(client, true);
        this.#wakeWatches();
      };
      client.on("notification", onNotification);
      client.on("error", onError);
      try {
        await client.query(`LISTEN ${NOTIFICATION_CHANNEL}`);
        if (this.#isClosed()) {
          this.#releaseClient(client, true);
          return;
        }
        this.#listener = client;
      } catch (error) {
        this.#releaseClient(client, true);
        throw error;
      }
    })();
    this.#listenerPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.#listenerPromise === connecting) this.#listenerPromise = undefined;
    }
  }

  async #closeProvider(): Promise<void> {
    await this.#openPromise?.catch(() => undefined);
    for (const watch of [...this.#watches]) watch.close();
    const campaigns = [...this.#campaigns.values()];
    const listener = this.#listener;
    this.#listener = undefined;
    if (listener !== undefined) this.#releaseClient(listener, true);
    const acquiringClients = [...this.#acquiringClients];
    if (acquiringClients.length > 0) {
      const cancellationPool = createPool(this.#options, "coordination-cancel", 1);
      try {
        await Promise.allSettled(
          acquiringClients.map(async (client) => {
            const processId = this.#backendProcessId(client);
            if (processId === undefined) return;
            await cancellationPool.query("SELECT pg_cancel_backend($1)", [processId]);
          }),
        );
      } finally {
        await cancellationPool.end();
      }
    }
    for (const client of acquiringClients) this.#releaseClient(client, true);
    this.#acquiringClients.clear();
    for (const session of [...this.#leadership.values()]) {
      this.#loseLeadership(session, "provider-close");
    }
    await Promise.allSettled(campaigns);
    this.#campaigns.clear();
    await this.#pool.end();
  }

  #backendProcessId(client: PoolClient): number | undefined {
    const processId = (client as PoolClient & { readonly processID?: unknown }).processID;
    return typeof processId === "number" && Number.isInteger(processId) && processId > 0
      ? processId
      : undefined;
  }

  #releaseClient(client: PoolClient, destroy: boolean): void {
    if (this.#releasedClients.has(client)) return;
    this.#releasedClients.add(client);
    client.release(destroy);
  }

  #wakeWatches(): void {
    for (const watch of this.#watches) watch.wake();
  }

  #assertOpen(): void {
    if (this.#lifecycle !== "open") throw this.#closedError();
  }

  #isClosed(): boolean {
    return this.#lifecycle === "closed";
  }

  #assertResource(resource: string): void {
    if (resource.length === 0) {
      throw this.#requestError("Coordination resource must not be empty", { resource });
    }
  }

  #requestError(message: string, details: JsonValue) {
    return postgresError("COORDINATION_REQUEST_INVALID", message, "coordination", details);
  }

  #closedError() {
    return postgresError(
      "COORDINATION_CLOSED",
      "PostgreSQL coordination provider is closed",
      "coordination",
      { lifecycle: this.#lifecycle },
    );
  }
}
