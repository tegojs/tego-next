import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseRuntimeSnapshotResponse } from "@tegojs/contracts";
import { requestControl } from "../../packages/cli/dist/src/control/client.js";
import { spawnManagedProcess } from "../support/managed-process.mjs";
import { createRunArtifacts } from "../support/run-artifacts.mjs";
import { collectSemanticSnapshot, settleWithCleanup } from "../support/single-main-process.mjs";

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

async function removeTreeWithReadOnlyDirectories(path) {
  async function makeDirectoriesWritable(candidate) {
    let identity;
    try {
      identity = await lstat(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (identity.isSymbolicLink() || !identity.isDirectory()) return;
    await chmod(candidate, 0o700);
    for (const entry of await readdir(candidate)) {
      await makeDirectoriesWritable(join(candidate, entry));
    }
  }

  await makeDirectoriesWritable(path);
  await rm(path, { force: true, recursive: true });
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
  await writeFile(
    join(pluginDirectory, "src", "component.ts"),
    `import { defineComponent } from "@tegojs/plugin-sdk";

const marker = Symbol.for("tego.example.echo.loaded");
const globals = globalThis as Record<PropertyKey, unknown>;
globals[marker] = (typeof globals[marker] === "number" ? globals[marker] : 0) + 1;

export default defineComponent({
  kind: "task",
  async run(context, input) {
    const requestedDelay =
      typeof input === "object" && input !== null && "delayMs" in input
        ? Reflect.get(input, "delayMs")
        : undefined;
    if (typeof requestedDelay === "number" && Number.isFinite(requestedDelay)) {
      const delayMs = Math.max(0, Math.min(requestedDelay, 10_000));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    if (
      typeof input === "object" &&
      input !== null &&
      Reflect.get(input, "inspectExecutionBinding") === true
    ) {
      return {
        configuration: context.config.get(),
        input,
      };
    }
    return input;
  },
});
`,
  );
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
    "--configuration",
    JSON.stringify(input.configuration),
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
    expectedOutput: input.expectedOutput,
  });
}

async function runTask({ endpoint, expectedOutput: expectedOutputInput, operationId, value }) {
  const expectedOutput = expectedOutputInput ?? value;
  const accepted = await startTask({ endpoint, operationId, value });
  let completed;
  try {
    completed = await runCli([
      "task",
      "wait",
      accepted.taskId,
      "--timeout-ms",
      String(processDeadlineMs),
      "--endpoint",
      endpoint,
      "--json",
    ]);
  } catch (error) {
    const pending = await runCli([
      "task",
      "status",
      accepted.taskId,
      "--endpoint",
      endpoint,
      "--json",
    ]).catch(() => undefined);
    throw new Error(`TASK_WAIT_FAILED:${JSON.stringify(pending)}`, { cause: error });
  }
  const status = await runCli([
    "task",
    "status",
    accepted.taskId,
    "--endpoint",
    endpoint,
    "--json",
  ]);
  assert.equal(
    completed.result.status,
    "succeeded",
    `task did not succeed: ${JSON.stringify(completed)}`,
  );
  assert.deepEqual(completed.result.output, expectedOutput);
  assert.deepEqual(status, completed);
  return completed;
}

async function startTask({ endpoint, operationId, orphanPolicy = "cancel", value }) {
  return runCli([
    "task",
    "run",
    "org.example.echo/echo",
    "--input",
    JSON.stringify(value),
    "--operation-id",
    operationId,
    "--orphan-policy",
    orphanPolicy,
    "--no-wait",
    "--endpoint",
    endpoint,
    "--json",
  ]);
}

async function runtimeSnapshot(endpoint, input = {}) {
  const requestId = randomUUID();
  const response = await requestControl({
    endpoint,
    input,
    operation: "runtime.snapshot",
    requestId,
    timeoutMs: processDeadlineMs,
  });
  assert.equal(response.requestId, requestId);
  if (!response.ok) {
    throw new Error(`RUNTIME_SNAPSHOT_FAILED:${JSON.stringify(response.diagnostic)}`);
  }
  return parseRuntimeSnapshotResponse(response.result);
}

async function semanticSnapshotItems(endpoint) {
  return collectSemanticSnapshot((input) => runtimeSnapshot(endpoint, input));
}

async function runtimeStatus(endpoint) {
  return runCli(["runtime", "status", "--endpoint", endpoint, "--json"]);
}

function onlySnapshotValue(page, section) {
  assert.equal(page.items.length, 1, `${section} must contain exactly one record`);
  return page.items[0].value;
}

function matchingSnapshotValue(page, section, predicate) {
  const matches = page.items.map((item) => item.value).filter(predicate);
  assert.equal(matches.length, 1, `${section} must contain exactly one matching record`);
  return matches[0];
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
  const restartedEndpoint = join(directory, "control-restart", "control.sock");
  const artifactPath = join(directory, "echo.tego");
  const credential = `worker-credential-${runIndex}`;
  const workerId = `worker-system-${runIndex}`;
  const pluginWorkspace = await mkdtemp(join(root, ".tego-system-plugin-"));
  let main;
  let worker;
  let restartedMain;
  let workerUrl;
  let operationError;
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
          labels: {},
          prepare: [artifactPath],
          resources: workerResources,
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
    const executionBindingConfiguration = {
      nested: {
        retries: 3,
        values: ["one", { enabled: true }],
      },
    };
    for (const [index, executor] of ["thread", "process", "remote"].entries()) {
      const value = {
        executor,
        inspectExecutionBinding: true,
        runIndex,
        value: index + 1,
      };
      tasks.push(
        await deployAndRun({
          endpoint,
          executor,
          generation: String(index + 1),
          input: {
            configuration: executionBindingConfiguration,
            digest: installation.digest,
            expectedOutput: {
              configuration: executionBindingConfiguration,
              input: value,
            },
            value,
          },
        }),
      );
    }
    for (const task of tasks) {
      assert.deepEqual(task.binding.configuration, executionBindingConfiguration);
      assert.equal(task.binding.permissionGrants.length > 0, true);
      assert.deepEqual(task.binding.capabilityDefinitions, []);
      assert.deepEqual(task.binding.capabilityBindings, []);
    }
    const beforeRestart = await runtimeSnapshot(endpoint);
    const beforeInstallation = onlySnapshotValue(beforeRestart.installations, "installations");
    const beforeDeployment = onlySnapshotValue(beforeRestart.deployments, "deployments");
    const beforeInstance = matchingSnapshotValue(
      beforeRestart.instances,
      "instances",
      (instance) => instance.deploymentGeneration === "3",
    );
    assert.equal(beforeInstallation.digest, installation.digest);
    assert.equal(beforeDeployment.generation, "3");
    assert.equal(beforeInstance.lifecycle, "ready");
    assert.equal(
      (await runCli(["runtime", "status", "--endpoint", endpoint, "--json"])).counts.workers,
      1,
    );

    const interruptedRemoteInput = {
      delayMs: 5_000,
      executor: "remote",
      phase: "main-crash",
      runIndex,
    };
    const interruptedRemote = await startTask({
      endpoint,
      operationId: `system-remote-main-crash-${runIndex}`,
      orphanPolicy: "finish-and-buffer",
      value: interruptedRemoteInput,
    });
    assert.equal(interruptedRemote.state, "running");

    process.kill(main.pid, "SIGKILL");
    await main.assertClean({ timeoutMs: processDeadlineMs });
    main = undefined;
    await assertPortClosed(workerUrl);
    const workerPort = Number(new URL(workerUrl).port);
    await mkdir(dirname(restartedEndpoint), { mode: 0o700, recursive: true });

    restartedMain = await spawnManagedProcess({
      artifacts,
      command: process.execPath,
      args: [mainFixture],
      env: {
        TEGO_TEST_MAIN_OPTIONS: JSON.stringify({
          applicationId: "application-default",
          dataDirectory,
          endpoint: restartedEndpoint,
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
    await waitForDeployment(restartedEndpoint, "3");
    await eventually(async () => {
      const status = await runCli(["runtime", "status", "--endpoint", restartedEndpoint, "--json"]);
      return status.counts.workers === 1 ? status : undefined;
    }, "Worker reconnection after Main restart");
    let recoveredRemote;
    try {
      recoveredRemote = await runCli([
        "task",
        "wait",
        interruptedRemote.taskId,
        "--timeout-ms",
        "10000",
        "--endpoint",
        restartedEndpoint,
        "--json",
      ]);
    } catch (error) {
      const pending = await runCli([
        "task",
        "status",
        interruptedRemote.taskId,
        "--endpoint",
        restartedEndpoint,
        "--json",
      ]).catch(() => undefined);
      throw new Error(`REMOTE_TASK_RECOVERY_FAILED:${JSON.stringify(pending)}`, { cause: error });
    }
    assert.equal(recoveredRemote.state, "terminal");
    assert.equal(
      recoveredRemote.result.status,
      "succeeded",
      `recovered remote task failed: ${JSON.stringify(recoveredRemote)}`,
    );
    assert.deepEqual(recoveredRemote.result.output, interruptedRemoteInput);

    const afterRestart = await runtimeSnapshot(restartedEndpoint);
    assert.deepEqual(
      onlySnapshotValue(afterRestart.installations, "installations"),
      beforeInstallation,
    );
    assert.deepEqual(onlySnapshotValue(afterRestart.deployments, "deployments"), beforeDeployment);
    assert.deepEqual(
      matchingSnapshotValue(
        afterRestart.instances,
        "instances",
        (instance) => instance.deploymentGeneration === "3",
      ),
      beforeInstance,
    );
    for (const task of tasks) {
      const status = await runCli([
        "task",
        "status",
        task.taskId,
        "--endpoint",
        restartedEndpoint,
        "--json",
      ]);
      assert.equal(status.taskId, task.taskId);
      assert.equal(status.attemptId, task.attemptId);
      assert.deepEqual(status.result.output, task.result.output);
    }
    const postRestartRemote = await runTask({
      endpoint: restartedEndpoint,
      operationId: `system-remote-after-restart-${runIndex}`,
      value: { executor: "remote", phase: "after-restart", runIndex },
    });
    assert.deepEqual(postRestartRemote.result.output, {
      executor: "remote",
      phase: "after-restart",
      runIndex,
    });

    return { directory, endpoint: restartedEndpoint, workerUrl };
  } catch (error) {
    operationError = error;
  } finally {
    await settleWithCleanup(async () => {
      if (operationError !== undefined) throw operationError;
    }, [
      async () => stopProcess(worker),
      async () => {
        if (restartedMain !== undefined) {
          await runCli(["runtime", "stop", "--endpoint", restartedEndpoint, "--json"]);
        }
      },
      async () => stopProcess(restartedMain),
      async () => {
        if (main !== undefined) {
          await runCli(["runtime", "stop", "--endpoint", endpoint, "--json"]);
        }
      },
      async () => stopProcess(main),
      async () => rm(endpoint, { force: true }),
      async () => {
        assert.equal(await exists(endpoint), false);
        assert.equal(await exists(restartedEndpoint), false);
      },
      async () => {
        if (workerUrl !== undefined) await assertPortClosed(workerUrl);
      },
      async () => {
        for (const name of ["main", "worker", "main-restart"]) {
          const cleanupPath = artifacts.cleanup(name);
          if (!(await exists(cleanupPath))) continue;
          const cleanup = JSON.parse(await readFile(cleanupPath, "utf8"));
          assert.deepEqual(cleanup.streamErrors ?? [], []);
          assert.deepEqual(cleanup.processingErrors ?? [], []);
        }
      },
      async () => removeTreeWithReadOnlyDirectories(directory),
      async () => rm(pluginWorkspace, { force: true, recursive: true }),
      async () => artifacts.dispose(),
    ]);
  }
}

test("@spec:runtime-operations/ci-authoritative-system-acceptance/real-single-main-process-flow execution binding parity", async () => {
  const first = await runSystemFlow(1);
  const second = await runSystemFlow(2);
  assert.notEqual(first.directory, second.directory);
  assert.notEqual(first.workerUrl, second.workerUrl);
});

const postgresUrl = process.env.TEGO_POSTGRES_URL;

test("@spec:coordination-provider/fenced-leadership/real-two-main-postgres-worker-failover", {
  skip:
    postgresUrl === undefined || postgresUrl.trim().length === 0
      ? "TEGO_POSTGRES_URL is required"
      : false,
}, async () => {
  assert.notEqual(postgresUrl, undefined);
  const uniqueRun = `${Date.now()}-${process.pid}`;
  const directory = await mkdtemp(join(tmpdir(), "tego-two-main-postgres-"));
  const artifacts = await createRunArtifacts("two-main-postgres");
  const runtimeId = `runtime-postgres-${uniqueRun}`;
  const credential = `worker-credential-${uniqueRun}`;
  const workerId = `worker-postgres-${uniqueRun}`;
  const artifactPath = join(directory, "echo.tego");
  const pluginWorkspace = await mkdtemp(join(root, ".tego-system-plugin-"));
  const mainConfigurations = [
    {
      dataDirectory: join(directory, "main-a"),
      endpoint: join(directory, "control-a", "control.sock"),
      name: "main-a",
      nodeId: `node-postgres-a-${uniqueRun}`,
    },
    {
      dataDirectory: join(directory, "main-b"),
      endpoint: join(directory, "control-b", "control.sock"),
      name: "main-b",
      nodeId: `node-postgres-b-${uniqueRun}`,
    },
  ];
  const mains = [];
  let worker;
  let restartedWorker;
  let killedLeader;
  let operationError;
  try {
    const pluginDirectory = await prepareEchoPlugin(pluginWorkspace);
    await runCli(["plugin", "pack", pluginDirectory, "--output", artifactPath, "--json"]);
    for (const configuration of mainConfigurations) {
      await mkdir(dirname(configuration.endpoint), { mode: 0o700, recursive: true });
      const handle = await spawnManagedProcess({
        artifacts,
        command: process.execPath,
        args: [mainFixture],
        env: {
          TEGO_TEST_MAIN_OPTIONS: JSON.stringify({
            applicationId: "application-default",
            dataDirectory: configuration.dataDirectory,
            endpoint: configuration.endpoint,
            mode: "multi-main",
            nodeId: configuration.nodeId,
            postgresUrl,
            runtimeId,
            worker: { credential, host: "127.0.0.1", port: 0, workerId },
          }),
        },
        name: configuration.name,
      });
      const ready = await handle.ready((event) => event.type === "main.ready", {
        timeoutMs: processDeadlineMs,
      });
      assert.equal(ready.pid, handle.pid);
      assert.equal(typeof ready.workerUrl, "string");
      mains.push({ configuration, handle, workerUrl: new URL(ready.workerUrl).href });
    }

    const elected = await eventually(async () => {
      const statuses = await Promise.all(
        mains.map(async (candidate) => ({
          candidate,
          status: await runtimeStatus(candidate.configuration.endpoint),
        })),
      );
      const leaders = statuses.filter(({ status }) => status.authority !== undefined);
      return leaders.length === 1
        ? {
            leader: leaders[0],
            follower: statuses.find(({ status }) => status.authority === undefined),
          }
        : undefined;
    }, "one PostgreSQL Main becomes leader");
    assert.notEqual(elected.leader, undefined);
    assert.notEqual(elected.follower, undefined);
    const leader = elected.leader;
    const follower = elected.follower;
    assert.equal(BigInt(leader.status.authority.epoch) > 0n, true);
    assert.equal(follower.status.counts.workers, 0);

    worker = await spawnManagedProcess({
      artifacts,
      command: process.execPath,
      args: [workerFixture],
      env: {
        TEGO_TEST_WORKER_COMMAND: JSON.stringify({
          kind: "worker.start",
          credential,
          dataDirectory: join(directory, "worker"),
          direction: "connect",
          json: true,
          labels: {},
          prepare: [artifactPath],
          resources: workerResources,
          url: leader.candidate.workerUrl,
          workerId,
        }),
      },
      name: "worker-leader",
    });
    await worker.ready((event) => event.type === "worker.ready", {
      timeoutMs: processDeadlineMs,
    });
    await eventually(async () => {
      const [leaderStatus, followerStatus] = await Promise.all([
        runtimeStatus(leader.candidate.configuration.endpoint),
        runtimeStatus(follower.candidate.configuration.endpoint),
      ]);
      return leaderStatus.counts.workers === 1 && followerStatus.counts.workers === 0
        ? { followerStatus, leaderStatus }
        : undefined;
    }, "Worker placement exists only on PostgreSQL leader");

    const installation = await runCli([
      "plugin",
      "install",
      artifactPath,
      "--endpoint",
      leader.candidate.configuration.endpoint,
      "--json",
    ]);
    const beforeFailover = await deployAndRun({
      endpoint: leader.candidate.configuration.endpoint,
      executor: "remote",
      generation: "1",
      input: {
        digest: installation.digest,
        value: { executor: "remote", phase: "before-leader-failover", uniqueRun },
      },
    });

    const followerSemanticBefore = JSON.stringify(
      await semanticSnapshotItems(follower.candidate.configuration.endpoint),
    );
    const leaderSemanticBefore = JSON.stringify(
      await semanticSnapshotItems(leader.candidate.configuration.endpoint),
    );
    assert.equal(followerSemanticBefore, leaderSemanticBefore);
    await assert.rejects(
      runCli([
        "plugin",
        "install",
        artifactPath,
        "--endpoint",
        follower.candidate.configuration.endpoint,
        "--json",
      ]),
      (error) => {
        assert.equal(JSON.parse(error.stderr).diagnostic.code, "COORDINATION_NOT_LEADER");
        return true;
      },
    );
    const followerSemanticAfter = JSON.stringify(
      await semanticSnapshotItems(follower.candidate.configuration.endpoint),
    );
    const leaderSemanticAfter = JSON.stringify(
      await semanticSnapshotItems(leader.candidate.configuration.endpoint),
    );
    assert.equal(followerSemanticAfter, followerSemanticBefore);
    assert.equal(leaderSemanticAfter, leaderSemanticBefore);
    assert.equal(followerSemanticAfter, leaderSemanticAfter);

    killedLeader = leader.candidate.handle;
    process.kill(killedLeader.pid, "SIGKILL");
    await killedLeader.assertClean({ timeoutMs: processDeadlineMs });
    const oldEpoch = BigInt(leader.status.authority.epoch);
    const promoted = await eventually(async () => {
      const status = await runtimeStatus(follower.candidate.configuration.endpoint);
      return status.authority !== undefined && BigInt(status.authority.epoch) > oldEpoch
        ? status
        : undefined;
    }, "PostgreSQL follower promotion with a newer authority epoch");

    await stopProcess(worker);
    worker = undefined;
    restartedWorker = await spawnManagedProcess({
      artifacts,
      command: process.execPath,
      args: [workerFixture],
      env: {
        TEGO_TEST_WORKER_COMMAND: JSON.stringify({
          kind: "worker.start",
          credential,
          dataDirectory: join(directory, "worker"),
          direction: "connect",
          json: true,
          labels: {},
          prepare: [artifactPath],
          resources: workerResources,
          url: follower.candidate.workerUrl,
          workerId,
        }),
      },
      name: "worker-follower",
    });
    await restartedWorker.ready((event) => event.type === "worker.ready", {
      timeoutMs: processDeadlineMs,
    });
    await eventually(async () => {
      const status = await runtimeStatus(follower.candidate.configuration.endpoint);
      return status.counts.workers === 1 && status.authority?.epoch === promoted.authority.epoch
        ? status
        : undefined;
    }, "Worker placement moves to the promoted PostgreSQL Main");
    await waitForDeployment(follower.candidate.configuration.endpoint, "1");

    const afterFailover = await runTask({
      endpoint: follower.candidate.configuration.endpoint,
      operationId: `system-remote-after-leader-failover-${uniqueRun}`,
      value: { executor: "remote", phase: "after-leader-failover", uniqueRun },
    });
    const snapshot = await runtimeSnapshot(follower.candidate.configuration.endpoint);
    const taskRecords = snapshot.tasks.items.map((item) => item.value);
    assert.equal(taskRecords.length, 2);
    assert.equal(new Set(taskRecords.map((task) => task.taskId)).size, 2);
    assert.deepEqual(
      new Set(taskRecords.map((task) => task.taskId)),
      new Set([beforeFailover.taskId, afterFailover.taskId]),
    );
    for (const task of taskRecords) {
      assert.equal(task.state, "terminal");
      assert.equal(task.result.status, "succeeded");
    }
  } catch (error) {
    operationError = error;
  } finally {
    await settleWithCleanup(async () => {
      if (operationError !== undefined) throw operationError;
    }, [
      async () => stopProcess(restartedWorker),
      async () => stopProcess(worker),
      ...mains.flatMap((main) =>
        main.handle === killedLeader
          ? []
          : [
              async () =>
                runCli(["runtime", "stop", "--endpoint", main.configuration.endpoint, "--json"]),
              async () => stopProcess(main.handle),
            ],
      ),
      ...mainConfigurations.map(
        (configuration) => async () => rm(configuration.endpoint, { force: true }),
      ),
      async () => removeTreeWithReadOnlyDirectories(directory),
      async () => rm(pluginWorkspace, { force: true, recursive: true }),
      async () => artifacts.dispose(),
    ]);
  }
});
