import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
      args: ["--eval", "setInterval(() => {}, 1_000)"],
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

test("managed process bounds stalled stream finalization", async () => {
  const artifacts = await createRunArtifacts("stalled-finalization");
  const grandchild = "setTimeout(() => process.exit(0), 200)";
  const parent = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['--eval', ${JSON.stringify(grandchild)}],`,
    "{ stdio: ['ignore', 'inherit', 'inherit'] });",
    "process.once('SIGTERM', () => process.exit(0));",
    "console.log(JSON.stringify({ type: 'ready', pid: process.pid }));",
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: ["--input-type=commonjs", "--eval", parent],
    name: "stalled-child",
  });
  await child.ready((event) => event.type === "ready", { timeoutMs: 2_000 });
  await assert.rejects(child.stop({ timeoutMs: 20 }), /PROCESS_CLEANUP_TIMEOUT/u);
  await assert.rejects(child.assertClean(), /PROCESS_CLEANUP_TIMEOUT/u);
  await delay(250);
});

test("managed process surfaces readiness listener processing errors", async () => {
  const artifacts = await createRunArtifacts("event-processing-error");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: [
      "--eval",
      [
        "process.once('SIGTERM', () => process.exit(0));",
        "setTimeout(() => console.log(JSON.stringify({ type: 'ready' })), 20);",
        "setInterval(() => {}, 1_000);",
      ].join(" "),
    ],
    name: "processing-child",
  });
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
