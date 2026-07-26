import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseApplicationId,
  parseArtifactDigest,
  parseCapabilityName,
  parseComponentId,
  parseFencingEpoch,
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
const digestTwo = parseArtifactDigest(
  "sha256:2222222222222222222222222222222222222222222222222222222222222222",
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
  live = new Set();

  async perform(effect) {
    this.calls.push(effect);
    if (effect.kind === "start") this.live.add(effect.instanceId);
    if (effect.kind === "stop") this.live.delete(effect.instanceId);
  }

  async restore(instance) {
    this.live.add(instance.instanceId);
  }

  isLive(instance) {
    return this.live.has(instance.instanceId);
  }

  async close() {
    this.live.clear();
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
      await run(store, clock, async () => store);
    } finally {
      await store.close();
    }
  });
  await t.test("SqliteStateStore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tego-reconciler-store-"));
    const clock = new ManualClock();
    const databasePath = join(directory, "state.sqlite");
    let store = new SqliteStateStore({ databasePath, clock });
    await store.open();
    try {
      await run(store, clock, async () => {
        await store.close();
        store = new SqliteStateStore({ databasePath, clock });
        await store.open();
        return store;
      });
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

async function readObservation(store, targetPluginId = pluginId) {
  return store.read({
    namespace: "tego",
    collection: "deployment-observations",
    id: `${applicationId}/${targetPluginId}`,
  });
}

test("automatic capability binding survives reconciler and state-store restart", async (t) => {
  await withRealStateStores(t, async (initialState, clock, reopen) => {
    const providerAId = parsePluginId("provider-a");
    const providerBId = parsePluginId("provider-b");
    const consumerId = parsePluginId("consumer");
    const capability = parseCapabilityName("org.example.durable");
    const providerADigest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
    const providerBDigest = parseArtifactDigest(`sha256:${"b".repeat(64)}`);
    const consumerDigest = parseArtifactDigest(`sha256:${"c".repeat(64)}`);
    const capabilityManifest = (targetPluginId, provides, requires) => ({
      ...manifest(),
      pluginId: targetPluginId,
      components: [],
      permissions: [],
      capabilities: { provides, requires },
    });
    const providerAManifest = capabilityManifest(
      providerAId,
      [{ name: capability, protocolVersion: "1.0.0" }],
      [],
    );
    const providerBManifest = capabilityManifest(
      providerBId,
      [{ name: capability, protocolVersion: "1.1.0" }],
      [],
    );
    const consumerManifest = capabilityManifest(
      consumerId,
      [],
      [{ name: capability, protocolRange: "^1.0.0" }],
    );
    const installations = [
      {
        ...installation(),
        pluginId: providerAId,
        digest: providerADigest,
        manifest: providerAManifest,
      },
      {
        ...installation(),
        pluginId: providerBId,
        digest: providerBDigest,
        manifest: providerBManifest,
      },
      {
        ...installation(),
        pluginId: consumerId,
        digest: consumerDigest,
        manifest: consumerManifest,
      },
    ];
    const artifacts = new Map(
      installations.map((installed) => [
        installed.digest,
        {
          digest: installed.digest,
          files: { schemaVersion: "1.0", files: [] },
          manifest: installed.manifest,
        },
      ]),
    );
    const providerA = {
      ...deployment(),
      pluginId: providerAId,
      artifactDigest: providerADigest,
      permissionGrants: [],
    };
    const providerB = {
      ...deployment(),
      pluginId: providerBId,
      artifactDigest: providerBDigest,
      permissionGrants: [],
    };
    const consumer = {
      ...deployment(),
      pluginId: consumerId,
      artifactDigest: consumerDigest,
      permissionGrants: [],
    };
    let deployments = [providerA, consumer];
    const options = (state) => ({
      artifactGate: {
        async validate(request) {
          const artifact = artifacts.get(request.digest);
          assert.ok(artifact);
          return artifact;
        },
      },
      clock,
      effects: new RecordingEffects(),
      state,
      loadDeployments: async () => deployments,
      loadInstallations: async () => installations,
    });
    const bindingKey = {
      namespace: "tego",
      collection: "capability-bindings",
      id: `${applicationId}/${consumerId}/${capability}`,
    };

    const first = new Reconciler(options(initialState));
    await first.start();
    const persisted = await initialState.read(bindingKey);
    assert.ok(persisted);
    assert.equal(persisted.value.provider.pluginId, providerAId);
    await first.stop();

    deployments = [providerA, providerB, consumer];
    const restartedState = await reopen();
    const restarted = new Reconciler(options(restartedState));
    await restarted.start();

    const afterRestart = await restartedState.read(bindingKey);
    assert.deepEqual(afterRestart, persisted);
    assert.deepEqual(restarted.diagnostics(), []);
    await restarted.stop();
  });
});

test("capability binding cleanup is canonical before deployment gates", async (t) => {
  await withRealStateStores(t, async (state, clock) => {
    const absentConsumerId = parsePluginId("absent-consumer");
    const staleConsumerId = parsePluginId("stale-consumer");
    const currentConsumerId = parsePluginId("current-consumer");
    const providerId = parsePluginId("provider");
    const capability = parseCapabilityName("org.example.cleanup");
    const bindingKey = (consumerId) => ({
      namespace: "tego",
      collection: "capability-bindings",
      id: `${applicationId}/${consumerId}/${capability}`,
    });
    const binding = (consumerId, deploymentGeneration) => ({
      consumer: { applicationId, pluginId: consumerId },
      capability,
      provider: { applicationId, pluginId: providerId },
      source: "automatic",
      deploymentGeneration,
      updatedAt: clock.now().toISOString(),
    });
    await state.transact({}, async (transaction) => {
      await transaction.put(
        bindingKey(absentConsumerId),
        binding(absentConsumerId, parseGeneration("1")),
        { expectedRevision: "absent" },
      );
      await transaction.put(
        bindingKey(staleConsumerId),
        binding(staleConsumerId, parseGeneration("1")),
        { expectedRevision: "absent" },
      );
      await transaction.put(
        bindingKey(currentConsumerId),
        binding(currentConsumerId, parseGeneration("1")),
        { expectedRevision: "absent" },
      );
      return null;
    });
    const missingDigest = parseArtifactDigest(`sha256:${"d".repeat(64)}`);
    const deployments = [
      {
        ...deployment(),
        pluginId: staleConsumerId,
        artifactDigest: missingDigest,
        generation: parseGeneration("2"),
      },
      {
        ...deployment(),
        pluginId: currentConsumerId,
        artifactDigest: missingDigest,
        generation: parseGeneration("1"),
      },
    ];
    const reconciler = new Reconciler({
      artifactGate: {
        async validate() {
          assert.fail("missing installations must fail before artifact validation");
        },
      },
      clock,
      effects: new RecordingEffects(),
      state,
      loadDeployments: async () => deployments,
      loadInstallations: async () => [],
    });

    await reconciler.start();

    assert.equal(await state.read(bindingKey(absentConsumerId)), undefined);
    assert.equal(await state.read(bindingKey(staleConsumerId)), undefined);
    assert.deepEqual(
      (await state.read(bindingKey(currentConsumerId)))?.value,
      binding(currentConsumerId, parseGeneration("1")),
    );
    assert.equal(
      reconciler
        .diagnostics()
        .filter((diagnostic) => diagnostic.code === "DEPLOYMENT_INSTALLATION_MISSING").length,
      2,
    );
    await reconciler.stop();
  });
});

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

test("leased stale placement defers replacement until the claim expires", async (t) => {
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
    const [leased] = await state.claimOutbox({
      leaseDurationMs: 30_000,
      limit: 1,
      owner: "other-runtime",
      topic: "component.lifecycle",
    });
    assert.ok(leased);
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
    assert.deepEqual(effects.calls, []);

    clock.advance(30_001);
    for (let wake = 0; wake < 3; wake += 1) {
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

test("upgrade and rollback tear down old components removed from the current manifest", async (t) => {
  for (const scenario of [
    {
      name: "upgrade",
      currentDigest: digestTwo,
      currentGeneration: parseGeneration("2"),
      currentVersion: "2.0.0",
      oldDigest: digest,
      oldGeneration: parseGeneration("1"),
    },
    {
      name: "rollback",
      currentDigest: digest,
      currentGeneration: parseGeneration("3"),
      currentVersion: "1.0.0",
      oldDigest: digestTwo,
      oldGeneration: parseGeneration("2"),
    },
  ]) {
    await t.test(scenario.name, async (scenarioTest) => {
      await withRealStateStores(scenarioTest, async (state, clock) => {
        const currentManifest = {
          ...manifest(),
          version: scenario.currentVersion,
          components: [],
          permissions: [],
        };
        const desired = {
          ...deployment(),
          version: scenario.currentVersion,
          artifactDigest: scenario.currentDigest,
          generation: scenario.currentGeneration,
          permissionGrants: [],
        };
        const currentInstallation = {
          ...installation(),
          version: scenario.currentVersion,
          digest: scenario.currentDigest,
          manifest: currentManifest,
        };
        const oldIdentity = planReconcile({
          deployment: {
            ...desired,
            artifactDigest: scenario.oldDigest,
            generation: scenario.oldGeneration,
          },
          gate: gate(),
          instances: [],
          now: clock.now().toISOString(),
          supportedExecutors: ["process"],
        }).steps[0]?.effect;
        assert.ok(oldIdentity);
        await state.transact({}, async (transaction) => {
          await transaction.put(
            {
              namespace: "tego",
              collection: "component-instances",
              id: oldIdentity.instanceId,
            },
            {
              applicationId,
              artifactDigest: scenario.oldDigest,
              componentId,
              deploymentGeneration: scenario.oldGeneration,
              executor: "process",
              instanceId: oldIdentity.instanceId,
              lifecycle: "ready",
              observedGeneration: scenario.oldGeneration,
              pluginId,
            },
            { expectedRevision: "absent" },
          );
          return null;
        });
        const effects = new RecordingEffects();
        const reconciler = new Reconciler({
          artifactGate: {
            validate: async () => ({
              ...gate().artifact,
              digest: scenario.currentDigest,
              manifest: currentManifest,
            }),
          },
          clock,
          effects,
          state,
          loadDeployments: async () => [desired],
          loadInstallations: async () => [currentInstallation],
        });

        await reconciler.start();
        await reconciler.wake();

        assert.deepEqual(
          effects.calls.map((effect) => [effect.kind, effect.artifactDigest, effect.executor]),
          [
            ["drain", scenario.oldDigest, "process"],
            ["stop", scenario.oldDigest, "process"],
          ],
        );
        assert.equal(
          (await readOnlyInstance(state, oldIdentity.instanceId))?.value.lifecycle,
          "stopped",
        );
        await reconciler.stop();
      });
    });
  }
});

test("failed prepare retries after retryAt and converges to ready", async (t) => {
  await withRealStateStores(t, async (state, clock) => {
    const desired = deployment();
    const effects = new RecordingEffects();
    let prepareAttempts = 0;
    effects.perform = async (effect) => {
      effects.calls.push(effect);
      if (effect.kind === "prepare") {
        prepareAttempts += 1;
        if (prepareAttempts === 1) throw new Error("prepare failed once");
      }
      if (effect.kind === "start") effects.live.add(effect.instanceId);
    };
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate().artifact },
      clock,
      effects,
      state,
      loadDeployments: async () => [desired],
      loadInstallations: async () => [installation()],
    });

    await reconciler.start();
    const effect = effects.calls[0];
    assert.ok(effect);
    const failed = await readOnlyInstance(state, effect.instanceId);
    assert.equal(failed?.value.lifecycle, "failed");
    assert.equal(failed?.value.retryEffect, "prepare");
    assert.equal(typeof failed?.value.retryAt, "string");

    clock.advance(60_000);
    await reconciler.wake();
    await reconciler.wake();

    assert.deepEqual(
      effects.calls.map((candidate) => candidate.kind),
      ["prepare", "prepare", "start"],
    );
    const ready = await readOnlyInstance(state, effect.instanceId);
    assert.equal(ready?.value.lifecycle, "ready");
    assert.equal("retryAt" in (ready?.value ?? {}), false);
    assert.equal(reconciler.applicationReady(), true);
    await reconciler.stop();
  });
});

test("current instance context mismatches cannot satisfy essential readiness", async (t) => {
  for (const mismatch of ["artifactDigest", "observedGeneration"]) {
    await t.test(mismatch, async (mismatchTest) => {
      await withRealStateStores(mismatchTest, async (state, clock) => {
        const desired = deployment();
        const identity = planReconcile({
          deployment: desired,
          gate: gate(),
          instances: [],
          now: clock.now().toISOString(),
          supportedExecutors: ["thread"],
        }).steps[0]?.effect;
        assert.ok(identity);
        await state.transact({}, async (transaction) => {
          await transaction.put(
            {
              namespace: "tego",
              collection: "component-instances",
              id: identity.instanceId,
            },
            {
              applicationId,
              artifactDigest: mismatch === "artifactDigest" ? digestTwo : digest,
              componentId,
              deploymentGeneration: parseGeneration("1"),
              executor: "thread",
              instanceId: identity.instanceId,
              lifecycle: "ready",
              observedGeneration:
                mismatch === "observedGeneration" ? parseGeneration("2") : parseGeneration("1"),
              pluginId,
            },
            { expectedRevision: "absent" },
          );
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

        assert.equal(reconciler.applicationReady(), false);
        assert.equal(reconciler.diagnostics()[0]?.code, "DEPLOYMENT_INSTANCE_INCONSISTENT");
        assert.equal((await readObservation(state))?.value.status, "inconsistent");
        assert.deepEqual(effects.calls, []);
        await reconciler.stop();
      });
    });
  }
});

test("current provider context mismatches cannot satisfy required capabilities", async (t) => {
  const providerId = parsePluginId("z-provider");
  const consumerId = parsePluginId("a-consumer");
  const providerComponentId = parseComponentId("provider");
  const consumerComponentId = parseComponentId("consumer");
  const capability = parseCapabilityName("org.example.echo");
  const component = (id) => ({
    componentId: parseComponentId(id),
    kind: "service",
    entrypoint: `components/${id}.js`,
    executors: ["process"],
  });
  const providerManifest = {
    ...manifest(),
    pluginId: providerId,
    components: [component("provider")],
    permissions: [{ kind: "executor", executors: ["process"] }],
    capabilities: {
      provides: [{ name: capability, protocolVersion: "1.0.0" }],
      requires: [],
    },
  };
  const consumerManifest = {
    ...manifest(),
    pluginId: consumerId,
    components: [component("consumer")],
    permissions: [{ kind: "executor", executors: ["process"] }],
    capabilities: {
      provides: [],
      requires: [{ name: capability, protocolRange: "^1.0.0" }],
    },
  };
  const providerDeployment = {
    ...deployment(),
    pluginId: providerId,
    permissionGrants: [{ kind: "executor", executors: ["process"] }],
  };
  const consumerDeployment = {
    ...deployment(),
    pluginId: consumerId,
    artifactDigest: digestTwo,
    essential: false,
    permissionGrants: [{ kind: "executor", executors: ["process"] }],
  };
  const providerInstallation = {
    ...installation(),
    pluginId: providerId,
    manifest: providerManifest,
  };
  const consumerInstallation = {
    ...installation(),
    pluginId: consumerId,
    digest: digestTwo,
    manifest: consumerManifest,
  };
  const artifacts = new Map([
    [digest, { ...gate().artifact, manifest: providerManifest }],
    [digestTwo, { ...gate().artifact, digest: digestTwo, manifest: consumerManifest }],
  ]);
  const providerGate = {
    artifact: artifacts.get(digest),
    capabilityResolution: {
      ok: true,
      diagnostics: [],
      providerLossActions: [],
      bindings: [],
      order: [{ applicationId, pluginId: providerId }],
    },
    permissionDecision: {
      allowed: true,
      diagnostics: [],
      granted: providerManifest.permissions,
      requested: providerManifest.permissions,
    },
  };
  assert.ok(providerGate.artifact);
  for (const mismatch of ["artifactDigest", "observedGeneration"]) {
    await t.test(mismatch, async (mismatchTest) => {
      await withRealStateStores(mismatchTest, async (state, clock) => {
        const identity = planReconcile({
          deployment: providerDeployment,
          gate: providerGate,
          instances: [],
          now: clock.now().toISOString(),
          supportedExecutors: ["process"],
        }).steps[0]?.effect;
        assert.ok(identity);
        await state.transact({}, async (transaction) => {
          await transaction.put(
            {
              namespace: "tego",
              collection: "component-instances",
              id: identity.instanceId,
            },
            {
              applicationId,
              artifactDigest: mismatch === "artifactDigest" ? digestTwo : digest,
              componentId: providerComponentId,
              deploymentGeneration: parseGeneration("1"),
              executor: "process",
              instanceId: identity.instanceId,
              lifecycle: "ready",
              observedGeneration:
                mismatch === "observedGeneration" ? parseGeneration("2") : parseGeneration("1"),
              pluginId: providerId,
            },
            { expectedRevision: "absent" },
          );
          return null;
        });
        const effects = new RecordingEffects();
        effects.supportedExecutors = ["process"];
        const reconciler = new Reconciler({
          artifactGate: {
            validate: async (request) => {
              const artifact = artifacts.get(request.digest);
              assert.ok(artifact);
              return artifact;
            },
          },
          clock,
          effects,
          state,
          loadDeployments: async () => [providerDeployment, consumerDeployment],
          loadInstallations: async () => [providerInstallation, consumerInstallation],
        });

        await reconciler.start();

        assert.equal(
          effects.calls.some(
            (effect) =>
              effect.pluginId === consumerId &&
              effect.componentId === consumerComponentId &&
              effect.kind === "prepare",
          ),
          false,
        );
        assert.equal(
          reconciler
            .diagnostics()
            .some((diagnostic) => diagnostic.code === "CAPABILITY_REQUIRED_UNAVAILABLE"),
          true,
        );
        assert.equal((await readObservation(state, providerId))?.value.status, "inconsistent");
        await reconciler.stop();
      });
    });
  }
});

test("failed start and stop retries persist a legal pre-state before external effects", async (t) => {
  const authority = {
    resource: "runtime:app",
    epoch: parseFencingEpoch("7"),
  };
  for (const target of ["start", "stop"]) {
    await t.test(target, async (targetTest) => {
      await withRealStateStores(targetTest, async (state, clock) => {
        const desired = target === "start" ? deployment() : { ...deployment(), state: "disabled" };
        if (target === "stop") {
          const identity = planReconcile({
            deployment: deployment(),
            gate: gate(),
            instances: [],
            now: clock.now().toISOString(),
            supportedExecutors: ["thread"],
          }).steps[0]?.effect;
          assert.ok(identity);
          await state.transact({}, async (transaction) => {
            await transaction.put(
              {
                namespace: "tego",
                collection: "component-instances",
                id: identity.instanceId,
              },
              {
                applicationId,
                artifactDigest: digest,
                componentId,
                deploymentGeneration: parseGeneration("1"),
                executor: "thread",
                instanceId: identity.instanceId,
                lifecycle: "ready",
                observedGeneration: parseGeneration("1"),
                pluginId,
              },
              { expectedRevision: "absent" },
            );
            return null;
          });
        }
        const effects = new RecordingEffects();
        let targetAttempts = 0;
        effects.perform = async (effect) => {
          effects.calls.push(effect);
          if (effect.kind === target) {
            targetAttempts += 1;
            if (targetAttempts === 1) throw new Error(`${target} failed once`);
          }
          if (effect.kind === "start") effects.live.add(effect.instanceId);
          if (effect.kind === "stop") effects.live.delete(effect.instanceId);
        };
        const reconciler = new Reconciler({
          artifactGate: { validate: async () => gate().artifact },
          authority,
          clock,
          effects,
          state,
          loadDeployments: async () => [desired],
          loadInstallations: async () => [installation()],
        });

        await reconciler.start();
        const callsAfterFailure = effects.calls.length;
        await reconciler.wake();
        const failedEffect = effects.calls.findLast((effect) => effect.kind === target);
        assert.ok(failedEffect);
        const failed = await readOnlyInstance(state, failedEffect.instanceId);
        assert.equal(failed?.value.lifecycle, "failed");
        assert.equal(failed?.value.retryEffect, target);
        assert.equal(
          effects.calls.length,
          callsAfterFailure,
          "wake must not retry a failed effect before retryAt",
        );
        assert.equal(
          reconciler
            .diagnostics()
            .some((diagnostic) => diagnostic.code === `LIFECYCLE_${target.toUpperCase()}_FAILED`),
          true,
        );

        clock.advance(60_000);
        await reconciler.wake();
        const callCountAfterSuccess = effects.calls.length;
        await reconciler.wake();

        assert.equal(effects.calls.filter((effect) => effect.kind === target).length, 2);
        assert.equal(effects.calls.length, callCountAfterSuccess);
        assert.equal(
          (await readOnlyInstance(state, failedEffect.instanceId))?.value.lifecycle,
          target === "start" ? "ready" : "stopped",
        );
        assert.equal(reconciler.lastCommitAuthority?.epoch, authority.epoch);
        await reconciler.stop();
      });
    });
  }
});
