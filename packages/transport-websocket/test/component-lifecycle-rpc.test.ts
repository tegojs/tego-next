import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  createExecutionBinding,
  parseApplicationId,
  parseComponentId,
  parsePluginId,
} from "@tegojs/contracts";
import { eventually, FakeClock } from "@tegojs/testkit";
import {
  MemoryRemoteAttemptStore,
  type RemoteComponentActivation,
  RemoteExecutor,
  WorkerRuntime,
  type WorkerRuntimeOptions,
} from "../src/index.js";
import { executionRequest, memorySessionPair, TestLocalExecutor } from "./remote-test-support.js";

const clock = new FakeClock(new Date(0));
const cleanups: Array<() => Promise<void>> = [];

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function activationFor(request: ReturnType<typeof executionRequest>): RemoteComponentActivation {
  return {
    identity: {
      applicationId: request.applicationId,
      pluginId: request.pluginId,
      componentId: request.componentId,
    },
    target: request.target,
    configuration: request.binding.configuration,
    permissionGrants: request.binding.permissionGrants,
    capabilityDefinitions: request.binding.capabilityDefinitions,
    capabilityBindings: request.binding.capabilityBindings,
    bindingFingerprint: request.binding.fingerprint,
  };
}

async function connected(
  options: Partial<
    Pick<WorkerRuntimeOptions, "activateComponent" | "drainComponent" | "stopComponent">
  > = {},
): Promise<{
  readonly local: TestLocalExecutor;
  readonly remote: RemoteExecutor;
  readonly validated: RemoteComponentActivation[];
}> {
  const workerId = executionRequest(null, "lifecycle-seed").target.executor;
  if (workerId.type !== "remote") throw new Error("test target must be remote");
  const local = new TestLocalExecutor();
  const validated: RemoteComponentActivation[] = [];
  const [mainSession, workerSession] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId: workerId.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
    validateActivation: (activation) => {
      validated.push(activation);
    },
    ...options,
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId: workerId.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  await remote.attach(mainSession);
  cleanups.push(async () => {
    for (const attempt of local.attempts.values()) {
      if (attempt.terminal === undefined) local.complete(attempt, "cancelled");
    }
    await Promise.all([remote.close(), runtime.close()]);
  });
  return { local, remote, validated };
}

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map(async (cleanup) => bounded(cleanup(), "lifecycle cleanup")),
  );
});

test("component activation is acknowledged only after Worker validation", async () => {
  const { remote, validated } = await connected();
  const request = executionRequest({ mode: "echo", value: "activated" }, "activate");
  const activation = activationFor(request);

  await remote.activateComponent(activation);
  assert.deepEqual(validated, [activation]);
  assert.equal((await (await remote.submit(request)).result).status, "succeeded");
});

test("replacement Worker materializes active components before accepting assignments", async () => {
  const request = executionRequest({ mode: "echo", value: "recovered" }, "replacement");
  const target = request.target.executor;
  if (target.type !== "remote") throw new Error("test target must be remote");
  const firstLocal = new TestLocalExecutor();
  const firstMaterialized: RemoteComponentActivation[] = [];
  const [firstMain, firstWorker] = memorySessionPair("1");
  const firstRuntime = new WorkerRuntime({
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => firstLocal,
    activateComponent: (activation) => {
      firstMaterialized.push(activation);
    },
  });
  await firstRuntime.attach(firstWorker);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  await remote.attach(firstMain);
  await remote.activateComponent(activationFor(request));
  assert.equal(firstMaterialized.length, 1);
  await firstRuntime.close();

  const replacementLocal = new TestLocalExecutor();
  const replacementMaterialized: RemoteComponentActivation[] = [];
  const [replacementMain, replacementWorker] = memorySessionPair("2");
  const replacementRuntime = new WorkerRuntime({
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => replacementLocal,
    activateComponent: (activation) => {
      replacementMaterialized.push(activation);
    },
  });
  await replacementRuntime.attach(replacementWorker);
  await remote.attach(replacementMain);
  cleanups.push(async () => {
    await Promise.all([remote.close(), replacementRuntime.close()]);
  });

  assert.deepEqual(replacementMaterialized, [activationFor(request)]);
  assert.equal((await (await remote.submit(request)).result).status, "succeeded");
  assert.equal(replacementLocal.executions, 1);
});

test("Worker rejects assignment until the exact target and binding fingerprint are activated", async () => {
  const { local, remote } = await connected();
  const request = executionRequest({ mode: "echo", value: "not-ready" }, "not-ready");

  assert.equal((await (await remote.submit(request)).result).status, "rejected");
  assert.equal(local.executions, 0);

  await remote.activateComponent(activationFor(request));
  const changedIdentity = {
    applicationId: parseApplicationId(request.applicationId),
    pluginId: parsePluginId(request.pluginId),
    componentId: parseComponentId(request.componentId),
    target: request.target,
  };
  const changed = {
    ...request,
    taskId: executionRequest(null, "changed-binding").taskId,
    attemptId: executionRequest(null, "changed-binding").attemptId,
    binding: createExecutionBinding(changedIdentity, {
      ...request.binding,
      configuration: { changed: true },
    }),
  };
  await assert.rejects(remote.submit(changed), /activation|binding/iu);
  assert.equal(local.executions, 0);
});

test("component drain blocks new assignments and waits for active exact-target work", async () => {
  const { local, remote } = await connected();
  const request = executionRequest({ mode: "wait" }, "drain-active");
  await bounded(remote.activateComponent(activationFor(request)), "component activation");
  const active = await bounded(remote.submit(request), "active submit");
  await bounded(
    eventually(() => assert.equal(local.executions, 1)),
    "local execution start",
  );

  let drained = false;
  const draining = remote.drainComponent(request.target).then(() => {
    drained = true;
  });
  try {
    await Promise.resolve();
    assert.equal(drained, false);

    const rejected = executionRequest({ mode: "echo", value: "late" }, "drain-late");
    await bounded(
      assert.rejects(remote.submit(rejected), /activation|active|drain/iu),
      "draining admission",
    );
    const localAttempt = [...local.attempts.values()][0];
    assert.ok(localAttempt);
    local.complete(localAttempt, "succeeded", "done");
    assert.equal((await bounded(active.result, "active result")).status, "succeeded");
    await bounded(draining, "component drain");
    assert.equal(drained, true);
  } finally {
    for (const attempt of local.attempts.values()) {
      if (attempt.terminal === undefined) local.complete(attempt, "cancelled");
    }
    await bounded(draining, "component drain cleanup");
  }
});

test("component stop removes the exact activation", async () => {
  const { local, remote } = await connected();
  const request = executionRequest({ mode: "echo", value: "stopped" }, "stop");
  await remote.activateComponent(activationFor(request));
  await remote.stopComponent(request.target);

  await assert.rejects(remote.submit(request), /activation|active/iu);
  assert.equal(local.executions, 0);
});

test("activation materialization completes before ACK and failed materialization is not stored", async () => {
  const events: string[] = [];
  const release = Promise.withResolvers<void>();
  let fail = false;
  const { remote } = await connected({
    activateComponent: async () => {
      events.push("activate:start");
      await release.promise;
      events.push("activate:finish");
      if (fail) throw new Error("materialization failed");
    },
  });
  const request = executionRequest({ mode: "echo", value: "materialized" }, "materialize");
  const activation = activationFor(request);
  let acknowledged = false;
  const pending = remote.activateComponent(activation).then(() => {
    acknowledged = true;
  });
  try {
    await bounded(
      eventually(() => assert.deepEqual(events, ["activate:start"])),
      "activation materializer start",
    );
    assert.equal(acknowledged, false);
    await assert.rejects(remote.submit(request), /activation|active/iu);
    release.resolve();
    await bounded(pending, "activation ACK");
    assert.deepEqual(events, ["activate:start", "activate:finish"]);
    assert.equal(acknowledged, true);

    await remote.stopComponent(request.target);
    fail = true;
    const failed = remote.activateComponent(activation);
    await assert.rejects(failed, (error: unknown) => {
      assert.equal(
        (error as { diagnostic?: { code?: unknown } }).diagnostic?.code,
        "LIFECYCLE_COMPONENT_ACTIVATION_FAILED",
      );
      return true;
    });
    await assert.rejects(remote.submit(request), /activation|active/iu);
  } finally {
    release.resolve();
  }
});

test("drain callback runs after active attempts settle and before ACK", async () => {
  const callbackStarted = Promise.withResolvers<void>();
  const releaseCallback = Promise.withResolvers<void>();
  const { local, remote } = await connected({
    drainComponent: async () => {
      callbackStarted.resolve();
      await releaseCallback.promise;
    },
  });
  const request = executionRequest({ mode: "wait" }, "drain-callback");
  await remote.activateComponent(activationFor(request));
  const active = await remote.submit(request);
  await bounded(
    eventually(() => assert.equal(local.executions, 1)),
    "drain callback local execution",
  );
  let acknowledged = false;
  const draining = remote.drainComponent(request.target).then(() => {
    acknowledged = true;
  });
  try {
    await Promise.resolve();
    assert.equal(acknowledged, false);
    const localAttempt = [...local.attempts.values()][0];
    assert.ok(localAttempt);
    local.complete(localAttempt, "succeeded");
    await bounded(active.result, "drain callback active result");
    await bounded(callbackStarted.promise, "drain callback start");
    assert.equal(acknowledged, false);
    releaseCallback.resolve();
    await bounded(draining, "drain callback ACK");
    assert.equal(acknowledged, true);
  } finally {
    releaseCallback.resolve();
    for (const attempt of local.attempts.values()) {
      if (attempt.terminal === undefined) local.complete(attempt, "cancelled");
    }
    await bounded(draining, "drain callback cleanup");
  }
});

test("failed stop callback retains the activation for a safe retry", async () => {
  let fail = true;
  let calls = 0;
  let local!: TestLocalExecutor;
  let observedTerminal = false;
  const connectedRuntime = await connected({
    stopComponent: () => {
      calls += 1;
      observedTerminal = [...local.attempts.values()].every(
        (attempt) => attempt.terminal !== undefined,
      );
      if (fail) throw new Error("teardown failed");
    },
  });
  local = connectedRuntime.local;
  const { remote } = connectedRuntime;
  const request = executionRequest({ mode: "wait" }, "stop-callback");
  await remote.activateComponent(activationFor(request));
  const active = await remote.submit(request);
  await bounded(
    eventually(() => assert.equal(local.executions, 1)),
    "stop callback local execution",
  );
  const stopping = remote.stopComponent(request.target);
  try {
    const localAttempt = [...local.attempts.values()][0];
    assert.ok(localAttempt);
    local.complete(localAttempt, "succeeded");
    await bounded(active.result, "stop callback active result");
    await assert.rejects(stopping, (error: unknown) => {
      assert.equal(
        (error as { diagnostic?: { code?: unknown } }).diagnostic?.code,
        "LIFECYCLE_COMPONENT_STOP_FAILED",
      );
      return true;
    });
    assert.equal(observedTerminal, true);
    fail = false;
    await remote.stopComponent(request.target);
    assert.equal(calls, 2);
  } finally {
    for (const attempt of local.attempts.values()) {
      if (attempt.terminal === undefined) local.complete(attempt, "cancelled");
    }
    await stopping.catch(() => undefined);
  }
});

test("failed drain callback retains a non-accepting activation for safe retry", async () => {
  let fail = true;
  let calls = 0;
  const { remote } = await connected({
    drainComponent: () => {
      calls += 1;
      if (fail) throw new Error("drain failed");
    },
  });
  const request = executionRequest(null, "drain-callback-failure");
  await remote.activateComponent(activationFor(request));

  await assert.rejects(remote.drainComponent(request.target), (error: unknown) => {
    assert.equal(
      (error as { diagnostic?: { code?: unknown } }).diagnostic?.code,
      "LIFECYCLE_COMPONENT_DRAIN_FAILED",
    );
    return true;
  });
  await assert.rejects(remote.submit(request), /activation|active|drain/iu);
  fail = false;
  await remote.drainComponent(request.target);
  assert.equal(calls, 2);
});

test("a draining activation cannot be promoted by replay after a higher session epoch", async () => {
  const request = executionRequest(null, "draining-replay");
  const target = request.target.executor;
  if (target.type !== "remote") throw new Error("test target must be remote");
  const { remote } = await connected({
    drainComponent: () => {
      throw new Error("drain failed");
    },
  });
  await remote.activateComponent(activationFor(request));
  await assert.rejects(remote.drainComponent(request.target), /drain/iu);

  const replacementMaterialized: RemoteComponentActivation[] = [];
  const [replacementMain, replacementWorker] = memorySessionPair("2");
  const replacementRuntime = new WorkerRuntime({
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    activateComponent: (activation) => {
      replacementMaterialized.push(activation);
    },
  });
  await replacementRuntime.attach(replacementWorker);
  await remote.attach(replacementMain);
  cleanups.push(async () => replacementRuntime.close());

  await assert.rejects(remote.activateComponent(activationFor(request)), /drain|active/iu);
  assert.deepEqual(replacementMaterialized, [activationFor(request)]);
  await assert.rejects(remote.submit(request), /drain|active/iu);
});

test("replacement Worker materializes draining components and completes teardown", async () => {
  const request = executionRequest(null, "draining-replacement");
  const target = request.target.executor;
  if (target.type !== "remote") throw new Error("test target must be remote");
  const [firstMain, firstWorker] = memorySessionPair("1");
  const firstRuntime = new WorkerRuntime({
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    drainComponent: () => {
      throw new Error("drain interrupted");
    },
  });
  await firstRuntime.attach(firstWorker);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  await remote.attach(firstMain);
  await remote.activateComponent(activationFor(request));
  await assert.rejects(remote.drainComponent(request.target), /drain/iu);
  await firstRuntime.close();

  const materialized: RemoteComponentActivation[] = [];
  const stopped: RemoteComponentActivation[] = [];
  const [replacementMain, replacementWorker] = memorySessionPair("2");
  const replacementRuntime = new WorkerRuntime({
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    activateComponent: (activation) => {
      materialized.push(activation);
    },
    stopComponent: (activation) => {
      stopped.push(activation);
    },
  });
  await replacementRuntime.attach(replacementWorker);
  await remote.attach(replacementMain);
  cleanups.push(async () => {
    await Promise.all([remote.close(), replacementRuntime.close()]);
  });

  assert.deepEqual(materialized, [activationFor(request)]);
  await assert.rejects(remote.submit(request), /drain|active/iu);
  await remote.stopComponent(request.target);
  assert.deepEqual(stopped, [activationFor(request)]);
});

test("fresh Main hydrates retained draining Worker state and completes teardown", async () => {
  const request = executionRequest(null, "draining-takeover");
  const target = request.target.executor;
  if (target.type !== "remote") throw new Error("test target must be remote");
  const stopped: RemoteComponentActivation[] = [];
  const [firstMain, firstWorker] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    drainComponent: () => {
      throw new Error("drain interrupted");
    },
    stopComponent: (activation) => {
      stopped.push(activation);
    },
  });
  await runtime.attach(firstWorker);
  const firstRemote = new RemoteExecutor({
    id: "remote",
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  await firstRemote.attach(firstMain);
  await firstRemote.activateComponent(activationFor(request));
  await assert.rejects(firstRemote.drainComponent(request.target), /drain/iu);
  firstMain.close();

  const [replacementMain, replacementWorker] = memorySessionPair("2");
  await runtime.attach(replacementWorker);
  const replacementRemote = new RemoteExecutor({
    id: "remote",
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  await replacementRemote.attach(replacementMain);
  cleanups.push(async () => {
    await Promise.all([firstRemote.close(), replacementRemote.close(), runtime.close()]);
  });

  await assert.rejects(replacementRemote.submit(request), /drain|active/iu);
  const stopExact = replacementRemote.stopComponent as (
    target: typeof request.target,
    bindingFingerprint: string,
  ) => Promise<void>;
  await assert.rejects(
    stopExact.call(replacementRemote, request.target, "0".repeat(64)),
    /binding|fingerprint|activation/iu,
  );
  await stopExact.call(
    replacementRemote,
    request.target,
    activationFor(request).bindingFingerprint,
  );
  assert.deepEqual(stopped, [activationFor(request)]);
});

test("Worker-reported draining state is never replayed to another replacement Worker", async () => {
  const request = executionRequest(null, "draining-provenance");
  const target = request.target.executor;
  if (target.type !== "remote") throw new Error("test target must be remote");
  const [retainedMain, retainedWorker] = memorySessionPair("1");
  const retainedRuntime = new WorkerRuntime({
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    drainComponent: () => {
      throw new Error("drain interrupted");
    },
  });
  await retainedRuntime.attach(retainedWorker);
  const seedRemote = new RemoteExecutor({
    id: "remote",
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  await seedRemote.attach(retainedMain);
  await seedRemote.activateComponent(activationFor(request));
  await assert.rejects(seedRemote.drainComponent(request.target), /drain/iu);
  retainedMain.close();

  const candidateRemote = new RemoteExecutor({
    id: "remote",
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  const [candidateMain, candidateWorker] = memorySessionPair("2");
  await retainedRuntime.attach(candidateWorker);
  await candidateRemote.attach(candidateMain);
  candidateMain.close();
  await retainedRuntime.close();

  const materialized: RemoteComponentActivation[] = [];
  const replacementRuntime = new WorkerRuntime({
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    activateComponent: (activation) => {
      materialized.push(activation);
    },
  });
  const [replacementMain, replacementWorker] = memorySessionPair("3");
  await replacementRuntime.attach(replacementWorker);
  await candidateRemote.attach(replacementMain);
  cleanups.push(async () => {
    await Promise.all([seedRemote.close(), candidateRemote.close(), replacementRuntime.close()]);
  });

  assert.deepEqual(materialized, []);
});

test("rejected Worker activation inventory cannot mutate the next reconciliation request", async () => {
  const request = executionRequest(null, "invalid-inventory");
  const target = request.target.executor;
  if (target.type !== "remote") throw new Error("test target must be remote");
  const activation = activationFor(request);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  const [firstMain, firstWorker] = memorySessionPair("1");
  firstWorker.onMessage((message) => {
    if (message.type !== "session.reconcile") return;
    void firstWorker.send(
      "session.reconcile",
      {
        epoch: firstWorker.epoch,
        attemptPersistenceAvailable: true,
        acknowledged: [],
        running: [],
        terminalUnacknowledged: [],
        preparedArtifacts: [],
        componentActivations: [
          { activation, state: "draining" },
          { activation, state: "draining" },
        ],
      },
      { correlationId: message.messageId },
    );
  });
  await assert.rejects(remote.attach(firstMain), /duplicate/iu);

  let nextActivations: unknown;
  const [nextMain, nextWorker] = memorySessionPair("2");
  nextWorker.onMessage((message) => {
    if (message.type !== "session.reconcile") return;
    nextActivations = (message.payload as { readonly activations?: unknown }).activations;
    void nextWorker.send(
      "session.reconcile",
      {
        epoch: nextWorker.epoch,
        attemptPersistenceAvailable: true,
        acknowledged: [],
        running: [],
        terminalUnacknowledged: [],
        preparedArtifacts: [],
        componentActivations: [],
      },
      { correlationId: message.messageId },
    );
  });
  await remote.attach(nextMain);
  cleanups.push(async () => remote.close());

  assert.deepEqual(nextActivations, []);
});

test("Worker validates a complete activation inventory before materialization", async () => {
  const request = executionRequest(null, "worker-invalid-inventory");
  const target = request.target.executor;
  if (target.type !== "remote") throw new Error("test target must be remote");
  const activation = activationFor(request);
  const materialized: RemoteComponentActivation[] = [];
  const [main, worker] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId: target.workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    activateComponent: (candidate) => {
      materialized.push(candidate);
    },
  });
  await runtime.attach(worker);
  cleanups.push(async () => runtime.close());

  const response = await main.request("session.reconcile", {
    workerId: target.workerId,
    epoch: main.epoch,
    activations: [
      { activation, state: "active" },
      { activation, state: "active" },
    ],
  });

  assert.notEqual((response.payload as { readonly error?: unknown }).error, undefined);
  assert.deepEqual(materialized, []);
});
