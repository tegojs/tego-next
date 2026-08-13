import { createHash } from "node:crypto";
import {
  type ArtifactDigest,
  type ArtifactStorageLimits,
  type ArtifactStore,
  DiagnosticError,
  type DriverHealth,
  parseArtifactDigest,
  parseArtifactStorageLimits,
  runtimeDiagnostic,
  serializeCause,
} from "@tego/contracts";
import type { Pool, PoolClient } from "pg";
import {
  createPool,
  monitorPostgresClient,
  openPool,
  type PostgresConnectionOptions,
  postgresError,
  postgresPoolHealth,
} from "./shared.js";

/** @deprecated Configure `limits.maxArtifactBytes` when constructing the store. */
export const POSTGRES_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_CONNECTION_TIMEOUT_MILLIS = 5_000;
const DEFAULT_RECONCILIATION_TIMEOUT_MILLIS = 5_000;

export interface PostgresArtifactStoreOptions extends PostgresConnectionOptions {
  readonly limits?: Partial<ArtifactStorageLimits>;
}

/** @internal Injectable PostgreSQL actions used by lifecycle fault tests. */
export interface PostgresArtifactStoreDependencies {
  readonly commitTransaction?: (client: PoolClient) => Promise<void>;
  readonly connectClient?: (pool: Pool) => Promise<PoolClient>;
  readonly createConnectionPool?: typeof createPool;
  readonly reconciliationTimeoutMillis?: number;
}

interface IngressReservation {
  readonly committedBytes: bigint;
  readonly digest: ArtifactDigest;
  readonly id: symbol;
  bytes: number;
  charged: boolean;
}

export class PostgresArtifactStore implements ArtifactStore {
  readonly scope = "shared" as const;
  readonly #namespace: string;
  readonly #limits: ArtifactStorageLimits;
  readonly #pool: Pool;
  readonly #connectClient: (pool: Pool) => Promise<PoolClient>;
  readonly #commitTransaction: (client: PoolClient) => Promise<void>;
  readonly #connectionTimeoutMillis: number;
  readonly #reconciliationTimeoutMillis: number;
  readonly #operations = new Set<Promise<unknown>>();
  readonly #clientAcquisitions = new Set<Promise<PoolClient>>();
  readonly #activeClients = new Set<PoolClient>();
  readonly #committingClients = new Set<PoolClient>();
  readonly #reconcilingClients = new Set<PoolClient>();
  readonly #releasedClients = new WeakSet<PoolClient>();
  readonly #writeControllers = new Set<AbortController>();
  readonly #ingress = new Map<ArtifactDigest, Map<symbol, IngressReservation>>();
  #ingressBytes = 0n;
  #lifecycle: "closed" | "created" | "open" | "opening" = "created";
  #openPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(
    options: PostgresArtifactStoreOptions,
    dependencies: PostgresArtifactStoreDependencies = {},
  ) {
    this.#namespace = options.namespace;
    this.#limits = parseArtifactStorageLimits(options.limits);
    this.#connectionTimeoutMillis = this.#positiveTimeout(
      options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MILLIS,
      "connectionTimeoutMillis",
    );
    this.#reconciliationTimeoutMillis = this.#positiveTimeout(
      dependencies.reconciliationTimeoutMillis ?? DEFAULT_RECONCILIATION_TIMEOUT_MILLIS,
      "reconciliationTimeoutMillis",
    );
    const createConnectionPool = dependencies.createConnectionPool ?? createPool;
    this.#pool = createConnectionPool(
      { ...options, connectionTimeoutMillis: this.#connectionTimeoutMillis },
      "artifacts",
    );
    this.#connectClient = dependencies.connectClient ?? ((pool) => pool.connect());
    this.#commitTransaction =
      dependencies.commitTransaction ?? (async (client) => client.query("COMMIT").then(() => {}));
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

  async put(digest: ArtifactDigest, source: AsyncIterable<Uint8Array>): Promise<void> {
    this.#assertOpen();
    const parsed = parseArtifactDigest(digest);
    const controller = new AbortController();
    this.#writeControllers.add(controller);
    const operation = this.#put(parsed, source, controller.signal);
    this.#operations.add(operation);
    try {
      await operation;
    } finally {
      this.#operations.delete(operation);
      this.#writeControllers.delete(controller);
    }
  }

  async *read(digest: ArtifactDigest): AsyncIterable<Uint8Array> {
    this.#assertOpen();
    const parsed = parseArtifactDigest(digest);
    const content = await this.#loadContent(parsed);
    if (content === undefined) {
      throw postgresError("ARTIFACT_NOT_FOUND", "Artifact does not exist", "artifact", {
        digest: parsed,
      });
    }
    const actual = parseArtifactDigest(
      `sha256:${createHash("sha256").update(content).digest("hex")}`,
    );
    if (actual !== parsed) {
      throw postgresError(
        "ARTIFACT_DIGEST_MISMATCH",
        "Stored artifact failed digest verification",
        "artifact",
        { actual, expected: parsed },
      );
    }
    for (let offset = 0; offset < content.byteLength; offset += READ_CHUNK_BYTES) {
      this.#assertOpen();
      yield Buffer.from(content.subarray(offset, offset + READ_CHUNK_BYTES));
    }
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
      for (const controller of this.#writeControllers) controller.abort(this.#closedError());
      await this.#openPromise?.catch(() => undefined);
      for (const client of [...this.#activeClients]) {
        if (!this.#committingClients.has(client) && !this.#reconcilingClients.has(client)) {
          this.#releaseClient(client, true);
        }
      }
      await Promise.allSettled([...this.#operations]);
      await this.#pool.end();
    })();
    this.#closePromise = closing;
    return closing;
  }

  async #put(
    digest: ArtifactDigest,
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const status = await this.#artifactStatus(digest, signal);
    if (signal.aborted || this.#lifecycle !== "open") throw this.#closedError();
    this.#promoteDurableIngress(status.durableDigests);
    const reservation = status.exists
      ? undefined
      : this.#reserveIngress(digest, status.committedBytes);
    try {
      const content = await this.#bufferAndVerify(digest, source, signal, reservation);
      if (signal.aborted || this.#lifecycle !== "open") throw this.#closedError();
      await this.#commitArtifact(digest, content, signal);
    } finally {
      if (reservation !== undefined) this.#releaseIngress(reservation);
    }
  }

  async #bufferAndVerify(
    expected: ArtifactDigest,
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    reservation: IngressReservation | undefined,
  ): Promise<Buffer> {
    const iterator = source[Symbol.asyncIterator]();
    const chunks: Buffer[] = [];
    let complete = false;
    let size = 0;
    const hash = createHash("sha256");
    try {
      while (true) {
        const result = await this.#nextSource(iterator, signal);
        if (result.done) {
          complete = true;
          break;
        }
        const chunkBytes = result.value.byteLength;
        if (
          !Number.isSafeInteger(chunkBytes) ||
          chunkBytes < 0 ||
          chunkBytes > this.#limits.maxArtifactBytes - size
        ) {
          const artifactBytes =
            Number.isSafeInteger(chunkBytes) && chunkBytes >= 0
              ? (BigInt(size) + BigInt(chunkBytes)).toString()
              : "invalid";
          throw this.#artifactSizeError(expected, artifactBytes);
        }
        const nextSize = size + chunkBytes;
        if (reservation !== undefined) this.#resizeIngress(reservation, nextSize);
        const copy = Buffer.from(result.value);
        size = nextSize;
        chunks.push(copy);
        hash.update(copy);
      }
    } finally {
      if (!complete && iterator.return !== undefined) {
        try {
          void Promise.resolve(iterator.return()).catch(() => undefined);
        } catch {
          // The authoritative write error is preserved when source cleanup fails synchronously.
        }
      }
    }
    const actual = parseArtifactDigest(`sha256:${hash.digest("hex")}`);
    if (actual !== expected) {
      throw postgresError(
        "ARTIFACT_DIGEST_MISMATCH",
        "Artifact bytes do not match the requested digest",
        "artifact",
        { actual, expected },
      );
    }
    return Buffer.concat(chunks, size);
  }

  async #nextSource(
    iterator: AsyncIterator<Uint8Array>,
    signal: AbortSignal,
  ): Promise<IteratorResult<Uint8Array>> {
    if (signal.aborted) throw this.#closedError();
    let removeAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(this.#closedError());
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([Promise.resolve(iterator.next()), aborted]);
    } finally {
      removeAbort();
    }
  }

  async #commitArtifact(
    digest: ArtifactDigest,
    content: Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    const client = await this.#trackedClient(signal);
    const monitor = monitorPostgresClient(client, this.#pool);
    let commitStarted = false;
    let transactionStarted = false;
    try {
      this.#assertOpen();
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(
        `INSERT INTO tego_artifact_namespace_usage(driver_namespace, committed_bytes)
         VALUES ($1, 0)
         ON CONFLICT(driver_namespace) DO NOTHING`,
        [this.#namespace],
      );
      const usage = await client.query<{ committed_bytes: string }>(
        `SELECT committed_bytes::text
           FROM tego_artifact_namespace_usage
          WHERE driver_namespace = $1
          FOR UPDATE`,
        [this.#namespace],
      );
      this.#assertOpen();
      const committedBytes = this.#databaseBytes(
        usage.rows[0]?.committed_bytes,
        "artifact namespace usage",
      );
      const existing = await client.query<{
        content: Buffer | null;
        content_bytes: string;
        size_bytes: string;
      }>(
        `SELECT
           CASE
             WHEN size_bytes <= $3::bigint
               AND octet_length(content) <= $3::bigint
               AND size_bytes = octet_length(content)
             THEN content
             ELSE NULL
           END AS content,
           octet_length(content)::text AS content_bytes,
           size_bytes::text
         FROM tego_artifacts
         WHERE driver_namespace = $1 AND digest = $2`,
        [this.#namespace, digest, this.#limits.maxArtifactBytes.toString()],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        const contentBytes = this.#databaseBytes(row.content_bytes, "artifact content size");
        const declaredBytes = this.#databaseBytes(row.size_bytes, "artifact declared size");
        if (
          contentBytes > BigInt(this.#limits.maxArtifactBytes) ||
          declaredBytes > BigInt(this.#limits.maxArtifactBytes)
        ) {
          throw this.#artifactSizeError(digest, contentBytes.toString());
        }
        if (
          contentBytes !== declaredBytes ||
          contentBytes !== BigInt(content.byteLength) ||
          row.content === null ||
          !Buffer.from(row.content).equals(content)
        ) {
          throw postgresError(
            "ARTIFACT_DIGEST_MISMATCH",
            "Artifact digest is already bound to different bytes",
            "artifact",
            { digest },
          );
        }
        commitStarted = true;
        await this.#commitAndReconcile(client, digest, content);
        transactionStarted = false;
        return;
      }

      const candidateBytes = BigInt(content.byteLength);
      if (committedBytes + candidateBytes > BigInt(this.#limits.maxNamespaceBytes)) {
        throw postgresError(
          "ARTIFACT_NAMESPACE_QUOTA_EXCEEDED",
          "Artifact namespace exceeds the configured storage quota",
          "artifact",
          {
            digest,
            namespace: this.#namespace,
            artifactBytes: content.byteLength.toString(),
            committedBytes: committedBytes.toString(),
            reservedBytes: content.byteLength.toString(),
            maximumBytes: this.#limits.maxNamespaceBytes.toString(),
          },
        );
      }
      await client.query(
        `INSERT INTO tego_artifacts(driver_namespace, digest, content, size_bytes)
         VALUES ($1, $2, $3, $4)`,
        [this.#namespace, digest, content, content.byteLength.toString()],
      );
      await client.query(
        `UPDATE tego_artifact_namespace_usage
            SET committed_bytes = committed_bytes + $2::bigint
          WHERE driver_namespace = $1`,
        [this.#namespace, content.byteLength.toString()],
      );
      this.#assertOpen();
      commitStarted = true;
      await this.#commitAndReconcile(client, digest, content);
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted && !commitStarted && !this.#releasedClients.has(client)) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      if (!commitStarted && this.#lifecycle === "closed") throw this.#closedError();
      throw error;
    } finally {
      this.#activeClients.delete(client);
      this.#committingClients.delete(client);
      const destroy = monitor.failure() !== undefined;
      monitor.close();
      this.#releaseClient(client, destroy);
    }
  }

  #reserveIngress(digest: ArtifactDigest, committedBytes: bigint): IngressReservation {
    const reservation = { committedBytes, digest, id: Symbol(digest), bytes: 0, charged: true };
    const digestReservations = this.#ingress.get(digest) ?? new Map<symbol, IngressReservation>();
    digestReservations.set(reservation.id, reservation);
    this.#ingress.set(digest, digestReservations);
    return reservation;
  }

  #resizeIngress(reservation: IngressReservation, bytes: number): void {
    if (!reservation.charged) {
      reservation.bytes = bytes;
      return;
    }
    const digestReservations = this.#ingress.get(reservation.digest);
    if (digestReservations === undefined || !digestReservations.has(reservation.id)) {
      throw new Error("Artifact ingress reservation is no longer active");
    }
    const previousBytes = reservation.bytes;
    const previousMaximum = this.#maximumReservation(digestReservations);
    reservation.bytes = bytes;
    const nextMaximum = this.#maximumReservation(digestReservations);
    const projected = this.#ingressBytes - BigInt(previousMaximum) + BigInt(nextMaximum);
    if (reservation.committedBytes + projected > BigInt(this.#limits.maxNamespaceBytes)) {
      reservation.bytes = previousBytes;
      throw postgresError(
        "ARTIFACT_NAMESPACE_QUOTA_EXCEEDED",
        "Artifact namespace exceeds the configured storage quota",
        "artifact",
        {
          digest: reservation.digest,
          namespace: this.#namespace,
          artifactBytes: bytes.toString(),
          committedBytes: reservation.committedBytes.toString(),
          reservedBytes: projected.toString(),
          maximumBytes: this.#limits.maxNamespaceBytes.toString(),
        },
      );
    }
    this.#ingressBytes = projected;
  }

  #releaseIngress(reservation: IngressReservation): void {
    if (!reservation.charged) return;
    const digestReservations = this.#ingress.get(reservation.digest);
    if (digestReservations === undefined || !digestReservations.has(reservation.id)) return;
    const previousMaximum = this.#maximumReservation(digestReservations);
    digestReservations.delete(reservation.id);
    const nextMaximum = this.#maximumReservation(digestReservations);
    this.#ingressBytes -= BigInt(previousMaximum - nextMaximum);
    if (digestReservations.size === 0) this.#ingress.delete(reservation.digest);
  }

  #maximumReservation(reservations: ReadonlyMap<symbol, IngressReservation>): number {
    let maximum = 0;
    for (const reservation of reservations.values()) {
      maximum = Math.max(maximum, reservation.bytes);
    }
    return maximum;
  }

  #promoteDurableIngress(digests: readonly string[]): void {
    for (const digest of digests) {
      const reservations = this.#ingress.get(digest as ArtifactDigest);
      if (reservations === undefined) continue;
      this.#ingressBytes -= BigInt(this.#maximumReservation(reservations));
      this.#ingress.delete(digest as ArtifactDigest);
      for (const reservation of reservations.values()) reservation.charged = false;
    }
  }

  #assertOpen(): void {
    if (this.#lifecycle !== "open") throw this.#closedError();
  }

  async #artifactStatus(
    digest: ArtifactDigest,
    signal: AbortSignal,
  ): Promise<{
    readonly committedBytes: bigint;
    readonly durableDigests: readonly string[];
    readonly exists: boolean;
  }> {
    const reservedDigests = [...this.#ingress.keys()];
    const client = await this.#trackedClient(signal);
    const monitor = monitorPostgresClient(client, this.#pool);
    try {
      const result = await client.query<{
        committed_bytes: string;
        durable_digests: string[];
        exists: boolean;
      }>(
        `SELECT
           EXISTS(
             SELECT 1
             FROM tego_artifacts
             WHERE driver_namespace = $1 AND digest = $2
           ) AS exists,
           COALESCE((
             SELECT committed_bytes::text
             FROM tego_artifact_namespace_usage
             WHERE driver_namespace = $1
           ), '0') AS committed_bytes,
           ARRAY(
             SELECT durable.digest
             FROM tego_artifacts durable
             WHERE durable.driver_namespace = $1
               AND durable.digest = ANY($3::text[])
           ) AS durable_digests`,
        [this.#namespace, digest, reservedDigests],
      );
      const row = result.rows[0];
      if (this.#lifecycle !== "open") throw this.#closedError();
      return {
        committedBytes: this.#databaseBytes(row?.committed_bytes, "artifact namespace usage"),
        durableDigests: row?.durable_digests ?? [],
        exists: row?.exists === true,
      };
    } catch (error) {
      if (this.#lifecycle === "closed") throw this.#closedError();
      throw error;
    } finally {
      this.#activeClients.delete(client);
      const destroy = monitor.failure() !== undefined;
      monitor.close();
      this.#releaseClient(client, destroy);
    }
  }

  async #loadContent(digest: ArtifactDigest): Promise<Buffer | undefined> {
    const result = await this.#pool.query<{
      content: Buffer | null;
      content_bytes: string;
      size_bytes: string;
    }>(
      `SELECT
         CASE
           WHEN size_bytes <= $3::bigint
             AND octet_length(content) <= $3::bigint
             AND size_bytes = octet_length(content)
           THEN content
           ELSE NULL
         END AS content,
         octet_length(content)::text AS content_bytes,
         size_bytes::text
       FROM tego_artifacts
       WHERE driver_namespace = $1 AND digest = $2`,
      [this.#namespace, digest, this.#limits.maxArtifactBytes.toString()],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const contentBytes = this.#databaseBytes(row.content_bytes, "artifact content size");
    const declaredBytes = this.#databaseBytes(row.size_bytes, "artifact declared size");
    const maximumBytes = BigInt(this.#limits.maxArtifactBytes);
    if (contentBytes > maximumBytes || declaredBytes > maximumBytes) {
      throw postgresError(
        "ARTIFACT_SIZE_LIMIT_EXCEEDED",
        "Stored artifact exceeds the configured per-artifact limit",
        "artifact",
        { digest, maximumBytes: this.#limits.maxArtifactBytes.toString() },
      );
    }
    if (contentBytes !== declaredBytes || row.content === null) {
      throw postgresError(
        "ARTIFACT_DIGEST_MISMATCH",
        "Stored artifact size metadata does not match its bytes",
        "artifact",
        {
          actualBytes: contentBytes.toString(),
          declaredBytes: declaredBytes.toString(),
          digest,
        },
      );
    }
    return Buffer.from(row.content);
  }

  #databaseBytes(value: unknown, field: string): bigint {
    if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
      throw new Error(`PostgreSQL returned invalid ${field}`);
    }
    return BigInt(value);
  }

  #artifactSizeError(digest: ArtifactDigest, artifactBytes: string) {
    return postgresError(
      "ARTIFACT_SIZE_LIMIT_EXCEEDED",
      "Artifact exceeds the configured per-artifact limit",
      "artifact",
      {
        digest,
        namespace: this.#namespace,
        artifactBytes,
        maximumBytes: this.#limits.maxArtifactBytes.toString(),
      },
    );
  }

  #releaseClient(client: PoolClient, destroy: boolean): void {
    if (this.#releasedClients.has(client)) return;
    this.#releasedClients.add(client);
    client.release(destroy);
  }

  async #commit(client: PoolClient): Promise<void> {
    this.#committingClients.add(client);
    try {
      await this.#commitTransaction(client);
    } finally {
      this.#committingClients.delete(client);
    }
  }

  async #trackedClient(
    signal?: AbortSignal,
    options: {
      readonly allowClosed?: boolean;
      readonly reconcile?: boolean;
      readonly timeoutMillis?: number;
    } = {},
  ): Promise<PoolClient> {
    if (signal?.aborted) throw this.#closedError();
    if (options.allowClosed !== true) this.#assertOpen();
    let abandoned = false;
    const acquisition = Promise.resolve().then(() => this.#connectClient(this.#pool));
    this.#clientAcquisitions.add(acquisition);
    const removeAcquisition = () => this.#clientAcquisitions.delete(acquisition);
    void acquisition.then(removeAcquisition, removeAcquisition);
    const guardedAcquisition = acquisition.then((client) => {
      if (abandoned) {
        this.#releasedClients.delete(client);
        this.#releaseClient(client, true);
      }
      return client;
    });
    let removeAbort = () => {};
    let timeout: NodeJS.Timeout | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      if (signal !== undefined) {
        const onAbort = () => reject(this.#closedError());
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      timeout = setTimeout(
        () => reject(this.#acquisitionTimeoutError(options.timeoutMillis)),
        options.timeoutMillis ?? this.#connectionTimeoutMillis,
      );
      timeout.unref();
    });
    let client: PoolClient;
    try {
      client = await Promise.race([guardedAcquisition, interrupted]);
    } catch (error) {
      abandoned = true;
      throw error;
    } finally {
      removeAbort();
      if (timeout !== undefined) clearTimeout(timeout);
    }
    this.#releasedClients.delete(client);
    this.#activeClients.add(client);
    if (options.reconcile === true) this.#reconcilingClients.add(client);
    if (options.allowClosed !== true && this.#lifecycle !== "open") {
      this.#activeClients.delete(client);
      this.#releaseClient(client, true);
      throw this.#closedError();
    }
    return client;
  }

  async #commitAndReconcile(
    client: PoolClient,
    digest: ArtifactDigest,
    content: Buffer,
  ): Promise<void> {
    try {
      await this.#commit(client);
    } catch (error) {
      this.#activeClients.delete(client);
      this.#releaseClient(client, true);
      const committed = await this.#reconcileCommit(digest, content, error);
      if (!committed) throw error;
    }
  }

  async #reconcileCommit(
    digest: ArtifactDigest,
    content: Buffer,
    commitError: unknown,
  ): Promise<boolean> {
    let client: PoolClient | undefined;
    let destroy = false;
    try {
      client = await this.#trackedClient(undefined, {
        allowClosed: true,
        reconcile: true,
        timeoutMillis: this.#reconciliationTimeoutMillis,
      });
      const reconciliation = (async () => {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO tego_artifact_namespace_usage(driver_namespace, committed_bytes)
           VALUES ($1, 0)
           ON CONFLICT(driver_namespace) DO NOTHING`,
          [this.#namespace],
        );
        await client.query(
          `SELECT committed_bytes
             FROM tego_artifact_namespace_usage
            WHERE driver_namespace = $1
            FOR UPDATE`,
          [this.#namespace],
        );
        const result = await client.query<{
          committed_bytes: string | null;
          content: Buffer | null;
          content_bytes: string | null;
          namespace_bytes: string;
          size_bytes: string | null;
        }>(
          `SELECT
             CASE
               WHEN target.size_bytes <= $3::bigint
                 AND octet_length(target.content) <= $3::bigint
                 AND target.size_bytes = octet_length(target.content)
               THEN target.content
               ELSE NULL
             END AS content,
             octet_length(target.content)::text AS content_bytes,
             target.size_bytes::text,
             usage.committed_bytes::text,
             COALESCE(total.namespace_bytes, 0)::text AS namespace_bytes
           FROM (SELECT $1::text AS driver_namespace, $2::text AS digest) requested
           LEFT JOIN tego_artifacts target USING (driver_namespace, digest)
           LEFT JOIN tego_artifact_namespace_usage usage USING (driver_namespace)
           LEFT JOIN LATERAL (
             SELECT COALESCE(sum(octet_length(content)), 0)::bigint AS namespace_bytes
             FROM tego_artifacts
             WHERE driver_namespace = requested.driver_namespace
           ) total ON true`,
          [this.#namespace, digest, this.#limits.maxArtifactBytes.toString()],
        );
        await client.query("ROLLBACK");
        return result;
      })();
      const result = await this.#bounded(reconciliation, this.#reconciliationTimeoutMillis, () => {
        if (client !== undefined) this.#releaseClient(client, true);
      });
      const row = result.rows[0];
      const committedBytes = this.#databaseBytes(row?.committed_bytes, "artifact namespace usage");
      const namespaceBytes = this.#databaseBytes(row?.namespace_bytes, "artifact namespace total");
      if (committedBytes !== namespaceBytes) {
        throw this.#commitIndeterminateError(digest, content.byteLength, commitError);
      }
      if (row?.content_bytes === null || row?.content_bytes === undefined) return false;
      const contentBytes = this.#databaseBytes(row.content_bytes, "artifact content size");
      const declaredBytes = this.#databaseBytes(row.size_bytes, "artifact declared size");
      if (
        contentBytes === BigInt(content.byteLength) &&
        declaredBytes === contentBytes &&
        row.content !== null &&
        Buffer.from(row.content).equals(content)
      ) {
        return true;
      }
      throw this.#commitIndeterminateError(digest, content.byteLength, commitError);
    } catch (error) {
      if (
        error instanceof DiagnosticError &&
        error.diagnostic.code === "ARTIFACT_COMMIT_INDETERMINATE"
      ) {
        throw error;
      }
      destroy = true;
      throw this.#commitIndeterminateError(digest, content.byteLength, commitError, error);
    } finally {
      if (client !== undefined) {
        this.#activeClients.delete(client);
        this.#reconcilingClients.delete(client);
        this.#releaseClient(client, destroy);
      }
    }
  }

  async #bounded<T>(promise: Promise<T>, timeoutMillis: number, onTimeout: () => void): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        onTimeout();
        reject(new Error("PostgreSQL reconciliation timed out"));
      }, timeoutMillis);
      timeout.unref();
    });
    try {
      return await Promise.race([promise, expired]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  #commitIndeterminateError(
    digest: ArtifactDigest,
    candidateBytes: number,
    commitError: unknown,
    reconciliationError?: unknown,
  ): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "ARTIFACT_COMMIT_INDETERMINATE",
        message: "PostgreSQL artifact commit outcome could not be determined",
        source: { kind: "artifact", id: "postgres-artifact" },
        retryable: true,
        details: {
          digest,
          namespace: this.#namespace,
          candidateBytes: candidateBytes.toString(),
          limitBytes: this.#limits.maxNamespaceBytes.toString(),
          ...(reconciliationError === undefined
            ? {}
            : { reconciliationFailure: serializeCause(reconciliationError) }),
        },
        cause: serializeCause(commitError),
      }),
    );
  }

  #acquisitionTimeoutError(timeoutMillis = this.#connectionTimeoutMillis): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "ARTIFACT_BACKEND_UNAVAILABLE",
        message: "Timed out acquiring a PostgreSQL artifact client",
        source: { kind: "artifact", id: "postgres-artifact" },
        retryable: true,
        details: { timeoutMillis: timeoutMillis.toString() },
      }),
    );
  }

  #positiveTimeout(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${field} must be a positive safe integer`);
    }
    return value;
  }

  #closedError() {
    return postgresError(
      "ARTIFACT_STORE_CLOSED",
      "PostgreSQL artifact store is closed",
      "artifact",
    );
  }
}
