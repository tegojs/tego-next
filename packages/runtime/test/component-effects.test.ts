import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseApplicationId,
  parseArtifactDigest,
  parseComponentId,
  parseGeneration,
  parseMessageId,
  parseOperationId,
  parsePluginId,
  type PluginDeployment,
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

class ControlledCache implements PreparedArtifactCache {
  readonly prepared: PreparedArtifact = Object.freeze({
    digest: artifactDigest,
    root: "/immutable/artifact",
    manifest,
  });
  prepares = 0;
  releases = 0;
  failRelease = false;

  async prepare(): Promise<PreparedArtifact> {
    this.prepares += 1;
    return this.prepared;
  }
  async release(): Promise<void> {
    this.releases += 1;
    if (this.failRelease) throw new Error("release failed");
  }
  async close(): Promise<void> {}
}

function harness() {
  const cache = new ControlledCache();
  const registry = new ComponentRegistry();
  const calls: string[] = [];
  let failStop = false;
  const effects = new ComponentEffects({
    artifacts: cache,
    registry,
    supportedExecutors: ["thread"],
    resolveDeployment: async () => deployment,
    host: {
      start: async (binding) => {
        assert.equal(Object.isFrozen(binding), true);
        calls.push(`start:${binding.instanceId}`);
      },
      drain: async (binding) => {
        calls.push(`drain:${binding.instanceId}`);
      },
      stop: async (binding) => {
        calls.push(`stop:${binding.instanceId}`);
        if (failStop) throw new Error("host stop failed");
      },
    },
  });
  return {
    cache,
    calls,
    effects,
    registry,
    setFailStop(value: boolean) {
      failStop = value;
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

test("stop releases the artifact even when host stop fails and reports all cleanup failures", async () => {
  const { cache, effects, registry, setFailStop } = harness();
  await effects.perform(effect("prepare"));
  await effects.perform(effect("start"));
  setFailStop(true);
  cache.failRelease = true;

  await assert.rejects(
    effects.perform(effect("stop")),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "diagnostic" in error &&
      (error as { diagnostic: { code?: unknown; details?: unknown } }).diagnostic.code ===
        "LIFECYCLE_STOP_FAILED",
  );
  assert.equal(cache.releases, 1);
  assert.equal(registry.get(instanceId), undefined);
});
