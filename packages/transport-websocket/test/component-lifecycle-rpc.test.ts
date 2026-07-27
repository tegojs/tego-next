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

async function connected(): Promise<{
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
