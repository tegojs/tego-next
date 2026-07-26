import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type PluginDeployment,
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseComponentId,
  parseGeneration,
  parsePluginId,
  parseTaskId,
  parseWorkerId,
} from "@tegojs/contracts";
import type { ComponentBinding, PreparedArtifact } from "@tegojs/runtime";
import { LocalComponentSessionRegistry } from "../src/runtime/local-component-session-registry.js";
import {
  RemoteComponentSessionHost,
  remoteComponentExecutorId,
} from "../src/runtime/remote-component-session-host.js";

const applicationId = parseApplicationId("application-default");
const pluginId = parsePluginId("org.example.remote");
const componentId = parseComponentId("echo");
const generation = parseGeneration("1");
const artifactDigest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
const workerId = parseWorkerId("worker-remote");

const deployment: PluginDeployment = {
  applicationId,
  pluginId,
  version: "1.0.0",
  artifactDigest,
  generation,
  state: "active",
  essential: true,
  configuration: {},
  permissionGrants: [
    { kind: "executor", executors: ["remote"] },
    {
      kind: "worker",
      labels: {},
      resources: { cpuMillis: 1_000, memoryBytes: 1_024, storageBytes: 1_024 },
    },
  ],
  capabilityBindings: {},
};

const artifact: PreparedArtifact = {
  digest: artifactDigest,
  root: "/prepared/remote",
  manifest: {
    schemaVersion: "1.0",
    pluginId,
    version: "1.0.0",
    contractRange: ">=0.0.0 <1.0.0",
    nodeRange: ">=26 <27",
    moduleFormat: "esm",
    components: [
      {
        componentId,
        kind: "task",
        entrypoint: "components/echo.js",
        executors: ["remote"],
      },
    ],
    permissions: [],
    capabilities: { provides: [], requires: [] },
  },
};

function binding(): ComponentBinding {
  const component = artifact.manifest.components[0];
  assert.ok(component);
  return {
    instanceId: "application-default.org_dexample_dremote.echo.g1",
    activation: "1",
    executor: "remote",
    workerId,
    artifact,
    deployment,
    component,
  };
}

class ControlledRemoteExecutor implements Executor {
  readonly id = remoteComponentExecutorId(workerId);
  readonly type = "remote" as const;
  readonly result = Promise.withResolvers<ExecutionResult>();
  readonly targetDrain = Promise.withResolvers<void>();
  submissions = 0;
  closes = 0;
  targetDrains = 0;
  submitGate: Promise<void> | undefined;

  async probe() {
    return {
      id: this.id,
      type: this.type,
      available: true,
      maxConcurrency: 4,
      availableCapacity: 4,
      securityIsolation: true,
    };
  }

  async submit(request: ExecutionRequest): Promise<ExecutionHandle> {
    this.submissions += 1;
    await this.submitGate;
    return {
      taskId: request.taskId,
      attemptId: request.attemptId,
      result: this.result.promise,
    };
  }

  async observe() {
    return undefined;
  }

  async cancel() {}

  async drain() {
    throw new Error("component drain must not drain the shared Worker executor");
  }

  async drainTarget() {
    this.targetDrains += 1;
    await this.targetDrain.promise;
  }

  async resumeTarget() {
    return undefined;
  }

  async health() {
    return {
      id: this.id,
      type: this.type,
      status: "healthy" as const,
      checkedAt: new Date(0).toISOString(),
      accepting: true,
      active: 0,
      queued: 0,
      retainedAttempts: 0,
    };
  }

  async close() {
    this.closes += 1;
  }
}

test("remote component sessions fail closed when the shared executor cannot drain an exact target", async () => {
  const registry = new LocalComponentSessionRegistry("runtime-remote-capability");
  const shared = new ControlledRemoteExecutor();
  Object.defineProperty(shared, "drainTarget", { value: undefined });
  const host = new RemoteComponentSessionHost({
    registry,
    resolveExecutor: (candidate: typeof workerId) => (candidate === workerId ? shared : undefined),
    runtimeId: "runtime-remote-capability",
  });

  await assert.rejects(host.start(binding()), /unavailable|drain/iu);
  await registry.close();
});

test("remote component drain waits for a submit admitted before drain to reach the shared executor", async () => {
  const registry = new LocalComponentSessionRegistry("runtime-remote-race");
  const shared = new ControlledRemoteExecutor();
  const submitGate = Promise.withResolvers<void>();
  shared.submitGate = submitGate.promise;
  const host = new RemoteComponentSessionHost({
    registry,
    resolveExecutor: (candidate: typeof workerId) => (candidate === workerId ? shared : undefined),
    runtimeId: "runtime-remote-race",
  });
  const component = binding();

  await host.start(component);
  const registration = registry.resolveFresh({
    applicationId,
    pluginId,
    componentId,
    input: null,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    orphanPolicy: "finish-and-persist",
  });
  const taskId = parseTaskId("remote-race-task");
  const attemptId = parseAttemptId("remote-race-attempt");
  const request: ExecutionRequest = {
    taskId,
    attemptId,
    target: registration.target,
    applicationId,
    pluginId,
    componentId,
    input: null,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    orphanPolicy: "finish-and-persist",
  };

  const submitting = registration.executor.submit(request);
  const draining = host.drain(component);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const targetDrainStartedBeforeSubmitSettled = shared.targetDrains > 0;

  submitGate.resolve();
  const handle = await submitting;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shared.targetDrains, 1);

  const now = new Date().toISOString();
  shared.result.resolve({
    taskId,
    attemptId,
    status: "succeeded",
    output: null,
    executor: { kind: "remote", workerId },
    startedAt: now,
    completedAt: now,
  });
  shared.targetDrain.resolve();
  await Promise.all([handle.result, draining]);

  assert.equal(targetDrainStartedBeforeSubmitSettled, false);
  await host.stop(component);
  await registry.close();
});

test("remote component sessions scope admission and drain without closing the shared Worker executor", async () => {
  const registry = new LocalComponentSessionRegistry("runtime-remote");
  const shared = new ControlledRemoteExecutor();
  const host = new RemoteComponentSessionHost({
    registry,
    resolveExecutor: (candidate: typeof workerId) => (candidate === workerId ? shared : undefined),
    runtimeId: "runtime-remote",
  });
  const component = binding();

  await host.start(component);
  const registration = registry.resolveFresh({
    applicationId,
    pluginId,
    componentId,
    input: null,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    orphanPolicy: "finish-and-persist",
  });
  assert.deepEqual(registration.target.executor, {
    id: remoteComponentExecutorId(workerId),
    type: "remote",
    workerId,
  });

  const taskId = parseTaskId("remote-task");
  const attemptId = parseAttemptId("remote-attempt");
  const request: ExecutionRequest = {
    taskId,
    attemptId,
    target: registration.target,
    applicationId,
    pluginId,
    componentId,
    input: { value: 1 },
    deadline: new Date(Date.now() + 60_000).toISOString(),
    orphanPolicy: "finish-and-persist",
  };
  const handle = await registration.executor.submit(request);
  const draining = host.drain(component);
  await assert.rejects(() => registration.executor.submit(request), /draining|accepting/iu);
  let drained = false;
  void draining.then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);

  const now = new Date().toISOString();
  shared.result.resolve({
    taskId,
    attemptId,
    status: "succeeded",
    output: { value: 1 },
    executor: { kind: "remote", workerId },
    startedAt: now,
    completedAt: now,
  });
  await handle.result;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  shared.targetDrain.resolve();
  await draining;
  await host.stop(component);
  assert.equal(shared.submissions, 1);
  assert.equal(shared.targetDrains, 1);
  assert.equal(shared.closes, 0);
  assert.throws(() => registry.resolveExact(registration.target), /missing|unavailable/iu);

  await registry.close();
});
