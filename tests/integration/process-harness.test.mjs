import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { spawnManagedProcess } from "../support/managed-process.mjs";
import { createRunArtifacts } from "../support/run-artifacts.mjs";

test("@spec:runtime-operations/ci-authoritative-system-acceptance/actionable-system-test-failure", async () => {
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
  const ready = await child.ready((event) => event.type === "ready", { timeoutMs: 2_000 });
  assert.equal(ready.pid, child.pid);
  await child.stop({ timeoutMs: 2_000 });
  await child.assertClean();
  assert.match(await readFile(artifacts.stdout("ready-child"), "utf8"), /"type":"ready"/u);
});

test("managed process reports deadline and preserves logs", async () => {
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
  await assert.rejects(child.ready(() => true, { timeoutMs: 50 }), /PROCESS_READY_TIMEOUT/u);
  await child.stop({ timeoutMs: 2_000 });
  assert.equal(await child.artifactsExist(), true);
});
