import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { diagnosticCode, parseRevision } from "@tegojs/contracts";
import { PostgresCoordinationProvider, PostgresStateStore } from "../src/index.js";

const connectionString = process.env.TEGO_POSTGRES_URL;
if (connectionString === undefined) {
  throw new Error("TEGO_POSTGRES_URL is required");
}

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

test("a stale leader is fenced immediately after takeover before the new leader writes state", async () => {
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
    await firstCoordination.terminateLeadershipConnectionForTest("runtime");
    const second = await within(takeover, "Timed out waiting for leadership takeover");
    assert.ok(BigInt(second.epoch) > BigInt(first.epoch));

    const staleKey = { namespace: "runtime", collection: "authority", id: "stale" };
    await assert.rejects(
      staleState.transact(
        { fencing: { resource: "runtime", epoch: first.epoch } },
        async (transaction) => {
          await transaction.put(staleKey, { epoch: first.epoch }, { expectedRevision: "absent" });
          return null;
        },
      ),
      (error: unknown) => diagnosticCode(error) === "STATE_FENCE_STALE",
    );
    assert.equal(await staleState.read(staleKey), undefined);

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
  } finally {
    await Promise.all([
      firstCoordination.close(),
      secondCoordination.close(),
      staleState.close(),
      currentState.close(),
    ]);
  }
});

test("unexpected leadership backend termination releases the advisory lock with a higher epoch", async () => {
  const sharedNamespace = namespace("backend_death");
  const firstCoordination = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  const secondCoordination = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  await Promise.all([firstCoordination.open(), secondCoordination.open()]);
  try {
    const first = await firstCoordination.campaign({ resource: "runtime" });
    const takeover = secondCoordination.campaign({ resource: "runtime" });

    await firstCoordination.terminateLeadershipConnectionForTest("runtime");

    const second = await within(takeover, "Timed out waiting for the advisory lock to release");
    assert.ok(BigInt(second.epoch) > BigInt(first.epoch));
  } finally {
    await Promise.all([firstCoordination.close(), secondCoordination.close()]);
  }
});

test("a pending watch catches up in exact order after notification interruption without duplicates", async () => {
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
    const iterator = watcher.watch({ cursor: parseRevision("0") })[Symbol.asyncIterator]();
    const firstPending = iterator.next();
    await watcher.interruptNotificationsForTest();
    const committed = [];
    for (const sequence of [1, 2, 3]) {
      const result = await writer.compareAndSet({
        key: `during-pause-${sequence}`,
        expectedRevision: "absent",
        value: { sequence },
      });
      assert.equal(result.applied, true);
      committed.push(result);
    }

    const observed = [
      await within(firstPending, "Timed out waiting for the first recovered watch change"),
      await within(iterator.next(), "Timed out waiting for the second recovered watch change"),
      await within(iterator.next(), "Timed out waiting for the third recovered watch change"),
    ];
    assert.deepEqual(
      observed,
      committed.map((result, index) => ({
        done: false,
        value: {
          key: `during-pause-${index + 1}`,
          revision: result.revision,
          value: { sequence: index + 1 },
        },
      })),
    );

    let duplicateSettled = false;
    const duplicate = iterator.next().then((result) => {
      duplicateSettled = true;
      return result;
    });
    await delay(100);
    assert.equal(duplicateSettled, false);
    await iterator.return?.();
    assert.deepEqual(await duplicate, { done: true, value: undefined });
  } finally {
    await Promise.all([writer.close(), watcher.close()]);
  }
});
