import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Executor,
  parseApplicationId,
  parseArtifactDigest,
  parseComponentId,
  parseComponentInstanceId,
  parseGeneration,
  parsePluginId,
  type RunTaskRequest,
  type TaskExecutionTarget,
} from "@tegojs/contracts";
import * as cli from "../src/index.js";

interface SessionRegistration {
  readonly applicationId: ReturnType<typeof parseApplicationId>;
  readonly pluginId: ReturnType<typeof parsePluginId>;
  readonly componentId: ReturnType<typeof parseComponentId>;
  readonly target: TaskExecutionTarget;
  readonly executor: Executor;
  readonly drainLifecycle: Executor["drain"];
}

interface SessionRegistry {
  register(registration: SessionRegistration): void;
  markDraining(target: TaskExecutionTarget): void;
  resolveExact(target: TaskExecutionTarget): SessionRegistration;
  resolveFresh(
    request: RunTaskRequest,
    isComponentAccepting?: (target: TaskExecutionTarget) => boolean,
  ): SessionRegistration;
  remove(target: TaskExecutionTarget): SessionRegistration;
  close(): Promise<void>;
}

type SessionRegistryConstructor = new (runtimeId: string) => SessionRegistry;

function target(generation: string, executor: "process" | "thread"): TaskExecutionTarget {
  return {
    instanceId: parseComponentInstanceId(`instance-${generation}-${executor}`),
    deploymentGeneration: parseGeneration(generation),
    artifactDigest: parseArtifactDigest(`sha256:${generation.padStart(64, "0")}`),
    executor: {
      id: `node-local:${executor}`,
      type: executor,
    },
  };
}

function executor(target: TaskExecutionTarget): Executor {
  return {
    id: target.executor.id,
    type: target.executor.type,
    probe: async () => ({
      id: target.executor.id,
      type: target.executor.type,
      available: true,
      maxConcurrency: 1,
      availableCapacity: 1,
      securityIsolation: target.executor.type === "process",
    }),
    submit: async () => {
      throw new Error("unused");
    },
    observe: async () => undefined,
    cancel: async () => undefined,
    drain: async () => undefined,
    health: async () => ({
      id: target.executor.id,
      type: target.executor.type,
      status: "healthy",
      checkedAt: new Date(0).toISOString(),
      accepting: true,
      active: 0,
      queued: 0,
      retainedAttempts: 0,
    }),
    close: async () => undefined,
  };
}

function registration(executionTarget: TaskExecutionTarget): SessionRegistration {
  return {
    applicationId: parseApplicationId("application-default"),
    pluginId: parsePluginId("org.example.echo"),
    componentId: parseComponentId("echo"),
    target: executionTarget,
    executor: executor(executionTarget),
    drainLifecycle: async () => undefined,
  };
}

function taskRequest(): RunTaskRequest {
  return {
    applicationId: parseApplicationId("application-default"),
    pluginId: parsePluginId("org.example.echo"),
    componentId: parseComponentId("echo"),
    input: null,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    orphanPolicy: "finish-and-persist",
  };
}

test("local session registry keys exact targets and keeps draining sessions recoverable", async () => {
  const Registry = (
    cli as typeof cli & {
      readonly LocalComponentSessionRegistry?: SessionRegistryConstructor;
    }
  ).LocalComponentSessionRegistry;
  assert.equal(typeof Registry, "function", "CLI must export LocalComponentSessionRegistry");
  const registry = new (Registry as SessionRegistryConstructor)("runtime-local");
  const threadTarget = target("1", "thread");
  const processTarget = target("2", "process");
  const thread = registration(threadTarget);
  const process = registration(processTarget);

  registry.register(thread);
  assert.throws(
    () => registry.resolveFresh(taskRequest(), () => false),
    /no active accepting/iu,
    "fresh selection must also require lifecycle registry admission",
  );
  registry.register(process);
  assert.throws(
    () => registry.resolveFresh(taskRequest()),
    /ambiguous/iu,
    "fresh selection must fail closed while two matching sessions accept work",
  );

  registry.markDraining(threadTarget);
  assert.deepEqual(registry.resolveFresh(taskRequest()).target, processTarget);
  assert.equal(registry.resolveExact(threadTarget).executor, thread.executor);

  registry.remove(threadTarget);
  assert.throws(() => registry.resolveExact(threadTarget), /missing|unavailable/iu);
  await registry.close();
});

test("local session registry owns deeply frozen target snapshots", async () => {
  const Registry = (
    cli as typeof cli & {
      readonly LocalComponentSessionRegistry?: SessionRegistryConstructor;
    }
  ).LocalComponentSessionRegistry;
  assert.equal(typeof Registry, "function", "CLI must export LocalComponentSessionRegistry");
  const registry = new (Registry as SessionRegistryConstructor)("runtime-local");
  const executionTarget = target("1", "thread");
  registry.register(registration(executionTarget));

  const resolved = registry.resolveExact(executionTarget);
  assert.equal(Object.isFrozen(resolved.target), true);
  assert.equal(Object.isFrozen(resolved.target.executor), true);
  assert.throws(() => {
    (resolved.target.executor as { id: string }).id = "node-mutated:thread";
  }, TypeError);
  assert.deepEqual(registry.resolveExact(executionTarget).target, executionTarget);

  await registry.close();
});
