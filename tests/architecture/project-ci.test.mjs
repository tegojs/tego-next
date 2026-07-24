import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("../../scripts/commitlint-ci.mjs", import.meta.url);
const workflowUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);

test("commitlint CI selects explicit ranges and safe fallbacks", async () => {
  assert.equal(existsSync(scriptUrl), true, "commitlint CI script must exist");
  const { commitlintArguments } = await import(scriptUrl.href);

  assert.deepEqual(
    commitlintArguments({
      COMMITLINT_FROM: "a".repeat(40),
      COMMITLINT_TO: "b".repeat(40),
    }),
    ["--from", "a".repeat(40), "--to", "b".repeat(40), "--verbose"],
  );
  assert.deepEqual(
    commitlintArguments({
      COMMITLINT_FROM: "0".repeat(40),
      COMMITLINT_TO: "b".repeat(40),
    }),
    ["--last", "--verbose"],
  );
  assert.deepEqual(commitlintArguments({}), ["--last", "--verbose"]);
});

test("GitHub CI declares quality and PostgreSQL integration gates", async () => {
  assert.equal(existsSync(workflowUrl), true, "CI workflow must exist");
  const workflow = await readFile(workflowUrl, "utf8");

  for (const marker of [
    "pull_request:",
    "push:",
    "workflow_dispatch:",
    "contents: read",
    "quality:",
    "postgres-integration:",
    "actions/checkout@v6",
    "actions/setup-node@v6",
    "node-version-file: .node-version",
    "npm run commitlint:ci",
    "npm run format:check",
    "npm run lint",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "postgres:16.14-alpine",
    "TEGO_POSTGRES_URL:",
    "npm run test:integration",
  ]) {
    assert.match(workflow, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
});
