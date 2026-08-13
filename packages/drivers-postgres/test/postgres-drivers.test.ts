import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ArtifactDigest,
  DiagnosticError,
  diagnosticCode,
  parseArtifactDigest,
  parseMessageId,
  parseOperationId,
  parseRevision,
} from "@tego/contracts";
import {
  coordinationConformance,
  defineArtifactStoreSuite,
  stateStoreConformance,
} from "@tego/testkit";
import { Pool } from "pg";
import {
  applyPostgresMigrations,
  PostgresArtifactStore,
  PostgresCoordinationProvider,
  PostgresStateStore,
  postgresSchemaVersion,
} from "../src/index.js";

const connectionString =
  process.env.TEGO_POSTGRES_URL ??
  "postgresql://tego_test:tego_test@127.0.0.1:55432/tego_next_test";

function namespace(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function within<T>(promise: Promise<T>, message: string, timeoutMs = 2_000): Promise<T> {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(message);
    }),
  ]);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(10);
  }
}

stateStoreConformance(
  () =>
    new PostgresStateStore({
      connectionString,
      namespace: namespace("state"),
    }),
  { name: "PostgreSQL StateStore conformance" },
);

const coordinationTestNamespace = namespace("coordination");

coordinationConformance(
  (requestedNamespace) =>
    new PostgresCoordinationProvider({
      connectionString,
      namespace: `${coordinationTestNamespace}_${requestedNamespace ?? "default"}`,
    }),
  { name: "PostgreSQL CoordinationProvider conformance" },
);

function digest(bytes: Uint8Array): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

defineArtifactStoreSuite(async (options) => ({
  store: new PostgresArtifactStore({
    connectionString,
    namespace: namespace(options.namespace),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  }),
  dispose: async () => {},
}));

async function* source(...chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* chunks;
}

test("PostgreSQL StateStore instances share state and revisions across reopen", async () => {
  const sharedNamespace = namespace("state_shared");
  const first = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const second = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const record = { namespace: "runtime", collection: "records", id: "shared" };
  await Promise.all([first.open(), second.open()]);
  try {
    await first.transact({}, async (transaction) => {
      await transaction.put(record, { version: 1 }, { expectedRevision: "absent" });
      return null;
    });
    assert.deepEqual(await second.read(record), {
      revision: parseRevision("1"),
      value: { version: 1 },
    });
  } finally {
    await Promise.all([first.close(), second.close()]);
  }

  const reopened = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  await reopened.open();
  try {
    await reopened.transact({}, async (transaction) => {
      await transaction.put(record, { version: 2 }, { expectedRevision: parseRevision("1") });
      return null;
    });
    assert.deepEqual(await reopened.read(record), {
      revision: parseRevision("2"),
      value: { version: 2 },
    });
  } finally {
    await reopened.close();
  }
});

test("PostgreSQL operation scans preserve exact bigint cursors and code-unit ordering", async () => {
  const stateNamespace = namespace("state_operation_cursor");
  const store = new PostgresStateStore({
    connectionString,
    namespace: stateNamespace,
  });
  const pool = new Pool({ connectionString });
  await store.open();
  try {
    await store.transact({}, async (transaction) => {
      for (const operationId of ["operation-a", "operation-A", "operation-_"]) {
        await transaction.appendOperation({
          operationId: parseOperationId(operationId),
          kind: "deploy",
          status: "planned",
          state: { operationId },
          updatedAt: "2026-07-25T00:00:00.000Z",
        });
      }
      return null;
    });
    for (const table of ["tego_operations", "tego_operation_history"]) {
      await pool.query(
        `
          UPDATE ${table}
          SET revision = 9007199254740993
          WHERE driver_namespace = $1
        `,
        [stateNamespace],
      );
    }

    for (const scan of [store.scanOperations.bind(store), store.scanOperationHistory.bind(store)]) {
      const entries = [];
      for await (const entry of scan({
        after: {
          revision: parseRevision("9007199254740993"),
          operationId: parseOperationId("operation-A"),
        },
        limit: 2,
      })) {
        entries.push([entry.operationId, entry.revision]);
      }
      assert.deepEqual(entries, [
        ["operation-_", parseRevision("9007199254740993")],
        ["operation-a", parseRevision("9007199254740993")],
      ]);
    }
  } finally {
    await Promise.all([store.close(), pool.end()]);
  }
});

test("concurrent idempotent transactions commit one durable state and outbox effect", async () => {
  const sharedNamespace = namespace("state_idempotent");
  const left = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const right = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const record = { namespace: "runtime", collection: "records", id: "idempotent" };
  const createdAt = new Date().toISOString();
  const messageId = parseMessageId("postgres-concurrent-idempotent-message");
  const operationId = parseOperationId("postgres-concurrent-idempotent-operation");
  await Promise.all([left.open(), right.open()]);
  try {
    const run = (store: PostgresStateStore, contender: string) =>
      store.transact(
        {
          idempotencyKey: "postgres-concurrent-idempotency",
          idempotencyFingerprint: "same-request",
        },
        async (transaction) => {
          await transaction.put(record, { contender }, { expectedRevision: "absent" });
          await transaction.enqueueOutbox({
            availableAt: createdAt,
            createdAt,
            messageId,
            operationId,
            payload: { contender },
            topic: "component.lifecycle",
          });
          return { contender };
        },
      );

    const [leftResult, rightResult] = await Promise.all([run(left, "left"), run(right, "right")]);
    assert.deepEqual(rightResult, leftResult);
    assert.deepEqual(await left.read(record), {
      revision: parseRevision("1"),
      value: leftResult,
    });
    const claims = await left.claimOutbox({
      leaseDurationMs: 30_000,
      limit: 2,
      owner: "idempotency-verifier",
    });
    assert.deepEqual(
      claims.map((claim) => claim.message.messageId),
      [messageId],
    );
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
});

test("concurrent updates of one revision report one stable state conflict", async () => {
  const sharedNamespace = namespace("state_revision_race");
  const left = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const right = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const record = { namespace: "runtime", collection: "records", id: "contended" };
  await Promise.all([left.open(), right.open()]);
  try {
    await left.transact({}, async (transaction) => {
      await transaction.put(record, { contender: "initial" }, { expectedRevision: "absent" });
      return null;
    });

    const ready = Promise.withResolvers<void>();
    let contenders = 0;
    const run = (store: PostgresStateStore, contender: string) =>
      store.transact({}, async (transaction) => {
        contenders += 1;
        if (contenders === 2) ready.resolve();
        await ready.promise;
        await transaction.put(record, { contender }, { expectedRevision: parseRevision("1") });
        return contender;
      });

    const results = await within(
      Promise.allSettled([run(left, "left"), run(right, "right")]),
      "Timed out waiting for the revision race",
    );
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(
      losers[0]?.status === "rejected" &&
        diagnosticCode(losers[0].reason) === "STATE_REVISION_CONFLICT",
    );
    const winner = winners[0];
    assert.ok(winner?.status === "fulfilled");
    assert.deepEqual(await left.read(record), {
      revision: parseRevision("2"),
      value: { contender: winner.value },
    });
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
});

test("opposite-order updates do not leak PostgreSQL deadlocks or partially commit", async () => {
  const sharedNamespace = namespace("state_deadlock");
  const left = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const right = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const observer = new Pool({ connectionString });
  const blocker = await observer.connect();
  const firstRecord = { namespace: "runtime", collection: "records", id: "first" };
  const secondRecord = { namespace: "runtime", collection: "records", id: "second" };
  await Promise.all([left.open(), right.open()]);
  let blocked = false;
  try {
    await left.transact({}, async (transaction) => {
      await transaction.put(firstRecord, { contender: "initial" }, { expectedRevision: "absent" });
      await transaction.put(secondRecord, { contender: "initial" }, { expectedRevision: "absent" });
      return null;
    });
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT revision FROM tego_state_revisions WHERE driver_namespace = $1 FOR UPDATE",
      [sharedNamespace],
    );
    blocked = true;

    const run = (
      store: PostgresStateStore,
      contender: string,
      first: typeof firstRecord,
      second: typeof secondRecord,
    ) =>
      store.transact({}, async (transaction) => {
        await transaction.put(first, { contender }, { expectedRevision: parseRevision("1") });
        await transaction.put(second, { contender }, { expectedRevision: parseRevision("1") });
        return contender;
      });
    const executions = [
      run(left, "left", firstRecord, secondRecord),
      run(right, "right", secondRecord, firstRecord),
    ];

    await waitFor(async () => {
      const result = await observer.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_stat_activity
          WHERE application_name = $1
            AND wait_event_type = 'Lock'`,
        [`tego:${sharedNamespace}:state`],
      );
      return Number(result.rows[0]?.count ?? 0) >= 2;
    }, "State transactions did not both reach the revision lock");
    await blocker.query("COMMIT");
    blocked = false;

    const results = await within(
      Promise.allSettled(executions),
      "Timed out waiting for opposite-order state transactions",
      4_000,
    );
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(
      losers[0]?.status === "rejected" &&
        diagnosticCode(losers[0].reason) === "STATE_REVISION_CONFLICT",
    );
    const winner = winners[0];
    assert.ok(winner?.status === "fulfilled");
    assert.deepEqual((await left.read(firstRecord))?.value, { contender: winner.value });
    assert.deepEqual((await left.read(secondRecord))?.value, { contender: winner.value });
  } finally {
    if (blocked) await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await Promise.all([left.close(), right.close(), observer.end()]);
  }
});

test("StateStore close cancels a transaction waiting for an advisory lock", async () => {
  const sharedNamespace = namespace("state_close_lock");
  const store = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const observer = new Pool({ connectionString });
  const blocker = await observer.connect();
  const idempotencyKey = "blocked-close";
  const lockName = `tego:state:idempotency:${sharedNamespace}:${idempotencyKey}`;
  await store.open();
  await blocker.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockName]);
  const transaction = store.transact(
    {
      idempotencyKey,
      idempotencyFingerprint: "blocked-close-request",
    },
    async () => null,
  );
  let closePromise: Promise<void> | undefined;
  try {
    await waitFor(async () => {
      const result = await observer.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_stat_activity
          WHERE application_name = $1
            AND wait_event = 'advisory'`,
        [`tego:${sharedNamespace}:state`],
      );
      return Number(result.rows[0]?.count ?? 0) === 1;
    }, "State transaction did not wait for the advisory lock");

    closePromise = store.close();
    await within(closePromise, "StateStore close remained blocked behind an advisory lock");
    const result = await within(
      transaction.then(
        () => "fulfilled" as const,
        (error: unknown) => diagnosticCode(error),
      ),
      "Blocked state transaction did not settle during close",
    );
    assert.equal(result, "STATE_CLOSED");
  } finally {
    await blocker
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockName])
      .catch(() => undefined);
    blocker.release();
    await Promise.allSettled([transaction, closePromise ?? store.close(), observer.end()]);
  }
});

test("concurrent outbox claims across PostgreSQL StateStore instances have one winner", async () => {
  const sharedNamespace = namespace("state_claim");
  const left = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const right = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const createdAt = new Date().toISOString();
  await Promise.all([left.open(), right.open()]);
  try {
    await left.transact({}, async (transaction) => {
      await transaction.enqueueOutbox({
        availableAt: createdAt,
        createdAt,
        messageId: parseMessageId("postgres-shared-claim-message"),
        operationId: parseOperationId("postgres-shared-claim-operation"),
        payload: { shared: true },
        topic: "component.lifecycle",
      });
      return null;
    });

    const [leftClaims, rightClaims] = await Promise.all([
      left.claimOutbox({ leaseDurationMs: 30_000, limit: 1, owner: "left" }),
      right.claimOutbox({ leaseDurationMs: 30_000, limit: 1, owner: "right" }),
    ]);
    assert.equal(leftClaims.length + rightClaims.length, 1);
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
});

test("concurrent absent PostgreSQL leases use database time and have one winner", async () => {
  const sharedNamespace = namespace("lease_race");
  const left = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  const right = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  const realDateNow = Date.now;
  await Promise.all([left.open(), right.open()]);
  try {
    const earliestDatabaseTime = realDateNow() - 5_000;
    Date.now = () => Date.UTC(2100, 0, 1);
    const results = await Promise.allSettled([
      left.acquireLease({
        resource: "task/absent-race",
        owner: "left",
        durationMs: 30_000,
      }),
      right.acquireLease({
        resource: "task/absent-race",
        owner: "right",
        durationMs: 30_000,
      }),
    ]);
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(
      losers[0]?.status === "rejected" &&
        diagnosticCode(losers[0].reason) === "COORDINATION_LEASE_HELD",
    );
    const winner = winners[0];
    assert.ok(winner?.status === "fulfilled");
    assert.ok(Date.parse(winner.value.acquiredAt) >= earliestDatabaseTime);
    assert.ok(Date.parse(winner.value.acquiredAt) <= realDateNow() + 5_000);
  } finally {
    Date.now = realDateNow;
    await Promise.all([left.close(), right.close()]);
  }
});

test("PostgreSQL ArtifactStore verifies digest, uniqueness, size, and restart reads", async () => {
  const content = Buffer.from("shared PostgreSQL artifact");
  const artifactDigest = digest(content);
  const storeNamespace = namespace("artifacts");
  const first = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
  });
  await first.open();
  await Promise.all([
    first.put(artifactDigest, source(content)),
    first.put(artifactDigest, source(Buffer.from(content))),
  ]);
  await first.close();

  const reopened = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
  });
  await reopened.open();
  const chunks: Uint8Array[] = [];
  for await (const chunk of reopened.read(artifactDigest)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), content);
  await reopened.close();
});

test("PostgreSQL ArtifactStore persists quota usage across restart and validates duplicate sources", async () => {
  const storeNamespace = namespace("artifact_quota_restart");
  const limits = { maxArtifactBytes: 4, maxNamespaceBytes: 6 };
  const content = Buffer.from("full");
  const artifactDigest = digest(content);
  const first = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
    limits,
  });
  await first.open();
  await first.put(artifactDigest, source(content));
  await first.close();

  const reopened = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
    limits,
  });
  await reopened.open();
  try {
    await reopened.put(artifactDigest, source(Buffer.from(content)));
    await assert.rejects(
      reopened.put(artifactDigest, source(Buffer.from("FAIL"))),
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_DIGEST_MISMATCH",
    );
    const nextDigest = digest(Buffer.from("next"));
    await assert.rejects(
      reopened.put(nextDigest, source(Buffer.from("next"))),
      (error: unknown) => {
        assert.ok(error instanceof DiagnosticError);
        assert.equal(error.diagnostic.code, "ARTIFACT_NAMESPACE_QUOTA_EXCEEDED");
        assert.deepEqual(error.diagnostic.details, {
          digest: nextDigest,
          namespace: storeNamespace,
          artifactBytes: 4,
          committedBytes: "4",
          reservedBytes: "4",
          maximumBytes: 6,
        });
        assert.doesNotThrow(() => JSON.stringify(error.diagnostic));
        return true;
      },
    );
  } finally {
    await reopened.close();
  }
});

test("PostgreSQL quota migration backfills exact bytes once and records stable checksums", async () => {
  const storeNamespace = namespace("artifact_quota_migration");
  const content = Buffer.from("before quota migration");
  const artifactDigest = digest(content);
  const pool = new Pool({ connectionString });
  try {
    await applyPostgresMigrations(pool);
    await pool.query("DELETE FROM tego_artifact_namespace_usage WHERE driver_namespace = $1", [
      storeNamespace,
    ]);
    await pool.query(
      `INSERT INTO tego_artifacts(driver_namespace, digest, content, size_bytes)
       VALUES ($1, $2, $3, $4)`,
      [storeNamespace, artifactDigest, content, content.byteLength.toString()],
    );
    await pool.query("DELETE FROM tego_schema_migrations WHERE version = $1", [
      postgresSchemaVersion,
    ]);

    await applyPostgresMigrations(pool);
    await applyPostgresMigrations(pool);

    const usage = await pool.query<{ committed_bytes: string }>(
      `SELECT committed_bytes::text
         FROM tego_artifact_namespace_usage
        WHERE driver_namespace = $1`,
      [storeNamespace],
    );
    assert.equal(usage.rows[0]?.committed_bytes, content.byteLength.toString());
    const migrations = await pool.query<{ checksum: string; version: number }>(
      "SELECT version, checksum FROM tego_schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      migrations.rows.map((row) => row.version),
      Array.from({ length: postgresSchemaVersion }, (_, index) => index + 1),
    );
    assert.ok(migrations.rows.every((row) => /^[0-9a-f]{64}$/u.test(row.checksum)));
  } finally {
    await pool.query("DELETE FROM tego_artifacts WHERE driver_namespace = $1", [storeNamespace]);
    await pool.query("DELETE FROM tego_artifact_namespace_usage WHERE driver_namespace = $1", [
      storeNamespace,
    ]);
    await pool.end();
  }
});

test("PostgreSQL migrations reject a recorded checksum that differs from the current migration", async () => {
  const pool = new Pool({ connectionString });
  const original = await pool.query<{ checksum: string }>(
    "SELECT checksum FROM tego_schema_migrations WHERE version = $1",
    [postgresSchemaVersion],
  );
  const checksum = original.rows[0]?.checksum;
  assert.ok(checksum !== undefined);
  try {
    await pool.query("UPDATE tego_schema_migrations SET checksum = $2 WHERE version = $1", [
      postgresSchemaVersion,
      "0".repeat(64),
    ]);
    await assert.rejects(
      applyPostgresMigrations(pool),
      new RegExp(`PostgreSQL migration ${postgresSchemaVersion} checksum does not match`),
    );
  } finally {
    await pool.query("UPDATE tego_schema_migrations SET checksum = $2 WHERE version = $1", [
      postgresSchemaVersion,
      checksum,
    ]);
    await pool.end();
  }
});

test("two PostgreSQL ArtifactStore pools cannot overcommit an existing namespace usage row", async () => {
  const storeNamespace = namespace("artifact_quota_existing_race");
  const limits = { maxArtifactBytes: 4, maxNamespaceBytes: 6 };
  const left = new PostgresArtifactStore({ connectionString, namespace: storeNamespace, limits });
  const right = new PostgresArtifactStore({ connectionString, namespace: storeNamespace, limits });
  const observer = new Pool({ connectionString });
  const blocker = await observer.connect();
  await Promise.all([left.open(), right.open()]);
  let blocked = false;
  try {
    await observer.query(
      `INSERT INTO tego_artifact_namespace_usage(driver_namespace, committed_bytes)
       VALUES ($1, 0)
       ON CONFLICT(driver_namespace) DO NOTHING`,
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

    const writes = [
      left.put(digest(Buffer.from("left")), source(Buffer.from("left"))),
      right.put(digest(Buffer.from("rght")), source(Buffer.from("rght"))),
    ];
    await waitFor(async () => {
      const result = await observer.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_stat_activity
          WHERE application_name = $1
            AND wait_event_type = 'Lock'`,
        [`tego:${storeNamespace}:artifacts`.slice(0, 63)],
      );
      return BigInt(result.rows[0]?.count ?? "0") === 2n;
    }, "Artifact transactions did not both reach the namespace usage lock");
    await blocker.query("COMMIT");
    blocked = false;

    const results = await within(
      Promise.allSettled(writes),
      "Timed out waiting for existing-row artifact quota contenders",
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.ok(
      rejected[0]?.status === "rejected" &&
        diagnosticCode(rejected[0].reason) === "ARTIFACT_NAMESPACE_QUOTA_EXCEEDED",
    );
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
    if (blocked) await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await Promise.all([left.close(), right.close(), observer.end()]);
  }
});

test("two PostgreSQL ArtifactStore pools serialize concurrent first use of a namespace", async () => {
  const storeNamespace = namespace("artifact_quota_first_race");
  const limits = { maxArtifactBytes: 4, maxNamespaceBytes: 6 };
  const left = new PostgresArtifactStore({ connectionString, namespace: storeNamespace, limits });
  const right = new PostgresArtifactStore({ connectionString, namespace: storeNamespace, limits });
  const observer = new Pool({ connectionString });
  const blocker = await observer.connect();
  await Promise.all([left.open(), right.open()]);
  let blocked = false;
  try {
    await observer.query("DELETE FROM tego_artifact_namespace_usage WHERE driver_namespace = $1", [
      storeNamespace,
    ]);
    await blocker.query("BEGIN");
    await blocker.query(
      `INSERT INTO tego_artifact_namespace_usage(driver_namespace, committed_bytes)
       VALUES ($1, 0)`,
      [storeNamespace],
    );
    blocked = true;

    const writes = [
      left.put(digest(Buffer.from("aaaa")), source(Buffer.from("aaaa"))),
      right.put(digest(Buffer.from("bbbb")), source(Buffer.from("bbbb"))),
    ];
    await waitFor(async () => {
      const result = await observer.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_stat_activity
          WHERE application_name = $1
            AND wait_event_type = 'Lock'`,
        [`tego:${storeNamespace}:artifacts`.slice(0, 63)],
      );
      return BigInt(result.rows[0]?.count ?? "0") === 2n;
    }, "Artifact transactions did not both reach first-use row creation");
    await blocker.query("ROLLBACK");
    blocked = false;

    const results = await within(
      Promise.allSettled(writes),
      "Timed out waiting for first-use artifact quota contenders",
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.ok(
      rejected[0]?.status === "rejected" &&
        diagnosticCode(rejected[0].reason) === "ARTIFACT_NAMESPACE_QUOTA_EXCEEDED",
    );
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
    if (blocked) await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await Promise.all([left.close(), right.close(), observer.end()]);
  }
});

test("PostgreSQL ArtifactStore quota usage is isolated by driver namespace", async () => {
  const limits = { maxArtifactBytes: 4, maxNamespaceBytes: 4 };
  const left = new PostgresArtifactStore({
    connectionString,
    namespace: namespace("artifact_quota_isolated_left"),
    limits,
  });
  const right = new PostgresArtifactStore({
    connectionString,
    namespace: namespace("artifact_quota_isolated_right"),
    limits,
  });
  const content = Buffer.from("same");
  const artifactDigest = digest(content);
  await Promise.all([left.open(), right.open()]);
  try {
    await Promise.all([
      left.put(artifactDigest, source(content)),
      right.put(artifactDigest, source(content)),
    ]);
    await assert.rejects(
      left.put(digest(Buffer.from("more")), source(Buffer.from("more"))),
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_NAMESPACE_QUOTA_EXCEEDED",
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of right.read(artifactDigest)) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), content);
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
});

test("PostgreSQL ArtifactStore rejects digest mismatches and oversized artifacts", async () => {
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: namespace("artifact_bounds"),
    limits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
  });
  await store.open();
  try {
    await assert.rejects(
      store.put(digest(Buffer.from("same")), source(Buffer.from("diff"))),
      (error: unknown) =>
        error instanceof Error &&
        "diagnostic" in error &&
        (error as { diagnostic?: { code?: string } }).diagnostic?.code ===
          "ARTIFACT_DIGEST_MISMATCH",
    );
    await assert.rejects(
      store.put(digest(Buffer.alloc(5)), source(Buffer.alloc(5))),
      (error: unknown) =>
        error instanceof Error &&
        "diagnostic" in error &&
        (error as { diagnostic?: { code?: string } }).diagnostic?.code ===
          "ARTIFACT_SIZE_LIMIT_EXCEEDED",
    );
  } finally {
    await store.close();
  }
});

test("PostgreSQL ArtifactStore rejects at-rest corruption before yielding bytes", async () => {
  const content = Buffer.from("uncorrupted artifact");
  const artifactDigest = digest(content);
  const storeNamespace = namespace("artifact_corruption");
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
  });
  const pool = new Pool({ connectionString });
  await store.open();
  try {
    await store.put(artifactDigest, source(content));
    const corrupted = Buffer.from("corrupted artifact");
    const updated = await pool.query(
      `UPDATE tego_artifacts
          SET content = $3, size_bytes = $4
        WHERE driver_namespace = $1 AND digest = $2`,
      [storeNamespace, artifactDigest, corrupted, corrupted.byteLength],
    );
    assert.equal(updated.rowCount, 1);

    const iterator = store.read(artifactDigest)[Symbol.asyncIterator]();
    await assert.rejects(
      iterator.next(),
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_DIGEST_MISMATCH",
    );
  } finally {
    await Promise.all([store.close(), pool.end()]);
  }
});

test("createPostgresDrivers creates one shared driver namespace", async () => {
  const { createPostgresDrivers } = await import("../src/index.js");
  const drivers = createPostgresDrivers({
    connectionString,
    namespace: namespace("bundle"),
    artifactLimits: { maxArtifactBytes: 4, maxNamespaceBytes: 4 },
  });
  assert.equal(drivers.state.scope, "shared");
  assert.equal(drivers.coordination.scope, "distributed");
  assert.equal(drivers.artifacts.scope, "shared");
  await drivers.artifacts.open();
  try {
    await assert.rejects(
      drivers.artifacts.put(digest(Buffer.alloc(5)), source(Buffer.alloc(5))),
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_SIZE_LIMIT_EXCEEDED",
    );
  } finally {
    await Promise.all([
      drivers.artifacts.close(),
      drivers.coordination.close(),
      drivers.state.close(),
    ]);
  }
});

test("PostgreSQL cluster time is canonical UTC and independent of the process clock", async () => {
  const { createPostgresDrivers } = await import("../src/index.js");
  const drivers = createPostgresDrivers({
    connectionString,
    namespace: namespace("cluster_time"),
  });
  const realDateNow = Date.now;
  await drivers.state.open();
  try {
    const earliestDatabaseTime = realDateNow() - 5_000;
    Date.now = () => Date.UTC(2100, 0, 1);
    const now = await drivers.clusterTime.now();
    assert.equal(new Date(now).toISOString(), now);
    assert.ok(Date.parse(now) >= earliestDatabaseTime);
    assert.ok(Date.parse(now) <= realDateNow() + 5_000);
  } finally {
    Date.now = realDateNow;
    await drivers.state.close();
  }
});
