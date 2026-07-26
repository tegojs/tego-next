import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflowPath = join(root, ".github", "workflows", "ci.yml");

test("@spec:runtime-operations/ci-authoritative-system-acceptance/workflow-gates", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  for (const job of ["quality", "integration", "system-e2e"]) {
    assert.match(workflow, new RegExp(`^  ${job}:`, "mu"));
  }
  for (const marker of [
    "npm install --global npm@11.13.0",
    "npm --version",
    "postgres:16.14-alpine",
    "- 5432/tcp",
    "job.services.postgres.ports['5432']",
    "TEGO_POSTGRES_URL:",
    "TEGO_TEST_ARTIFACTS_DIR:",
    "npm run test:integration",
    "npm run test:e2e:single-main",
    "npm run test:e2e:multi-main",
    "actions/upload-artifact@v7",
    "if: always()",
    "timeout-minutes:",
  ]) {
    assert.match(workflow, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
});

test("release verification is strict, complete, and non-recursive", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["verify:release"], "node scripts/verify-release.mjs");
  assert.equal(
    packageJson.scripts["test:e2e:single-main"],
    'node --test --test-name-pattern="real-single-main-process-flow" tests/e2e/single-main-process.test.mjs',
  );
  assert.equal(
    packageJson.scripts["test:e2e:multi-main"],
    'node --test --test-name-pattern="real-two-main-postgres-worker-failover" tests/e2e/single-main-process.test.mjs',
  );

  const verifier = await import(
    new URL(`../../scripts/verify-release.mjs?test=${Date.now()}`, import.meta.url)
  );
  assert.deepEqual(
    verifier.releaseCommands.map(({ name }) => name),
    [
      "clean lockfile install",
      "format",
      "lint",
      "build",
      "typecheck",
      "unit and architecture tests",
      "integration tests",
      "deterministic plugin package",
      "single-Main smoke",
      "multi-Main takeover",
      "strict OpenSpec validation",
    ],
  );
  for (const { command, args } of verifier.releaseCommands) {
    assert.notEqual(
      [command, ...args].join(" ").includes("verify:release"),
      true,
      "release verification must not recursively invoke itself",
    );
  }
});

test("release verification preflight fails closed with structured diagnostics", async () => {
  const { validateReleasePreflight } = await import(
    new URL(`../../scripts/verify-release.mjs?preflight=${Date.now()}`, import.meta.url)
  );
  const valid = {
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
    workflow: [
      "quality:",
      "integration:",
      "system-e2e:",
      "npm install --global npm@11.13.0",
      "postgres:16.14-alpine",
      "npm run test:integration",
      "npm run test:e2e:single-main",
      "npm run test:e2e:multi-main",
      "actions/upload-artifact@v7",
      "if: always()",
    ].join("\n"),
  };

  assert.deepEqual(validateReleasePreflight(valid), []);
  for (const [field, value, code] of [
    ["gitStatus", " M package.json", "dirty_worktree"],
    ["nodeVersion", "v26.5.1", "node_version_mismatch"],
    ["npmVersion", "11.13.1", "npm_version_mismatch"],
    ["postgresUrl", "", "postgres_url_missing"],
    ["workflow", "quality:", "ci_contract_incomplete"],
  ]) {
    const diagnostics = validateReleasePreflight({ ...valid, [field]: value });
    assert.equal(diagnostics.some((diagnostic) => diagnostic.code === code), true);
    assert.equal(diagnostics.every((diagnostic) => diagnostic.level === "error"), true);
  }
});
