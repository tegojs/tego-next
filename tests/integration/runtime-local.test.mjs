import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  diagnosticCode,
  parseApplicationId,
  parseArtifactDigest,
  parseGeneration,
  parseNodeId,
  parsePluginId,
  parseRuntimeId,
} from "@tegojs/contracts";
import { createLocalDrivers } from "@tegojs/drivers-local";
import { createRuntime } from "@tegojs/runtime";

const applicationId = parseApplicationId("application-01");

const configuration = {
  mode: "single-main",
  runtimeId: parseRuntimeId("runtime-01"),
  applicationId,
  nodeId: parseNodeId("main-01"),
};

function deployment({ essential, state }) {
  return {
    applicationId,
    pluginId: parsePluginId("org.example.readiness"),
    version: "1.0.0",
    artifactDigest: parseArtifactDigest(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
    generation: parseGeneration("1"),
    state,
    essential,
    configuration: {},
    permissionGrants: [],
    capabilityBindings: {},
  };
}

async function persistDeployment(directory, value) {
  return persistRecords(directory, [
    {
      collection: "deployments",
      id: "org.example.readiness",
      value,
    },
  ]);
}

async function persistRecords(directory, records) {
  const drivers = await createLocalDrivers({ dataDirectory: directory });
  await drivers.state.open();
  await drivers.state.transact({}, async (transaction) => {
    for (const record of records) {
      await transaction.put(
        {
          namespace: "tego",
          collection: record.collection,
          id: record.id,
        },
        record.value,
        { expectedRevision: "absent" },
      );
    }
    return null;
  });
  await drivers.state.close();
}

test("@spec:runtime-bootstrap/essential-readiness/recovered-SQLite-deployments", async (t) => {
  for (const scenario of [
    {
      name: "active essential deployment blocks readiness without a ready instance",
      value: deployment({ essential: true, state: "active" }),
      readiness: false,
    },
    {
      name: "active non-essential deployment does not block readiness",
      value: deployment({ essential: false, state: "active" }),
      readiness: true,
    },
    {
      name: "disabled essential deployment does not block readiness",
      value: deployment({ essential: true, state: "disabled" }),
      readiness: true,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const directory = await mkdtemp(join(tmpdir(), "tego-runtime-readiness-"));
      try {
        await persistDeployment(directory, scenario.value);
        const runtime = createRuntime(
          configuration,
          await createLocalDrivers({ dataDirectory: directory }),
        );
        await runtime.start();
        const status = await runtime.status();
        assert.equal(status.lifecycle, "running");
        assert.equal(status.readiness, scenario.readiness);
        assert.equal(status.counts.deployments, 1);
        await runtime.stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("live SQLite status scans noncanonical keys and deduplicates the current generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-runtime-status-scope-"));
  try {
    const generationOne = deployment({ essential: true, state: "active" });
    const generationTwo = {
      ...generationOne,
      generation: parseGeneration("2"),
    };
    const otherApplication = parseApplicationId("application-02");
    await persistRecords(directory, [
      {
        collection: "deployments",
        id: "legacy-deployment-one",
        value: generationOne,
      },
      {
        collection: "deployments",
        id: "legacy-deployment-two",
        value: generationTwo,
      },
      {
        collection: "deployments",
        id: "other-application",
        value: { ...generationOne, applicationId: otherApplication },
      },
      {
        collection: "deployment-observations",
        id: "legacy-observation-one",
        value: {
          applicationId,
          pluginId: generationOne.pluginId,
          generation: generationOne.generation,
          status: "ready",
          diagnostics: [],
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      },
      {
        collection: "deployment-observations",
        id: "legacy-observation-two",
        value: {
          applicationId,
          pluginId: generationTwo.pluginId,
          generation: generationTwo.generation,
          status: "ready",
          diagnostics: [],
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      },
    ]);
    const runtime = createRuntime(
      configuration,
      await createLocalDrivers({ dataDirectory: directory }),
    );
    await runtime.start();
    const status = await runtime.status();
    assert.equal(status.counts.deployments, 1);
    assert.equal(status.readiness, true);
    await runtime.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid persisted deployment data fails recovery structurally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-runtime-invalid-deployment-"));
  try {
    await persistDeployment(directory, {
      state: "active",
      essential: true,
    });
    const runtime = createRuntime(
      configuration,
      await createLocalDrivers({ dataDirectory: directory }),
    );
    await assert.rejects(
      runtime.start(),
      (error) => diagnosticCode(error) === "DEPLOYMENT_RECORD_INVALID",
    );
    await assert.rejects(
      runtime.status(),
      (error) => diagnosticCode(error) === "DEPLOYMENT_RECORD_INVALID",
    );
    const firstStop = runtime.stop();
    assert.equal(runtime.stop(), firstStop);
    await firstStop;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal status preserves a live reader failure instead of exposing STATE_CLOSED", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-runtime-invalid-observation-"));
  try {
    const desired = deployment({ essential: true, state: "active" });
    await persistRecords(directory, [
      {
        collection: "deployments",
        id: "legacy-deployment",
        value: desired,
      },
      {
        collection: "deployment-observations",
        id: "legacy-observation",
        value: {
          applicationId,
          pluginId: desired.pluginId,
          generation: desired.generation,
          status: "not-a-status",
          diagnostics: [],
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      },
    ]);
    const runtime = createRuntime(
      configuration,
      await createLocalDrivers({ dataDirectory: directory }),
    );
    await runtime.start();
    await assert.rejects(
      runtime.status(),
      (error) => diagnosticCode(error) === "PROTOCOL_DEPLOYMENT_OBSERVATION_INVALID",
    );
    await assert.rejects(
      runtime.stop(),
      (error) => diagnosticCode(error) === "BOOTSTRAP_STOP_FAILED",
    );
    await assert.rejects(
      runtime.status(),
      (error) => diagnosticCode(error) === "PROTOCOL_DEPLOYMENT_OBSERVATION_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent SQLite stop and status calls share one terminal durable snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-runtime-concurrent-stop-status-"));
  try {
    await persistDeployment(directory, deployment({ essential: false, state: "active" }));
    const runtime = createRuntime(
      configuration,
      await createLocalDrivers({ dataDirectory: directory }),
    );
    await runtime.start();
    const stopping = runtime.stop();
    assert.equal(runtime.stop(), stopping);
    const statuses = await Promise.all(Array.from({ length: 16 }, async () => runtime.status()));
    await stopping;
    assert.equal(
      statuses.every((status) => status.counts.deployments === 1),
      true,
    );
    const stopped = await runtime.status();
    assert.equal(stopped.lifecycle, "stopped");
    assert.equal(stopped.counts.deployments, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
