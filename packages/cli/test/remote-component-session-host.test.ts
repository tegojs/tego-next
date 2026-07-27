import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createExecutionBinding,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type PluginDeployment,
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseCapabilityName,
  parseComponentId,
  parseGeneration,
  parseOperationId,
  parsePluginId,
  parseTaskId,
  parseWorkerId,
} from "@tegojs/contracts";
import type { ComponentBinding, PreparedArtifact } from "@tegojs/runtime";
import type {
  RemoteCapabilityInvocation,
  RemoteComponentActivation,
} from "@tegojs/transport-websocket";
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

function executionBinding(target: ExecutionRequest["target"]) {
  return createExecutionBinding(
    { applicationId, pluginId, componentId, target },
    {
      configuration: {},
      permissionGrants: [
        { kind: "executor", executors: ["remote"] },
        {
          kind: "worker",
          labels: {},
          resources: { cpuMillis: 1_000, memoryBytes: 1_024, storageBytes: 1_024 },
        },
      ],
      capabilityDefinitions: [],
      capabilityBindings: [],
    },
  );
}

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
  drainedTargets: ExecutionRequest["target"][] = [];
  targetDrains = 0;
  activations: RemoteComponentActivation[] = [];
  capabilityInvocations: RemoteCapabilityInvocation[] = [];
  lifecycle: string[] = [];
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

  async drainTarget(target: ExecutionRequest["target"]) {
    this.targetDrains += 1;
    this.drainedTargets.push(target);
    await this.targetDrain.promise;
  }

  async activateComponent(activation: RemoteComponentActivation) {
    this.lifecycle.push("activate");
    this.activations.push(activation);
  }

  async drainComponent() {
    this.lifecycle.push("drain");
  }

  async stopComponent() {
    this.lifecycle.push("stop");
  }

  async invokeCapability(request: RemoteCapabilityInvocation) {
    this.capabilityInvocations.push(request);
    return { invoked: request.invocation.method };
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
    resolveExecutionBinding: (_binding, target) => Promise.resolve(executionBinding(target)),
    runtimeId: "runtime-remote-capability",
  });

  await assert.rejects(host.start(binding()), /unavailable|drain/iu);
  await registry.close();
});

test("remote component activation binds lifecycle and capability invocation to one immutable target", async () => {
  const registry = new LocalComponentSessionRegistry("runtime-remote-activation");
  const shared = new ControlledRemoteExecutor();
  const host = new RemoteComponentSessionHost({
    registry,
    resolveExecutor: (candidate: typeof workerId) => (candidate === workerId ? shared : undefined),
    resolveExecutionBinding: (_binding, target) => Promise.resolve(executionBinding(target)),
    runtimeId: "runtime-remote-activation",
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
  const immutableBinding = executionBinding(registration.target);
  assert.deepEqual(shared.activations, [
    {
      identity: { applicationId, pluginId, componentId },
      target: registration.target,
      configuration: immutableBinding.configuration,
      permissionGrants: immutableBinding.permissionGrants,
      capabilityDefinitions: immutableBinding.capabilityDefinitions,
      capabilityBindings: immutableBinding.capabilityBindings,
      bindingFingerprint: immutableBinding.fingerprint,
    },
  ]);

  const provider = registration.executor as Executor & {
    invokeCapability(request: {
      readonly invocationId: ReturnType<typeof parseOperationId>;
      readonly identity: {
        readonly name: ReturnType<typeof parseCapabilityName>;
        readonly protocolVersion: string;
      };
      readonly method: string;
      readonly input: null;
    }): Promise<unknown>;
  };
  const invocation = {
    invocationId: parseOperationId("remote-capability-1"),
    identity: {
      name: parseCapabilityName("org.example.echo"),
      protocolVersion: "1.0.0",
    },
    method: "echo",
    input: null,
  };
  assert.deepEqual(await provider.invokeCapability(invocation), { invoked: "echo" });
  assert.deepEqual(shared.capabilityInvocations, [
    {
      invocationId: invocation.invocationId,
      bindingFingerprint: immutableBinding.fingerprint,
      target: registration.target,
      invocation,
    },
  ]);
  await host.stop(component);
  assert.deepEqual(shared.lifecycle, ["activate", "stop"]);
  await registry.close();
});

test("remote component stop drains the persisted target after a fresh registry restart", async () => {
  const registry = new LocalComponentSessionRegistry("runtime-remote-restart-stop");
  const shared = new ControlledRemoteExecutor();
  shared.targetDrain.resolve();
  const host = new RemoteComponentSessionHost({
    registry,
    resolveExecutor: (candidate: typeof workerId) => (candidate === workerId ? shared : undefined),
    resolveExecutionBinding: (_binding, target) => Promise.resolve(executionBinding(target)),
    runtimeId: "runtime-remote-restart-stop",
  });
  const component = binding();

  await host.stop(component);

  assert.equal(shared.targetDrains, 1);
  assert.deepEqual(shared.drainedTargets, [
    {
      instanceId: component.instanceId,
      deploymentGeneration: component.deployment.generation,
      artifactDigest: component.artifact.digest,
      executor: {
        id: remoteComponentExecutorId(workerId),
        type: "remote",
        workerId,
      },
    },
  ]);
  await registry.close();
});

test("remote component stop fails closed when the persisted executor cannot be resolved exactly", async () => {
  for (const resolved of [
    undefined,
    Object.assign(new ControlledRemoteExecutor(), {
      id: remoteComponentExecutorId(parseWorkerId("worker-other")),
    }),
  ]) {
    const registry = new LocalComponentSessionRegistry("runtime-remote-restart-stop-invalid");
    const host = new RemoteComponentSessionHost({
      registry,
      resolveExecutor: () => resolved,
      resolveExecutionBinding: (_binding, target) => Promise.resolve(executionBinding(target)),
      runtimeId: "runtime-remote-restart-stop-invalid",
    });

    await assert.rejects(host.stop(binding()), /unavailable|exact|drain/iu);
    assert.equal(resolved?.targetDrains ?? 0, 0);
    await registry.close();
  }
});

test("remote component drain waits for a submit admitted before drain to reach the shared executor", async () => {
  const registry = new LocalComponentSessionRegistry("runtime-remote-race");
  const shared = new ControlledRemoteExecutor();
  const submitGate = Promise.withResolvers<void>();
  shared.submitGate = submitGate.promise;
  const host = new RemoteComponentSessionHost({
    registry,
    resolveExecutor: (candidate: typeof workerId) => (candidate === workerId ? shared : undefined),
    resolveExecutionBinding: (_binding, target) => Promise.resolve(executionBinding(target)),
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
    binding: executionBinding(registration.target),
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
    resolveExecutionBinding: (_binding, target) => Promise.resolve(executionBinding(target)),
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
    binding: executionBinding(registration.target),
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
