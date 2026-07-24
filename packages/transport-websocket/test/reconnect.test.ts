import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkerId, type ExecutionResult } from "@tegojs/contracts";
import { eventually, FakeClock } from "@tegojs/testkit";
import {
  MemoryRemoteAttemptStore,
  MemoryRemoteResultStore,
  RemoteExecutor,
  WorkerRuntime,
  requestFingerprint,
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
    assert.equal(
      local.attempts.has(`${request.taskId.length}:${request.taskId}${request.attemptId}`),
      true,
    ),
  );
  main.close();
  await flush();
  assert.equal((await local.observe(request.taskId, request.attemptId))?.state, "terminal");

  await reconnect(remote, runtime, "2");
  assert.equal((await handle.result).status, "cancelled");
  await Promise.all([remote.close(), runtime.close()]);
});

test("permanent disconnect settles Main attempts after the orphan recovery window", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    orphanTimeoutMs: 100,
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
  const request = executionRequest({ mode: "wait" }, "permanent-disconnect", "finish-and-buffer");
  const handle = await remote.submit(request);
  await eventually(() => assert.equal(local.executions, 1));
  main.close();
  await flush();
  clock.advanceBy(101);

  const result = await handle.result;
  assert.equal(result.status, "failed");
  assert.match(result.diagnostic?.code ?? "", /ORPHAN|UNAVAILABLE/iu);
  await remote.drain({});
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

test("Worker records acknowledgement before delegating to the local Executor", async () => {
  const clock = new FakeClock(new Date(0));
  const events: string[] = [];
  const local = new TestLocalExecutor();
  const originalSubmit = local.submit.bind(local);
  local.submit = async (request) => {
    events.push("execute");
    return originalSubmit(request);
  };
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore({
      onSave: (record) => events.push(`store:${record.state}`),
    }),
    selectExecutor: () => local,
  });
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  await reconnect(remote, runtime, "1");
  await (await remote.submit(executionRequest({ mode: "echo", value: "ordered" }, "worker-order")))
    .result;
  assert.ok(events.indexOf("store:acknowledged") < events.indexOf("execute"));
  await Promise.all([remote.close(), runtime.close()]);
});

test("disconnect before assignment delivery replays the same attempt only after inventory", async () => {
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
  const delivery = Promise.withResolvers<void>();
  main.gateNextMessage(delivery.promise);
  const request = executionRequest({ mode: "echo", value: "replayed" }, "pre-send");
  const handle = await remote.submit(request);
  main.close();
  delivery.resolve();
  await flush();
  assert.equal(local.executions, 0);

  await reconnect(remote, runtime, "2");
  assert.equal((await handle.result).output, "replayed");
  assert.equal(local.executions, 1);
  await Promise.all([remote.close(), runtime.close()]);
});

test("lost result acknowledgement retains one terminal result and duplicate inventory releases it", async () => {
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
  const originalSend = main.send.bind(main);
  let dropped = false;
  main.send = async (type, payload, options) => {
    if (
      type === "task.acknowledge" &&
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      "kind" in payload &&
      payload.kind === "result" &&
      !dropped
    ) {
      dropped = true;
      return "message-dropped-result-ack";
    }
    return originalSend(type, payload, options);
  };
  await runtime.attach(worker);
  await remote.attach(main);
  const result = await (
    await remote.submit(executionRequest({ mode: "echo", value: "once" }, "lost-result-ack"))
  ).result;
  assert.equal(result.output, "once");
  await eventually(() => assert.equal(runtime.bufferedResultCount, 1));

  await reconnect(remote, runtime, "2");
  await eventually(() => assert.equal(runtime.bufferedResultCount, 0));
  assert.equal(local.executions, 1);
  await Promise.all([remote.close(), runtime.close()]);
});

test("Worker reserves bounded terminal-result capacity before starting finish-and-buffer work", async () => {
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
    resultBuffer: { maxCount: 1, maxBytes: 40 * 1024 },
    selectExecutor: () => local,
  });
  await reconnect(remote, runtime, "1");
  const firstRequest = executionRequest({ mode: "wait" }, "buffer-slot-1", "finish-and-buffer");
  const secondRequest = executionRequest({ mode: "wait" }, "buffer-slot-2", "finish-and-buffer");
  const first = await remote.submit(firstRequest);
  const second = await remote.submit(secondRequest);
  try {
    for (let index = 0; index < 10; index += 1) await flush();
    assert.equal(local.executions, 1);
    const rejected = await second.result;
    assert.equal(rejected.status, "rejected");
    assert.match(rejected.diagnostic?.code ?? "", /BUFFER|ADMISSION/iu);
  } finally {
    await remote.cancel(firstRequest.taskId, firstRequest.attemptId);
    await remote.cancel(secondRequest.taskId, secondRequest.attemptId);
    await first.result;
    await second.result;
    await Promise.all([remote.close(), runtime.close()]);
  }
});

test("durable result write failure becomes a structured terminal failure", async () => {
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
    resultStore: {
      durable: true,
      put: async () => {
        throw new Error("durable result store unavailable");
      },
      delete: async () => undefined,
      list: async () => [],
    },
    selectExecutor: () => local,
  });
  await reconnect(remote, runtime, "1");
  const result = await (
    await remote.submit(
      executionRequest(
        { mode: "echo", value: "lost" },
        "persist-write-failure",
        "finish-and-persist",
      ),
    )
  ).result;
  assert.equal(result.status, "failed");
  assert.match(result.diagnostic?.code ?? "", /PERSIST/iu);
  assert.equal(local.executions, 1);
  await Promise.all([remote.close(), runtime.close()]);
});

test("failed durable result deletion keeps the memory result until a later acknowledgement succeeds", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const durable = new MemoryRemoteResultStore({ durable: true });
  let deletes = 0;
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
    resultStore: {
      durable: true,
      put: async (result) => durable.put(result),
      list: async () => durable.list(),
      delete: async (taskId, attemptId) => {
        deletes += 1;
        if (deletes === 1) throw new Error("durable delete unavailable");
        await durable.delete(taskId, attemptId);
      },
    },
    selectExecutor: () => local,
  });
  await reconnect(remote, runtime, "1");
  const result = await (
    await remote.submit(
      executionRequest({ mode: "echo", value: "retained" }, "delete-failure", "finish-and-persist"),
    )
  ).result;
  assert.equal(result.output, "retained");
  await eventually(() => assert.equal(deletes, 1));
  assert.equal(runtime.bufferedResultCount, 1);

  await reconnect(remote, runtime, "2");
  await eventually(() => assert.equal(runtime.bufferedResultCount, 0));
  assert.equal(deletes, 2);
  await Promise.all([remote.close(), runtime.close()]);
});

test("oversized reconnect inventory rejects attach instead of leaving a pending correlation", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const [main, worker] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    maxInventoryItems: 1,
    preparedArtifacts: () => ["sha256:first", "sha256:second"],
    selectExecutor: () => local,
  });
  await runtime.attach(worker);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  await assert.rejects(remote.attach(main), /inventory/iu);
  await runtime.close();
});

test("inventory provider failure rejects attach instead of leaving a pending correlation", async () => {
  const clock = new FakeClock(new Date(0));
  const [main, worker] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    preparedArtifacts: () => {
      throw new Error("artifact inventory unavailable");
    },
    selectExecutor: () => new TestLocalExecutor(),
  });
  await runtime.attach(worker);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  await assert.rejects(remote.attach(main), /inventory/iu);
  await runtime.close();
});

test("acknowledged terminal attempts expire under the configured retention bound", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    maxAssignments: 1,
    retentionMs: 100,
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    maxAssignments: 1,
    retentionMs: 100,
    selectExecutor: () => local,
  });
  await reconnect(remote, runtime, "1");
  const firstRequest = executionRequest({ mode: "echo", value: "first" }, "retention-first");
  assert.equal((await (await remote.submit(firstRequest)).result).output, "first");
  await eventually(() => assert.equal(runtime.bufferedResultCount, 0));
  clock.advanceBy(101);
  await flush();

  const secondRequest = executionRequest({ mode: "echo", value: "second" }, "retention-second");
  assert.equal((await (await remote.submit(secondRequest)).result).output, "second");
  assert.equal(await remote.observe(firstRequest.taskId, firstRequest.attemptId), undefined);
  assert.equal(local.executions, 2);
  await Promise.all([remote.close(), runtime.close()]);
});

test("concurrent duplicate submit waits for one persisted assignment and returns one handle", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const saveGate = Promise.withResolvers<void>();
  const backing = new MemoryRemoteAttemptStore();
  let assignedSaves = 0;
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: {
      save: async (record) => {
        if (record.state === "assigned") {
          assignedSaves += 1;
          await saveGate.promise;
        }
        await backing.save(record);
      },
      delete: async (taskId, attemptId) => backing.delete(taskId, attemptId),
      load: async (taskId, attemptId) => backing.load(taskId, attemptId),
      list: async (id) => backing.list(id),
    },
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  await reconnect(remote, runtime, "1");
  const request = executionRequest({ mode: "wait" }, "concurrent-duplicate");
  const firstPromise = remote.submit(request);
  const secondPromise = remote.submit(request);
  saveGate.resolve();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  try {
    assert.strictEqual(second, first);
    assert.equal(assignedSaves, 1);
    await eventually(() => assert.equal(local.executions, 1));
  } finally {
    await remote.cancel(request.taskId, request.attemptId);
    await second.result;
    await Promise.all([remote.close(), runtime.close()]);
  }
});

test("late rejection from a stale assignment cannot roll back the reconciled epoch", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const mainStore = new MemoryRemoteAttemptStore();
  const remote = new RemoteExecutor({ id: "remote", workerId, clock, attemptStore: mainStore });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  const [oldMain, oldWorker] = memorySessionPair("1");
  await runtime.attach(oldWorker);
  await remote.attach(oldMain);
  const oldRequest = oldMain.request.bind(oldMain);
  const staleAssignment = Promise.withResolvers<never>();
  oldMain.request = (type, payload) =>
    type === "task.assign" ? staleAssignment.promise : oldRequest(type, payload);
  const request = executionRequest({ mode: "wait" }, "stale-assignment");
  const handle = await remote.submit(request);
  await reconnect(remote, runtime, "2");
  await eventually(() => assert.equal(local.executions, 1));
  staleAssignment.reject(new Error("stale session rejected"));
  await flush();

  const record = await mainStore.load(request.taskId, request.attemptId);
  assert.equal(record?.epoch, "2");
  assert.equal(record?.state, "running");
  await remote.cancel(request.taskId, request.attemptId);
  await handle.result;
  await Promise.all([remote.close(), runtime.close()]);
});

test("retention tombstone failure keeps terminal identity in memory", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const backing = new MemoryRemoteAttemptStore();
  let tombstones = 0;
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    maxAssignments: 1,
    retentionMs: 100,
    attemptStore: {
      save: async (record) => {
        if (record.state === "expired") {
          tombstones += 1;
          throw new Error(
            `tombstone unavailable for ${record.request.taskId}/${record.request.attemptId}`,
          );
        }
        await backing.save(record);
      },
      load: async (taskId, attemptId) => backing.load(taskId, attemptId),
      list: async (id) => backing.list(id),
    },
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    retentionMs: 100,
    selectExecutor: () => local,
  });
  await reconnect(remote, runtime, "1");
  const firstRequest = executionRequest({ mode: "echo", value: "first" }, "delete-retention");
  await (await remote.submit(firstRequest)).result;
  await eventually(() => assert.equal(runtime.bufferedResultCount, 0));
  clock.advanceBy(101);

  await assert.rejects(
    remote.submit(executionRequest({ mode: "echo", value: "second" }, "delete-retention-next")),
    /tombstone unavailable/iu,
  );
  assert.equal(tombstones, 1);
  assert.equal(
    (await remote.observe(firstRequest.taskId, firstRequest.attemptId))?.state,
    "terminal",
  );
  await Promise.all([remote.close(), runtime.close()]);
});

test("duplicate terminal result cannot acknowledge Worker evidence before Main persistence commits", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const backing = new MemoryRemoteAttemptStore();
  const terminalSaveStarted = Promise.withResolvers<void>();
  const terminalSaveGate = Promise.withResolvers<void>();
  let terminalResult: ExecutionResult | undefined;
  const [main, worker] = memorySessionPair("1");
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: {
      save: async (record) => {
        if (record.state === "terminal") {
          terminalResult = record.result;
          terminalSaveStarted.resolve();
          await terminalSaveGate.promise;
        }
        await backing.save(record);
      },
      delete: async (taskId, attemptId) => backing.delete(taskId, attemptId),
      load: async (taskId, attemptId) => backing.load(taskId, attemptId),
      list: async (id) => backing.list(id),
    },
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  await runtime.attach(worker);
  await remote.attach(main);
  const request = executionRequest({ mode: "echo", value: "barrier" }, "publication-barrier");
  const handle = await remote.submit(request);
  await terminalSaveStarted.promise;
  if (terminalResult === undefined) throw new Error("terminal result was not captured");
  let settled = false;
  void handle.result.then(() => {
    settled = true;
  });
  await worker.send("task.result", { result: terminalResult });
  await flush();
  assert.equal(settled, false);
  assert.equal(runtime.bufferedResultCount, 1);

  terminalSaveGate.resolve();
  assert.equal((await handle.result).output, "barrier");
  await eventually(() => assert.equal(runtime.bufferedResultCount, 0));
  await Promise.all([remote.close(), runtime.close()]);
});

test("cancel is latched while the Worker is still selecting a local Executor", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const selected = Promise.withResolvers<void>();
  const selectorGate = Promise.withResolvers<void>();
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
    selectExecutor: async () => {
      selected.resolve();
      await selectorGate.promise;
      return local;
    },
  });
  await reconnect(remote, runtime, "1");
  const request = executionRequest({ mode: "wait" }, "cancel-selecting");
  const handle = await remote.submit(request);
  await selected.promise;
  await remote.cancel(request.taskId, request.attemptId);
  selectorGate.resolve();

  assert.equal((await handle.result).status, "cancelled");
  assert.equal(local.executions, 0);
  await Promise.all([remote.close(), runtime.close()]);
});

test("a restarted Worker terminates uncertain finish-and-buffer work without re-execution", async () => {
  const clock = new FakeClock(new Date(0));
  const request = executionRequest(
    { mode: "echo", value: "recovered" },
    "worker-restart",
    "finish-and-buffer",
  );
  const workerStore = new MemoryRemoteAttemptStore();
  await workerStore.save({
    workerId,
    request,
    fingerprint: requestFingerprint(request),
    state: "running",
    epoch: "4",
    updatedAt: clock.now().toISOString(),
  });
  const local = new TestLocalExecutor();
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: workerStore,
    selectExecutor: () => local,
  });
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });

  await reconnect(remote, runtime, "5");
  await eventually(async () =>
    assert.equal((await workerStore.load(request.taskId, request.attemptId))?.state, "terminal"),
  );
  const recovered = await workerStore.load(request.taskId, request.attemptId);
  assert.equal(recovered?.state, "terminal");
  assert.equal(recovered?.result?.status, "failed");
  assert.equal(local.executions, 0);
  await Promise.all([remote.close(), runtime.close()]);
});

test("expired terminal attempts remain deduplicated and cannot execute again", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const store = new MemoryRemoteAttemptStore();
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: store,
    retentionMs: 100,
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    retentionMs: 100,
    selectExecutor: () => local,
  });
  await reconnect(remote, runtime, "1");
  const request = executionRequest({ mode: "echo", value: "once" }, "expired-identity");
  assert.equal((await (await remote.submit(request)).result).output, "once");
  await eventually(() => assert.equal(runtime.bufferedResultCount, 0));
  clock.advanceBy(101);

  await assert.rejects(remote.submit(request), /expired|retention/iu);
  assert.equal(local.executions, 1);
  assert.equal((await store.load(request.taskId, request.attemptId))?.state, "expired");
  await Promise.all([remote.close(), runtime.close()]);
});

test("persisted attempt epochs fence stale sessions after Main restart", async () => {
  const clock = new FakeClock(new Date(0));
  const request = executionRequest({ mode: "wait" }, "persisted-epoch");
  const store = new MemoryRemoteAttemptStore();
  await store.save({
    workerId,
    request,
    fingerprint: "persisted-fingerprint",
    state: "assigned",
    epoch: "7",
    updatedAt: clock.now().toISOString(),
  });
  const remote = new RemoteExecutor({ id: "remote", workerId, clock, attemptStore: store });
  const [stale] = memorySessionPair("6");

  await assert.rejects(remote.attach(stale), /epoch|stale/iu);
});

test("a correlated assignment result must match the assigned attempt identity", async () => {
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
  const originalRequest = main.request.bind(main);
  const assigned = executionRequest({ mode: "wait" }, "identity-a");
  const forged = executionRequest({ mode: "wait" }, "identity-b");
  main.request = async (type, payload) => {
    if (type !== "task.assign") return originalRequest(type, payload);
    const now = clock.now().toISOString();
    return {
      messageId: "forged-result",
      correlationId: "assignment",
      type: "task.acknowledge",
      payload: {
        accepted: false,
        result: {
          taskId: forged.taskId,
          attemptId: forged.attemptId,
          status: "rejected",
          executor: { kind: "remote", workerId },
          startedAt: now,
          completedAt: now,
        },
      },
    };
  };

  const handle = await remote.submit(assigned);
  const result = await handle.result;
  assert.equal(result.status, "failed");
  assert.match(result.diagnostic?.code ?? "", /IDENTITY/iu);
  await Promise.all([remote.close(), runtime.close()]);
});

test("drain observes a submit whose durable assignment save is still in progress", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const backing = new MemoryRemoteAttemptStore();
  const saveStarted = Promise.withResolvers<void>();
  const saveGate = Promise.withResolvers<void>();
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: {
      save: async (record) => {
        if (record.state === "assigned") {
          saveStarted.resolve();
          await saveGate.promise;
        }
        await backing.save(record);
      },
      load: async (taskId, attemptId) => backing.load(taskId, attemptId),
      list: async (id) => backing.list(id),
    },
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  await reconnect(remote, runtime, "1");
  const request = executionRequest({ mode: "wait" }, "drain-submit-race");
  const submitted = remote.submit(request);
  await saveStarted.promise;
  let drained = false;
  const draining = remote
    .drain({ deadline: new Date(clock.now().getTime() + 100).toISOString() })
    .then(() => {
      drained = true;
    });
  saveGate.resolve();
  await submitted;
  assert.equal(drained, false);
  clock.advanceBy(101);
  await draining;
  assert.equal(local.active, 0);
  await Promise.all([remote.close(), runtime.close()]);
});

test("Worker rejects an assignment whose expired tombstone exists only in durable state", async () => {
  const clock = new FakeClock(new Date(0));
  const request = executionRequest({ mode: "echo", value: "never" }, "worker-tombstone");
  const store = new MemoryRemoteAttemptStore();
  await store.save({
    workerId,
    request,
    fingerprint: requestFingerprint(request),
    state: "expired",
    epoch: "1",
    updatedAt: clock.now().toISOString(),
  });
  const local = new TestLocalExecutor();
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: store,
    selectExecutor: () => local,
  });
  const [main, worker] = memorySessionPair("2");
  await runtime.attach(worker);

  const response = await main.request("task.assign", { request });
  assert.equal(
    typeof response.payload === "object" &&
      response.payload !== null &&
      !Array.isArray(response.payload) &&
      "accepted" in response.payload &&
      response.payload.accepted,
    false,
  );
  assert.equal(local.executions, 0);
  await runtime.close();
});

test("late buffered Worker evidence cannot block reconnect after Main orphan settlement", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    orphanTimeoutMs: 100,
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
    { mode: "echo", value: "late-success" },
    "late-after-orphan",
    "finish-and-buffer",
  );
  main.gateNextMessage(Promise.resolve());
  const handle = await remote.submit(request);
  await flush();
  main.close();
  await eventually(() => assert.equal(runtime.bufferedResultCount, 1));
  await flush();
  clock.advanceBy(101);
  assert.equal((await handle.result).status, "failed");

  await reconnect(remote, runtime, "2");
  await eventually(() => assert.equal(runtime.bufferedResultCount, 0));
  await Promise.all([remote.close(), runtime.close()]);
});

test("durable terminal evidence wins over an uncertain running record after Worker restart", async () => {
  const clock = new FakeClock(new Date(0));
  const request = executionRequest(
    { mode: "echo", value: "must-not-run" },
    "durable-before-attempt-save",
    "finish-and-persist",
  );
  const workerStore = new MemoryRemoteAttemptStore();
  await workerStore.save({
    workerId,
    request,
    fingerprint: requestFingerprint(request),
    state: "running",
    epoch: "3",
    updatedAt: clock.now().toISOString(),
  });
  const now = clock.now().toISOString();
  const durable = new MemoryRemoteResultStore({ durable: true });
  await durable.put({
    taskId: request.taskId,
    attemptId: request.attemptId,
    status: "succeeded",
    output: "durable",
    executor: { kind: "remote", workerId },
    startedAt: now,
    completedAt: now,
  });
  const local = new TestLocalExecutor();
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: workerStore,
    resultStore: durable,
    selectExecutor: () => local,
  });
  const [main, worker] = memorySessionPair("4");
  await runtime.attach(worker);

  const response = await main.request("session.reconcile", { workerId, epoch: "4" });
  assert.equal(local.executions, 0);
  assert.equal(
    typeof response.payload === "object" &&
      response.payload !== null &&
      !Array.isArray(response.payload) &&
      "terminalUnacknowledged" in response.payload &&
      Array.isArray(response.payload.terminalUnacknowledged),
    true,
  );
  assert.equal((await workerStore.load(request.taskId, request.attemptId))?.state, "terminal");
  await runtime.close();
});

test("expired tombstones do not consume active restart inventory capacity", async () => {
  const clock = new FakeClock(new Date(0));
  const store = new MemoryRemoteAttemptStore();
  for (let index = 0; index < 513; index += 1) {
    const request = executionRequest(null, `historical-${index}`);
    await store.save({
      workerId,
      request,
      fingerprint: requestFingerprint(request),
      state: "expired",
      epoch: "1",
      updatedAt: clock.now().toISOString(),
    });
  }
  const remote = new RemoteExecutor({ id: "remote", workerId, clock, attemptStore: store });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: store,
    selectExecutor: () => new TestLocalExecutor(),
  });

  await reconnect(remote, runtime, "2");
  await Promise.all([remote.close(), runtime.close()]);
});

test("Worker rejects a result buffer that cannot fit in one recovery inventory", () => {
  const clock = new FakeClock(new Date(0));
  assert.throws(
    () =>
      new WorkerRuntime({
        workerId,
        clock,
        attemptStore: new MemoryRemoteAttemptStore(),
        maxInventoryBytes: 48 * 1024,
        resultBuffer: { maxBytes: 48 * 1024 },
        selectExecutor: () => new TestLocalExecutor(),
      }),
    /inventory|buffer|bytes/iu,
  );
});

test("Worker rewrites a local Executor result with the wrong attempt identity", async () => {
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const forged = executionRequest(null, "forged-local-result");
  local.submit = async (request) => ({
    taskId: request.taskId,
    attemptId: request.attemptId,
    result: Promise.resolve({
      taskId: forged.taskId,
      attemptId: forged.attemptId,
      status: "succeeded",
      output: "wrong",
      executor: { kind: "process" },
      startedAt: clock.now().toISOString(),
      completedAt: clock.now().toISOString(),
    }),
  });
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
  const request = executionRequest({ mode: "echo", value: "right" }, "local-result-identity");
  const result = await (await remote.submit(request)).result;

  assert.equal(result.taskId, request.taskId);
  assert.equal(result.attemptId, request.attemptId);
  assert.equal(result.status, "failed");
  assert.match(result.diagnostic?.code ?? "", /IDENTITY/iu);
  await Promise.all([remote.close(), runtime.close()]);
});
