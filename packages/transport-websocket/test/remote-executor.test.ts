import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseWorkerId, type JsonValue } from "@tegojs/contracts";
import {
  executorConformance,
  eventually,
  FakeClock,
  type ExecutorCleanupRaceFixture,
  type ExecutorConformanceFixture,
} from "@tegojs/testkit";
import {
  MemoryRemoteAttemptStore,
  RemoteExecutor,
  WorkerRuntime,
  type RemoteExecutorOptions,
} from "../src/index.js";
import {
  executionRequest,
  flush,
  memorySessionPair,
  TestLocalExecutor,
} from "./remote-test-support.js";

const clock = new FakeClock(new Date(0));
const workerId = parseWorkerId("worker-remote");
const cleanups: Array<() => Promise<void>> = [];
let currentLocal: TestLocalExecutor | undefined;

async function connected(
  options: Partial<RemoteExecutorOptions> = {},
  local = new TestLocalExecutor(),
): Promise<{ remote: RemoteExecutor; runtime: WorkerRuntime; local: TestLocalExecutor }> {
  const [mainSession, workerSession] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote-worker",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    maxConcurrency: 8,
    ...options,
  });
  await remote.attach(mainSession);
  cleanups.push(async () => {
    await Promise.all([remote.close(), runtime.close()]);
  });
  return { remote, runtime, local };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

function cleanupFixture(
  trigger: "cancel" | "deadline",
  failed = false,
): Promise<ExecutorCleanupRaceFixture> {
  const cleanupStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const local = new TestLocalExecutor();
  const originalSubmit = local.submit.bind(local);
  local.submit = async (request) => {
    const handle = await originalSubmit({ ...request, input: { mode: "wait" } });
    const attempt = local.attempts.get(
      `${request.taskId.length}:${request.taskId}${request.attemptId}`,
    );
    queueMicrotask(() => cleanupStarted.resolve());
    void release.promise.then(() => {
      if (attempt !== undefined) {
        local.complete(
          attempt,
          failed ? "failed" : "succeeded",
          failed ? undefined : "cleanup-stable",
        );
      }
    });
    return handle;
  };
  local.cancel = async () => undefined;
  return connected({}, local).then(({ remote }) => {
    const request = executionRequest(
      { mode: "wait" },
      `cleanup-${trigger}`,
      "finish-and-buffer",
    );
    return {
      executor: remote,
      request,
      cleanupStarted: cleanupStarted.promise,
      expectedOutput: "cleanup-stable",
      async trigger() {
        if (trigger === "cancel") {
          await remote.cancel(request.taskId, request.attemptId);
        } else {
          clock.advanceBy(60_001);
          await flush();
        }
      },
      releaseCleanup: () => release.resolve(),
    };
  });
}

const fixture: ExecutorConformanceFixture = {
  request: executionRequest,
  echoInput: { mode: "echo", value: { echoed: true } },
  echoOutput: { echoed: true },
  waitingInput: { mode: "wait" },
  crashInput: { mode: "crash" },
  replacementInput: { mode: "echo", value: "replacement" },
  replacementOutput: "replacement",
  oversizedInput: { value: "x".repeat(2_000_000) },
  oversizedOutputInput: { mode: "large-output" },
  activeResourceCount: () => currentLocal?.active ?? 0,
  async spawnFailureFactory() {
    currentLocal = new TestLocalExecutor();
    currentLocal.failSubmit = true;
    return (await connected({}, currentLocal)).remote;
  },
  async shutdownHostTwice() {
    const { remote, runtime } = await connected();
    await Promise.all([remote.close(), remote.close(), runtime.close(), runtime.close()]);
  },
  advanceClock: async (milliseconds) => {
    clock.advanceBy(milliseconds);
    await flush();
  },
  cleanupRaceFactory: (trigger) => cleanupFixture(trigger),
  failedCleanupRaceFactory: (trigger) => cleanupFixture(trigger, true),
};

executorConformance(async () => {
  currentLocal = new TestLocalExecutor();
  return (await connected({}, currentLocal)).remote;
}, fixture);

test("assignment is recorded before the Worker receives it", async () => {
  const events: string[] = [];
  const store = new MemoryRemoteAttemptStore({
    onSave: (record) => events.push(`store:${record.state}`),
  });
  const local = new TestLocalExecutor();
  const [mainSession, workerSession] = memorySessionPair("1");
  const originalRequest = mainSession.request.bind(mainSession);
  mainSession.request = async (type, payload) => {
    events.push(`send:${type}`);
    return originalRequest(type, payload);
  };
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote-order",
    workerId,
    clock,
    attemptStore: store,
  });
  await remote.attach(mainSession);
  cleanups.push(async () => Promise.all([remote.close(), runtime.close()]).then(() => undefined));

  const result = await (await remote.submit(executionRequest({ mode: "echo", value: 1 }, "order"))).result;
  assert.equal(result.status, "succeeded");
  assert.ok(events.indexOf("store:assigned") < events.indexOf("send:task.assign"));
});

test("same attempt with a different fingerprint is rejected before remote execution", async () => {
  const { remote, local } = await connected();
  const request = executionRequest({ mode: "wait" }, "fingerprint");
  try {
    await remote.submit(request);
    await assert.rejects(
      remote.submit({ ...request, input: { changed: true } }),
      /fingerprint|identity/iu,
    );
    await eventually(() => assert.equal(local.executions, 1));
  } finally {
    await remote.cancel(request.taskId, request.attemptId);
  }
});

test("remote probe reports Worker identity and isolated execution", async () => {
  const { remote } = await connected();
  const capabilities = await remote.probe();
  assert.equal(capabilities.type, "remote");
  assert.equal(capabilities.securityIsolation, true);
  assert.deepEqual(capabilities.availableCapacity, 8);
});

test("remote result output stays JSON-compatible", async () => {
  const { remote } = await connected();
  const value: JsonValue = { nested: [true, null, 1, "value"] };
  const result = await (await remote.submit(executionRequest({ mode: "echo", value }, "json"))).result;
  assert.deepEqual(result.output, value);
});

test("future drain deadline cancels active remote attempts with the fake clock", async () => {
  const { remote } = await connected();
  const request = executionRequest({ mode: "wait" }, "drain-deadline");
  const handle = await remote.submit(request);
  await eventually(async () =>
    assert.deepEqual(await remote.observe(request.taskId, request.attemptId), {
      state: "running",
    }),
  );
  let drained = false;
  const draining = remote
    .drain({ deadline: new Date(clock.now().getTime() + 100).toISOString() })
    .then(() => {
      drained = true;
    });
  try {
    clock.advanceBy(101);
    await eventually(() => assert.equal(drained, true));
    assert.equal((await handle.result).status, "cancelled");
  } finally {
    await remote.cancel(request.taskId, request.attemptId);
    await draining;
  }
});

test("Worker attempt-store failure rejects before local execution instead of leaving an ambiguous ack", async () => {
  const local = new TestLocalExecutor();
  const [mainSession, workerSession] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: {
      save: async () => {
        throw new Error("attempt store unavailable");
      },
      load: async () => undefined,
      list: async () => [],
    },
    selectExecutor: () => local,
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote-store-failure",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  await remote.attach(mainSession);
  const request = executionRequest({ mode: "echo", value: "never" }, "worker-store-failure");
  const handle = await remote.submit(request);
  for (let index = 0; index < 10; index += 1) await flush();
  const observed = await remote.observe(request.taskId, request.attemptId);
  assert.equal(observed?.state, "terminal");
  assert.equal((await handle.result).status, "rejected");
  assert.equal(local.executions, 0);
  await Promise.all([remote.close(), runtime.close()]);
});
