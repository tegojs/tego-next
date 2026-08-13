import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { diagnosticCode, parseArtifactDigest } from "@tego/contracts";
import { Pool } from "pg";
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
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: namespace("artifact_source_limit"),
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
    await assert.rejects(
      store.put(digest(new Uint8Array()), source),
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_SIZE_LIMIT_EXCEEDED",
    );
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
