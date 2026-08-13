import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { DiagnosticError, diagnosticCode, parseArtifactDigest } from "@tego/contracts";
import { Pool, type PoolClient } from "pg";
import { PostgresArtifactStore } from "../src/postgres-artifact-store.js";

const connectionString =
  process.env.TEGO_POSTGRES_URL ??
  "postgresql://tego_test:tego_test@127.0.0.1:55432/tego_next_test";

function namespace(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function digest(content: Uint8Array) {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(content).digest("hex")}`);
}

async function* source(...chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* chunks;
}

test("an oversized source chunk is rejected before its bytes are copied", async () => {
  const storeNamespace = namespace("artifact_source_limit");
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
    limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
  });
  const oversized = new Proxy(new Uint8Array(1), {
    get(_target, property) {
      if (property === "byteLength") return 5;
      throw new Error(`Oversized chunk bytes were accessed through ${String(property)}`);
    },
  }) as Uint8Array;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      let emitted = false;
      return {
        next: () => {
          if (emitted) return Promise.resolve({ done: true, value: undefined });
          emitted = true;
          return Promise.resolve({ done: false, value: oversized });
        },
      };
    },
  };
  await store.open();
  try {
    await assert.rejects(store.put(digest(new Uint8Array()), source), (error: unknown) => {
      assert.ok(error instanceof DiagnosticError);
      assert.equal(error.diagnostic.code, "ARTIFACT_SIZE_LIMIT_EXCEEDED");
      assert.deepEqual(error.diagnostic.details, {
        digest: digest(new Uint8Array()),
        namespace: storeNamespace,
        artifactBytes: "5",
        maximumBytes: "4",
      });
      assert.doesNotThrow(() => JSON.stringify(error.diagnostic));
      return true;
    });
  } finally {
    await store.close();
  }
});

test("an oversized at-rest artifact is rejected before yielding bytes", async () => {
  const storeNamespace = namespace("artifact_stored_limit");
  const content = Buffer.alloc(5, 0x61);
  const artifactDigest = digest(content);
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
    limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
  });
  const pool = new Pool({ connectionString });
  await store.open();
  try {
    await pool.query(
      `INSERT INTO tego_artifacts(driver_namespace, digest, content, size_bytes)
       VALUES ($1, $2, $3, 1)`,
      [storeNamespace, artifactDigest, content],
    );
    const iterator = store.read(artifactDigest)[Symbol.asyncIterator]();
    await assert.rejects(
      iterator.next(),
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_SIZE_LIMIT_EXCEEDED",
    );
  } finally {
    await Promise.all([store.close(), pool.end()]);
  }
});

test("artifact reads reject inconsistent stored size metadata", async () => {
  const storeNamespace = namespace("artifact_size_metadata");
  const content = Buffer.from("metadata-bound-artifact");
  const artifactDigest = digest(content);
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
  });
  const pool = new Pool({ connectionString });
  await store.open();
  try {
    await pool.query(
      `INSERT INTO tego_artifacts(driver_namespace, digest, content, size_bytes)
       VALUES ($1, $2, $3, $4)`,
      [storeNamespace, artifactDigest, content, content.byteLength + 1],
    );
    const iterator = store.read(artifactDigest)[Symbol.asyncIterator]();
    await assert.rejects(
      iterator.next(),
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_DIGEST_MISMATCH",
    );
  } finally {
    await Promise.all([store.close(), pool.end()]);
  }
});

test("artifact insert and quota accounting roll back together when the usage update fails", async () => {
  const storeNamespace = namespace("artifact_quota_rollback");
  const content = Buffer.from("data");
  const artifactDigest = digest(content);
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
    limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
  });
  const pool = new Pool({ connectionString });
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `tego_test_quota_failure_${suffix}`;
  const triggerName = `tego_test_quota_failure_${suffix}`;
  await store.open();
  try {
    await pool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger
       LANGUAGE plpgsql AS $function$
       BEGIN
         IF NEW.driver_namespace = '${storeNamespace}' THEN
           RAISE EXCEPTION 'injected quota update failure';
         END IF;
         RETURN NEW;
       END
       $function$`,
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName}
       BEFORE UPDATE ON tego_artifact_namespace_usage
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    await assert.rejects(store.put(artifactDigest, source(content)));
    const durable = await pool.query<{ artifacts: string; committed_bytes: string }>(
      `SELECT
         count(a.digest)::text AS artifacts,
         COALESCE(u.committed_bytes, 0)::text AS committed_bytes
       FROM (SELECT $1::text AS driver_namespace) target
       LEFT JOIN tego_artifact_namespace_usage u USING (driver_namespace)
       LEFT JOIN tego_artifacts a USING (driver_namespace)
       GROUP BY u.committed_bytes`,
      [storeNamespace],
    );
    assert.deepEqual(durable.rows[0], { artifacts: "0", committed_bytes: "0" });
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON tego_artifact_namespace_usage`);
    await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await Promise.all([store.close(), pool.end()]);
  }
});

test("closing a store cancels a quota transaction waiting on a row lock without partial commit", async () => {
  const storeNamespace = namespace("artifact_quota_close");
  const content = Buffer.from("data");
  const artifactDigest = digest(content);
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
    limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
  });
  const observer = new Pool({ connectionString });
  const blocker = await observer.connect();
  await store.open();
  let blocked = false;
  try {
    await observer.query(
      `INSERT INTO tego_artifact_namespace_usage(driver_namespace, committed_bytes)
       VALUES ($1, 0)`,
      [storeNamespace],
    );
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT committed_bytes
         FROM tego_artifact_namespace_usage
        WHERE driver_namespace = $1
        FOR UPDATE`,
      [storeNamespace],
    );
    blocked = true;
    const write = store.put(artifactDigest, source(content));
    const deadline = Date.now() + 2_000;
    while (true) {
      const waiting = await observer.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_stat_activity
          WHERE application_name = $1
            AND wait_event_type = 'Lock'`,
        [`tego:${storeNamespace}:artifacts`.slice(0, 63)],
      );
      if (waiting.rows[0]?.count === "1") break;
      if (Date.now() >= deadline)
        throw new Error("Artifact write did not reach the quota row lock");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await Promise.race([
      store.close(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Artifact store close did not cancel its transaction")),
          2_000,
        ),
      ),
    ]);
    await assert.rejects(
      write,
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_STORE_CLOSED",
    );
    await blocker.query("ROLLBACK");
    blocked = false;
    const durable = await observer.query<{ artifacts: string; committed_bytes: string }>(
      `SELECT
         count(a.digest)::text AS artifacts,
         u.committed_bytes::text
       FROM tego_artifact_namespace_usage u
       LEFT JOIN tego_artifacts a USING (driver_namespace)
       WHERE u.driver_namespace = $1
       GROUP BY u.committed_bytes`,
      [storeNamespace],
    );
    assert.deepEqual(durable.rows[0], { artifacts: "0", committed_bytes: "0" });
  } finally {
    if (blocked) await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await Promise.all([store.close(), observer.end()]);
  }
});

test("closing a store cancels a put blocked during its preflight artifact status query", async () => {
  const storeNamespace = namespace("artifact_quota_preflight_close");
  const content = Buffer.from("data");
  const artifactDigest = digest(content);
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
    limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
  });
  const observer = new Pool({ connectionString });
  const blocker = await observer.connect();
  await store.open();
  let blocked = false;
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE tego_artifacts IN ACCESS EXCLUSIVE MODE");
    blocked = true;
    const write = store.put(artifactDigest, source(content));
    const deadline = Date.now() + 2_000;
    while (true) {
      const waiting = await observer.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_stat_activity
          WHERE application_name = $1
            AND wait_event_type = 'Lock'`,
        [`tego:${storeNamespace}:artifacts`.slice(0, 63)],
      );
      if (waiting.rows[0]?.count === "1") break;
      if (Date.now() >= deadline)
        throw new Error("Artifact put did not reach its preflight status lock");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await Promise.race([
      store.close(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Artifact store close did not cancel its preflight query")),
          2_000,
        ),
      ),
    ]);
    await assert.rejects(
      write,
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_STORE_CLOSED",
    );
    await blocker.query("ROLLBACK");
    blocked = false;
    const durable = await observer.query<{ artifacts: string; usage: string }>(
      `SELECT
         (SELECT count(*)::text FROM tego_artifacts WHERE driver_namespace = $1) AS artifacts,
         (SELECT count(*)::text FROM tego_artifact_namespace_usage WHERE driver_namespace = $1)
           AS usage`,
      [storeNamespace],
    );
    assert.deepEqual(durable.rows[0], { artifacts: "0", usage: "0" });
  } finally {
    if (blocked) await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await Promise.all([store.close(), observer.end()]);
  }
});

test("closing a store lets an already-committing artifact transaction settle successfully", async () => {
  const storeNamespace = namespace("artifact_quota_commit_close");
  const content = Buffer.from("data");
  const artifactDigest = digest(content);
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
    limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
  });
  const observer = new Pool({ connectionString });
  const blocker = await observer.connect();
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `tego_test_commit_barrier_${suffix}`;
  const triggerName = `tego_test_commit_barrier_${suffix}`;
  const lockName = `tego:test:artifact-commit:${suffix}`;
  await store.open();
  let locked = false;
  try {
    await observer.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger
       LANGUAGE plpgsql AS $function$
       BEGIN
         IF NEW.driver_namespace = '${storeNamespace}' THEN
           PERFORM pg_advisory_xact_lock(hashtextextended('${lockName}', 0));
         END IF;
         RETURN NEW;
       END
       $function$`,
    );
    await observer.query(
      `CREATE CONSTRAINT TRIGGER ${triggerName}
       AFTER INSERT ON tego_artifacts
       DEFERRABLE INITIALLY DEFERRED
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockName]);
    locked = true;
    const write = store.put(artifactDigest, source(content));
    const deadline = Date.now() + 2_000;
    while (true) {
      const waiting = await observer.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_stat_activity
          WHERE application_name = $1
            AND wait_event_type = 'Lock'`,
        [`tego:${storeNamespace}:artifacts`.slice(0, 63)],
      );
      if (waiting.rows[0]?.count === "1") break;
      if (Date.now() >= deadline)
        throw new Error("Artifact transaction did not reach its deferred commit barrier");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let closeSettled = false;
    const close = store.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(closeSettled, false);
    await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockName]);
    locked = false;
    await Promise.all([write, close]);

    const durable = await observer.query<{ artifacts: string; committed_bytes: string }>(
      `SELECT
         count(a.digest)::text AS artifacts,
         u.committed_bytes::text
       FROM tego_artifact_namespace_usage u
       LEFT JOIN tego_artifacts a USING (driver_namespace)
       WHERE u.driver_namespace = $1
       GROUP BY u.committed_bytes`,
      [storeNamespace],
    );
    assert.deepEqual(durable.rows[0], { artifacts: "1", committed_bytes: "4" });
  } finally {
    if (locked) {
      await blocker
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockName])
        .catch(() => undefined);
    }
    blocker.release();
    await store.close();
    await observer.query(`DROP TRIGGER IF EXISTS ${triggerName} ON tego_artifacts`);
    await observer.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await observer.end();
  }
});

test("a lost COMMIT acknowledgement is reconciled as success while close waits", async () => {
  const storeNamespace = namespace("artifact_commit_ack_lost");
  const content = Buffer.from("data");
  const artifactDigest = digest(content);
  const commitApplied = Promise.withResolvers<void>();
  let rejectAcknowledgement = true;
  const injectedFailure = new Error("injected lost COMMIT acknowledgement");
  const store = new PostgresArtifactStore(
    {
      connectionString,
      namespace: storeNamespace,
      limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
    },
    {
      commitTransaction: async (client: PoolClient) => {
        await client.query("COMMIT");
        if (!rejectAcknowledgement) return;
        rejectAcknowledgement = false;
        commitApplied.resolve();
        await Promise.resolve();
        throw injectedFailure;
      },
    },
  );
  const observer = new Pool({ connectionString });
  await store.open();
  try {
    const write = store.put(artifactDigest, source(content));
    await commitApplied.promise;
    await Promise.all([write, store.close()]);

    const durable = await observer.query<{
      artifacts: string;
      committed_bytes: string;
    }>(
      `SELECT
         count(a.digest)::text AS artifacts,
         u.committed_bytes::text
       FROM tego_artifact_namespace_usage u
       LEFT JOIN tego_artifacts a USING (driver_namespace)
       WHERE u.driver_namespace = $1
       GROUP BY u.committed_bytes`,
      [storeNamespace],
    );
    assert.deepEqual(durable.rows[0], { artifacts: "1", committed_bytes: "4" });
  } finally {
    await Promise.all([store.close(), observer.end()]);
  }
});

test("inconsistent state after a lost COMMIT acknowledgement is retryably indeterminate", async () => {
  const storeNamespace = namespace("artifact_commit_indeterminate");
  const content = Buffer.from("data");
  const artifactDigest = digest(content);
  const observer = new Pool({ connectionString });
  let rejectAcknowledgement = true;
  const store = new PostgresArtifactStore(
    {
      connectionString,
      namespace: storeNamespace,
      limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
    },
    {
      commitTransaction: async (client: PoolClient) => {
        await client.query("COMMIT");
        if (!rejectAcknowledgement) return;
        rejectAcknowledgement = false;
        await observer.query(
          `UPDATE tego_artifact_namespace_usage
              SET committed_bytes = committed_bytes + 1
            WHERE driver_namespace = $1`,
          [storeNamespace],
        );
        throw new Error("injected lost COMMIT acknowledgement");
      },
    },
  );
  await store.open();
  try {
    await assert.rejects(store.put(artifactDigest, source(content)), (error: unknown) => {
      assert.ok(error instanceof DiagnosticError);
      assert.equal(error.diagnostic.code, "ARTIFACT_COMMIT_INDETERMINATE");
      assert.equal(error.diagnostic.retryable, true);
      assert.deepEqual(error.diagnostic.details, {
        digest: artifactDigest,
        namespace: storeNamespace,
        candidateBytes: "4",
        limitBytes: "4",
      });
      assert.doesNotThrow(() => JSON.stringify(error.diagnostic));
      return true;
    });
  } finally {
    await Promise.all([store.close(), observer.end()]);
  }
});

test("a definitively absent artifact after COMMIT failure preserves the original error", async () => {
  const storeNamespace = namespace("artifact_commit_absent");
  const content = Buffer.from("data");
  const injectedFailure = new Error("injected pre-COMMIT connection failure");
  const store = new PostgresArtifactStore(
    {
      connectionString,
      namespace: storeNamespace,
      limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
    },
    {
      commitTransaction: async (client: PoolClient) => {
        await client.query("ROLLBACK");
        throw injectedFailure;
      },
    },
  );
  const observer = new Pool({ connectionString });
  await store.open();
  try {
    await assert.rejects(
      store.put(digest(content), source(content)),
      (error: unknown) => error === injectedFailure,
    );
    const durable = await observer.query<{ artifacts: string; usage: string }>(
      `SELECT
         (SELECT count(*)::text FROM tego_artifacts WHERE driver_namespace = $1) AS artifacts,
         (SELECT count(*)::text FROM tego_artifact_namespace_usage WHERE driver_namespace = $1)
           AS usage`,
      [storeNamespace],
    );
    assert.deepEqual(durable.rows[0], { artifacts: "0", usage: "0" });
  } finally {
    await Promise.all([store.close(), observer.end()]);
  }
});

test("an absent artifact with stale usage after COMMIT failure is retryably indeterminate", async () => {
  const storeNamespace = namespace("artifact_commit_absent_stale_usage");
  const content = Buffer.from("data");
  const artifactDigest = digest(content);
  const observer = new Pool({ connectionString });
  const store = new PostgresArtifactStore(
    {
      connectionString,
      namespace: storeNamespace,
      limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
    },
    {
      commitTransaction: async (client: PoolClient) => {
        await client.query("COMMIT");
        await observer.query(
          "DELETE FROM tego_artifacts WHERE driver_namespace = $1 AND digest = $2",
          [storeNamespace, artifactDigest],
        );
        throw new Error("injected lost COMMIT acknowledgement");
      },
    },
  );
  await store.open();
  try {
    await assert.rejects(store.put(artifactDigest, source(content)), (error: unknown) => {
      assert.ok(error instanceof DiagnosticError);
      assert.equal(error.diagnostic.code, "ARTIFACT_COMMIT_INDETERMINATE");
      assert.equal(error.diagnostic.retryable, true);
      assert.deepEqual(error.diagnostic.details, {
        digest: artifactDigest,
        namespace: storeNamespace,
        candidateBytes: "4",
        limitBytes: "4",
      });
      return true;
    });
  } finally {
    await Promise.all([store.close(), observer.end()]);
  }
});

for (const connectionTimeoutMillis of [undefined, 137] as const) {
  test(`PostgreSQL artifact pool receives the ${connectionTimeoutMillis ?? "default"} acquisition timeout`, async () => {
    let observedTimeout: number | undefined;
    const store = new PostgresArtifactStore(
      {
        connectionString,
        namespace: namespace("artifact_pool_timeout"),
        ...(connectionTimeoutMillis === undefined ? {} : { connectionTimeoutMillis }),
      },
      {
        createConnectionPool: (options, component, max) => {
          observedTimeout = options.connectionTimeoutMillis;
          assert.equal(component, "artifacts");
          assert.equal(max, undefined);
          return new Pool({ connectionString: options.connectionString });
        },
      },
    );
    try {
      assert.equal(observedTimeout, connectionTimeoutMillis ?? 5_000);
    } finally {
      await store.close();
    }
  });
}

test("a saturated real pool times out acquisition and still closes cleanly", async () => {
  const storeNamespace = namespace("artifact_real_pool_timeout");
  let artifactPool: Pool | undefined;
  const store = new PostgresArtifactStore(
    {
      connectionString,
      connectionTimeoutMillis: 30,
      namespace: storeNamespace,
    },
    {
      createConnectionPool: (options, component) => {
        artifactPool = new Pool({
          application_name: `tego:${options.namespace}:${component}`,
          connectionString: options.connectionString,
          connectionTimeoutMillis: options.connectionTimeoutMillis,
          max: 1,
        });
        return artifactPool;
      },
    },
  );
  await store.open();
  assert.ok(artifactPool !== undefined);
  const heldClient = await artifactPool.connect();
  try {
    await assert.rejects(
      store.put(digest(Buffer.from("data")), source(Buffer.from("data"))),
      (error: unknown) => {
        assert.ok(error instanceof DiagnosticError);
        assert.equal(error.diagnostic.code, "ARTIFACT_BACKEND_UNAVAILABLE");
        assert.equal(error.diagnostic.retryable, true);
        assert.deepEqual(error.diagnostic.details, { timeoutMillis: "30" });
        return true;
      },
    );
  } finally {
    heldClient.release();
  }
  await Promise.race([
    store.close(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("PostgreSQL pool did not end after timeout")), 2_000),
    ),
  ]);
});

for (const blockedAcquisition of ["preflight", "transaction"] as const) {
  test(`close cancels a never-resolving ${blockedAcquisition} client acquisition and destroys a late client`, async () => {
    const storeNamespace = namespace(`artifact_${blockedAcquisition}_acquire_close`);
    const content = Buffer.from("data");
    const artifactDigest = digest(content);
    const acquisitionStarted = Promise.withResolvers<void>();
    const lateAcquisition = Promise.withResolvers<PoolClient>();
    const observer = new Pool({ connectionString });
    let calls = 0;
    const store = new PostgresArtifactStore(
      {
        connectionString,
        namespace: storeNamespace,
        limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
        connectionTimeoutMillis: 5_000,
      },
      {
        connectClient: async (pool: Pool) => {
          calls += 1;
          if (blockedAcquisition === "transaction" && calls === 1) return pool.connect();
          acquisitionStarted.resolve();
          return lateAcquisition.promise;
        },
      },
    );
    await store.open();
    try {
      const write = store.put(artifactDigest, source(content));
      await acquisitionStarted.promise;
      await Promise.race([
        store.close(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Artifact store close did not cancel client acquisition")),
            2_000,
          ),
        ),
      ]);
      await assert.rejects(
        write,
        (error: unknown) => diagnosticCode(error) === "ARTIFACT_STORE_CLOSED",
      );

      const lateClient = await observer.connect();
      lateAcquisition.resolve(lateClient);
      const deadline = Date.now() + 2_000;
      while (observer.totalCount !== 0) {
        if (Date.now() >= deadline) throw new Error("Late PostgreSQL client was not destroyed");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await Promise.all([store.close(), observer.end()]);
    }
  });
}
