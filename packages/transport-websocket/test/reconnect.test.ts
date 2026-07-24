import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkerId } from "@tegojs/contracts";
import { eventually, FakeClock } from "@tegojs/testkit";
import {
  MemoryRemoteAttemptStore,
  MemoryRemoteResultStore,
  RemoteExecutor,
  WorkerRuntime,
} from "../src/index.js";
import {
  executionRequest,
  flush,
  memorySessionPair,
  TestLocalExecutor,
} from "./remote-test-support.js";

const workerId = parseWorkerId("worker-reconnect");

async function reconnect(
  remote: RemoteExecutor,
  runtime: WorkerRuntime,
  epoch: string,
): Promise<void> {
  const [main, worker] = memorySessionPair(epoch);
  await runtime.attach(worker);
  await remote.attach(main);
}

test("duplicate assignment after reconnect reuses one local attempt", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const mainStore = new MemoryRemoteAttemptStore();
  const workerStore = new MemoryRemoteAttemptStore();
  const remote = new RemoteExecutor({ id: "remote", workerId, clock, attemptStore: mainStore });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: workerStore,
    selectExecutor: () => local,
  });
  await reconnect(remote, runtime, "1");
  const request = executionRequest({ mode: "wait" }, "duplicate");
  const handle = await remote.submit(request);
  await eventually(() => assert.equal(local.executions, 1));

  await reconnect(remote, runtime, "2");
  const duplicate = await remote.submit(request);
  assert.strictEqual(duplicate, handle);
  assert.equal(local.executions, 1);
  await remote.cancel(request.taskId, request.attemptId);
  assert.equal((await handle.result).status, "cancelled");
  await Promise.all([remote.close(), runtime.close()]);
});

test("cancel orphan policy cancels locally and preserves terminal evidence for reconnect", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  const [main, worker] = memorySessionPair("1");
  await runtime.attach(worker);
  await remote.attach(main);
  const request = executionRequest({ mode: "wait" }, "cancel-orphan", "cancel");
  const handle = await remote.submit(request);
  await eventually(() =>
    assert.equal(local.attempts.has(`${request.taskId.length}:${request.taskId}${request.attemptId}`), true),
  );
  main.close();
  await flush();
  assert.equal((await local.observe(request.taskId, request.attemptId))?.state, "terminal");

  await reconnect(remote, runtime, "2");
  assert.equal((await handle.result).status, "cancelled");
  await Promise.all([remote.close(), runtime.close()]);
});

test("finish-and-buffer completes offline and releases only after Main acknowledgement", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  const [main, worker] = memorySessionPair("1");
  await runtime.attach(worker);
  await remote.attach(main);
  const request = executionRequest(
    { mode: "echo", value: "buffered" },
    "buffered",
    "finish-and-buffer",
  );
  main.gateNextMessage(Promise.resolve());
  const handle = await remote.submit(request);
  await flush();
  main.close();
  await eventually(() => assert.equal(runtime.bufferedResultCount, 1));

  await reconnect(remote, runtime, "2");
  assert.equal((await handle.result).output, "buffered");
  await flush();
  assert.equal(runtime.bufferedResultCount, 0);
  await Promise.all([remote.close(), runtime.close()]);
});

test("finish-and-persist rejects without a durable result boundary", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  await reconnect(remote, runtime, "1");
  const result = await (
    await remote.submit(
      executionRequest({ mode: "echo", value: "nope" }, "persist-missing", "finish-and-persist"),
    )
  ).result;
  assert.equal(result.status, "rejected");
  assert.match(result.diagnostic?.code ?? "", /PERSIST/iu);
  assert.equal(local.executions, 0);
  await Promise.all([remote.close(), runtime.close()]);
});

test("finish-and-persist recovers terminal result from an injected durable store", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const results = new MemoryRemoteResultStore({ durable: true });
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    resultStore: results,
    selectExecutor: () => local,
  });
  const [main, worker] = memorySessionPair("1");
  await runtime.attach(worker);
  await remote.attach(main);
  const request = executionRequest(
    { mode: "echo", value: "persisted" },
    "persisted",
    "finish-and-persist",
  );
  const handle = await remote.submit(request);
  await flush();
  main.close();
  await eventually(async () => assert.equal((await results.list()).length, 1));

  await reconnect(remote, runtime, "2");
  assert.equal((await handle.result).output, "persisted");
  await flush();
  assert.equal((await results.list()).length, 0);
  await Promise.all([remote.close(), runtime.close()]);
});

test("stale session results cannot override a newer authoritative epoch", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  const [staleMain, staleWorker] = memorySessionPair("1");
  await runtime.attach(staleWorker);
  await remote.attach(staleMain);
  await reconnect(remote, runtime, "2");
  await assert.rejects(remote.attach(staleMain), /epoch|stale/iu);
  await Promise.all([remote.close(), runtime.close()]);
});
