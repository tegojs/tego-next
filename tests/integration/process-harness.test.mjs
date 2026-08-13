import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createPosixTreeStrategy,
  createWindowsTreeStrategy,
  ManagedProcess,
  runBoundedProcessHelper,
  spawnManagedProcess,
} from "../support/managed-process.mjs";
import { createRunArtifacts } from "../support/run-artifacts.mjs";
import { usingManagedProcess } from "../support/single-main-process.mjs";
import { registerTestCleanup, useTempWorkspace } from "../support/temp-workspace.mjs";

function registerCleanup(t, child) {
  registerTestCleanup(t, async () => {
    await child.stop({ timeoutMs: 2_000 });
    await child.assertClean();
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function nextEventLoopTurn(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearImmediate(immediate);
      reject(signal.reason);
    };
    const immediate = setImmediate(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function settleTestPromiseWithin(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ASSERT_CLEAN_TIMEOUT")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitForPidDeath(pid, { timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs);
  while (isProcessAlive(pid)) {
    try {
      await nextEventLoopTurn(signal);
    } catch {
      throw new Error(`PROCESS_DEATH_TIMEOUT:${pid}:${timeoutMs}ms`);
    }
  }
}

async function waitForArtifactEvent(path, predicate, { timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs);
  while (!signal.aborted) {
    const contents = await readFile(path, "utf8");
    for (const line of contents.split("\n")) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // A concurrent append can expose a partial final line; retry from disk.
        continue;
      }
      if (predicate(event)) return event;
    }
    try {
      await nextEventLoopTurn(signal);
    } catch {
      break;
    }
  }
  throw new Error(`ARTIFACT_EVENT_TIMEOUT:${path}:${timeoutMs}ms`);
}

async function processPidFromStdout(artifacts, processName, eventTypes) {
  const stdout = await readFile(artifacts.stdout(processName), "utf8");
  for (const line of stdout.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (eventTypes.includes(event.type)) return event.pid;
  }
  return undefined;
}

function registerExpectedDiagnosticCleanup(t, child, expected, finishResources = async () => {}) {
  t.after(async () => {
    let stopError;
    try {
      await child.stop({ timeoutMs: 2_000 });
    } catch (error) {
      stopError = error;
    }
    await finishResources();
    if (stopError !== undefined) assert.match(String(stopError), expected);
    await assert.rejects(child.assertClean(), expected);
  });
}

test("@spec:runtime-operations/ci-authoritative-system-acceptance/actionable-system-test-failure", async (t) => {
  const artifacts = await createRunArtifacts("managed-process");
  const workspace = await useTempWorkspace(t, "managed-process");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: [
      "--eval",
      [
        "require('node:fs').writeFileSync(",
        "require('node:path').join(process.env.TEGO_TEST_WORKSPACE, 'child.txt'),",
        "'created\\n');",
        "process.once('SIGTERM', () => process.exit(0));",
        "console.log(JSON.stringify({ type: 'ready', pid: process.pid }));",
        "setInterval(() => {}, 1_000);",
      ].join(" "),
    ],
    env: { TEGO_TEST_WORKSPACE: workspace.directory },
    name: "ready-child",
  });
  registerCleanup(t, child);
  const ready = await child.ready((event) => event.type === "ready", { timeoutMs: 2_000 });
  assert.equal(ready.pid, child.pid);
  await child.stop({ timeoutMs: 2_000 });
  await child.assertClean();
  assert.equal(await readFile(workspace.path("child.txt"), "utf8"), "created\n");
  assert.match(await readFile(artifacts.stdout("ready-child"), "utf8"), /"type":"ready"/u);
});

test("managed process reports deadline and preserves logs", async (t) => {
  const artifacts = await createRunArtifacts("silent-process");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: [
      "--eval",
      "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)",
    ],
    name: "silent-child",
  });
  registerCleanup(t, child);
  await assert.rejects(
    child.ready(() => true, { timeoutMs: 50 }),
    /PROCESS_READY_TIMEOUT/u,
  );
  await child.stop({ timeoutMs: 2_000 });
  assert.equal(await child.artifactsExist(), true);
});

test("registered cleanup stops a child after a readiness failure", async (t) => {
  let pid;
  await t.test("failure path", async (t) => {
    const artifacts = await createRunArtifacts("after-cleanup");
    const child = await spawnManagedProcess({
      artifacts,
      command: process.execPath,
      args: ["--eval", "process.stdin.resume()"],
      name: "after-child",
    });
    registerCleanup(t, child);
    pid = child.pid;
    await assert.rejects(
      child.ready(() => true, { timeoutMs: 20 }),
      /PROCESS_READY_TIMEOUT/u,
    );
  });
  assert.equal(isProcessAlive(pid), false);
});

test("registered cleanup stops a child before removing its workspace", async (t) => {
  let workspace;
  await t.test("readiness failure while child owns workspace", async (t) => {
    const artifacts = await createRunArtifacts("ordered-cleanup");
    workspace = await useTempWorkspace(t, "ordered-cleanup");
    const child = await spawnManagedProcess({
      artifacts,
      command: process.execPath,
      args: [
        "--eval",
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "process.stdin.on('end', () => {",
          "fs.writeFileSync(path.join(process.env.TEGO_TEST_WORKSPACE, 'stopped.txt'), 'stopped\\n');",
          "});",
          "process.stdin.resume();",
        ].join(" "),
      ],
      env: { TEGO_TEST_WORKSPACE: workspace.directory },
      name: "workspace-owner",
    });
    registerCleanup(t, child);
    await assert.rejects(
      child.ready(() => true, { timeoutMs: 20 }),
      /PROCESS_READY_TIMEOUT/u,
    );
  });
  await workspace.assertRemoved();
});

test("managed process reports spawn failure without waiting for exit", async (t) => {
  const artifacts = await createRunArtifacts("spawn-failure");
  const child = await spawnManagedProcess({
    artifacts,
    command: workspacePathForMissingExecutable(artifacts.directory),
    args: [],
    name: "missing-child",
  });
  registerExpectedDiagnosticCleanup(t, child, /PROCESS_SPAWN_ERROR/u);
  await assert.rejects(settleTestPromiseWithin(child.assertClean(), 200), /PROCESS_SPAWN_ERROR/u);
});

test("managed process reports a live child without waiting for exit", async (t) => {
  const artifacts = await createRunArtifacts("live-child");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: ["--eval", "console.log(JSON.stringify({ type: 'ready' })); process.stdin.resume();"],
    name: "live-child",
  });
  registerCleanup(t, child);
  await child.ready((event) => event.type === "ready", { timeoutMs: 2_000 });
  await assert.rejects(settleTestPromiseWithin(child.assertClean(), 200), /PROCESS_STILL_RUNNING/u);
  await assert.rejects(
    settleTestPromiseWithin(child.assertClean({ timeoutMs: 20 }), 200),
    /PROCESS_STILL_RUNNING/u,
  );
});

test("managed process can wait boundedly for an externally killed child to exit", async (t) => {
  const artifacts = await createRunArtifacts("externally-killed-child");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: ["--eval", "console.log(JSON.stringify({ type: 'ready' })); process.stdin.resume();"],
    name: "externally-killed-child",
  });
  registerCleanup(t, child);
  await child.ready((event) => event.type === "ready", { timeoutMs: 2_000 });
  process.kill(child.pid, "SIGKILL");
  await child.assertClean({ timeoutMs: 2_000 });
});

test("managed process gives stdin EOF a bounded graceful stop phase", async (t) => {
  const artifacts = await createRunArtifacts("stdin-eof-stop");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: [
      "--eval",
      [
        "process.stdin.once('end', () => process.exit(0));",
        "process.stdin.resume();",
        "console.log(JSON.stringify({ type: 'ready' }));",
      ].join(" "),
    ],
    name: "stdin-child",
  });
  registerCleanup(t, child);
  await child.ready((event) => event.type === "ready", { timeoutMs: 2_000 });
  await child.stop({ timeoutMs: 2_000 });
  await child.assertClean();
  const cleanup = JSON.parse(await readFile(artifacts.cleanup("stdin-child"), "utf8"));
  assert.deepEqual(cleanup.actions, ["stdin:end"]);
});

test("managed process bounds stalled stream finalization", async (t) => {
  const artifacts = await createRunArtifacts("stalled-finalization");
  const grandchild = [
    "const net = require('node:net');",
    "const server = net.createServer();",
    "server.listen(0, '127.0.0.1', () =>",
    "console.log(JSON.stringify({ type: 'grandchild-ready', pid: process.pid })));",
    "process.once('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join(" ");
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const spawned = spawn(process.execPath, ['--eval', ${JSON.stringify(grandchild)}],`,
    "{ detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
    "console.log(JSON.stringify({ type: 'grandchild-spawned', pid: spawned.pid }));",
    "process.once('SIGTERM', () => process.exit(0));",
    "console.log(JSON.stringify({ type: 'ready', pid: process.pid }));",
    "process.stdin.resume();",
  ].join(" ");
  let grandchildPid;
  let parentTerminated = false;
  const terminateGrandchild = async () => {
    grandchildPid ??= await processPidFromStdout(artifacts, "stalled-child", [
      "grandchild-spawned",
      "grandchild-ready",
    ]);
    if (grandchildPid === undefined || !isProcessAlive(grandchildPid)) return;
    process.kill(grandchildPid, "SIGTERM");
    await waitForPidDeath(grandchildPid, { timeoutMs: 2_000 });
  };
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: ["--input-type=commonjs", "--eval", parent],
    name: "stalled-child",
    processTreeStrategy: {
      async capture(pid) {
        return { pid };
      },
      async snapshot() {},
      async probe({ pid }) {
        return parentTerminated || !isProcessAlive(pid);
      },
      async terminate({ pid }, signal) {
        try {
          process.kill(pid, signal);
          parentTerminated = true;
          return true;
        } catch (error) {
          if (error?.code === "ESRCH") {
            parentTerminated = true;
            return true;
          }
          throw error;
        }
      },
    },
  });
  t.after(async () => {
    await terminateGrandchild();
    await child.stop({ timeoutMs: 2_000 }).catch(() => undefined);
  });
  const spawned = await child.ready((event) => event.type === "grandchild-spawned", {
    timeoutMs: 2_000,
  });
  grandchildPid = spawned.pid;
  const ready = await child.ready((event) => event.type === "grandchild-ready", {
    timeoutMs: 2_000,
  });
  assert.equal(ready.pid, grandchildPid);
  await assert.rejects(child.stop({ timeoutMs: 20 }), /PROCESS_(?:CLEANUP|STOP)_TIMEOUT/u);
  await assert.rejects(
    child.assertClean(),
    /PROCESS_(?:CLEANUP_TIMEOUT|TREE_STILL_RUNNING|STILL_RUNNING)/u,
  );
  process.kill(grandchildPid, "SIGTERM");
  await waitForPidDeath(grandchildPid, { timeoutMs: 2_000 });
});

function workspacePathForMissingExecutable(directory) {
  return `${directory}/executable-that-does-not-exist`;
}

test("managed process surfaces readiness listener processing errors", async (t) => {
  const artifacts = await createRunArtifacts("event-processing-error");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: [
      "--eval",
      [
        "process.once('SIGTERM', () => process.exit(0));",
        "console.log(JSON.stringify({ type: 'ready' }));",
        "process.stdin.resume();",
      ].join(" "),
    ],
    name: "processing-child",
  });
  registerExpectedDiagnosticCleanup(t, child, /PROCESS_EVENT_PROCESSING_ERROR/u);
  await waitForArtifactEvent(
    artifacts.events("processing-child"),
    (event) => event.type === "ready",
    { timeoutMs: 2_000 },
  );
  await assert.rejects(
    child.ready(
      () => {
        throw new Error("predicate failed");
      },
      { timeoutMs: 2_000 },
    ),
    /predicate failed/u,
  );
  await child.stop({ timeoutMs: 2_000 });
  await assert.rejects(child.assertClean(), /PROCESS_EVENT_PROCESSING_ERROR:predicate failed/u);
});

test("teardown kills a spawned grandchild when readiness fails", async (t) => {
  let childPid;
  let grandchildPid;
  let cleanupPath;
  let workspace;
  await t.test("failure before grandchild readiness", async (t) => {
    const artifacts = await createRunArtifacts("spawned-before-ready");
    workspace = await useTempWorkspace(t, "spawned-before-ready");
    cleanupPath = artifacts.cleanup("before-ready-child");
    const grandchild = [
      "const net = require('node:net');",
      "const server = net.createServer();",
      "server.listen(0, '127.0.0.1');",
      "process.once('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join(" ");
    const parent = [
      "const { spawn } = require('node:child_process');",
      `const spawned = spawn(process.execPath, ['--eval', ${JSON.stringify(grandchild)}],`,
      "{ stdio: ['ignore', 'inherit', 'inherit'] });",
      "console.log(JSON.stringify({ type: 'grandchild-spawned', pid: spawned.pid }));",
      "process.once('SIGTERM', () => process.exit(0));",
      "process.stdin.resume();",
    ].join(" ");
    await assert.rejects(
      usingManagedProcess(
        async (child) => {
          childPid = child.pid;
          const spawned = await child.ready((event) => event.type === "grandchild-spawned", {
            timeoutMs: 2_000,
          });
          grandchildPid = spawned.pid;
          await child.ready((event) => event.type === "grandchild-ready", { timeoutMs: 20 });
        },
        {
          artifacts,
          command: process.execPath,
          args: ["--input-type=commonjs", "--eval", parent],
          name: "before-ready-child",
        },
      ),
      /PROCESS_READY_TIMEOUT/u,
    );
    assert.equal(await readFile(cleanupPath, "utf8").then((value) => value !== "{}\n"), true);
    await workspace.assertExists();
  });
  assert.equal(isProcessAlive(childPid), false);
  assert.equal(isProcessAlive(grandchildPid), false);
  await assert.doesNotReject(readFile(cleanupPath, "utf8"));
  await workspace.assertRemoved();
});

test("throwing readiness predicate cleans the whole process tree and preserves the predicate error", async () => {
  const artifacts = await createRunArtifacts("predicate-tree-cleanup");
  const grandchild =
    "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000);";
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const spawned = spawn(process.execPath, ['--eval', ${JSON.stringify(grandchild)}],`,
    "{ stdio: 'ignore' });",
    "spawned.unref();",
    "console.log(JSON.stringify({ type: 'grandchild-spawned', pid: spawned.pid }));",
    "process.once('SIGTERM', () => process.exit(0));",
    "process.stdin.resume();",
  ].join(" ");
  let childPid;
  let grandchildPid;
  const predicateError = new Error("predicate ownership failure");

  await assert.rejects(
    usingManagedProcess(
      async (child) => {
        childPid = child.pid;
        const spawned = await child.ready((event) => event.type === "grandchild-spawned", {
          timeoutMs: 2_000,
        });
        grandchildPid = spawned.pid;
        await child.ready(
          () => {
            throw predicateError;
          },
          { timeoutMs: 2_000 },
        );
      },
      {
        artifacts,
        command: process.execPath,
        args: ["--input-type=commonjs", "--eval", parent],
        name: "predicate-tree-child",
      },
    ),
    (error) =>
      error instanceof AggregateError
        ? error.errors[0] === predicateError
        : error === predicateError,
  );
  assert.equal(isProcessAlive(childPid), false);
  assert.equal(isProcessAlive(grandchildPid), false);
  assert.equal(
    await readFile(artifacts.cleanup("predicate-tree-child"), "utf8").then(
      (value) => value !== "{}\n",
    ),
    true,
  );
});

test("assertClean rejects a live grandchild after its direct parent exits", async (t) => {
  const artifacts = await createRunArtifacts("parent-exits-grandchild-lives");
  const grandchild =
    "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000);";
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const spawned = spawn(process.execPath, ['--eval', ${JSON.stringify(grandchild)}],`,
    "{ stdio: ['ignore', 'inherit', 'inherit'] });",
    "spawned.unref();",
    "console.log(JSON.stringify({ type: 'grandchild-spawned', pid: spawned.pid }));",
    "setTimeout(() => process.exit(0), 100);",
  ].join(" ");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: ["--input-type=commonjs", "--eval", parent],
    name: "exited-parent",
  });
  registerCleanup(t, child);
  const spawned = await child.ready((event) => event.type === "grandchild-spawned", {
    timeoutMs: 2_000,
  });
  await waitForPidDeath(child.pid, { timeoutMs: 2_000 });

  await assert.rejects(
    child.assertClean({ timeoutMs: 100 }),
    /PROCESS_(?:TREE_STILL_RUNNING|CLEANUP_TIMEOUT|TREE_ADAPTER_TIMEOUT)/u,
  );
  assert.equal(isProcessAlive(spawned.pid), true);
  await child.stop({ timeoutMs: 2_000 });
  assert.equal(isProcessAlive(spawned.pid), false);
});

test("Windows cleanup targets the owned tree and proves descendant termination", async () => {
  const artifacts = await createRunArtifacts("windows-tree-strategy");
  const events = [];
  let treeAlive = true;
  let childPid;
  await usingManagedProcess(
    async (child) => {
      childPid = child.pid;
      await child.ready(() => true, { timeoutMs: 20 });
    },
    {
      artifacts,
      command: process.execPath,
      args: [
        "--eval",
        "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)",
      ],
      name: "windows-tree-child",
      platform: "win32",
      windowsTreeStrategy: {
        canTerminateAfterLeaderExit: true,
        async probe(processId) {
          events.push(`probe:${processId}:${treeAlive}`);
          return !treeAlive;
        },
        async terminate(processId, signal) {
          events.push(`terminate:${processId}:${signal}`);
          process.kill(processId, signal);
          treeAlive = false;
          return true;
        },
      },
    },
  ).catch((error) => {
    const primary = error instanceof AggregateError ? error.errors[0] : error;
    assert.match(String(primary), /PROCESS_READY_TIMEOUT/u);
  });
  assert.deepEqual(
    events
      .filter((event) => event.startsWith("terminate:"))
      .map((event) => event.replace(String(childPid), "pid")),
    ["terminate:pid:SIGTERM"],
  );
  assert.equal(
    events.some((event) => event === `probe:${childPid}:false`),
    true,
  );
});

test("Windows cleanup fails closed when whole-tree termination cannot be proven", async () => {
  const artifacts = await createRunArtifacts("windows-tree-unproven");
  let childPid;
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: [
      "--eval",
      "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)",
    ],
    name: "windows-unproven-child",
    platform: "win32",
    windowsTreeStrategy: {
      canTerminateAfterLeaderExit: true,
      async probe() {
        return false;
      },
      async terminate(processId, signal) {
        childPid = processId;
        try {
          process.kill(processId, signal);
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
        return false;
      },
    },
  });
  await assert.rejects(child.stop({ timeoutMs: 200 }), /PROCESS_STOP_TIMEOUT/u);
  await assert.rejects(child.assertClean({ timeoutMs: 200 }), /PROCESS_TREE_STILL_RUNNING/u);
  if (isProcessAlive(childPid)) process.kill(childPid, "SIGKILL");
});

test("managed process rejects unsafe child PIDs before creating tree ownership", async () => {
  const artifacts = await createRunArtifacts("unsafe-child-pid");
  let strategyCalled = false;
  for (const pid of [0, -1, Number.NaN]) {
    assert.throws(
      () =>
        new ManagedProcess({
          artifacts,
          child: { pid },
          name: "unsafe-pid",
          processTreeStrategy: {
            capture() {
              strategyCalled = true;
            },
          },
        }),
      /INVALID_MANAGED_PROCESS_PID/u,
    );
  }
  assert.equal(strategyCalled, false);
});

test("fast process exit during ownership capture is still finalized", async () => {
  const artifacts = await createRunArtifacts("fast-exit-during-capture");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: ["--eval", "process.exit(0)"],
    name: "fast-exit-child",
    processTreeStrategy: {
      async capture(pid) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { pid };
      },
      async snapshot() {},
      async probe() {
        return true;
      },
      async terminate() {
        return true;
      },
    },
  });

  await assert.doesNotReject(child.assertClean({ timeoutMs: 500 }));
  assert.equal(await child.artifactsExist(), true);
});

test("ownership capture failure uses managed cleanup and reaps the child", async () => {
  const artifacts = await createRunArtifacts("capture-failure-cleanup");
  let childPid;
  await assert.rejects(
    spawnManagedProcess({
      artifacts,
      command: process.execPath,
      args: ["--eval", "setInterval(() => {}, 1_000)"],
      name: "capture-failure-child",
      processTreeStrategy: {
        async capture(pid) {
          childPid = pid;
          throw new Error("capture failed");
        },
      },
    }),
    /capture failed/u,
  );
  assert.equal(isProcessAlive(childPid), false);
  assert.equal(
    await readFile(artifacts.cleanup("capture-failure-child"), "utf8").then(
      (contents) => contents.length > 0,
    ),
    true,
  );
});

test("ownership capture failure kills and proves a real child and grandchild tree", async (t) => {
  const artifacts = await createRunArtifacts("capture-failure-tree-cleanup");
  let childPid;
  let grandchildPid;
  t.after(async () => {
    for (const pid of [grandchildPid, childPid]) {
      if (pid === undefined || !isProcessAlive(pid)) continue;
      process.kill(pid, "SIGKILL");
      await waitForPidDeath(pid, { timeoutMs: 2_000 }).catch(() => undefined);
    }
  });
  const grandchild = "setInterval(() => {}, 1_000)";
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['--eval', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
    "console.log(JSON.stringify({ type: 'grandchild-spawned', pid: child.pid }));",
    "setInterval(() => {}, 1_000);",
  ].join(" ");

  await assert.rejects(
    spawnManagedProcess({
      artifacts,
      command: process.execPath,
      args: ["--input-type=commonjs", "--eval", parent],
      name: "capture-failure-tree-child",
      processTreeStrategy: {
        async capture(pid) {
          childPid = pid;
          await waitForArtifactEvent(
            artifacts.events("capture-failure-tree-child"),
            (event) => event.type === "grandchild-spawned",
            { timeoutMs: 1_000 },
          );
          throw new Error("tree capture failed");
        },
      },
    }),
    /tree capture failed/u,
  );
  grandchildPid = await processPidFromStdout(artifacts, "capture-failure-tree-child", [
    "grandchild-spawned",
  ]);
  assert.equal(isProcessAlive(childPid), false);
  assert.equal(isProcessAlive(grandchildPid), false);
  assert.equal(
    await readFile(artifacts.cleanup("capture-failure-tree-child"), "utf8").then(
      (contents) => contents.length > 0,
    ),
    true,
  );
});

test("Windows default strategy terminates a cached descendant after graceful leader exit", async () => {
  const live = new Map([
    [101, "leader-created"],
    [202, "descendant-created"],
  ]);
  const terminated = [];
  const strategy = createWindowsTreeStrategy({
    async readProcesses() {
      return [...live].map(([pid, creationDate]) => ({
        pid,
        parentPid: pid === 202 ? 101 : 0,
        creationDate,
      }));
    },
    async terminatePid(pid, force) {
      terminated.push({ pid, force });
      live.delete(pid);
      return true;
    },
  });
  const ownership = await strategy.capture(101, Date.now() + 1_000);
  await strategy.snapshot(ownership, Date.now() + 1_000);
  live.delete(101);

  assert.equal(await strategy.terminate(ownership, "SIGTERM", Date.now() + 1_000), true);
  assert.equal(await strategy.probe(ownership, Date.now() + 1_000), true);
  assert.deepEqual(terminated, [{ pid: 202, force: false }]);
});

test("Windows strategy refreshes a late descendant immediately before termination", async () => {
  let processes = [{ pid: 101, parentPid: 0, creationDate: "leader-created" }];
  const terminated = [];
  const strategy = createWindowsTreeStrategy({
    async readProcesses() {
      return processes;
    },
    async terminatePid(pid) {
      terminated.push(pid);
      processes = processes.filter((process_) => process_.pid !== pid);
      return true;
    },
  });
  const ownership = await strategy.capture(101, Date.now() + 1_000);
  await strategy.snapshot(ownership, Date.now() + 1_000);
  processes.push({ pid: 202, parentPid: 101, creationDate: "late-created" });

  assert.equal(await strategy.terminate(ownership, "SIGTERM", Date.now() + 1_000), true);
  assert.deepEqual(terminated, [101, 202]);
  assert.equal(await strategy.probe(ownership, Date.now() + 1_000), true);
});

test("Windows strategy discovers descendants through a previously owned live parent", async () => {
  let processes = [
    { pid: 101, parentPid: 0, creationDate: "leader-created" },
    { pid: 202, parentPid: 101, creationDate: "child-created" },
  ];
  const terminated = [];
  const strategy = createWindowsTreeStrategy({
    async readProcesses() {
      return processes;
    },
    async terminatePid(pid) {
      terminated.push(pid);
      processes = processes.filter((process_) => process_.pid !== pid);
      return true;
    },
  });
  const ownership = await strategy.capture(101, Date.now() + 1_000);
  await strategy.snapshot(ownership, Date.now() + 1_000);
  processes = [
    { pid: 202, parentPid: 1, creationDate: "child-created" },
    { pid: 303, parentPid: 202, creationDate: "grandchild-created" },
  ];

  assert.equal(await strategy.terminate(ownership, "SIGKILL", Date.now() + 1_000), true);
  assert.deepEqual(terminated, [202, 303]);
  assert.equal(await strategy.probe(ownership, Date.now() + 1_000), true);
});

test("Windows strategy rejects unsafe descendant PIDs before helper invocation", async () => {
  let terminateCalled = false;
  const strategy = createWindowsTreeStrategy({
    async readProcesses() {
      return [
        { pid: 101, parentPid: 0, creationDate: "leader-created" },
        { pid: -2, parentPid: 101, creationDate: "invalid-created" },
      ];
    },
    async terminatePid() {
      terminateCalled = true;
      return true;
    },
  });
  const ownership = await strategy.capture(101, Date.now() + 1_000);
  await assert.rejects(
    strategy.snapshot(ownership, Date.now() + 1_000),
    /INVALID_MANAGED_PROCESS_PID:-2/u,
  );
  assert.equal(terminateCalled, false);
});

test("Windows strategy ignores an unrelated system PID zero", async () => {
  const strategy = createWindowsTreeStrategy({
    async readProcesses() {
      return [
        { pid: 0, parentPid: 0, creationDate: "system-idle" },
        { pid: 101, parentPid: 0, creationDate: "leader-created" },
      ];
    },
  });
  await assert.doesNotReject(strategy.capture(101, Date.now() + 1_000));
});

test("process tree adapter calls are bounded by the absolute stop deadline", async () => {
  const artifacts = await createRunArtifacts("adapter-deadline");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: ["--eval", "setInterval(() => {}, 1_000)"],
    name: "adapter-deadline-child",
    processTreeStrategy: {
      async capture(pid) {
        return { pid };
      },
      snapshot() {
        return new Promise(() => {});
      },
      probe() {
        return new Promise(() => {});
      },
      terminate() {
        return new Promise(() => {});
      },
    },
  });
  const startedAt = Date.now();
  await assert.rejects(child.stop({ timeoutMs: 40 }), /PROCESS_TREE_ADAPTER_TIMEOUT/u);
  assert.ok(Date.now() - startedAt < 500);
  process.kill(child.pid, "SIGKILL");
});

test("bounded process helper kills and reaps a real hanging helper", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runBoundedProcessHelper(
      process.execPath,
      ["--eval", "process.once('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
      Date.now() + 40,
    ),
    /PROCESS_TREE_HELPER_TIMEOUT/u,
  );
  assert.ok(Date.now() - startedAt < 500);
});

test("bounded process helper rejects when kill returns false and close never arrives", async () => {
  const helper = new EventEmitter();
  helper.stdout = new PassThrough();
  helper.stderr = new PassThrough();
  helper.stdin = new PassThrough();
  helper.kill = () => false;
  const startedAt = Date.now();
  await assert.rejects(
    runBoundedProcessHelper("ignored", [], Date.now() + 20, {
      reapGraceMs: 20,
      spawnProcess: () => helper,
    }),
    /PROCESS_TREE_HELPER_TIMEOUT/u,
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.doesNotThrow(() => helper.emit("error", new Error("eventual helper error")));
});

test("POSIX identity mutation fails closed without signaling a recycled group", async () => {
  let processes = [{ pid: 101, groupId: 101, startToken: "original" }];
  const signals = [];
  const strategy = createPosixTreeStrategy({
    async readProcesses() {
      return processes;
    },
    signalGroup(groupId, signal) {
      signals.push({ groupId, signal });
    },
  });
  const ownership = await strategy.capture(101, Date.now() + 1_000);
  await strategy.snapshot(ownership, Date.now() + 1_000);
  processes = [{ pid: 101, groupId: 101, startToken: "reused" }];

  assert.equal(await strategy.terminate(ownership, "SIGKILL", Date.now() + 1_000), false);
  assert.deepEqual(signals, []);
});

test("artifact event predicate errors surface immediately", async () => {
  const artifacts = await createRunArtifacts("artifact-predicate-error");
  await artifacts.initialize("event-source");
  await writeFile(artifacts.events("event-source"), '{"type":"ready"}\n');
  await assert.rejects(
    waitForArtifactEvent(
      artifacts.events("event-source"),
      () => {
        throw new Error("artifact predicate failed");
      },
      { timeoutMs: 50 },
    ),
    /artifact predicate failed/u,
  );
});
