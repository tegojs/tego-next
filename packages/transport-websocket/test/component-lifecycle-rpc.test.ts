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
import {
  executionRequest,
  memorySessionPair,
  TestLocalExecutor,
} from "./remote-test-support.js";

const clock = new FakeClock(new Date(0));
const cleanups: Array<() => Promise<void>> = [];

function activationFor(
  request: ReturnType<typeof executionRequest>,
): RemoteComponentActivation {
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
  const request = executionRequest(null, "lifecycle-seed");
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
    await Promise.all([remote.close(), runtime.close()]);
  });
  return { local, remote, validated };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
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
  assert.equal((await (await remote.submit(changed)).result).status, "rejected");
  assert.equal(local.executions, 0);
});

test("component drain blocks new assignments and waits for active exact-target work", async () => {
  const { local, remote } = await connected();
  const request = executionRequest({ mode: "wait" }, "drain-active");
  await remote.activateComponent(activationFor(request));
  const active = await remote.submit(request);
  await eventually(() => assert.equal(local.executions, 1));

  let drained = false;
  const draining = remote.drainComponent(request.target).then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);

  const rejected = executionRequest({ mode: "echo", value: "late" }, "drain-late");
  assert.equal((await (await remote.submit(rejected)).result).status, "rejected");
  const localAttempt = [...local.attempts.values()][0];
  assert.ok(localAttempt);
  local.complete(localAttempt, "succeeded", "done");
  assert.equal((await active.result).status, "succeeded");
  await draining;
  assert.equal(drained, true);
});

test("component stop removes the exact activation", async () => {
  const { local, remote } = await connected();
  const request = executionRequest({ mode: "echo", value: "stopped" }, "stop");
  await remote.activateComponent(activationFor(request));
  await remote.stopComponent(request.target);

  assert.equal((await (await remote.submit(request)).result).status, "rejected");
  assert.equal(local.executions, 0);
});
