import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeRuntimeHost, packPlugin } from "@tegojs/cli";
import {
  diagnosticCode,
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseComponentId,
  parseFencingEpoch,
  parseGeneration,
  parsePluginId,
  parseTaskId,
  parseWorkerId,
} from "@tegojs/contracts";
import { MemoryStateStore, SqliteStateStore } from "@tegojs/drivers-local";
import { ComponentEffects, ComponentRegistry, Reconciler } from "@tegojs/runtime";
import { eventually, FakeClock } from "@tegojs/testkit";
import { MemoryRemoteAttemptStore, RemoteExecutor } from "@tegojs/transport-websocket";
import { DeterministicRemoteSession } from "../fixtures/runtime-fault-session.mjs";

const applicationId = parseApplicationId("app");
const pluginId = parsePluginId("org.example.fault");
const componentId = parseComponentId("fault-service");
const digest = parseArtifactDigest(`sha256:${"1".repeat(64)}`);

function manifest() {
  return {
    schemaVersion: "1.0",
    pluginId,
    version: "1.0.0",
    contractRange: ">=0.0.0",
    nodeRange: ">=26.0.0",
    moduleFormat: "esm",
    components: [
      {
        componentId,
        kind: "service",
        entrypoint: "components/fault.js",
        executors: ["thread"],
      },
    ],
    permissions: [{ kind: "executor", executors: ["thread"] }],
    capabilities: { provides: [], requires: [] },
  };
}

function installation() {
  return {
    pluginId,
    version: "1.0.0",
    digest,
    manifest: manifest(),
    installedAt: new Date(0).toISOString(),
  };
}

function deployment() {
  return {
    applicationId,
    pluginId,
    version: "1.0.0",
    artifactDigest: digest,
    generation: parseGeneration("1"),
    state: "active",
    essential: true,
    configuration: {},
    permissionGrants: [{ kind: "executor", executors: ["thread"] }],
    capabilityBindings: {},
  };
}

function artifact() {
  return {
    digest,
    files: {
      schemaVersion: "1.0",
      files: [{ path: "components/fault.js", sha256: digest, size: 1 }],
    },
    manifest: manifest(),
  };
}

function realComponentEffects(startDeliveries, options = {}) {
  const registry = new ComponentRegistry();
  let failPrepares = options.failPrepares ?? 0;
  const prepared = Object.freeze({
    digest,
    root: "/immutable/fault-artifact",
    manifest: manifest(),
  });
  const cache = {
    prepares: 0,
    releases: 0,
    async prepare(request) {
      assert.equal(request.digest, digest);
      this.prepares += 1;
      if (failPrepares > 0) {
        failPrepares -= 1;
        throw new Error("FAULT_INJECTED_STARTING_RESTORE_PREPARE_FAILURE");
      }
      return prepared;
    },
    async release(releasedDigest) {
      assert.equal(releasedDigest, digest);
      this.releases += 1;
    },
  };
  const effects = new ComponentEffects({
    artifacts: cache,
    registry,
    supportedExecutors: ["thread"],
    resolveDeployment: async (effect) => {
      assert.equal(effect.deploymentGeneration, deployment().generation);
      assert.equal(effect.activation, "1");
      assert.equal(effect.artifactDigest, digest);
      assert.equal(effect.executor, "thread");
      return {
        deployment: deployment(),
        artifact: {
          digest,
          manifest: manifest(),
        },
      };
    },
    host: {
      async start(binding) {
        assert.equal(registry.require(binding.instanceId).state, "prepared");
        startDeliveries.push({
          activation: binding.activation,
          artifactDigest: binding.artifact.digest,
          deploymentGeneration: binding.deployment.generation,
          executor: binding.executor,
          instanceId: binding.instanceId,
        });
      },
      async drain() {},
      async stop() {},
    },
  });
  return { cache, effects, registry };
}

class IdempotentEffects {
  supportedExecutors = ["thread"];
  effectiveStarts = new Set();
  live = new Set();
  startDeliveries = 0;

  async perform(effect) {
    if (effect.kind === "start") {
      this.startDeliveries += 1;
      this.effectiveStarts.add(effect.operationId);
      this.live.add(effect.instanceId);
    }
    if (effect.kind === "stop") this.live.delete(effect.instanceId);
  }

  cleanup() {
    this.live.clear();
  }
}

function faultStartCommitOnce(state) {
  let injected = false;
  return new Proxy(state, {
    get(target, property) {
      if (property === "transact") {
        return (options, work) =>
          target.transact(options, (transaction) =>
            work(
              new Proxy(transaction, {
                get(transactionTarget, transactionProperty) {
                  if (transactionProperty === "appendOperation") {
                    return async (entry) => {
                      if (
                        !injected &&
                        entry.status === "completed" &&
                        entry.state?.effect?.kind === "start"
                      ) {
                        injected = true;
                        throw new Error("FAULT_INJECTED_START_COMMIT_INTERRUPTION");
                      }
                      return transactionTarget.appendOperation(entry);
                    };
                  }
                  const value = Reflect.get(transactionTarget, transactionProperty);
                  return typeof value === "function" ? value.bind(transactionTarget) : value;
                },
              }),
            ),
          );
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function executionRequest(workerId) {
  return {
    taskId: parseTaskId("fault-remote-task"),
    attemptId: parseAttemptId("fault-remote-attempt"),
    target: {
      instanceId: "app.org.example.fault.task.g1",
      deploymentGeneration: parseGeneration("1"),
      artifactDigest: digest,
      executor: { id: "fault-remote", type: "remote", workerId },
    },
    applicationId,
    pluginId,
    componentId,
    input: { injected: "duplicate-terminal" },
    deadline: new Date(60_000).toISOString(),
    orphanPolicy: "finish-and-buffer",
  };
}

function terminalResult(request) {
  return {
    taskId: request.taskId,
    attemptId: request.attemptId,
    status: "succeeded",
    output: { effective: "once" },
    executor: { kind: "remote", workerId: request.target.executor.workerId },
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
  };
}

async function readMarkerLoadCount(markerPath, read = readFile) {
  try {
    const contents = await read(markerPath, "utf8");
    return contents.trim().split("\n").filter(Boolean).length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function cleanupPermissionFaultEvidence({ directory, host, primaryError, remove = rm }) {
  let teardownComplete = host === undefined;
  let teardownError;
  try {
    if (host !== undefined) {
      await host.runtime.stop();
      teardownComplete = true;
    }
  } catch (error) {
    teardownError = error;
  }

  if (teardownError !== undefined) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, teardownError],
        "Permission fault test and runtime teardown both failed",
      );
    }
    throw teardownError;
  }

  assert.equal(teardownComplete, true, "runtime teardown must complete before evidence deletion");

  try {
    await remove(directory, { recursive: true, force: true });
  } catch (removalError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, removalError],
        "Permission fault test and evidence removal both failed",
      );
    }
    throw removalError;
  }

  if (primaryError !== undefined) throw primaryError;
}

test("@spec:plugin-deployment/idempotent-reconciliation/fault-after-effect-before-commit", async () => {
  const clock = new FakeClock(new Date(0));
  const backingState = new MemoryStateStore({ clock });
  const state = faultStartCommitOnce(backingState);
  const effects = new IdempotentEffects();
  await state.open();
  try {
    const options = {
      artifactGate: { validate: async () => artifact() },
      clock,
      effects,
      state,
      loadDeployments: async () => [deployment()],
      loadInstallations: async () => [installation()],
    };
    const interrupted = new Reconciler(options);
    await assert.rejects(interrupted.start(), /FAULT_INJECTED_START_COMMIT_INTERRUPTION/u);
    await interrupted.stop();

    clock.advanceBy(31_000);
    const recovered = new Reconciler(options);
    await recovered.start();
    await recovered.wake();

    assert.equal(effects.startDeliveries, 2);
    assert.equal(effects.effectiveStarts.size, 1);
    assert.equal(effects.live.size, 1);
    const instances = [];
    for await (const record of state.scan({
      namespace: "tego",
      collection: "component-instances",
    })) {
      instances.push(record);
    }
    assert.equal(instances.filter((record) => record.value.lifecycle === "ready").length, 1);

    await recovered.stop();
    effects.cleanup();
    assert.equal(effects.live.size, 0);
  } finally {
    await state.close();
  }
});

test("@spec:runtime-bootstrap/durable-restart-recovery/starting-checkpoint-real-effects starting checkpoint", async () => {
  const clock = new FakeClock(new Date(0));
  const backingState = new MemoryStateStore({ clock });
  const state = faultStartCommitOnce(backingState);
  const startDeliveries = [];
  await state.open();
  let interrupted;
  let recovered;
  try {
    const firstRuntime = realComponentEffects(startDeliveries);
    interrupted = new Reconciler({
      artifactGate: { validate: async () => artifact() },
      clock,
      effects: firstRuntime.effects,
      state,
      loadDeployments: async () => [deployment()],
      loadInstallations: async () => [installation()],
    });
    await assert.rejects(interrupted.start(), /FAULT_INJECTED_START_COMMIT_INTERRUPTION/u);

    const interruptedInstances = [];
    for await (const record of state.scan({
      namespace: "tego",
      collection: "component-instances",
    })) {
      interruptedInstances.push(record);
    }
    const checkpoint = interruptedInstances.find((record) => record.value.lifecycle === "starting");
    assert.ok(checkpoint);
    assert.equal(startDeliveries.length, 1);

    clock.advanceBy(31_000);
    const secondRuntime = realComponentEffects(startDeliveries, { failPrepares: 1 });
    recovered = new Reconciler({
      artifactGate: { validate: async () => artifact() },
      clock,
      effects: secondRuntime.effects,
      state,
      loadDeployments: async () => [deployment()],
      loadInstallations: async () => [installation()],
    });
    await recovered.start();

    const deferred = await state.read(checkpoint.key);
    assert.equal(deferred?.value.lifecycle, "starting");
    assert.equal(deferred?.value.diagnostic?.code, "LIFECYCLE_RESTORE_FAILED");
    assert.equal(startDeliveries.length, 1);

    clock.advanceBy(60_000);
    await recovered.wake();

    const restored = await state.read(checkpoint.key);
    assert.equal(restored?.value.lifecycle, "ready");
    assert.equal(restored?.value.diagnostic, undefined);
    assert.equal(restored?.value.retryEffect, undefined);
    assert.equal(startDeliveries.length, 2);
    assert.deepEqual(startDeliveries[1], startDeliveries[0]);
    const active = secondRuntime.registry.require(checkpoint.value.instanceId);
    assert.equal(active.state, "active");
    assert.equal(active.binding.activation, checkpoint.value.activation);
    assert.equal(active.binding.deployment.generation, checkpoint.value.deploymentGeneration);
    assert.equal(active.binding.artifact.digest, checkpoint.value.artifactDigest);
    assert.equal(active.binding.executor, checkpoint.value.executor);
  } finally {
    await recovered?.stop();
    await interrupted?.stop();
    await state.close();
  }
});

test("@spec:coordination-provider/fenced-leadership/stale-epoch-fault", async () => {
  const state = new MemoryStateStore({ clock: new FakeClock(new Date(0)) });
  const key = { namespace: "fault", collection: "authority", id: "runtime" };
  const staleKey = { namespace: "fault", collection: "authority", id: "stale-write" };
  await state.open();
  try {
    await state.transact(
      { fencing: { resource: "runtime", epoch: parseFencingEpoch("2") } },
      async (transaction) => {
        await transaction.put(key, { owner: "leader-b" }, { expectedRevision: "absent" });
        return null;
      },
    );

    await assert.rejects(
      state.transact(
        { fencing: { resource: "runtime", epoch: parseFencingEpoch("1") } },
        async (transaction) => {
          await transaction.put(staleKey, { owner: "leader-a" }, { expectedRevision: "absent" });
          return null;
        },
      ),
      (error) => diagnosticCode(error) === "STATE_FENCE_STALE",
    );
    assert.equal((await state.read(key))?.value.owner, "leader-b");
    assert.equal(await state.read(staleKey), undefined);
  } finally {
    await state.close();
  }
  await assert.rejects(state.read(key), (error) => diagnosticCode(error) === "STATE_CLOSED");
});

test("@spec:worker-protocol/durable-worker-attempts/duplicate-terminal-result-fault", async () => {
  const workerId = parseWorkerId("worker-fault");
  const terminalSaves = [];
  const attemptStore = new MemoryRemoteAttemptStore({
    onSave: (record) => {
      if (record.state === "terminal") terminalSaves.push(record);
    },
  });
  const remote = new RemoteExecutor({
    id: "fault-remote",
    workerId,
    clock: new FakeClock(new Date(0)),
    attemptStore,
  });
  const session = new DeterministicRemoteSession();
  await remote.attach(session);
  try {
    const request = executionRequest(workerId);
    const handle = await remote.submit(request);
    const result = terminalResult(request);
    session.emitResult(result, "original");
    session.emitResult(result, "duplicate");

    assert.deepEqual(await handle.result, result);
    await eventually(() => assert.equal(session.resultAcknowledgements.length, 2));
    assert.equal(terminalSaves.length, 1);
    assert.equal(
      (await attemptStore.list(workerId)).filter((record) => record.state === "terminal").length,
      1,
    );
    assert.equal(
      new Set(
        session.resultAcknowledgements.map(
          (acknowledgement) =>
            `${acknowledgement.taskId.length}:${acknowledgement.taskId}${acknowledgement.attemptId}`,
        ),
      ).size,
      1,
    );
  } finally {
    await remote.close();
    session.close();
  }
  assert.deepEqual(await remote.health(), {
    id: "fault-remote",
    type: "remote",
    status: "unhealthy",
    checkedAt: new Date(0).toISOString(),
    accepting: false,
    active: 0,
    queued: 0,
    retainedAttempts: 1,
  });
});

test("@spec:plugin-deployment/pre-execution-deployment-gate/permission-before-import-fault", async () => {
  const markerReadError = Object.assign(new Error("FAULT_INJECTED_MARKER_READ_FAILURE"), {
    code: "EACCES",
  });
  await assert.rejects(
    readMarkerLoadCount("unused", async () => {
      throw markerReadError;
    }),
    (error) => error === markerReadError,
  );

  const primaryError = new Error("FAULT_INJECTED_PRIMARY_FAILURE");
  const stopError = new Error("FAULT_INJECTED_STOP_FAILURE");
  const cleanupEvents = [];
  await assert.rejects(
    cleanupPermissionFaultEvidence({
      directory: "unused",
      host: {
        runtime: {
          stop: async () => {
            cleanupEvents.push("stop");
            throw stopError;
          },
        },
      },
      primaryError,
      remove: async () => cleanupEvents.push("remove"),
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors[0] === primaryError &&
      error.errors[1] === stopError,
  );
  assert.deepEqual(cleanupEvents, ["stop"]);

  const directory = await mkdtemp(join(tmpdir(), "tego-permission-fault-"));
  const pluginDirectory = join(directory, "plugin");
  const buildDirectory = join(pluginDirectory, "build", "components");
  const markerPath = join(directory, "plugin-loads.txt");
  const dataDirectory = join(directory, "runtime");
  let host;
  let testError;
  try {
    await mkdir(buildDirectory, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(
      join(pluginDirectory, "manifest.json"),
      `${JSON.stringify({
        ...manifest(),
        pluginId: "org.example.permission-fault",
        components: [
          {
            componentId: "fault",
            kind: "task",
            entrypoint: "components/fault.js",
            executors: ["thread"],
          },
        ],
      })}\n`,
    );
    await writeFile(
      join(buildDirectory, "fault.js"),
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(markerPath)}, "loaded\\n");`,
        'export default { protocol: "tego.component/1.0", kind: "task", async run() { return null; } };',
        "",
      ].join("\n"),
    );
    const packed = await packPlugin({
      artifactPath: join(directory, "permission-fault.tego"),
      build: false,
      pluginDirectory,
    });
    host = await createNodeRuntimeHost({
      applicationId: "application-default",
      dataDirectory,
      mode: "single-main",
      nodeId: "node-permission-fault",
      runtimeId: "runtime-permission-fault",
    });
    await host.runtime.start();
    await host.artifactIngress.putPath(packed.artifactPath);
    await host.runtime.operations.installPlugin({ digest: packed.digest });
    await host.runtime.stop();
    host = undefined;

    const state = new SqliteStateStore({
      databasePath: join(dataDirectory, "state.sqlite"),
    });
    await state.open();
    try {
      await state.transact({}, async (transaction) => {
        await transaction.put(
          {
            namespace: "tego",
            collection: "deployments",
            id: "application-default/org.example.permission-fault",
          },
          {
            applicationId: "application-default",
            pluginId: "org.example.permission-fault",
            version: "1.0.0",
            artifactDigest: packed.digest,
            generation: "1",
            state: "active",
            essential: true,
            configuration: {},
            permissionGrants: [
              { kind: "executor", executors: ["thread"] },
              { kind: "environment", names: ["FAULT_INJECTION"] },
            ],
            capabilityBindings: {},
          },
          { expectedRevision: "absent" },
        );
        return null;
      });
    } finally {
      await state.close();
    }

    host = await createNodeRuntimeHost({
      applicationId: "application-default",
      dataDirectory,
      mode: "single-main",
      nodeId: "node-permission-fault-recovered",
      runtimeId: "runtime-permission-fault",
    });
    await host.runtime.start();
    const blocked = await eventually(async () => {
      const status = await host.runtime.operations.pluginStatus({
        applicationId: "application-default",
        pluginId: "org.example.permission-fault",
      });
      return status.observation?.status === "blocked" ? status : undefined;
    });
    assert.equal(
      blocked.observation.diagnostics.some(
        (diagnostic) => diagnostic.code === "PERMISSION_GRANT_EXCEEDS_REQUEST",
      ),
      true,
    );
    const loadCount = await readMarkerLoadCount(markerPath);
    assert.equal(loadCount, 0);
  } catch (error) {
    testError = error;
  } finally {
    await cleanupPermissionFaultEvidence({
      directory,
      host,
      primaryError: testError,
    });
  }
});
