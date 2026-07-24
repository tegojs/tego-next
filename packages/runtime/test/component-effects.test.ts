import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseApplicationId,
  parseArtifactDigest,
  parseComponentId,
  parseFencingEpoch,
  parseGeneration,
  parseMessageId,
  parseOperationId,
  parsePluginId,
  type PluginDeployment,
  type RuntimeAuthority,
} from "@tegojs/contracts";
import type {
  PreparedArtifact,
  PreparedArtifactCache,
} from "../src/artifacts/prepared-artifact-cache.js";
import { ComponentEffects } from "../src/components/component-effects.js";
import { ComponentRegistry } from "../src/components/component-registry.js";
import type { ReconcileEffect, ReconcileEffectKind } from "../src/reconcile/plan.js";

const artifactDigest = parseArtifactDigest(`sha256:${"1".repeat(64)}`);
const applicationId = parseApplicationId("app");
const pluginId = parsePluginId("echo");
const componentId = parseComponentId("task");
const generation = parseGeneration("1");
const instanceId = "app.echo.task.g1";
const otherComponentId = parseComponentId("other-task");

const manifest = {
  schemaVersion: "1.0" as const,
  pluginId,
  version: "1.0.0",
  contractRange: ">=1 <2",
  nodeRange: ">=26 <27",
  moduleFormat: "esm" as const,
  components: [
    {
      componentId,
      kind: "task" as const,
      entrypoint: "components/task.js",
      executors: ["thread" as const],
    },
    {
      componentId: otherComponentId,
      kind: "task" as const,
      entrypoint: "components/other.js",
      executors: ["thread" as const],
    },
  ],
  permissions: [],
  capabilities: { provides: [], requires: [] },
};

const deployment: PluginDeployment = {
  applicationId,
  pluginId,
  version: "1.0.0",
  artifactDigest,
  generation,
  state: "active",
  essential: false,
  configuration: null,
  permissionGrants: [],
  capabilityBindings: {},
};

function effect(kind: ReconcileEffectKind): ReconcileEffect {
  return {
    kind,
    operationId: parseOperationId(`${kind}-operation`),
    messageId: parseMessageId(`${kind}-message`),
    instanceId,
    applicationId,
    pluginId,
    componentId,
    deploymentGeneration: generation,
    artifactDigest,
    executor: "thread",
  };
}

class ControlledCache implements Pick<PreparedArtifactCache, "close" | "prepare" | "release"> {
  readonly prepared: PreparedArtifact = Object.freeze({
    digest: artifactDigest,
    root: "/immutable/artifact",
    manifest,
  });
  prepares = 0;
  releases = 0;
  failRelease = false;
  failReleases = 0;
  result: PreparedArtifact = this.prepared;

  async prepare(): Promise<PreparedArtifact> {
    this.prepares += 1;
    return this.result;
  }
  async release(): Promise<void> {
    this.releases += 1;
    if (this.failRelease || this.failReleases-- > 0) throw new Error("release failed");
  }
  async close(): Promise<void> {}
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function harness(
  options: { readonly authority?: RuntimeAuthority; readonly deployment?: PluginDeployment } = {},
) {
  const cache = new ControlledCache();
  const registry = new ComponentRegistry();
  const calls: string[] = [];
  let failStops = 0;
  let failStarts = 0;
  let authority = options.authority;
  let startGate: Promise<void> | undefined;
  let stopGate: Promise<void> | undefined;
  const selectedDeployment = options.deployment ?? deployment;
  const validatedDeployment = {
    ...selectedDeployment,
    deployment: selectedDeployment,
    artifact: cache.prepared,
  } as PluginDeployment & {
    readonly deployment: PluginDeployment;
    readonly artifact: PreparedArtifact;
  };
  const effects = new ComponentEffects({
    artifacts: cache,
    registry,
    supportedExecutors: ["thread"],
    resolveDeployment: async () => validatedDeployment,
    authority: () => authority,
    host: {
      start: async (binding) => {
        assert.equal(Object.isFrozen(binding), true);
        calls.push(`start:${binding.instanceId}`);
        await startGate;
        if (failStarts-- > 0) throw new Error("host start failed");
      },
      drain: async (binding) => {
        calls.push(`drain:${binding.instanceId}`);
      },
      stop: async (binding) => {
        calls.push(`stop:${binding.instanceId}`);
        await stopGate;
        if (failStops-- > 0) throw new Error("host stop failed");
      },
    },
  });
  return {
    cache,
    calls,
    effects,
    registry,
    setAuthority(value: RuntimeAuthority | undefined) {
      authority = value;
    },
    setFailStarts(value: number) {
      failStarts = value;
    },
    setFailStops(value: number) {
      failStops = value;
    },
    setStartGate(value: Promise<void> | undefined) {
      startGate = value;
    },
    setStopGate(value: Promise<void> | undefined) {
      stopGate = value;
    },
  };
}

test("@spec:plugin-deployment/idempotent-reconciliation/component-effects", async () => {
  const { cache, calls, effects, registry } = harness();
  const prepareEffect = effect("prepare");
  await effects.perform(prepareEffect);
  await effects.perform(prepareEffect);
  await effects.perform(effect("start"));
  assert.equal(registry.require(instanceId).state, "active");
  await effects.perform(effect("drain"));
  assert.equal(registry.require(instanceId).state, "draining");
  await effects.perform(effect("stop"));
  assert.equal(registry.get(instanceId), undefined);
  assert.equal(cache.prepares, 1);
  assert.equal(cache.releases, 1);
  assert.deepEqual(calls, [`start:${instanceId}`, `drain:${instanceId}`, `stop:${instanceId}`]);
});

test("operation identity replay is idempotent and conflicting payloads are rejected", async () => {
  const { effects } = harness();
  const prepare = effect("prepare");
  await Promise.all([effects.perform(prepare), effects.perform(prepare)]);

  await assert.rejects(
    effects.perform({ ...effect("start"), operationId: prepare.operationId }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "diagnostic" in error &&
      (error as { diagnostic: { code?: unknown } }).diagnostic.code ===
        "LIFECYCLE_OPERATION_CONFLICT",
  );
});

test("stale deployment identity cannot operate a newly registered instance", async () => {
  const { effects, registry } = harness();
  await effects.perform(effect("prepare"));
  const stale = {
    ...effect("start"),
    artifactDigest: parseArtifactDigest(`sha256:${"2".repeat(64)}`),
  };

  await assert.rejects(effects.perform(stale), /identity|deployment|artifact/iu);
  assert.equal(registry.require(instanceId).state, "prepared");
});

test("@spec:plugin-deployment/idempotent-reconciliation/transient-start-retry", async () => {
  const { calls, effects, registry, setFailStarts } = harness();
  await effects.perform(effect("prepare"));
  setFailStarts(1);
  const start = effect("start");

  await assert.rejects(effects.perform(start), /start failed/u);
  await effects.perform(start);

  assert.equal(registry.require(instanceId).state, "active");
  assert.deepEqual(calls, [`start:${instanceId}`, `start:${instanceId}`]);
});

test("@spec:plugin-deployment/idempotent-reconciliation/partial-stop-retry", async () => {
  const { cache, calls, effects, registry, setFailStops } = harness();
  await effects.perform(effect("prepare"));
  await effects.perform(effect("start"));
  setFailStops(1);
  const stop = effect("stop");

  await assert.rejects(effects.perform(stop), /cleanup failures/u);
  assert.equal(registry.require(instanceId).state, "stopping");
  assert.equal(cache.releases, 1);
  await effects.perform(stop);

  assert.equal(cache.releases, 1);
  assert.deepEqual(calls, [`start:${instanceId}`, `stop:${instanceId}`, `stop:${instanceId}`]);
  assert.equal(registry.get(instanceId), undefined);
});

test("@spec:plugin-deployment/idempotent-reconciliation/full-stop-retry", async () => {
  const { cache, effects, registry, setFailStops } = harness();
  await effects.perform(effect("prepare"));
  await effects.perform(effect("start"));
  setFailStops(1);
  cache.failReleases = 1;
  const stop = effect("stop");

  await assert.rejects(effects.perform(stop), /cleanup failures/u);
  const retained = registry.require(instanceId);
  assert.equal(retained.state, "stopping");
  assert.equal(
    "hostStopped" in retained
      ? (retained as unknown as { hostStopped: boolean }).hostStopped
      : false,
    false,
  );
  assert.equal(
    "artifactReleased" in retained
      ? (retained as unknown as { artifactReleased: boolean }).artifactReleased
      : false,
    false,
  );

  await effects.perform(stop);
  assert.equal(cache.releases, 2);
  assert.equal(registry.get(instanceId), undefined);
});

test("@spec:coordination-provider/fenced-leadership/component-start-loss-cleanup", async () => {
  const first = { resource: "runtime:app", epoch: parseFencingEpoch("1") };
  const second = { resource: "runtime:app", epoch: parseFencingEpoch("2") };
  const gate = deferred();
  const { cache, calls, effects, registry, setAuthority, setStartGate } = harness({
    authority: first,
  });
  await effects.perform(effect("prepare"));
  setStartGate(gate.promise);
  const starting = effects.perform(effect("start"));
  await Promise.resolve();
  setAuthority(second);
  gate.resolve();

  await assert.rejects(starting, /authority|fenc|leadership/iu);
  assert.notEqual(registry.get(instanceId)?.state, "active");
  assert.equal(cache.releases, 1);
  assert.deepEqual(calls, [`start:${instanceId}`, `stop:${instanceId}`]);
});

test("@spec:coordination-provider/fenced-leadership/operation-replay-cross-epoch", async () => {
  const first = { resource: "runtime:app", epoch: parseFencingEpoch("1") };
  const second = { resource: "runtime:app", epoch: parseFencingEpoch("2") };
  const { effects, setAuthority } = harness({ authority: first });
  const prepare = effect("prepare");
  await effects.perform(prepare);
  setAuthority(second);

  await assert.rejects(effects.perform(prepare), /conflict|authority|fenc/iu);
});

test("@spec:coordination-provider/fenced-leadership/component-stop-loss-after-action", async () => {
  const first = { resource: "runtime:app", epoch: parseFencingEpoch("1") };
  const second = { resource: "runtime:app", epoch: parseFencingEpoch("2") };
  const gate = deferred();
  const { cache, effects, registry, setAuthority, setStopGate } = harness({
    authority: first,
  });
  await effects.perform(effect("prepare"));
  await effects.perform(effect("start"));
  setStopGate(gate.promise);
  const stopping = effects.perform(effect("stop"));
  await Promise.resolve();
  setAuthority(second);
  gate.resolve();

  await stopping;
  await effects.perform(effect("stop"));
  assert.equal(cache.releases, 1);
  assert.equal(registry.get(instanceId), undefined);
});

test("@spec:coordination-provider/fenced-leadership/component-stop-takeover-retries-unfinished-cleanup", async () => {
  const first = { resource: "runtime:app", epoch: parseFencingEpoch("1") };
  const second = { resource: "runtime:app", epoch: parseFencingEpoch("2") };
  const gate = deferred();
  const { cache, calls, effects, registry, setAuthority, setFailStops, setStopGate } = harness({
    authority: first,
  });
  await effects.perform(effect("prepare"));
  await effects.perform(effect("start"));
  setFailStops(1);
  setStopGate(gate.promise);
  const stop = effect("stop");
  const firstAttempt = effects.perform(stop);
  await Promise.resolve();
  setAuthority(second);
  gate.resolve();

  await assert.rejects(firstAttempt, /cleanup failures/u);
  assert.equal(registry.require(instanceId).state, "stopping");
  assert.equal(cache.releases, 1);
  setStopGate(undefined);
  await effects.perform(stop);

  assert.equal(cache.releases, 1);
  assert.deepEqual(calls, [`start:${instanceId}`, `stop:${instanceId}`, `stop:${instanceId}`]);
  assert.equal(registry.get(instanceId), undefined);
});

test("@spec:plugin-deployment/idempotent-reconciliation/bounds-failed-operation-history", async () => {
  const { effects } = harness();
  for (let index = 0; index < 300; index += 1) {
    await assert.rejects(
      effects.perform({
        ...effect("stop"),
        operationId: parseOperationId(`missing-stop-${index}`),
        messageId: parseMessageId(`missing-stop-message-${index}`),
      }),
      /not registered/u,
    );
  }

  await assert.rejects(
    effects.perform({
      ...effect("drain"),
      operationId: parseOperationId("missing-stop-0"),
      messageId: parseMessageId("replacement-message"),
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "diagnostic" in error &&
      (error as { diagnostic: { code?: unknown } }).diagnostic.code !==
        "LIFECYCLE_OPERATION_CONFLICT",
  );
});

test("@spec:plugin-deployment/idempotent-reconciliation/prepare-rollback-aggregates-release-failure", async () => {
  const { cache, effects, registry } = harness();
  cache.result = Object.freeze({
    ...cache.prepared,
    manifest: {
      ...cache.prepared.manifest,
      pluginId: parsePluginId("different-plugin"),
    },
  });
  cache.failReleases = 1;

  await assert.rejects(
    effects.perform(effect("prepare")),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "diagnostic" in error &&
      (error as { diagnostic: { code?: unknown } }).diagnostic.code ===
        "LIFECYCLE_PREPARE_ROLLBACK_FAILED",
  );
  assert.equal(cache.releases, 1);
  assert.equal(registry.get(instanceId), undefined);
});

test("@spec:plugin-deployment/kernel-owned-component-lifecycle/immutable-component-binding", async () => {
  const mutableDeployment: PluginDeployment = {
    ...structuredClone(deployment),
    configuration: { nested: { value: "before" } },
  };
  const { effects, registry } = harness({ deployment: mutableDeployment });
  await effects.perform(effect("prepare"));
  const binding = registry.require(instanceId).binding;

  assert.equal("component" in binding, true);
  const selected = (
    binding as unknown as { component: { componentId: string; entrypoint: string } }
  ).component;
  assert.equal(selected.componentId, componentId);
  assert.equal(selected.entrypoint, "components/task.js");
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(binding.deployment), true);
  assert.equal(Object.isFrozen(binding.deployment.configuration), true);

  (mutableDeployment.configuration as { nested: { value: string } }).nested.value = "after";
  assert.deepEqual(binding.deployment.configuration, { nested: { value: "before" } });
  assert.notEqual(selected.entrypoint, "components/other.js");
});

test("@spec:plugin-deployment/kernel-owned-component-lifecycle/rejects-component-drift", async () => {
  const { effects, registry } = harness();
  await effects.perform(effect("prepare"));
  const entry = registry.require(instanceId);
  const drifted = {
    ...entry,
    binding: {
      ...entry.binding,
      component: {
        componentId,
        kind: "task",
        entrypoint: "components/other.js",
        executors: ["thread"],
      },
    },
  };

  assert.throws(
    () => registry.register(effect("prepare"), drifted.binding as never, undefined),
    /component|identity|entrypoint/iu,
  );
});
