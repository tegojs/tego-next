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
import { Reconciler } from "@tegojs/runtime";
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
  const directory = await mkdtemp(join(tmpdir(), "tego-permission-fault-"));
  const pluginDirectory = join(directory, "plugin");
  const buildDirectory = join(pluginDirectory, "build", "components");
  const markerPath = join(directory, "plugin-loads.txt");
  const dataDirectory = join(directory, "runtime");
  let host;
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
    const loadCount = await readFile(markerPath, "utf8")
      .then((contents) => contents.trim().split("\n").filter(Boolean).length)
      .catch(() => 0);
    assert.equal(loadCount, 0);
  } finally {
    await host?.runtime.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
