import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
      try {
        const event = JSON.parse(line);
        if (predicate(event)) return event;
      } catch {
        // A concurrent append can expose a partial final line; retry from disk.
      }
    }
    try {
      await nextEventLoopTurn(signal);
    } catch {
      break;
    }
  }
  throw new Error(`ARTIFACT_EVENT_TIMEOUT:${path}:${timeoutMs}ms`);
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
    `spawn(process.execPath, ['--eval', ${JSON.stringify(grandchild)}],`,
    "{ stdio: ['ignore', 'inherit', 'inherit'] });",
    "process.once('SIGTERM', () => process.exit(0));",
    "console.log(JSON.stringify({ type: 'ready', pid: process.pid }));",
    "process.stdin.resume();",
  ].join(" ");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: ["--input-type=commonjs", "--eval", parent],
    name: "stalled-child",
  });
  let grandchildPid;
  const terminateGrandchild = async () => {
    if (grandchildPid === undefined) {
      const stdout = await readFile(artifacts.stdout("stalled-child"), "utf8");
      for (const line of stdout.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "grandchild-ready") grandchildPid = event.pid;
        } catch {
          // Ignore non-JSON diagnostic output while recovering the cleanup PID.
        }
      }
    }
    if (grandchildPid === undefined || !isProcessAlive(grandchildPid)) return;
    process.kill(grandchildPid, "SIGTERM");
    await waitForPidDeath(grandchildPid, { timeoutMs: 2_000 });
  };
  registerExpectedDiagnosticCleanup(t, child, /PROCESS_CLEANUP_TIMEOUT/u, terminateGrandchild);
  const ready = await child.ready((event) => event.type === "grandchild-ready", {
    timeoutMs: 2_000,
  });
  grandchildPid = ready.pid;
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
