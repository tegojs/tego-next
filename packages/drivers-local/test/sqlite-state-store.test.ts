import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import {
  diagnosticCode,
  type JsonObject,
  type OperationJournalEntry,
  type PersistedOperationJournalEntry,
  parseFencingEpoch,
  parseMessageId,
  parseOperationId,
  parseRevision,
  type StateKey,
  stateStringOrderKey,
} from "@tegojs/contracts";
import { stateStoreConformance } from "@tegojs/testkit";
import * as publicApi from "../src/index.js";
import { SqliteStateStore } from "../src/index.js";

interface ExampleRecord extends JsonObject {
  readonly label: string;
}

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDatabase(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `tego-sqlite-${name}-`));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
}

function key(namespace: string, id: string): StateKey<ExampleRecord> {
  return { namespace, collection: "examples", id };
}

async function openStore(databasePath: string): Promise<SqliteStateStore> {
  const store = new SqliteStateStore({ databasePath });
  await store.open();
  return store;
}

async function recoverableOperations(
  store: SqliteStateStore,
): Promise<readonly PersistedOperationJournalEntry[]> {
  const entries = [];
  for await (const entry of store.scanRecoverableOperations({})) {
    entries.push(entry);
  }
  return entries;
}

function runChild(script: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script, ...arguments_],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `child exited with code ${String(code)} and signal ${String(signal)}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      }
    });
  });
}

stateStoreConformance(
  async () => new SqliteStateStore({ databasePath: await temporaryDatabase("conformance") }),
  { name: "SqliteStateStore" },
);

test("storage-specific migration machinery is not part of the public package API", () => {
  assert.equal("applySqliteMigrations" in publicApi, false);
  assert.equal("sqliteSchemaVersion" in publicApi, false);
});

test("@spec:runtime-bootstrap/durable-restart-recovery/restart-after-an-interrupted-operation", async () => {
  const databasePath = await temporaryDatabase("restart-operation");
  const operation: OperationJournalEntry = {
    operationId: parseOperationId("operation-restart"),
    kind: "install",
    status: "executing",
    state: { step: "artifact-published" },
    updatedAt: "2026-07-23T00:00:00.000Z",
  };

  const first = await openStore(databasePath);
  await first.transact({}, async (transaction) => {
    await transaction.appendOperation(operation);
    return null;
  });
  await first.close();

  const second = await openStore(databasePath);
  assert.deepEqual(await recoverableOperations(second), [
    { ...operation, revision: parseRevision("1") },
  ]);
  await second.close();
});

test("a committed transaction survives abrupt process termination without close", async () => {
  const databasePath = await temporaryDatabase("crash");
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const childScript = `
    import { parseOperationId } from "@tegojs/contracts";
    const [{ SqliteStateStore }] = await Promise.all([import(process.argv[2])]);
    const store = new SqliteStateStore({ databasePath: process.argv[1] });
    await store.open();
    await store.transact({}, async (transaction) => {
      await transaction.appendOperation({
        operationId: parseOperationId("operation-crash"),
        kind: "deploy",
        status: "executing",
        state: { step: "desired-state-written" },
        updatedAt: "2026-07-23T00:00:00.000Z",
      });
      return null;
    });
    process.exit(0);
  `;

  await runChild(childScript, [databasePath, moduleUrl]);

  const reopened = await openStore(databasePath);
  assert.equal((await recoverableOperations(reopened))[0]?.status, "executing");
  await reopened.close();
});

test("an outbox claim survives restart, expires, rejects stale acknowledgement, and is reclaimed", async () => {
  const databasePath = await temporaryDatabase("outbox-restart");
  const messageId = parseMessageId("message-restart");
  const operationId = parseOperationId("operation-restart-outbox");
  const first = await openStore(databasePath);
  await first.transact({}, async (transaction) => {
    await transaction.enqueueOutbox({
      availableAt: "2026-07-23T00:00:00.000Z",
      createdAt: "2026-07-23T00:00:00.000Z",
      messageId,
      operationId,
      payload: { effect: "prepare" },
      topic: "component.lifecycle",
    });
    return null;
  });
  const [claim] = await first.claimOutbox({
    leaseDurationMs: 1,
    limit: 1,
    owner: "main-before-restart",
  });
  assert.ok(claim);
  await first.close();

  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await openStore(databasePath);
  const [reclaimed] = await second.claimOutbox({
    leaseDurationMs: 30_000,
    limit: 1,
    owner: "main-after-restart",
  });
  assert.ok(reclaimed);
  assert.equal(reclaimed.message.messageId, messageId);
  assert.equal(reclaimed.attempt, 2);
  assert.equal(reclaimed.claimEpoch, parseFencingEpoch("2"));
  await assert.rejects(
    second.acknowledgeOutbox({
      claimEpoch: claim.claimEpoch,
      messageId,
      outcome: "completed",
      owner: claim.owner,
    }),
    (error: unknown) => diagnosticCode(error) === "STATE_FENCE_STALE",
  );
  const acknowledged = await second.acknowledgeOutbox({
    claimEpoch: reclaimed.claimEpoch,
    messageId,
    outcome: "completed",
    owner: reclaimed.owner,
  });
  assert.equal(acknowledged.duplicate, false);
  assert.equal(
    (
      await second.acknowledgeOutbox({
        claimEpoch: reclaimed.claimEpoch,
        messageId,
        outcome: "completed",
        owner: reclaimed.owner,
      })
    ).duplicate,
    true,
  );
  assert.deepEqual(
    await second.claimOutbox({ leaseDurationMs: 30_000, limit: 1, owner: "never-again" }),
    [],
  );
  await second.close();
});

test("same-transaction outbox enqueue order survives restart", async () => {
  const databasePath = await temporaryDatabase("outbox-order-restart");
  const first = await openStore(databasePath);
  const createdAt = new Date().toISOString();
  await first.transact({}, async (transaction) => {
    for (const suffix of ["z-first", "a-second"] as const) {
      await transaction.enqueueOutbox({
        availableAt: createdAt,
        createdAt,
        messageId: parseMessageId(`restart-${suffix}`),
        operationId: parseOperationId(`restart-${suffix}`),
        payload: { suffix },
        topic: "component.lifecycle",
      });
    }
    return null;
  });
  await first.close();

  const second = await openStore(databasePath);
  const claims = await second.claimOutbox({
    leaseDurationMs: 30_000,
    limit: 2,
    owner: "restart-order",
  });
  assert.deepEqual(
    claims.map((claim) => claim.message.messageId),
    [parseMessageId("restart-z-first"), parseMessageId("restart-a-second")],
  );
  await second.close();
});

test("migrations are idempotent and configure WAL mode", async () => {
  const databasePath = await temporaryDatabase("migrations");
  await (await openStore(databasePath)).close();
  await (await openStore(databasePath)).close();

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const migrations = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => row.version);
    assert.deepEqual(migrations, [1, 2, 3, 4, 5]);
    assert.equal(database.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, [
      "changes",
      "fences",
      "idempotency",
      "operation_history",
      "operations",
      "outbox",
      "records",
      "revisions",
      "schema_migrations",
    ]);
  } finally {
    database.close();
  }
});

test("simultaneous processes migrate a v3 database without SQLITE_BUSY or lost state", async () => {
  const databasePath = await temporaryDatabase("concurrent-migration");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, '2026-07-25T00:00:00.000Z'),
             (2, '2026-07-25T00:00:00.000Z'),
             (3, '2026-07-25T00:00:00.000Z');
    CREATE TABLE revisions (
      revision INTEGER PRIMARY KEY AUTOINCREMENT
    ) STRICT;
    INSERT INTO revisions(revision) VALUES (1);
    CREATE TABLE records (
      namespace TEXT NOT NULL,
      collection_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      revision INTEGER NOT NULL REFERENCES revisions(revision),
      PRIMARY KEY (namespace, collection_name, record_id)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE operations (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL REFERENCES revisions(revision)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO operations(
      operation_id, kind, status, state_json, updated_at, revision
    ) VALUES (
      'migration-operation',
      'deploy',
      'planned',
      '{"step":"preserved"}',
      '2026-07-25T00:00:00.000Z',
      1
    );
  `);
  const insert = database.prepare(
    `
      INSERT INTO records(namespace, collection_name, record_id, value_json, revision)
      VALUES ('migration', 'examples', ?, ?, 1)
    `,
  );
  for (let index = 0; index < 2_000; index += 1) {
    insert.run(`record-${String(index).padStart(4, "0")}`, `{"index":${String(index)}}`);
  }
  database.close();

  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const startsAt = String(Date.now() + 1_000);
  const childScript = `
    import { setTimeout as delay } from "node:timers/promises";
    const [{ SqliteStateStore }] = await Promise.all([import(process.argv[2])]);
    while (Date.now() < Number(process.argv[3])) await delay(1);
    const store = new SqliteStateStore({ databasePath: process.argv[1] });
    await store.open();
    await store.close();
  `;
  await Promise.all([
    runChild(childScript, [databasePath, moduleUrl, startsAt]),
    runChild(childScript, [databasePath, moduleUrl, startsAt]),
  ]);

  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      migrated
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => row.version),
      [1, 2, 3, 4, 5],
    );
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM records").get()?.count, 2_000);
    assert.deepEqual(
      migrated
        .prepare(
          "SELECT operation_id, status, state_json FROM operation_history ORDER BY revision, operation_id",
        )
        .all()
        .map((row) => ({
          operation_id: row.operation_id,
          status: row.status,
          state_json: row.state_json,
        })),
      [
        {
          operation_id: "migration-operation",
          status: "planned",
          state_json: '{"step":"preserved"}',
        },
      ],
    );
  } finally {
    migrated.close();
  }
});

test("idempotency results and fingerprints survive restart", async () => {
  const databasePath = await temporaryDatabase("idempotency");
  const options = {
    idempotencyKey: "durable-key",
    idempotencyFingerprint: "request-v1",
  } as const;
  const first = await openStore(databasePath);
  assert.deepEqual(await first.transact(options, async () => ({ outcome: "committed" })), {
    outcome: "committed",
  });
  await first.close();

  const second = await openStore(databasePath);
  let replayWorkInvocations = 0;
  assert.deepEqual(
    await second.transact(options, async () => {
      replayWorkInvocations += 1;
      return { outcome: "wrong" };
    }),
    { outcome: "committed" },
  );
  assert.equal(replayWorkInvocations, 0);
  await assert.rejects(
    second.transact(
      { idempotencyKey: "durable-key", idempotencyFingerprint: "request-v2" },
      async () => null,
    ),
    (error: unknown) => diagnosticCode(error) === "STATE_IDEMPOTENCY_CONFLICT",
  );
  await second.close();
});

test("fences and database-generated revisions survive restart", async () => {
  const databasePath = await temporaryDatabase("fence-revision");
  const firstKey = key("durable", "first");
  const first = await openStore(databasePath);
  await first.transact(
    { fencing: { resource: "runtime", epoch: parseFencingEpoch("5") } },
    async (transaction) => {
      await transaction.put(firstKey, { label: "first" }, {});
      return null;
    },
  );
  assert.equal((await first.read(firstKey))?.revision, parseRevision("1"));
  await first.close();

  const second = await openStore(databasePath);
  await assert.rejects(
    second.transact(
      { fencing: { resource: "runtime", epoch: parseFencingEpoch("4") } },
      async () => null,
    ),
    (error: unknown) => diagnosticCode(error) === "STATE_FENCE_STALE",
  );
  const secondKey = key("durable", "second");
  await second.transact({}, async (transaction) => {
    await transaction.put(secondKey, { label: "second" }, {});
    return null;
  });
  assert.equal((await second.read(secondKey))?.revision, parseRevision("2"));
  await second.close();
});

test("watch replays durable changes created before reopening", async () => {
  const databasePath = await temporaryDatabase("watch-restart");
  const watchedKey = key("watch-restart", "record");
  const first = await openStore(databasePath);
  await first.transact({}, async (transaction) => {
    await transaction.put(watchedKey, { label: "durable" }, {});
    return null;
  });
  await first.close();

  const second = await openStore(databasePath);
  const iterator = second.watch(parseRevision("0"))[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: {
      revision: parseRevision("1"),
      key: watchedKey,
      kind: "put",
      value: { label: "durable" },
    },
  });
  await iterator.return?.();
  await second.close();
});

test("decoded database values are validated before they escape", async () => {
  const databasePath = await temporaryDatabase("invalid-json");
  const store = await openStore(databasePath);
  await store.close();

  const database = new DatabaseSync(databasePath);
  database.prepare("INSERT INTO revisions DEFAULT VALUES").run();
  database
    .prepare(
      "INSERT INTO records(namespace, collection_name, record_id, record_id_order_key, value_json, revision) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("invalid", "examples", "record", Buffer.from(stateStringOrderKey("record")), '{"not":', 1);
  database.close();

  const reopened = await openStore(databasePath);
  await assert.rejects(
    reopened.read(key("invalid", "record")),
    (error: unknown) => diagnosticCode(error) === "STATE_DATA_INVALID",
  );
  await reopened.close();
});

test("close releases the database file and remains idempotent", async () => {
  const databasePath = await temporaryDatabase("close");
  const movedPath = `${databasePath}.moved`;
  const store = await openStore(databasePath);
  await store.close();
  await store.close();

  await rename(databasePath, movedPath);
  await rename(movedPath, databasePath);
});

test("close racing with open cannot resurrect the SQLite connection", async () => {
  const databasePath = await temporaryDatabase("open-close-race");
  const store = new SqliteStateStore({ databasePath });

  const opening = store.open();
  const closing = store.close();
  await Promise.allSettled([opening, closing]);

  await assert.rejects(
    store.health(),
    (error: unknown) => diagnosticCode(error) === "STATE_CLOSED",
  );
});

test("database-generated revisions remain exact above Number.MAX_SAFE_INTEGER", async () => {
  const databasePath = await temporaryDatabase("bigint-revision");
  await (await openStore(databasePath)).close();
  const database = new DatabaseSync(databasePath);
  database
    .prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('revisions', ?)")
    .run(9_007_199_254_740_992n);
  database.close();

  const store = await openStore(databasePath);
  const recordKey = key("bigint-revision", "record");
  await store.transact({}, async (transaction) => {
    await transaction.put(recordKey, { label: "exact" }, {});
    return null;
  });
  assert.equal((await store.read(recordKey))?.revision, parseRevision("9007199254740993"));
  await store.close();
});

test("transaction reads use one immutable SQLite snapshot", async () => {
  const databasePath = await temporaryDatabase("snapshot");
  const first = await openStore(databasePath);
  const second = await openStore(databasePath);
  const recordKey = key("snapshot", "record");

  await first.transact({}, async (transaction) => {
    assert.equal(await transaction.get(recordKey), undefined);
    await second.transact({}, async (otherTransaction) => {
      await otherTransaction.put(recordKey, { label: "concurrent" }, {});
      return null;
    });
    assert.equal(await transaction.get(recordKey), undefined);
    return null;
  });

  await first.close();
  await second.close();
});

test("transaction scans decode only their SQL page and keep one immutable snapshot", async () => {
  const databasePath = await temporaryDatabase("scan-snapshot");
  const first = await openStore(databasePath);
  const second = await openStore(databasePath);
  await first.transact({}, async (transaction) => {
    await transaction.put(key("scan-snapshot", "B"), { label: "initial" }, {});
    return null;
  });

  const database = new DatabaseSync(databasePath);
  database.prepare("INSERT INTO revisions DEFAULT VALUES").run();
  database
    .prepare(
      `
        INSERT INTO records(
          namespace,
          collection_name,
          record_id,
          record_id_order_key,
          value_json,
          revision
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      "unrelated-invalid",
      "examples",
      "broken",
      Buffer.from(stateStringOrderKey("broken")),
      '{"not":',
      2,
    );
  database.close();

  await first.transact({}, async (transaction) => {
    const scan = async () => {
      const labels = [];
      for await (const entry of transaction.scan<ExampleRecord>({
        namespace: "scan-snapshot",
        collection: "examples",
        limit: 1,
      })) {
        labels.push(entry.value.label);
      }
      return labels;
    };

    assert.deepEqual(await scan(), ["initial"]);
    await second.transact({}, async (otherTransaction) => {
      await otherTransaction.put(key("scan-snapshot", "A"), { label: "concurrent" }, {});
      return null;
    });
    assert.deepEqual(await scan(), ["initial"]);
    return null;
  });

  await first.close();
  await second.close();
});

test("transaction scans do not expand their SQL page for unrelated staged puts", async () => {
  const databasePath = await temporaryDatabase("scan-unrelated-staged-put");
  const initial = await openStore(databasePath);
  await initial.transact({}, async (transaction) => {
    await transaction.put(key("scan-page", "A"), { label: "first" }, {});
    return null;
  });
  await initial.close();

  const database = new DatabaseSync(databasePath);
  database.prepare("INSERT INTO revisions DEFAULT VALUES").run();
  database
    .prepare(
      `
        INSERT INTO records(
          namespace,
          collection_name,
          record_id,
          record_id_order_key,
          value_json,
          revision
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run("scan-page", "examples", "B", Buffer.from(stateStringOrderKey("B")), '{"not":', 2);
  database.close();

  const store = await openStore(databasePath);
  await store.transact({}, async (transaction) => {
    await transaction.put(key("unrelated-page", "staged"), { label: "unrelated" }, {});
    const labels = [];
    for await (const entry of transaction.scan<ExampleRecord>({
      namespace: "scan-page",
      collection: "examples",
      limit: 1,
    })) {
      labels.push(entry.value.label);
    }
    assert.deepEqual(labels, ["first"]);
    return null;
  });
  await store.close();
});

test("a failed SQLite open can be retried after repairing the path", async () => {
  const unusedDatabasePath = await temporaryDatabase("retry-open");
  const blockedDirectory = `${unusedDatabasePath}.blocked`;
  const databasePath = join(blockedDirectory, "state.sqlite");
  await writeFile(blockedDirectory, "not-a-directory");
  const store = new SqliteStateStore({ databasePath });

  await assert.rejects(store.open());
  await rm(blockedDirectory);
  await mkdir(blockedDirectory);
  await store.open();
  assert.equal((await store.health()).status, "healthy");
  await store.close();
});
