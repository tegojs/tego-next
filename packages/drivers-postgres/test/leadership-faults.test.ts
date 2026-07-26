import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setImmediate as yieldToEventLoop, setTimeout as delay } from "node:timers/promises";
import { diagnosticCode, parseRevision } from "@tegojs/contracts";
import { Pool } from "pg";
import { PostgresCoordinationProvider, PostgresStateStore } from "../src/index.js";

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

async function terminateLeadershipBackend(sharedNamespace: string): Promise<void> {
  const admin = new Pool({ connectionString });
  try {
    const result = await admin.query<{ terminated: boolean }>(
      `SELECT pg_terminate_backend(activity.pid) AS terminated
         FROM pg_stat_activity AS activity
        WHERE activity.application_name = $1
          AND activity.pid <> pg_backend_pid()
          AND EXISTS (
            SELECT 1
              FROM pg_locks AS locks
             WHERE locks.pid = activity.pid
               AND locks.locktype = 'advisory'
               AND locks.granted
          )`,
      [`tego:${sharedNamespace}:coordination`.slice(0, 63)],
    );
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0]?.terminated, true);
  } finally {
    await admin.end();
  }
}

async function terminateNotificationBackends(sharedNamespace: string): Promise<void> {
  const admin = new Pool({ connectionString });
  try {
    const result = await admin.query<{ terminated: boolean }>(
      `SELECT pg_terminate_backend(activity.pid) AS terminated
         FROM pg_stat_activity AS activity
        WHERE activity.application_name = $1
          AND activity.pid <> pg_backend_pid()
          AND activity.query = $2`,
      [`tego:${sharedNamespace}:coordination`.slice(0, 63), "LISTEN tego_coordination_changes"],
    );
    assert.ok((result.rowCount ?? 0) >= 1);
    assert.ok(result.rows.every((row) => row.terminated));
  } finally {
    await admin.end();
  }
}

async function waitForAdvisoryWaiterCount(
  sharedNamespace: string,
  expected: number,
  timeoutMs = 2_000,
): Promise<void> {
  const admin = new Pool({ connectionString });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const result = await admin.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting
           FROM pg_stat_activity AS activity
           JOIN pg_locks AS locks ON locks.pid = activity.pid
          WHERE activity.application_name = $1
            AND locks.locktype = 'advisory'
            AND NOT locks.granted`,
        [`tego:${sharedNamespace}:coordination`.slice(0, 63)],
      );
      if (result.rows[0]?.waiting === String(expected)) return;
      await yieldToEventLoop();
    }
    throw new Error(`Timed out waiting for ${expected} blocked leadership campaigns`);
  } finally {
    await admin.end();
  }
}

async function coordinationBackendCount(sharedNamespace: string): Promise<number> {
  const admin = new Pool({ connectionString });
  try {
    const result = await admin.query<{ connections: string }>(
      `SELECT count(*)::text AS connections
         FROM pg_stat_activity AS activity
        WHERE activity.application_name = $1`,
      [`tego:${sharedNamespace}:coordination`.slice(0, 63)],
    );
    return Number(result.rows[0]?.connections ?? "-1");
  } finally {
    await admin.end();
  }
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
    await terminateLeadershipBackend(sharedNamespace);
    const second = await within(takeover, "Timed out waiting for leadership takeover");
    assert.ok(BigInt(second.leadership.epoch) > BigInt(first.leadership.epoch));

    const staleKey = { namespace: "runtime", collection: "authority", id: "stale" };
    await assert.rejects(
      staleState.transact(
        { fencing: { resource: "runtime", epoch: first.leadership.epoch } },
        async (transaction) => {
          await transaction.put(
            staleKey,
            { epoch: first.leadership.epoch },
            { expectedRevision: "absent" },
          );
          return null;
        },
      ),
      (error: unknown) => diagnosticCode(error) === "STATE_FENCE_STALE",
    );
    assert.equal(await staleState.read(staleKey), undefined);

    await currentState.transact(
      { fencing: { resource: "runtime", epoch: second.leadership.epoch } },
      async (transaction) => {
        await transaction.put(
          { namespace: "runtime", collection: "authority", id: "current" },
          { epoch: second.leadership.epoch },
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

test("@spec:coordination-provider/fenced-leadership/observable-loss", async () => {
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

    await terminateLeadershipBackend(sharedNamespace);

    const diagnostic = await within(first.lost, "Timed out waiting for leadership loss");
    assert.equal(diagnostic.code, "COORDINATION_LEADERSHIP_LOST");
    assert.equal(diagnostic.retryable, true);

    const second = await within(takeover, "Timed out waiting for the advisory lock to release");
    assert.ok(BigInt(second.leadership.epoch) > BigInt(first.leadership.epoch));

    const reacquisition = firstCoordination.campaign({ resource: "runtime" });

    await secondCoordination.close();
    const third = await within(reacquisition, "Timed out waiting for the terminated provider");
    assert.ok(BigInt(third.leadership.epoch) > BigInt(second.leadership.epoch));
    assert.equal("terminateLeadershipConnectionForTest" in firstCoordination, false);
    assert.equal("interruptNotificationsForTest" in firstCoordination, false);
    assert.equal("scanChanges" in firstCoordination, false);
    assert.equal("removeWatch" in firstCoordination, false);
  } finally {
    await Promise.all([firstCoordination.close(), secondCoordination.close()]);
  }
});

test("@spec:coordination-provider/fenced-leadership/close-during-acquisition", async () => {
  const sharedNamespace = namespace("close_acquiring");
  const providerA = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  const providerB = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  await Promise.all([providerA.open(), providerB.open()]);
  const first = await providerA.campaign({ resource: "runtime" });
  const pending = providerB.campaign({ resource: "runtime" });
  const pendingOutcome = pending.then(
    () => {
      throw new Error("Blocked leadership campaign unexpectedly acquired leadership");
    },
    (error: unknown) => error,
  );
  try {
    await waitForAdvisoryWaiterCount(sharedNamespace, 1);
    await within(providerB.close(), "Timed out closing a provider with a pending campaign");
    const error = await within(pendingOutcome, "Timed out settling the pending campaign");
    assert.ok(error instanceof Error);
    await waitForAdvisoryWaiterCount(sharedNamespace, 0);
  } finally {
    await within(first.release(), "Timed out releasing the held leadership");
    await Promise.all([providerA.close(), providerB.close()]);
  }
});

test("@spec:coordination-provider/fenced-leadership/close-while-campaign-waits-for-pool", async () => {
  const sharedNamespace = namespace("close_pool_waiter");
  const providerA = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  const providerB = new PostgresCoordinationProvider({
    connectionString,
    namespace: sharedNamespace,
  });
  await Promise.all([providerA.open(), providerB.open()]);
  const held = await providerA.campaign({ resource: "contended" });
  await Promise.all(
    Array.from({ length: 19 }, (_, index) =>
      providerB.campaign({ resource: `pool-filler:${index}` }),
    ),
  );
  assert.equal(await coordinationBackendCount(sharedNamespace), 22);

  const pending = providerB.campaign({ resource: "contended" });
  const pendingOutcome = pending.then(
    () => {
      throw new Error("Pool-blocked campaign unexpectedly acquired leadership");
    },
    (error: unknown) => error,
  );
  await waitForAdvisoryWaiterCount(sharedNamespace, 0);
  const closePromise = providerB.close();
  try {
    await within(closePromise, "Timed out closing a provider with a pool-blocked campaign", 500);
    const error = await within(pendingOutcome, "Timed out settling the pool-blocked campaign");
    assert.equal(diagnosticCode(error), "COORDINATION_CLOSED");
    await waitForAdvisoryWaiterCount(sharedNamespace, 0);
  } finally {
    await within(held.release(), "Timed out releasing the contended leadership");
    await Promise.all([closePromise, providerA.close(), providerB.close()]);
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
    await terminateNotificationBackends(sharedNamespace);
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
