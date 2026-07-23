import assert from "node:assert/strict";
import { rm, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  diagnosticCode,
  parseFencingEpoch,
  parseOperationId,
  parseRevision,
  type JsonObject,
  type OperationJournalEntry,
  type StateKey,
} from "@tegojs/contracts";
import { stateStoreConformance } from "@tegojs/testkit";
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
  assert.deepEqual(await second.readOperation(operation.operationId), operation);
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
  assert.equal(
    (await reopened.readOperation(parseOperationId("operation-crash")))?.status,
    "executing",
  );
  await reopened.close();
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
    assert.deepEqual(migrations, [1]);
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
      "INSERT INTO records(namespace, collection_name, record_id, value_json, revision) VALUES (?, ?, ?, ?, ?)",
    )
    .run("invalid", "examples", "record", '{"not":', 1);
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
