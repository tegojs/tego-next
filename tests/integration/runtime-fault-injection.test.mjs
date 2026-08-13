import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createNodeRuntimeHost, packPlugin, StateRemoteAttemptStore } from "@tego/cli";
import {
  createExecutionBinding,
  diagnosticCode,
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseComponentId,
  parseFencingEpoch,
  parseGeneration,
  parsePluginId,
  parseTaskExecutionTarget,
  parseTaskId,
  parseWorkerId,
} from "@tego/contracts";
import { MemoryStateStore, SqliteStateStore } from "@tego/drivers-local";
import { createPostgresDrivers, PostgresStateStore } from "@tego/drivers-postgres";
import { ComponentEffects, ComponentRegistry, Reconciler } from "@tego/runtime";
import { eventually, FakeClock } from "@tego/testkit";
import { MemoryRemoteAttemptStore, RemoteExecutor } from "@tego/transport-websocket";
import { Pool } from "pg";
import { DeterministicRemoteSession } from "../fixtures/runtime-fault-session.mjs";
import {
  assertDisposablePostgresNamespace,
  cleanupPostgresNamespace,
} from "../support/postgres-namespace.mjs";

const applicationId = parseApplicationId("app");
const pluginId = parsePluginId("org.example.fault");
const componentId = parseComponentId("fault-service");
const digest = parseArtifactDigest(`sha256:${"1".repeat(64)}`);

async function runWithCleanup(run, cleanups) {
  let result;
  let primaryError;
  try {
    result = await run();
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const errors = [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Runtime fault test and cleanup completed with failures");
  }
  return result;
}

test("fault harness preserves primary and teardown failures", async () => {
  await assert.rejects(
    runWithCleanup(async () => {
      throw new Error("primary failure");
    }, [
      async () => {
        throw new Error("close failure");
      },
      async () => {},
    ]),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((candidate) => candidate.message),
        ["primary failure", "close failure"],
      );
      return true;
    },
  );
});

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
      async prepare(binding, persisted) {
        if (persisted !== undefined) return persisted;
        const target = parseTaskExecutionTarget({
          instanceId: binding.instanceId,
          deploymentGeneration: binding.deployment.generation,
          artifactDigest: binding.artifact.digest,
          executor: { id: "fault-thread", type: "thread" },
        });
        return createExecutionBinding(
          {
            applicationId: binding.deployment.applicationId,
            pluginId: binding.deployment.pluginId,
            componentId: binding.component.componentId,
            target,
          },
          {
            configuration: binding.deployment.configuration,
            permissionGrants: binding.deployment.permissionGrants,
            capabilityDefinitions: [],
            capabilityBindings: [],
          },
        );
      },
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
  const target = {
    instanceId: "app.org.example.fault.task.g1",
    deploymentGeneration: parseGeneration("1"),
    artifactDigest: digest,
    executor: { id: "fault-remote", type: "remote", workerId },
  };
  const request = {
    taskId: parseTaskId("fault-remote-task"),
    attemptId: parseAttemptId("fault-remote-attempt"),
    target,
    applicationId,
    pluginId,
    componentId,
    input: { injected: "duplicate-terminal" },
    deadline: new Date(60_000).toISOString(),
    orphanPolicy: "finish-and-buffer",
  };
  return {
    ...request,
    binding: createExecutionBinding(
      { applicationId, pluginId, componentId, target },
      {
        configuration: {},
        permissionGrants: [{ kind: "executor", executors: ["remote"] }],
        capabilityDefinitions: [],
        capabilityBindings: [],
      },
    ),
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
    const makeDirectoriesWritable = async (path) => {
      const identity = await lstat(path).catch(() => undefined);
      if (identity === undefined || identity.isSymbolicLink() || !identity.isDirectory()) return;
      await chmod(path, 0o700);
      for (const entry of await readdir(path)) {
        await makeDirectoriesWritable(join(path, entry));
      }
    };
    await makeDirectoriesWritable(directory);
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

async function withFaultStateStores(t, run) {
  await t.test("MemoryStateStore", async () => {
    const store = new MemoryStateStore({ clock: new FakeClock(new Date(0)) });
    await store.open();
    try {
      await run(store);
    } finally {
      await store.close();
    }
  });
  await t.test("SqliteStateStore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tego-runtime-fault-store-"));
    const store = new SqliteStateStore({
      clock: new FakeClock(new Date(0)),
      databasePath: join(directory, "state.sqlite"),
    });
    await store.open();
    try {
      await run(store);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

async function withRestartableFaultStateStores(t, run) {
  await t.test("MemoryStateStore", async () => {
    const clock = new FakeClock(new Date(0));
    const store = new MemoryStateStore({ clock });
    await store.open();
    await runWithCleanup(() => run(store, clock, async () => store), [() => store.close()]);
  });
  await t.test("SqliteStateStore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tego-runtime-fault-restart-"));
    const databasePath = join(directory, "state.sqlite");
    const clock = new FakeClock(new Date(0));
    let store = new SqliteStateStore({ clock, databasePath });
    await store.open();
    await runWithCleanup(
      () =>
        run(store, clock, async () => {
          await store.close();
          store = new SqliteStateStore({ clock, databasePath });
          await store.open();
          return store;
        }),
      [() => store.close(), () => rm(directory, { recursive: true, force: true })],
    );
  });
}

test("namespace cleanup rejects unsafe targets before opening PostgreSQL", async () => {
  for (const namespace of ["", "tego", "public", "*", "%", "../x", "runtime-default"]) {
    assert.throws(
      () => assertDisposablePostgresNamespace(namespace),
      /UNSAFE_POSTGRES_TEST_NAMESPACE/u,
    );
    await assert.rejects(
      cleanupPostgresNamespace({ connectionString: "not a PostgreSQL URL", namespace }),
      /UNSAFE_POSTGRES_TEST_NAMESPACE/u,
    );
  }
  for (const namespace of ["test_fault_1", "test_a_b", "test_123_a_b_c"]) {
    assert.doesNotThrow(() => assertDisposablePostgresNamespace(namespace));
  }
});

test("namespace cleanup bounds a never-settling query and pool end", async () => {
  const releaseCalls = [];
  const client = {
    query() {
      return new Promise(() => {});
    },
    release(destroy) {
      releaseCalls.push(destroy);
    },
  };
  const startedAt = Date.now();
  await assert.rejects(
    cleanupPostgresNamespace({
      connectionString: "unused",
      namespace: "test_timeout_query",
      timeoutMs: 30,
      createPool: () => ({
        connect: async () => client,
        end: () => new Promise(() => {}),
      }),
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, /POSTGRES_NAMESPACE_CLEANUP_TIMEOUT:BEGIN/u);
      assert.match(error.errors.at(-1).message, /POSTGRES_NAMESPACE_CLEANUP_TIMEOUT:pool.end/u);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(releaseCalls, [true]);
});

test("namespace cleanup destroys a client acquired after its deadline", async () => {
  const releaseCalls = [];
  const lateClient = {
    release(destroy) {
      releaseCalls.push(destroy);
    },
  };
  let resolveConnect;
  await assert.rejects(
    cleanupPostgresNamespace({
      connectionString: "unused",
      namespace: "test_timeout_connect",
      timeoutMs: 20,
      cleanupGraceMs: 100,
      createPool: () => ({
        connect: () =>
          new Promise((resolve) => {
            resolveConnect = resolve;
            setTimeout(() => resolve(lateClient), 30);
          }),
        async end() {},
      }),
    }),
    /POSTGRES_NAMESPACE_CLEANUP_TIMEOUT:connect/u,
  );
  assert.equal(typeof resolveConnect, "function");
  assert.deepEqual(releaseCalls, [true]);
});

test("namespace cleanup aggregates a late client destroy error before returning", async () => {
  const releaseError = new Error("late release failed");
  let resolveConnect;
  await assert.rejects(
    cleanupPostgresNamespace({
      connectionString: "unused",
      namespace: "test_late_release_error",
      timeoutMs: 20,
      cleanupGraceMs: 100,
      createPool: () => ({
        connect: () =>
          new Promise((resolve) => {
            resolveConnect = resolve;
            setTimeout(
              () =>
                resolve({
                  release(destroy) {
                    assert.equal(destroy, true);
                    throw releaseError;
                  },
                }),
              30,
            );
          }),
        async end() {},
      }),
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, /POSTGRES_NAMESPACE_CLEANUP_TIMEOUT:connect/u);
      assert.equal(error.errors[1], releaseError);
      return true;
    },
  );
  assert.equal(typeof resolveConnect, "function");
});

test("namespace cleanup aggregates primary rollback release and pool errors in order", async () => {
  const primaryError = new Error("delete failed");
  const rollbackError = new Error("rollback failed");
  const releaseError = new Error("release failed");
  const endError = new Error("pool end failed");
  let queryIndex = 0;
  await assert.rejects(
    cleanupPostgresNamespace({
      connectionString: "unused",
      namespace: "test_errors_order",
      timeoutMs: 1_000,
      createPool: () => ({
        connect: async () => ({
          async query() {
            queryIndex += 1;
            if (queryIndex === 4) throw primaryError;
            if (queryIndex === 5) throw rollbackError;
          },
          release() {
            throw releaseError;
          },
        }),
        async end() {
          throw endError;
        },
      }),
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primaryError, rollbackError, releaseError, endError]);
      return true;
    },
  );
});

test("namespace cleanup bounds and reports a never-settling release promise", async () => {
  const primaryError = new Error("query failed before release");
  let queryIndex = 0;
  const startedAt = Date.now();
  await assert.rejects(
    cleanupPostgresNamespace({
      connectionString: "unused",
      namespace: "test_release_timeout",
      timeoutMs: 30,
      cleanupGraceMs: 30,
      createPool: () => ({
        async connect() {
          return {
            async query() {
              queryIndex += 1;
              if (queryIndex === 4) throw primaryError;
            },
            release() {
              return new Promise(() => {});
            },
          };
        },
        async end() {},
      }),
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], primaryError);
      assert.match(error.errors[1].message, /POSTGRES_NAMESPACE_CLEANUP_TIMEOUT:release/u);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 500);
});

test("namespace cleanup releases an acquisition that settles after return and reports its error", async () => {
  const lateReleaseError = new Error("post-return late release failed");
  const lateErrors = [];
  let resolveConnect;
  let releaseCalled = false;
  await assert.rejects(
    cleanupPostgresNamespace({
      connectionString: "unused",
      namespace: "test_post_return_release",
      timeoutMs: 20,
      cleanupGraceMs: 20,
      onLateCleanupError(error) {
        lateErrors.push(error);
      },
      createPool: () => ({
        connect() {
          return new Promise((resolve) => {
            resolveConnect = resolve;
          });
        },
        async end() {},
      }),
    }),
    /POSTGRES_NAMESPACE_CLEANUP_TIMEOUT:connect/u,
  );

  resolveConnect({
    release(destroy) {
      assert.equal(destroy, true);
      releaseCalled = true;
      return Promise.reject(lateReleaseError);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(releaseCalled, true);
  assert.deepEqual(lateErrors, [lateReleaseError]);
});

test("namespace cleanup deletes one exact namespace and preserves another byte-for-byte", {
  skip: process.env.TEGO_POSTGRES_URL === undefined ? "TEGO_POSTGRES_URL is required" : false,
}, async () => {
  const run = `${process.pid}_${Date.now()}`;
  const removedNamespace = `test_cleanup_${run}`;
  const preservedNamespace = `test_preserved_${run}`;
  const removed = new PostgresStateStore({
    connectionString: process.env.TEGO_POSTGRES_URL,
    namespace: removedNamespace,
  });
  const preserved = new PostgresStateStore({
    connectionString: process.env.TEGO_POSTGRES_URL,
    namespace: preservedNamespace,
  });
  const observer = new Pool({ connectionString: process.env.TEGO_POSTGRES_URL, max: 1 });
  const snapshot = async (namespace) => {
    const rows = [];
    for (const table of [
      "tego_operation_history",
      "tego_operations",
      "tego_outbox",
      "tego_idempotency",
      "tego_state_changes",
      "tego_records",
      "tego_fences",
      "tego_state_revisions",
      "tego_coordination_changes",
      "tego_coordination_records",
      "tego_coordination_leases",
      "tego_coordination_epochs",
      "tego_coordination_revisions",
      "tego_artifacts",
      "tego_artifact_namespace_usage",
    ]) {
      const result = await observer.query(
        `SELECT to_jsonb(contents)::text AS contents
           FROM ${table} AS contents
          WHERE driver_namespace = $1
          ORDER BY to_jsonb(contents)::text`,
        [namespace],
      );
      rows.push(...result.rows.map(({ contents }) => ({ table, contents })));
    }
    return rows;
  };
  try {
    await Promise.all([removed.open(), preserved.open()]);
    await removed.transact({}, async (transaction) => {
      await transaction.put(
        { namespace: "fault", collection: "cleanup", id: "removed" },
        { owner: "removed", bytes: [1, 2, 3] },
        {},
      );
      return null;
    });
    await preserved.transact({}, async (transaction) => {
      await transaction.put(
        { namespace: "fault", collection: "cleanup", id: "preserved" },
        { owner: "preserved", bytes: [4, 5, 6] },
        {},
      );
      return null;
    });
    await Promise.all([removed.close(), preserved.close()]);
    const before = await snapshot(preservedNamespace);
    await cleanupPostgresNamespace({
      connectionString: process.env.TEGO_POSTGRES_URL,
      namespace: removedNamespace,
    });
    assert.deepEqual(await snapshot(removedNamespace), []);
    assert.deepEqual(await snapshot(preservedNamespace), before);
  } finally {
    await Promise.allSettled([removed.close(), preserved.close()]);
    await cleanupPostgresNamespace({
      connectionString: process.env.TEGO_POSTGRES_URL,
      namespace: removedNamespace,
    });
    await cleanupPostgresNamespace({
      connectionString: process.env.TEGO_POSTGRES_URL,
      namespace: preservedNamespace,
    });
    await observer.end();
  }
});

test("@spec:plugin-deployment/idempotent-reconciliation/fault-after-effect-before-commit", async (t) => {
  await withRestartableFaultStateStores(t, async (initialState, clock, reopen) => {
    const effects = new IdempotentEffects();
    const options = (state) => ({
      artifactGate: { validate: async () => artifact() },
      clock,
      effects,
      state,
      loadDeployments: async () => [deployment()],
      loadInstallations: async () => [installation()],
    });
    const interrupted = new Reconciler(options(faultStartCommitOnce(initialState)));
    await assert.rejects(interrupted.start(), /FAULT_INJECTED_START_COMMIT_INTERRUPTION/u);
    await interrupted.stop();

    clock.advanceBy(31_000);
    const state = await reopen();
    const recovered = new Reconciler(options(state));
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
  });
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

async function assertStaleAuthorityRejected(state) {
  const key = { namespace: "fault", collection: "authority", id: "runtime" };
  const staleKey = { namespace: "fault", collection: "authority", id: "stale-write" };
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
}

test("@spec:coordination-provider/fenced-leadership/stale-epoch-fault", async (t) => {
  await withFaultStateStores(t, assertStaleAuthorityRejected);
});

test("@spec:coordination-provider/fenced-leadership/postgres-stale-epoch-fault", {
  skip: process.env.TEGO_POSTGRES_URL === undefined ? "TEGO_POSTGRES_URL is required" : false,
}, async () => {
  const namespace = `test_fault_${process.pid}_${Date.now()}`;
  const state = new PostgresStateStore({
    connectionString: process.env.TEGO_POSTGRES_URL,
    namespace,
  });
  await state.open();
  try {
    await assertStaleAuthorityRejected(state);
  } finally {
    try {
      await state.close();
    } finally {
      await cleanupPostgresNamespace({
        connectionString: process.env.TEGO_POSTGRES_URL,
        namespace,
      });
    }
  }
});

test("@spec:plugin-deployment/idempotent-reconciliation/postgres-cluster-time-takeover", {
  skip: process.env.TEGO_POSTGRES_URL === undefined ? "TEGO_POSTGRES_URL is required" : false,
}, async () => {
  const namespace = `test_cluster_time_${process.pid}_${Date.now()}`;
  const drivers = createPostgresDrivers({
    connectionString: process.env.TEGO_POSTGRES_URL,
    namespace,
  });
  const createEffects = (failStart) => ({
    supportedExecutors: ["thread"],
    calls: [],
    live: new Set(),
    async perform(effect) {
      this.calls.push(effect);
      if (failStart && effect.kind === "start") throw new Error("cluster retry fault");
      if (effect.kind === "start") this.live.add(effect.instanceId);
      if (effect.kind === "stop") this.live.delete(effect.instanceId);
    },
    async restore(instance) {
      this.live.add(instance.instanceId);
    },
    isLive(instance) {
      return this.live.has(instance.instanceId);
    },
    async close() {
      this.live.clear();
    },
  });
  const farClock = (now) => ({
    now: () => new Date(now),
    sleep: (_delayMs, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  await Promise.all([drivers.state.open(), drivers.coordination.open()]);
  let first;
  let replacement;
  try {
    const resource = "runtime/app";
    const firstAuthority = {
      resource,
      epoch: await drivers.coordination.nextEpoch(resource),
    };
    const firstEffects = createEffects(true);
    first = new Reconciler({
      artifactGate: { validate: async () => artifact() },
      authority: firstAuthority,
      clock: farClock("2099-01-01T00:00:00.000Z"),
      clusterTime: drivers.clusterTime,
      effects: firstEffects,
      owner: "leader-a",
      state: drivers.state,
      loadDeployments: async () => [deployment()],
      loadInstallations: async () => [installation()],
    });

    const databaseBeforeFailure = await drivers.clusterTime.now();
    await first.start();
    const instanceId = firstEffects.calls.find((effect) => effect.kind === "start")?.instanceId;
    assert.ok(instanceId);
    const failed = await drivers.state.read({
      namespace: "tego",
      collection: "component-instances",
      id: instanceId,
    });
    const retryAt = failed?.value.retryAt;
    assert.equal(typeof retryAt, "string");
    assert.ok(Date.parse(retryAt) >= Date.parse(databaseBeforeFailure) + 1_000);
    assert.ok(Date.parse(retryAt) < Date.parse(databaseBeforeFailure) + 3_000);
    assert.ok(Date.parse(retryAt) < Date.parse("2030-01-01T00:00:00.000Z"));
    await first.stop();
    first = undefined;

    const replacementAuthority = {
      resource,
      epoch: await drivers.coordination.nextEpoch(resource),
    };
    const remaining = Date.parse(retryAt) - Date.parse(await drivers.clusterTime.now());
    if (remaining > 0) await delay(remaining + 100);
    const replacementEffects = createEffects(false);
    replacement = new Reconciler({
      artifactGate: { validate: async () => artifact() },
      authority: replacementAuthority,
      clock: farClock("2001-01-01T00:00:00.000Z"),
      clusterTime: drivers.clusterTime,
      effects: replacementEffects,
      owner: "leader-b",
      state: drivers.state,
      loadDeployments: async () => [deployment()],
      loadInstallations: async () => [installation()],
    });

    await replacement.start();

    assert.deepEqual(
      replacementEffects.calls.map((effect) => effect.kind),
      ["start"],
    );
    assert.equal(replacement.applicationReady(), true);
  } finally {
    await replacement?.stop();
    await first?.stop();
    try {
      await Promise.all([drivers.coordination.close(), drivers.state.close()]);
    } finally {
      await cleanupPostgresNamespace({
        connectionString: process.env.TEGO_POSTGRES_URL,
        namespace,
      });
    }
  }
});

test("@spec:worker-protocol/durable-worker-attempts/restart-terminal-replay-fault", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-remote-attempt-restart-"));
  const databasePath = join(directory, "state.sqlite");
  const workerId = parseWorkerId("worker-fault-restart");
  const request = executionRequest(workerId);
  const result = terminalResult(request);
  let state = new SqliteStateStore({ databasePath });
  let firstRemote;
  let secondRemote;
  let firstSession;
  let secondSession;
  await runWithCleanup(async () => {
    await state.open();
    firstRemote = new RemoteExecutor({
      id: "fault-remote",
      workerId,
      clock: new FakeClock(new Date(0)),
      attemptStore: new StateRemoteAttemptStore({ state, workerId }),
    });
    firstSession = new DeterministicRemoteSession();
    await firstRemote.attach(firstSession);
    const firstHandle = await firstRemote.submit(request);
    firstSession.emitResult(result, "before-restart");
    assert.deepEqual(await firstHandle.result, result);
    await eventually(() => assert.equal(firstSession.resultAcknowledgements.length, 1));
    await firstRemote.close();
    firstRemote = undefined;
    firstSession.close();
    firstSession = undefined;
    await state.close();

    state = new SqliteStateStore({ databasePath });
    await state.open();
    const reopenedAttempts = new StateRemoteAttemptStore({ state, workerId });
    secondRemote = new RemoteExecutor({
      id: "fault-remote",
      workerId,
      clock: new FakeClock(new Date(0)),
      attemptStore: reopenedAttempts,
    });
    secondSession = new DeterministicRemoteSession();
    secondSession.epoch = "2";
    const requestFromSession = secondSession.request.bind(secondSession);
    secondSession.request = async (type, payload) => {
      const response = await requestFromSession(type, payload);
      return type === "session.reconcile"
        ? {
            ...response,
            payload: {
              ...response.payload,
              terminalUnacknowledged: [{ result }],
            },
          }
        : response;
    };
    await secondRemote.attach(secondSession);
    const recovered = await secondRemote.submit(request);
    assert.deepEqual(await recovered.result, result);
    await eventually(() => assert.equal(secondSession.resultAcknowledgements.length, 1));

    const terminal = (await reopenedAttempts.list(workerId)).filter(
      (record) => record.state === "terminal",
    );
    assert.equal(terminal.length, 1);
    assert.deepEqual(terminal[0].result, result);
  }, [
    async () => secondRemote?.close(),
    async () => firstRemote?.close(),
    async () => secondSession?.close(),
    async () => firstSession?.close(),
    () => state.close(),
    () => rm(directory, { recursive: true, force: true }),
  ]);
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
    assert.equal(await readMarkerLoadCount(markerPath), 0);
    await host.runtime.stop();
    host = undefined;

    const correctedState = new SqliteStateStore({
      databasePath: join(dataDirectory, "state.sqlite"),
    });
    await correctedState.open();
    try {
      await correctedState.transact({}, async (transaction) => {
        const key = {
          namespace: "tego",
          collection: "deployments",
          id: "application-default/org.example.permission-fault",
        };
        const current = await transaction.get(key);
        assert.ok(current);
        await transaction.put(
          key,
          {
            ...current.value,
            permissionGrants: [{ kind: "executor", executors: ["thread"] }],
          },
          { expectedRevision: current.revision },
        );
        return null;
      });
    } finally {
      await correctedState.close();
    }

    host = await createNodeRuntimeHost({
      applicationId: "application-default",
      dataDirectory,
      mode: "single-main",
      nodeId: "node-permission-fault-corrected",
      runtimeId: "runtime-permission-fault",
    });
    await host.runtime.start();
    await eventually(async () => {
      const status = await host.runtime.operations.pluginStatus({
        applicationId: "application-default",
        pluginId: "org.example.permission-fault",
      });
      assert.equal(status.observation?.status, "ready");
    });
    assert.equal(await readMarkerLoadCount(markerPath), 1);
    const stableStatus = await host.runtime.operations.pluginStatus({
      applicationId: "application-default",
      pluginId: "org.example.permission-fault",
    });
    assert.equal(stableStatus.observation?.status, "ready");
    assert.equal(await readMarkerLoadCount(markerPath), 1);
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
