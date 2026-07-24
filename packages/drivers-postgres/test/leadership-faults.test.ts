import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { diagnosticCode } from "@tegojs/contracts";
import { PostgresCoordinationProvider, PostgresStateStore } from "../src/index.js";

const connectionString = process.env.TEGO_POSTGRES_URL;
if (connectionString === undefined) {
  throw new Error("TEGO_POSTGRES_URL is required");
}

function namespace(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

test("leader connection death releases authority and fences the stale writer", async () => {
  const sharedNamespace = namespace("takeover");
  const firstCoordination = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  const secondCoordination = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  const staleState = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  const currentState = new PostgresStateStore({
    connectionString,
    namespace: sharedNamespace,
  });
  await Promise.all([
    firstCoordination.open(),
    secondCoordination.open(),
    staleState.open(),
    currentState.open(),
  ]);
  try {
    const first = await firstCoordination.campaign({ resource: "runtime" });
    const takeover = secondCoordination.campaign({ resource: "runtime" });
    await firstCoordination.close();
    const second = await takeover;
    assert.ok(BigInt(second.epoch) > BigInt(first.epoch));

    await currentState.transact(
      { fencing: { resource: "runtime", epoch: second.epoch } },
      async (transaction) => {
        await transaction.put(
          { namespace: "runtime", collection: "authority", id: "current" },
          { epoch: second.epoch },
          { expectedRevision: "absent" },
        );
        return null;
      },
    );
    await assert.rejects(
      staleState.transact(
        { fencing: { resource: "runtime", epoch: first.epoch } },
        async (transaction) => {
          await transaction.put(
            { namespace: "runtime", collection: "authority", id: "stale" },
            { epoch: first.epoch },
            { expectedRevision: "absent" },
          );
          return null;
        },
      ),
      (error: unknown) => diagnosticCode(error) === "STATE_FENCE_STALE",
    );
  } finally {
    await Promise.all([
      firstCoordination.close(),
      secondCoordination.close(),
      staleState.close(),
      currentState.close(),
    ]);
  }
});

test("watch catches up after notification delivery is interrupted", async () => {
  const sharedNamespace = namespace("notify");
  const writer = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  const watcher = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  await Promise.all([writer.open(), watcher.open()]);
  try {
    const iterator = watcher.watch({ cursor: "0" })[Symbol.asyncIterator]();
    await watcher.interruptNotificationsForTest();
    const committed = await writer.compareAndSet({
      key: "during-pause",
      expectedRevision: "absent",
      value: { durable: true },
    });
    assert.equal(committed.applied, true);
    assert.deepEqual(await iterator.next(), {
      done: false,
      value: {
        key: "during-pause",
        revision: committed.revision,
        value: { durable: true },
      },
    });
    await iterator.return?.();
  } finally {
    await Promise.all([writer.close(), watcher.close()]);
  }
});
