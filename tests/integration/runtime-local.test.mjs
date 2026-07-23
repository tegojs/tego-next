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
  const drivers = await createLocalDrivers({ dataDirectory: directory });
  await drivers.state.open();
  await drivers.state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "deployments",
        id: "org.example.readiness",
      },
      value,
      { expectedRevision: "absent" },
    );
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
        await runtime.stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
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
    assert.equal((await runtime.status()).lifecycle, "failed");
    await runtime.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
