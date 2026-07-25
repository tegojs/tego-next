import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawnManagedProcess } from "../support/managed-process.mjs";
import { createRunArtifacts } from "../support/run-artifacts.mjs";

const executeFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliBinary = join(root, "packages/cli/dist/src/bin.js");
const mainFixture = join(root, "tests/fixtures/main-process.mjs");
const workerFixture = join(root, "tests/fixtures/worker-process.mjs");
const examplePlugin = join(root, "examples/echo-plugin");
const processDeadlineMs = 15_000;
const workerResources = {
  cpuMillis: 1_000,
  memoryBytes: 256 * 1024 * 1024,
  storageBytes: 256 * 1024 * 1024,
};

async function runCli(arguments_) {
  const { stdout, stderr } = await executeFile(process.execPath, [cliBinary, ...arguments_], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: processDeadlineMs,
  });
  assert.equal(stderr, "");
  return JSON.parse(stdout);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function eventually(operation, description) {
  const signal = AbortSignal.timeout(processDeadlineMs);
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

async function assertPortClosed(workerUrl) {
  const url = new URL(workerUrl);
  const closed = await new Promise((resolveClosed) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.once("connect", () => {
      socket.destroy();
      resolveClosed(false);
    });
    socket.once("error", () => resolveClosed(true));
  });
  assert.equal(closed, true);
}

async function prepareEchoPlugin(directory) {
  const pluginDirectory = join(directory, "echo-plugin");
  await cp(examplePlugin, pluginDirectory, { recursive: true });
  const manifestPath = join(pluginDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.contractRange = ">=0.0.0 <1.0.0";
  manifest.permissions.push({
    kind: "worker",
    labels: {},
    resources: workerResources,
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return pluginDirectory;
}

async function waitForDeployment(endpoint, generation) {
  return eventually(async () => {
    const status = await runCli([
      "plugin",
      "status",
      "org.example.echo",
      "--endpoint",
      endpoint,
      "--json",
    ]);
    return status.desired?.generation === generation && status.observation?.status === "ready"
      ? status
      : undefined;
  }, `deployment generation ${generation} readiness`);
}

async function deployAndRun({ endpoint, executor, generation, input }) {
  const permissions = [
    { kind: "executor", executors: [executor] },
    ...(executor === "remote" ? [{ kind: "worker", labels: {}, resources: workerResources }] : []),
  ];
  const deployment = await runCli([
    "plugin",
    "deploy",
    "org.example.echo",
    "--digest",
    input.digest,
    "--permissions",
    JSON.stringify(permissions),
    "--endpoint",
    endpoint,
    "--json",
  ]);
  assert.equal(deployment.generation, generation);
  await waitForDeployment(endpoint, generation);
  return runTask({
    endpoint,
    operationId: `system-${executor}`,
    value: input.value,
  });
}

async function runTask({ endpoint, operationId, value }) {
  const accepted = await runCli([
    "task",
    "run",
    "org.example.echo/echo",
    "--input",
    JSON.stringify(value),
    "--operation-id",
    operationId,
    "--no-wait",
    "--endpoint",
    endpoint,
    "--json",
  ]);
  const completed = await runCli([
    "task",
    "wait",
    accepted.taskId,
    "--timeout-ms",
    String(processDeadlineMs),
    "--endpoint",
    endpoint,
    "--json",
  ]);
  const status = await runCli([
    "task",
    "status",
    accepted.taskId,
    "--endpoint",
    endpoint,
    "--json",
  ]);
  assert.equal(completed.result.status, "succeeded");
  assert.deepEqual(completed.result.output, value);
  assert.deepEqual(status, completed);
  return completed;
}

async function runtimeSnapshot(endpoint) {
  return runCli(["runtime", "snapshot", "--endpoint", endpoint, "--json"]);
}

async function stopProcess(processHandle) {
  if (processHandle === undefined) return;
  await processHandle.stop({ timeoutMs: 5_000 });
  await processHandle.assertClean();
}

async function runSystemFlow(runIndex) {
  const directory = await mkdtemp(join(tmpdir(), `tego-single-main-${runIndex}-`));
  const artifacts = await createRunArtifacts(`single-main-${runIndex}`);
  const dataDirectory = join(directory, "main");
  const workerDataDirectory = join(directory, "worker");
  const endpoint = join(directory, "control", "control.sock");
  const artifactPath = join(directory, "echo.tego");
  const credential = `worker-credential-${runIndex}`;
  const workerId = `worker-system-${runIndex}`;
  const pluginWorkspace = await mkdtemp(join(root, ".tego-system-plugin-"));
  let main;
  let worker;
  let restartedMain;
  let workerUrl;
  try {
    await mkdir(dirname(endpoint), { mode: 0o700, recursive: true });
    const pluginDirectory = await prepareEchoPlugin(pluginWorkspace);
    await runCli(["plugin", "pack", pluginDirectory, "--output", artifactPath, "--json"]);
    main = await spawnManagedProcess({
      artifacts,
      command: process.execPath,
      args: [mainFixture],
      env: {
        TEGO_TEST_MAIN_OPTIONS: JSON.stringify({
          applicationId: "application-default",
          dataDirectory,
          endpoint,
          mode: "single-main",
          nodeId: `node-system-${runIndex}`,
          runtimeId: `runtime-system-${runIndex}`,
          worker: { credential, host: "127.0.0.1", port: 0, workerId },
        }),
      },
      name: "main",
    });
    const mainReady = await main.ready((event) => event.type === "main.ready", {
      timeoutMs: processDeadlineMs,
    });
    assert.equal(mainReady.pid, main.pid);
    assert.equal(typeof mainReady.workerUrl, "string");
    workerUrl = new URL(mainReady.workerUrl).href;
    assert.notEqual(new URL(workerUrl).port, "0");

    worker = await spawnManagedProcess({
      artifacts,
      command: process.execPath,
      args: [workerFixture],
      env: {
        TEGO_TEST_WORKER_COMMAND: JSON.stringify({
          kind: "worker.start",
          credential,
          dataDirectory: workerDataDirectory,
          direction: "connect",
          json: true,
          prepare: [],
          url: workerUrl,
          workerId,
        }),
      },
      name: "worker",
    });
    const workerReady = await worker.ready((event) => event.type === "worker.ready", {
      timeoutMs: processDeadlineMs,
    });
    assert.equal(workerReady.pid, worker.pid);

    const installation = await runCli([
      "plugin",
      "install",
      artifactPath,
      "--endpoint",
      endpoint,
      "--json",
    ]);
    const tasks = [];
    for (const [index, executor] of ["thread", "process", "remote"].entries()) {
      tasks.push(
        await deployAndRun({
          endpoint,
          executor,
          generation: String(index + 1),
          input: {
            digest: installation.digest,
            value: { executor, runIndex, value: index + 1 },
          },
        }),
      );
    }
    const beforeRestart = await runtimeSnapshot(endpoint);
    assert.equal(beforeRestart.installation.digest, installation.digest);
    assert.equal(beforeRestart.deployment.generation, "3");
    assert.equal(beforeRestart.instance.lifecycle, "ready");
    assert.equal(beforeRestart.worker.workerId, workerId);
    assert.equal(beforeRestart.worker.preparedArtifacts.includes(installation.digest), true);
    const epochBeforeRestart = BigInt(beforeRestart.worker.epoch);

    await runCli(["runtime", "stop", "--endpoint", endpoint, "--json"]);
    await main.assertClean();
    main = undefined;
    assert.equal(await exists(endpoint), false);
    await assertPortClosed(workerUrl);
    const workerPort = Number(new URL(workerUrl).port);

    restartedMain = await spawnManagedProcess({
      artifacts,
      command: process.execPath,
      args: [mainFixture],
      env: {
        TEGO_TEST_MAIN_OPTIONS: JSON.stringify({
          applicationId: "application-default",
          dataDirectory,
          endpoint,
          mode: "single-main",
          nodeId: `node-system-${runIndex}`,
          runtimeId: `runtime-system-${runIndex}`,
          worker: { credential, host: "127.0.0.1", port: workerPort, workerId },
        }),
      },
      name: "main-restart",
    });
    const restartedMainReady = await restartedMain.ready((event) => event.type === "main.ready", {
      timeoutMs: processDeadlineMs,
    });
    assert.equal(new URL(restartedMainReady.workerUrl).href, workerUrl);
    await waitForDeployment(endpoint, "3");
    const afterRestart = await eventually(async () => {
      const snapshot = await runtimeSnapshot(endpoint);
      return BigInt(snapshot.worker.epoch) > epochBeforeRestart ? snapshot : undefined;
    }, "durable Worker epoch advancement after Main restart");
    assert.deepEqual(afterRestart.installation, beforeRestart.installation);
    assert.deepEqual(afterRestart.deployment, beforeRestart.deployment);
    assert.deepEqual(afterRestart.instance, beforeRestart.instance);
    assert.equal(afterRestart.worker.workerId, workerId);
    assert.equal(afterRestart.worker.preparedArtifacts.includes(installation.digest), true);
    for (const task of tasks) {
      const status = await runCli([
        "task",
        "status",
        task.taskId,
        "--endpoint",
        endpoint,
        "--json",
      ]);
      assert.equal(status.taskId, task.taskId);
      assert.equal(status.attemptId, task.attemptId);
      assert.deepEqual(status.result.output, task.result.output);
    }
    const postRestartRemote = await runTask({
      endpoint,
      operationId: `system-remote-after-restart-${runIndex}`,
      value: { executor: "remote", phase: "after-restart", runIndex },
    });
    assert.deepEqual(postRestartRemote.result.output, {
      executor: "remote",
      phase: "after-restart",
      runIndex,
    });

    return { directory, endpoint, workerUrl };
  } finally {
    try {
      await stopProcess(worker);
      if (restartedMain !== undefined) {
        await runCli(["runtime", "stop", "--endpoint", endpoint, "--json"]).catch(() => undefined);
        await stopProcess(restartedMain);
      }
      if (main !== undefined) {
        await runCli(["runtime", "stop", "--endpoint", endpoint, "--json"]).catch(() => undefined);
        await stopProcess(main);
      }
      assert.equal(await exists(endpoint), false);
      if (workerUrl !== undefined) await assertPortClosed(workerUrl);
      for (const name of ["main", "worker", "main-restart"]) {
        const cleanupPath = artifacts.cleanup(name);
        if (!(await exists(cleanupPath))) continue;
        const cleanup = JSON.parse(await readFile(cleanupPath, "utf8"));
        assert.deepEqual(cleanup.streamErrors ?? [], []);
        assert.deepEqual(cleanup.processingErrors ?? [], []);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
      await rm(pluginWorkspace, { force: true, recursive: true });
      await artifacts.dispose();
    }
  }
}

test("@spec:runtime-operations/ci-authoritative-system-acceptance/real-single-main-process-flow", async () => {
  const first = await runSystemFlow(1);
  const second = await runSystemFlow(2);
  assert.notEqual(first.directory, second.directory);
  assert.notEqual(first.workerUrl, second.workerUrl);
});
