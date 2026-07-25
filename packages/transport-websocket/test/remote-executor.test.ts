import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseWorkerId, type ExecutionRequest, type JsonValue } from "@tegojs/contracts";
import {
  executorConformance,
  eventually,
  FakeClock,
  type ExecutorCleanupRaceFixture,
  type ExecutorConformanceFixture,
} from "@tegojs/testkit";
import {
  MemoryRemoteAttemptStore,
  REMOTE_ASSIGN,
  RemoteExecutor,
  WorkerRuntime,
  type RemoteAttemptStore,
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
    id: "remote",
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
    const request = executionRequest({ mode: "wait" }, `cleanup-${trigger}`, "finish-and-buffer");
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
    id: "remote",
    workerId,
    clock,
    attemptStore: store,
  });
  await remote.attach(mainSession);
  cleanups.push(async () => Promise.all([remote.close(), runtime.close()]).then(() => undefined));

  const result = await (await remote.submit(executionRequest({ mode: "echo", value: 1 }, "order")))
    .result;
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

test("RemoteExecutor rejects mismatched immutable targets before attempt-store access", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly target: ExecutionRequest["target"];
  }[] = [
    {
      name: "executor id",
      target: {
        ...executionRequest(null, "target-id").target,
        executor: {
          id: "different-remote",
          type: "remote",
          workerId,
        },
      },
    },
    {
      name: "executor type",
      target: {
        ...executionRequest(null, "target-type").target,
        executor: {
          id: "remote",
          type: "process",
        },
      },
    },
    {
      name: "worker id",
      target: {
        ...executionRequest(null, "target-worker").target,
        executor: {
          id: "remote",
          type: "remote",
          workerId: parseWorkerId("different-worker"),
        },
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let storeCalls = 0;
      const store: RemoteAttemptStore = {
        save: async () => {
          storeCalls += 1;
        },
        commit: async () => {
          storeCalls += 1;
          return undefined;
        },
        delete: async () => {
          storeCalls += 1;
        },
        load: async () => {
          storeCalls += 1;
          return undefined;
        },
        list: async () => {
          storeCalls += 1;
          return [];
        },
      };
      const remote = new RemoteExecutor({
        id: "remote",
        workerId,
        clock,
        attemptStore: store,
      });
      const request = executionRequest(null, `remote-${testCase.name.replaceAll(" ", "-")}`);

      await assert.rejects(
        remote.submit({ ...request, target: testCase.target }),
        /target|executor|worker/iu,
      );
      assert.equal(storeCalls, 0);
    });
  }
});

test("WorkerRuntime rejects non-bound immutable targets before persistence, ACK, or selection", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly target: ExecutionRequest["target"];
  }[] = [
    {
      name: "local executor target",
      target: {
        ...executionRequest(null, "worker-local-target").target,
        executor: {
          id: "local",
          type: "thread",
        },
      },
    },
    {
      name: "different worker target",
      target: {
        ...executionRequest(null, "worker-cross-target").target,
        executor: {
          id: "remote",
          type: "remote",
          workerId: parseWorkerId("different-worker"),
        },
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let storeCalls = 0;
      let selectorCalls = 0;
      const local = new TestLocalExecutor();
      const store: RemoteAttemptStore = {
        save: async () => {
          storeCalls += 1;
        },
        commit: async () => {
          storeCalls += 1;
          return undefined;
        },
        delete: async () => {
          storeCalls += 1;
        },
        load: async () => {
          storeCalls += 1;
          return undefined;
        },
        list: async () => {
          storeCalls += 1;
          return [];
        },
      };
      const [mainSession, workerSession] = memorySessionPair("1");
      const runtime = new WorkerRuntime({
        workerId,
        clock,
        attemptStore: store,
        selectExecutor: () => {
          selectorCalls += 1;
          return local;
        },
      });
      await runtime.attach(workerSession);
      storeCalls = 0;
      cleanups.push(async () => runtime.close());
      const request = executionRequest(null, `worker-${testCase.name.replaceAll(" ", "-")}`);

      const response = await mainSession.request(REMOTE_ASSIGN, {
        request: { ...request, target: testCase.target },
      });

      assert.equal((response.payload as { readonly accepted?: boolean }).accepted, false);
      assert.equal(storeCalls, 0);
      assert.equal(selectorCalls, 0);
      assert.equal(local.executions, 0);
    });
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
  const result = await (await remote.submit(executionRequest({ mode: "echo", value }, "json")))
    .result;
  assert.deepEqual(result.output, value);
});

test("future drain deadline cancels active remote attempts with the fake clock", async () => {
  const { remote } = await connected();
  const request = {
    ...executionRequest({ mode: "wait" }, "drain-deadline"),
    deadline: new Date(clock.now().getTime() + 1_000_000).toISOString(),
  };
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
    await draining;
    assert.equal(drained, true);
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
      commit: async () => {
        throw new Error("attempt store unavailable");
      },
      load: async () => undefined,
      list: async () => [],
    },
    selectExecutor: () => local,
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote",
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

test("default remote assignment and result limits fit the Worker protocol frame", async () => {
  const { remote, local } = await connected();
  await assert.rejects(
    remote.submit(executionRequest({ value: "x".repeat(70_000) }, "frame-safe-input")),
    /admission|capacity|large|max/iu,
  );
  const result = await (
    await remote.submit(executionRequest({ mode: "large-output" }, "frame-safe-output"))
  ).result;
  assert.equal(result.status, "failed");
  assert.match(result.diagnostic?.code ?? "", /RESULT_TOO_LARGE/iu);
  assert.equal(local.executions, 1);
});
