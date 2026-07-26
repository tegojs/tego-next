import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type PluginDeployment,
  parseApplicationId,
  parseArtifactDigest,
  parseComponentId,
  parseFencingEpoch,
  parseGeneration,
  parseMessageId,
  parseOperationId,
  parsePluginId,
  parseRevision,
  type RuntimeAuthority,
} from "@tegojs/contracts";
import type {
  PreparedArtifact,
  PreparedArtifactCache,
} from "../src/artifacts/prepared-artifact-cache.js";
import { ComponentEffects } from "../src/components/component-effects.js";
import { ComponentRegistry } from "../src/components/component-registry.js";
import type {
  ComponentInstance,
  ReconcileEffect,
  ReconcileEffectKind,
} from "../src/reconcile/plan.js";

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

function readyInstance(overrides: Partial<ComponentInstance> = {}): ComponentInstance {
  return {
    applicationId,
    artifactDigest,
    componentId,
    deploymentGeneration: generation,
    executor: "thread",
    instanceId,
    lifecycle: "ready",
    observedGeneration: generation,
    pluginId,
    revision: parseRevision("1"),
    ...overrides,
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
  prepareGate: Promise<void> | undefined;
  result: PreparedArtifact = this.prepared;

  async prepare(): Promise<PreparedArtifact> {
    this.prepares += 1;
    await this.prepareGate;
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
  let failDrains = 0;
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
        if (failDrains-- > 0) throw new Error("host drain failed");
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
    setFailDrains(value: number) {
      failDrains = value;
    },
    setFailStops(value: number) {
      failStops = value;
    },
    setStartGate(value: Promise<void> | undefined) {
      startGate = value;
    },
    setPrepareGate(value: Promise<void> | undefined) {
      cache.prepareGate = value;
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

test("restores one exact persisted ready session idempotently and closes it without durable effects", async () => {
  const { cache, calls, effects, registry } = harness();
  const lifecycle = effects as ComponentEffects & {
    restore(instance: ComponentInstance): Promise<void>;
    isLive(instance: ComponentInstance): boolean;
    close(): Promise<void>;
  };
  const instance = readyInstance();

  await lifecycle.restore(instance);
  await lifecycle.restore(instance);

  assert.equal(lifecycle.isLive(instance), true);
  assert.equal(registry.require(instanceId).state, "active");
  assert.equal(cache.prepares, 1);
  assert.deepEqual(calls, [`start:${instanceId}`]);

  await lifecycle.close();
  await lifecycle.close();

  assert.equal(lifecycle.isLive(instance), false);
  assert.equal(registry.get(instanceId), undefined);
  assert.equal(cache.releases, 1);
  assert.deepEqual(calls, [`start:${instanceId}`, `drain:${instanceId}`, `stop:${instanceId}`]);
});

test("restores persisted preparing sessions without starting them twice", async () => {
  const { cache, calls, effects, registry } = harness();
  const preparing = readyInstance({ lifecycle: "preparing" });

  await effects.restore(preparing);
  await effects.restore(preparing);

  assert.equal(registry.require(instanceId).state, "prepared");
  assert.equal(cache.prepares, 1);
  assert.deepEqual(calls, []);
  await effects.close();
});

test("close fences concurrent restoration and concurrent close calls share cleanup", async () => {
  const stopGate = deferred();
  const { calls, effects, registry, setStopGate } = harness();
  const instance = readyInstance();
  await effects.restore(instance);
  setStopGate(stopGate.promise);

  const firstClose = effects.close();
  await Promise.resolve();
  const secondClose = effects.close();
  await assert.rejects(effects.restore(instance), /closing|unavailable/iu);
  stopGate.resolve();

  const results = await Promise.allSettled([firstClose, secondClose]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "fulfilled"],
  );
  assert.equal(registry.get(instanceId), undefined);
  assert.deepEqual(calls, [`start:${instanceId}`, `drain:${instanceId}`, `stop:${instanceId}`]);
});

test("bulk close releases only sessions owned by the exact authority", async () => {
  const first = { resource: "runtime:app", epoch: parseFencingEpoch("1") };
  const second = { resource: "runtime:app", epoch: parseFencingEpoch("2") };
  const { cache, calls, effects, registry, setAuthority } = harness({ authority: first });
  const lifecycle = effects as ComponentEffects & {
    restore(instance: ComponentInstance): Promise<void>;
    close(authority?: RuntimeAuthority): Promise<void>;
  };

  await lifecycle.restore(readyInstance());
  setAuthority(second);
  await lifecycle.close(second);
  assert.equal(registry.require(instanceId).state, "active");
  assert.equal(cache.releases, 0);

  await lifecycle.close(first);
  assert.equal(registry.get(instanceId), undefined);
  assert.equal(cache.releases, 1);
  assert.deepEqual(calls, [`start:${instanceId}`, `drain:${instanceId}`, `stop:${instanceId}`]);
});

test("restoration identities remain valid for maximum-length instance identifiers", async () => {
  const { effects } = harness();
  const longInstance = readyInstance({ instanceId: "i".repeat(128) });

  await effects.restore(longInstance);

  assert.equal(effects.isLive(longInstance), true);
  await effects.close();
});

test("concurrent restoration shares one attempt and evicts a failed attempt for retry", async () => {
  const prepareGate = deferred();
  const { cache, calls, effects, registry, setFailStarts, setPrepareGate } = harness();
  const instance = readyInstance();
  setPrepareGate(prepareGate.promise);
  setFailStarts(1);

  const first = effects.restore(instance);
  await Promise.resolve();
  const second = effects.restore(instance);
  await Promise.resolve();
  assert.equal(cache.prepares, 1);
  prepareGate.resolve();

  const failed = await Promise.allSettled([first, second]);
  assert.deepEqual(
    failed.map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.equal(cache.prepares, 1);
  assert.deepEqual(calls, [`start:${instanceId}`]);
  assert.equal(registry.require(instanceId).state, "prepared");

  setPrepareGate(undefined);
  await effects.restore(instance);
  assert.equal(cache.prepares, 1);
  assert.deepEqual(calls, [`start:${instanceId}`, `start:${instanceId}`]);
  assert.equal(effects.isLive(instance), true);
  await effects.close();
});

test("concurrent restoration rejects immutable identity and lifecycle conflicts for one key", async () => {
  const prepareGate = deferred();
  const { calls, effects, setPrepareGate } = harness();
  const instance = readyInstance();
  setPrepareGate(prepareGate.promise);

  const first = effects.restore(instance);
  await Promise.resolve();
  const identityConflict = effects.restore({
    ...instance,
    componentId: otherComponentId,
  });
  const lifecycleConflict = Promise.resolve().then(() =>
    effects.restore({
      ...instance,
      lifecycle: "draining",
    }),
  );
  prepareGate.resolve();

  await first;
  await assert.rejects(identityConflict, /conflict|identity|lifecycle/iu);
  await assert.rejects(lifecycleConflict, /conflict|identity|lifecycle|ready/iu);
  assert.deepEqual(calls, [`start:${instanceId}`]);
  await effects.close();
});

test("bulk close drains, stops, and releases every exact-authority entry despite failures", async () => {
  const authority = { resource: "runtime:app", epoch: parseFencingEpoch("3") };
  const { cache, calls, effects, setFailDrains, setFailStops } = harness({ authority });
  const secondInstanceId = "app.echo.other-task.g1";
  await effects.restore(readyInstance());
  await effects.restore(
    readyInstance({
      componentId: otherComponentId,
      instanceId: secondInstanceId,
    }),
  );
  setFailDrains(2);
  setFailStops(2);
  cache.failReleases = 2;

  await assert.rejects(effects.close(authority), (error: unknown) => {
    if (typeof error !== "object" || error === null || !("diagnostic" in error)) {
      return false;
    }
    const diagnostic = (
      error as {
        diagnostic: { details?: { causes?: readonly unknown[] } };
      }
    ).diagnostic;
    return diagnostic.details?.causes?.length === 6;
  });
  assert.deepEqual(
    calls.filter((call) => !call.startsWith("start:")),
    [
      `drain:${instanceId}`,
      `stop:${instanceId}`,
      `drain:${secondInstanceId}`,
      `stop:${secondInstanceId}`,
    ],
  );
  assert.equal(cache.releases, 2);
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

test("suspend activation effects reject a value that differs from the immutable binding", async () => {
  const { effects, registry } = harness();
  const prepare = {
    ...effect("prepare"),
    activation: "1",
  } as ReconcileEffect & { readonly activation: string };
  await effects.perform(prepare);

  await assert.rejects(
    effects.perform({
      ...effect("start"),
      activation: "2",
    } as ReconcileEffect & { readonly activation: string }),
    /activation|identity|binding/iu,
  );
  assert.equal(registry.require(instanceId).state, "prepared");
  await effects.close();
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

test("@spec:coordination-provider/fenced-leadership/stop-takeover-requires-strictly-newer-decimal-epoch", async (context) => {
  async function stoppingEntry(epoch: string) {
    const authority = {
      resource: "runtime:app",
      epoch: parseFencingEpoch(epoch),
    };
    const { effects, registry } = harness({ authority });
    await effects.perform(effect("prepare"));
    return {
      authority,
      registry,
      stopping: registry.transition(effect("stop"), "prepared", "stopping", authority),
    };
  }

  await context.test("rejects epoch rollback", async () => {
    const { registry } = await stoppingEntry("2");
    assert.throws(
      () =>
        registry.takeoverStopping(effect("stop"), {
          resource: "runtime:app",
          epoch: parseFencingEpoch("1"),
        }),
      /authority|epoch|fenc|newer/iu,
    );
  });

  await context.test("rejects equal epoch", async () => {
    const { registry } = await stoppingEntry("2");
    assert.throws(
      () =>
        registry.takeoverStopping(effect("stop"), {
          resource: "runtime:app",
          epoch: parseFencingEpoch("2"),
        }),
      /authority|epoch|fenc|newer/iu,
    );
  });

  await context.test("rejects another resource", async () => {
    const { registry } = await stoppingEntry("2");
    assert.throws(
      () =>
        registry.takeoverStopping(effect("stop"), {
          resource: "runtime:other",
          epoch: parseFencingEpoch("3"),
        }),
      /authority|resource|identity/iu,
    );
  });

  await context.test("compares epochs beyond Number.MAX_SAFE_INTEGER exactly", async () => {
    const { registry } = await stoppingEntry("9007199254740992");
    const taken = registry.takeoverStopping(effect("stop"), {
      resource: "runtime:app",
      epoch: parseFencingEpoch("9007199254740993"),
    });
    assert.equal(taken.binding.authority?.epoch, "9007199254740993");
  });
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
