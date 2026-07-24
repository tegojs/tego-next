import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { spawnManagedProcess } from "../support/managed-process.mjs";
import { createRunArtifacts } from "../support/run-artifacts.mjs";

function registerCleanup(t, child) {
  t.after(async () => {
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
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: [
      "--eval",
      [
        "process.once('SIGTERM', () => process.exit(0));",
        "console.log(JSON.stringify({ type: 'ready', pid: process.pid }));",
        "setInterval(() => {}, 1_000);",
      ].join(" "),
    ],
    name: "ready-child",
  });
  registerCleanup(t, child);
  const ready = await child.ready((event) => event.type === "ready", { timeoutMs: 2_000 });
  assert.equal(ready.pid, child.pid);
  await child.stop({ timeoutMs: 2_000 });
  await child.assertClean();
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
    "{ stdio: ['ignore', 'inherit', 'inherit'] });",
    "console.log(JSON.stringify({ type: 'grandchild-spawned', pid: spawned.pid }));",
    "process.once('SIGTERM', () => process.exit(0));",
    "console.log(JSON.stringify({ type: 'ready', pid: process.pid }));",
    "process.stdin.resume();",
  ].join(" ");
  let grandchildPid;
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
  });
  registerExpectedDiagnosticCleanup(t, child, /PROCESS_CLEANUP_TIMEOUT/u, terminateGrandchild);
  const spawned = await child.ready((event) => event.type === "grandchild-spawned", {
    timeoutMs: 2_000,
  });
  grandchildPid = spawned.pid;
  const ready = await child.ready((event) => event.type === "grandchild-ready", {
    timeoutMs: 2_000,
  });
  assert.equal(ready.pid, grandchildPid);
  await assert.rejects(child.stop({ timeoutMs: 20 }), /PROCESS_CLEANUP_TIMEOUT/u);
  await assert.rejects(child.assertClean(), /PROCESS_CLEANUP_TIMEOUT/u);
  process.kill(grandchildPid, "SIGTERM");
  await waitForPidDeath(grandchildPid, { timeoutMs: 2_000 });
});

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
  let grandchildPid;
  await t.test("failure before grandchild readiness", async (t) => {
    const artifacts = await createRunArtifacts("spawned-before-ready");
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
    const terminateGrandchild = async () => {
      grandchildPid ??= await processPidFromStdout(artifacts, "before-ready-child", [
        "grandchild-spawned",
      ]);
      if (grandchildPid === undefined || !isProcessAlive(grandchildPid)) return;
      process.kill(grandchildPid, "SIGTERM");
      await waitForPidDeath(grandchildPid, { timeoutMs: 2_000 });
    };
    const child = await spawnManagedProcess({
      artifacts,
      command: process.execPath,
      args: ["--input-type=commonjs", "--eval", parent],
      name: "before-ready-child",
    });
    registerExpectedDiagnosticCleanup(t, child, /PROCESS_CLEANUP_TIMEOUT/u, terminateGrandchild);
    const spawned = await child.ready((event) => event.type === "grandchild-spawned", {
      timeoutMs: 2_000,
    });
    grandchildPid = spawned.pid;
    await assert.rejects(
      child.ready((event) => event.type === "grandchild-ready", { timeoutMs: 20 }),
      /PROCESS_READY_TIMEOUT/u,
    );
    await assert.rejects(child.stop({ timeoutMs: 20 }), /PROCESS_CLEANUP_TIMEOUT/u);
  });
  assert.equal(isProcessAlive(grandchildPid), false);
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
