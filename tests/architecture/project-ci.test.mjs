import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
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

test("TypeScript workspaces reference every internal build dependency", async () => {
  const packagesDirectory = join(root, "packages");
  const directories = await readdir(packagesDirectory, { withFileTypes: true });
  const workspaces = new Map();

  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const manifest = JSON.parse(
      await readFile(join(packagesDirectory, directory.name, "package.json"), "utf8"),
    );
    workspaces.set(manifest.name, directory.name);
  }

  for (const [workspaceName, directoryName] of workspaces) {
    const workspaceDirectory = join(packagesDirectory, directoryName);
    const manifest = JSON.parse(await readFile(join(workspaceDirectory, "package.json"), "utf8"));
    const tsconfig = JSON.parse(await readFile(join(workspaceDirectory, "tsconfig.json"), "utf8"));
    const references = new Set(
      (tsconfig.references ?? []).map((reference) => basename(reference.path)),
    );
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };

    for (const dependencyName of Object.keys(dependencies)) {
      const dependencyDirectory = workspaces.get(dependencyName);
      if (!dependencyDirectory) continue;
      assert.equal(
        references.has(dependencyDirectory),
        true,
        `${workspaceName} must reference ${dependencyName}`,
      );
    }
  }
});

test("GitHub CI declares quality, integration, and system E2E gates", async () => {
  assert.equal(existsSync(workflowUrl), true, "CI workflow must exist");
  const workflow = await readFile(workflowUrl, "utf8");
  const { parseWorkflowJobs, validateWorkflowContract } = await import(
    new URL(`../../scripts/verify-release.mjs?project-ci=${Date.now()}`, import.meta.url)
  );
  const jobs = parseWorkflowJobs(workflow);

  for (const marker of [
    "pull_request:",
    "push:",
    "workflow_dispatch:",
    "contents: read",
    "quality:",
    "integration:",
    "system-e2e:",
    "timeout-minutes:",
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
    "node-version-file: .node-version",
    "npm run commitlint:ci",
    "npm run format:check",
    "npm run lint",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "node scripts/verify-release.mjs --deterministic-package",
    "postgres:16.14-alpine",
    "TEGO_POSTGRES_URL:",
    "TEGO_TEST_ARTIFACTS_DIR:",
    "npm run test:integration",
    "npm run test:e2e:single-main",
    "npm run test:e2e:multi-main",
    "if: always()",
    "if-no-files-found: error",
  ]) {
    assert.match(workflow, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
  assert.deepEqual(validateWorkflowContract(workflow), []);
  assert.doesNotMatch(workflow, /uses: actions\/[^@\s]+@v\d/u);

  assert.ok(
    workflow.indexOf("run: npm run build") < workflow.indexOf("run: npm run typecheck"),
    "clean CI must build workspace dependencies before typechecking their consumers",
  );

  const qualityJob = jobs.get("quality");
  const integrationJob = jobs.get("integration");
  const processE2eJob = jobs.get("system-e2e");
  assert.ok(qualityJob);
  assert.ok(integrationJob);
  assert.ok(processE2eJob);
  for (const [name, job] of [
    ["quality", qualityJob],
    ["PostgreSQL integration", integrationJob],
    ["process E2E", processE2eJob],
  ]) {
    assert.equal(job["timeout-minutes"], 15, `${name} CI must have a bounded job timeout`);
  }
  for (const [name, job] of [
    ["PostgreSQL integration", integrationJob],
    ["process E2E", processE2eJob],
  ]) {
    assert.equal(
      job.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")),
      true,
      `${name} CI must upload process diagnostics`,
    );
    assert.equal(
      job.steps.some((step) => step.env?.TEGO_TEST_ARTIFACTS_DIR !== undefined),
      true,
      `${name} CI must retain process diagnostics for upload`,
    );
  }
  const integrationBuild = integrationJob.steps.findIndex((step) => step.run === "npm run build");
  const integrationTests = integrationJob.steps.findIndex((step) =>
    step.run?.endsWith("-- npm run test:integration"),
  );
  assert.notEqual(integrationBuild, -1, "PostgreSQL CI must build workspace packages");
  assert.ok(
    integrationBuild < integrationTests,
    "PostgreSQL CI must build workspace packages before importing them in integration tests",
  );
});
