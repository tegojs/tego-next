import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  type ExecutionRequest,
  type JsonValue,
  parseComponentInstanceId,
  parseWorkerId,
} from "@tegojs/contracts";
import {
  type ExecutorCleanupRaceFixture,
  type ExecutorConformanceFixture,
  eventually,
  executorConformance,
  FakeClock,
} from "@tegojs/testkit";
import {
  MemoryRemoteAttemptStore,
  REMOTE_ASSIGN,
  REMOTE_CANCEL,
  REMOTE_RESULT_ACK,
  type RemoteAttemptStore,
  RemoteExecutor,
  type RemoteExecutorOptions,
  WorkerRuntime,
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

test("target drain leaves other component targets accepting and running", async () => {
  const { remote } = await connected();
  const request = {
    ...executionRequest({ mode: "wait" }, "target-drain"),
    deadline: new Date(clock.now().getTime() + 1_000_000).toISOString(),
  };
  const otherTarget = {
    ...request.target,
    instanceId: parseComponentInstanceId("app.org.example.remote.other.g1"),
  };
  const handle = await remote.submit(request);
  await eventually(async () =>
    assert.equal((await remote.observe(request.taskId, request.attemptId))?.state, "running"),
  );

  await remote.drainTarget(otherTarget);
  assert.equal((await remote.observe(request.taskId, request.attemptId))?.state, "running");
  assert.equal((await remote.probe()).available, true);

  const draining = remote.drainTarget(request.target, {
    deadline: new Date(clock.now().getTime() + 100).toISOString(),
  });
  clock.advanceBy(101);
  await draining;
  assert.equal((await handle.result).status, "cancelled");
});

test("target drain waits for a submit that started before the drain snapshot", async () => {
  const loadStarted = Promise.withResolvers<void>();
  const releaseLoad = Promise.withResolvers<void>();
  class BlockingLoadStore extends MemoryRemoteAttemptStore {
    override async load(
      taskId: ExecutionRequest["taskId"],
      attemptId: ExecutionRequest["attemptId"],
    ) {
      loadStarted.resolve();
      await releaseLoad.promise;
      return super.load(taskId, attemptId);
    }
  }
  const { remote } = await connected({ attemptStore: new BlockingLoadStore() });
  const request = {
    ...executionRequest({ mode: "wait" }, "target-drain-submit-race"),
    deadline: new Date(clock.now().getTime() + 1_000_000).toISOString(),
  };

  const submitting = remote.submit(request);
  await loadStarted.promise;
  let drained = false;
  const draining = remote.drainTarget(request.target).then(() => {
    drained = true;
  });
  await flush();
  const drainedBeforeSubmitSettled = drained;

  releaseLoad.resolve();
  const handle = await submitting;
  await eventually(async () =>
    assert.equal((await remote.observe(request.taskId, request.attemptId))?.state, "running"),
  );
  const drainedWhileTargetActive = drained;
  await remote.cancel(request.taskId, request.attemptId);
  await draining;
  assert.equal((await handle.result).status, "cancelled");

  assert.equal(drainedBeforeSubmitSettled, false);
  assert.equal(drainedWhileTargetActive, false);
});

test("authority revoke immediately disables admission and cannot be reversed by attaching", async () => {
  const { remote } = await connected();

  await remote.revokeAuthority();

  assert.equal((await remote.probe()).available, false);
  await assert.rejects(
    remote.submit(executionRequest({ mode: "echo", value: "rejected" }, "revoked-admission")),
    /authority|available/iu,
  );
  const [replacementSession] = memorySessionPair("2");
  await assert.rejects(remote.attach(replacementSession), /authority|revoked/iu);
});

test("authority revoke fences an attach that was queued before revocation", async () => {
  const [mainSession, workerSession] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  cleanups.push(async () => runtime.close());

  const attaching = remote.attach(mainSession);
  remote.revokeAuthority();

  await assert.rejects(attaching, /authority|revoked/iu);
  assert.equal((await remote.probe()).available, false);
});

test("authority revoke fences an attach whose hydration is already in progress", async () => {
  const listStarted = Promise.withResolvers<void>();
  const releaseList = Promise.withResolvers<void>();
  class BlockingListStore extends MemoryRemoteAttemptStore {
    override async list(requestedWorkerId: typeof workerId) {
      listStarted.resolve();
      await releaseList.promise;
      return super.list(requestedWorkerId);
    }
  }
  const [mainSession, workerSession] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new BlockingListStore(),
  });
  cleanups.push(async () => runtime.close());

  const attaching = remote.attach(mainSession);
  await listStarted.promise;
  remote.revokeAuthority();
  releaseList.resolve();

  await assert.rejects(attaching, /authority|revoked/iu);
  assert.equal((await remote.probe()).available, false);
});

test("authority revoke fences a submit whose durable create is already in progress", async () => {
  const createStarted = Promise.withResolvers<void>();
  const releaseCreate = Promise.withResolvers<void>();
  class BlockingCreateStore extends MemoryRemoteAttemptStore {
    override async commit(
      record: Parameters<MemoryRemoteAttemptStore["commit"]>[0],
      condition: Parameters<MemoryRemoteAttemptStore["commit"]>[1],
    ) {
      if (condition.expectedRevision === null) {
        createStarted.resolve();
        await releaseCreate.promise;
      }
      return super.commit(record, condition);
    }
  }
  const store = new BlockingCreateStore();
  const { remote, local } = await connected({ attemptStore: store });
  const request = executionRequest({ mode: "wait" }, "revoked-create");

  const submitting = remote.submit(request);
  await createStarted.promise;
  remote.revokeAuthority();
  releaseCreate.resolve();

  await assert.rejects(submitting, /authority|revoked/iu);
  const observed = await remote.observe(request.taskId, request.attemptId);
  assert.equal(observed?.state, "terminal");
  assert.equal(observed?.result.status, "indeterminate");
  assert.equal(local.attempts.size, 0);
  assert.deepEqual(
    (await store.list(workerId)).map(({ state, epoch }) => ({ state, epoch })),
    [{ state: "assigned", epoch: "1" }],
  );
});

test("session replacement rebinds a submit whose durable create captured the previous epoch", async () => {
  const createStarted = Promise.withResolvers<void>();
  const releaseCreate = Promise.withResolvers<void>();
  class BlockingCreateStore extends MemoryRemoteAttemptStore {
    override async commit(
      record: Parameters<MemoryRemoteAttemptStore["commit"]>[0],
      condition: Parameters<MemoryRemoteAttemptStore["commit"]>[1],
    ) {
      if (condition.expectedRevision === null) {
        createStarted.resolve();
        await releaseCreate.promise;
      }
      return super.commit(record, condition);
    }
  }
  const store = new BlockingCreateStore();
  const { remote, local } = await connected({ attemptStore: store });
  const request = {
    ...executionRequest({ mode: "wait" }, "replaced-create"),
    deadline: new Date(clock.now().getTime() + 1_000_000).toISOString(),
  };
  const submitting = remote.submit(request);
  await createStarted.promise;

  const [replacementMain, replacementWorker] = memorySessionPair("2");
  const replacementRuntime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  cleanups.push(async () => replacementRuntime.close());
  const replacementAssignmentEpochs: Array<string | undefined> = [];
  const replacementRequest = replacementMain.request.bind(replacementMain);
  replacementMain.request = async (type, payload) => {
    if (type === REMOTE_ASSIGN) {
      replacementAssignmentEpochs.push(
        (await store.load(request.taskId, request.attemptId))?.epoch,
      );
    }
    return replacementRequest(type, payload);
  };
  await replacementRuntime.attach(replacementWorker);
  await remote.attach(replacementMain);
  releaseCreate.resolve();

  const handle = await submitting;
  await eventually(async () => assert.equal(replacementAssignmentEpochs.length, 1));
  await remote.cancel(request.taskId, request.attemptId);
  assert.equal((await handle.result).status, "cancelled");
  assert.deepEqual(replacementAssignmentEpochs, ["2"]);
  assert.equal(local.attempts.size, 1);
  assert.deepEqual(
    (await store.list(workerId)).map(({ state, epoch }) => ({ state, epoch })),
    [{ state: "terminal", epoch: "2" }],
  );
});

test("authority revoke settles active attempts in memory without persistence or Worker control", async () => {
  const writes: string[] = [];
  const store = new MemoryRemoteAttemptStore({
    onSave: (record) => writes.push(record.state),
  });
  const local = new TestLocalExecutor();
  const [mainSession, workerSession] = memorySessionPair("1");
  const outbound: string[] = [];
  const originalRequest = mainSession.request.bind(mainSession);
  const originalSend = mainSession.send.bind(mainSession);
  mainSession.request = async (type, payload) => {
    outbound.push(type);
    return originalRequest(type, payload);
  };
  mainSession.send = async (type, payload, options) => {
    outbound.push(type);
    return originalSend(type, payload, options);
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
    orphanTimeoutMs: 100,
  });
  await remote.attach(mainSession);
  cleanups.push(async () => runtime.close());
  const request = {
    ...executionRequest({ mode: "wait" }, "revoke-active"),
    deadline: new Date(clock.now().getTime() + 100).toISOString(),
  };
  const handle = await remote.submit(request);
  await eventually(async () =>
    assert.equal((await remote.observe(request.taskId, request.attemptId))?.state, "running"),
  );
  const writesBeforeRevoke = [...writes];
  const outboundBeforeRevoke = [...outbound];

  await remote.revokeAuthority();
  const result = await handle.result;
  clock.advanceBy(1_000);
  await flush();

  assert.equal(result.status, "indeterminate");
  assert.match(result.diagnostic?.code ?? "", /AUTHORITY_REVOKED/iu);
  assert.deepEqual(writes, writesBeforeRevoke);
  assert.deepEqual(outbound, outboundBeforeRevoke);
  assert.equal(outbound.includes(REMOTE_CANCEL), false);
});

test("authority revoke detaches result handling so late Worker results are neither stored nor acknowledged", async () => {
  const writes: string[] = [];
  const store = new MemoryRemoteAttemptStore({
    onSave: (record) => writes.push(record.state),
  });
  const local = new TestLocalExecutor();
  const [mainSession, workerSession] = memorySessionPair("1");
  let resultAcks = 0;
  const originalSend = mainSession.send.bind(mainSession);
  mainSession.send = async (type, payload, options) => {
    if (type === REMOTE_RESULT_ACK) resultAcks += 1;
    return originalSend(type, payload, options);
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
  cleanups.push(async () => runtime.close());
  const request = executionRequest({ mode: "wait" }, "revoke-late-result");
  const handle = await remote.submit(request);
  await eventually(async () =>
    assert.equal((await remote.observe(request.taskId, request.attemptId))?.state, "running"),
  );

  await remote.revokeAuthority();
  const writesAfterRevoke = [...writes];
  const attempt = [...local.attempts.values()][0];
  assert.ok(attempt);
  local.complete(attempt, "succeeded", "too-late");
  await flush();
  await flush();

  assert.equal((await handle.result).status, "indeterminate");
  assert.deepEqual(writes, writesAfterRevoke);
  assert.equal(resultAcks, 0);
});

test("authority revoke aborts orphan expiry without publishing to the attempt store", async () => {
  const store = new MemoryRemoteAttemptStore();
  const local = new TestLocalExecutor();
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
    attemptStore: store,
    orphanTimeoutMs: 100,
  });
  await remote.attach(mainSession);
  cleanups.push(async () => runtime.close());
  const request = executionRequest({ mode: "wait" }, "revoke-orphan");
  const handle = await remote.submit(request);
  await eventually(async () =>
    assert.equal((await remote.observe(request.taskId, request.attemptId))?.state, "running"),
  );
  mainSession.close();
  await eventually(async () => {
    const [record] = await store.list(workerId);
    assert.equal(record?.state, "unknown");
  });

  await remote.revokeAuthority();
  const recordsAfterRevoke = await store.list(workerId);
  clock.advanceBy(1_000);
  await flush();
  await flush();

  assert.equal((await handle.result).status, "indeterminate");
  assert.deepEqual(await store.list(workerId), recordsAfterRevoke);
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
