import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseApplicationId,
  parseArtifactDigest,
  parseComponentId,
  parseGeneration,
  parsePluginId,
} from "@tegojs/contracts";
import { MemoryStateStore, SqliteStateStore } from "@tegojs/drivers-local";
import { planReconcile, Reconciler } from "@tegojs/runtime";

const applicationId = parseApplicationId("app");
const pluginId = parsePluginId("org.example.echo");
const componentId = parseComponentId("echo-service");
const digest = parseArtifactDigest(
  "sha256:1111111111111111111111111111111111111111111111111111111111111111",
);

class ManualClock {
  #now = Date.parse("2026-07-23T00:00:00.000Z");

  now() {
    return new Date(this.#now);
  }

  sleep() {
    return Promise.resolve();
  }

  advance(milliseconds) {
    this.#now += milliseconds;
  }
}

class RecordingEffects {
  supportedExecutors = ["thread"];
  calls = [];

  async perform(effect) {
    this.calls.push(effect);
  }
}

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
        entrypoint: "components/echo.js",
        executors: ["process", "thread"],
      },
    ],
    permissions: [{ kind: "executor", executors: ["process", "thread"] }],
    capabilities: { provides: [], requires: [] },
  };
}

function installation() {
  return {
    pluginId,
    version: "1.0.0",
    digest,
    manifest: manifest(),
    installedAt: "2026-07-23T00:00:00.000Z",
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
    permissionGrants: [{ kind: "executor", executors: ["process", "thread"] }],
    capabilityBindings: {},
  };
}

function gate() {
  const value = installation();
  return {
    artifact: {
      digest,
      files: {
        schemaVersion: "1.0",
        files: [{ path: "components/echo.js", sha256: digest, size: 1 }],
      },
      manifest: value.manifest,
    },
    capabilityResolution: {
      ok: true,
      diagnostics: [],
      providerLossActions: [],
      bindings: [],
      order: [{ applicationId, pluginId }],
    },
    permissionDecision: {
      allowed: true,
      diagnostics: [],
      granted: value.manifest.permissions,
      requested: value.manifest.permissions,
    },
  };
}

async function withRealStateStores(t, run) {
  await t.test("MemoryStateStore", async () => {
    const clock = new ManualClock();
    const store = new MemoryStateStore({ clock });
    await store.open();
    try {
      await run(store, clock);
    } finally {
      await store.close();
    }
  });
  await t.test("SqliteStateStore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tego-reconciler-store-"));
    const clock = new ManualClock();
    const store = new SqliteStateStore({
      databasePath: join(directory, "state.sqlite"),
      clock,
    });
    await store.open();
    try {
      await run(store, clock);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

async function readOnlyInstance(store, instanceId) {
  return store.read({
    namespace: "tego",
    collection: "component-instances",
    id: instanceId,
  });
}

test("stale pending placement is quarantined before its stable identity is replaced", async (t) => {
  await withRealStateStores(t, async (state, clock) => {
    const desired = deployment();
    const pending = planReconcile({
      deployment: desired,
      gate: gate(),
      instances: [],
      now: clock.now().toISOString(),
      supportedExecutors: ["process"],
    }).steps[0]?.effect;
    assert.ok(pending);
    const now = clock.now().toISOString();
    await state.transact({}, async (transaction) => {
      await transaction.put(
        {
          namespace: "tego",
          collection: "component-instances",
          id: pending.instanceId,
        },
        {
          applicationId,
          artifactDigest: digest,
          componentId,
          deploymentGeneration: parseGeneration("1"),
          executor: "process",
          instanceId: pending.instanceId,
          lifecycle: "created",
          observedGeneration: parseGeneration("1"),
          pluginId,
        },
        { expectedRevision: "absent" },
      );
      await transaction.enqueueOutbox({
        availableAt: now,
        createdAt: now,
        messageId: pending.messageId,
        operationId: pending.operationId,
        payload: pending,
        topic: "component.lifecycle",
      });
      return null;
    });
    const effects = new RecordingEffects();
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate().artifact },
      clock,
      effects,
      state,
      loadDeployments: async () => [desired],
      loadInstallations: async () => [installation()],
    });

    await reconciler.start();
    for (let wake = 0; wake < 4; wake += 1) {
      await reconciler.wake();
    }

    assert.deepEqual(
      effects.calls.map((effect) => [effect.kind, effect.executor]),
      [
        ["prepare", "thread"],
        ["start", "thread"],
      ],
    );
    assert.equal((await readOnlyInstance(state, pending.instanceId))?.value.lifecycle, "ready");
    await reconciler.stop();
  });
});
