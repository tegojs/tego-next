import assert from "node:assert/strict";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createNodeRuntimeHost, packPlugin } from "@tegojs/cli";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const examplePlugin = join(root, "examples/echo-plugin");
const convergenceDeadlineMs = 2_000;

async function eventually(operation, description) {
  const signal = AbortSignal.timeout(convergenceDeadlineMs);
  while (!signal.aborted) {
    const result = await operation();
    if (result !== undefined) return result;
    await new Promise((resolveTurn, reject) => {
      const immediate = setImmediate(resolveTurn);
      signal.addEventListener(
        "abort",
        () => {
          clearImmediate(immediate);
          reject(signal.reason);
        },
        { once: true },
      );
    }).catch(() => undefined);
  }
  throw new Error(`EVENTUALLY_TIMEOUT:${description}`);
}

async function removePreparedTree(rootPath) {
  async function makeWritable(path) {
    let identity;
    try {
      identity = await lstat(path);
    } catch {
      return;
    }
    if (identity.isSymbolicLink() || !identity.isDirectory()) return;
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await makeWritable(join(path, entry));
  }
  await makeWritable(rootPath);
  await rm(rootPath, { recursive: true, force: true });
}

async function prepareArtifact(directory, pluginWorkspace) {
  const pluginDirectory = join(pluginWorkspace, "echo-plugin");
  const artifactPath = join(directory, "echo.tego");
  await cp(examplePlugin, pluginDirectory, { recursive: true });
  const manifestPath = join(pluginDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.contractRange = ">=0.0.0 <1.0.0";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return packPlugin({ artifactPath, pluginDirectory });
}

async function createHost(dataDirectory) {
  return createNodeRuntimeHost({
    applicationId: "application-default",
    dataDirectory,
    mode: "single-main",
    nodeId: "node-integration",
    runtimeId: "runtime-integration",
  });
}

async function waitForReady(runtime, generation) {
  return eventually(async () => {
    const status = await runtime.operations.pluginStatus({
      applicationId: "application-default",
      pluginId: "org.example.echo",
    });
    return status.desired?.generation === generation && status.observation?.status === "ready"
      ? status
      : undefined;
  }, `local deployment generation ${generation} readiness`);
}

async function deploy(runtime, digest, executor, generation) {
  const deployment = await runtime.operations.deployPlugin({
    applicationId: "application-default",
    pluginId: "org.example.echo",
    artifactDigest: digest,
    essential: true,
    configuration: {},
    permissionGrants: [{ kind: "executor", executors: [executor] }],
    capabilityBindings: {},
  });
  assert.equal(deployment.generation, generation);
  await waitForReady(runtime, generation);
}

async function runEcho(runtime, executor, operationId) {
  const input = { executor, operationId };
  const accepted = await runtime.operations.runTask({
    applicationId: "application-default",
    pluginId: "org.example.echo",
    componentId: "echo",
    input,
    deadline: new Date(Date.now() + convergenceDeadlineMs).toISOString(),
    orphanPolicy: "finish-and-persist",
    operationId,
  });
  const completed = await runtime.operations.waitTask(accepted.taskId);
  assert.equal(completed.result?.status, "succeeded");
  assert.equal(completed.result?.executor.kind, executor);
  assert.deepEqual(completed.result?.output, input);
  return completed;
}

test("@spec:runtime-operations/local-node-runtime-host/thread-process-convergence-and-reattachment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-node-runtime-host-"));
  const pluginWorkspace = await mkdtemp(join(root, ".tego-node-runtime-host-"));
  const dataDirectory = join(directory, "runtime");
  let host;
  let restarted;
  try {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const packed = await prepareArtifact(directory, pluginWorkspace);
    host = await createHost(dataDirectory);
    await host.runtime.start();
    const ingested = await host.artifactIngress.putPath(packed.artifactPath);
    assert.equal(ingested, packed.digest);
    const installation = await host.runtime.operations.installPlugin({ digest: packed.digest });
    assert.equal(installation.digest, packed.digest);

    await deploy(host.runtime, packed.digest, "thread", "1");
    await runEcho(host.runtime, "thread", "integration-thread");
    await deploy(host.runtime, packed.digest, "process", "2");
    const processTask = await runEcho(host.runtime, "process", "integration-process");

    await host.runtime.stop();
    host = undefined;

    restarted = await createHost(dataDirectory);
    await restarted.runtime.start();
    await waitForReady(restarted.runtime, "2");
    const recovered = await restarted.runtime.operations.taskStatus(processTask.taskId);
    assert.equal(recovered?.attemptId, processTask.attemptId);
    assert.deepEqual(recovered?.result?.output, processTask.result?.output);
    await runEcho(restarted.runtime, "process", "integration-process-after-restart");
  } finally {
    await restarted?.runtime.stop().catch(() => undefined);
    await host?.runtime.stop().catch(() => undefined);
    await removePreparedTree(directory);
    await rm(pluginWorkspace, { recursive: true, force: true });
  }
});
