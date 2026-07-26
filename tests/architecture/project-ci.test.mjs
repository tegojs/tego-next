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

  for (const marker of [
    "pull_request:",
    "push:",
    "workflow_dispatch:",
    "contents: read",
    "quality:",
    "integration:",
    "system-e2e:",
    "timeout-minutes:",
    "actions/checkout@v6",
    "actions/setup-node@v6",
    "actions/upload-artifact@v7",
    "node-version-file: .node-version",
    "npm run commitlint:ci",
    "npm run format:check",
    "npm run lint",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "postgres:16.14-alpine",
    "TEGO_POSTGRES_URL:",
    "TEGO_TEST_ARTIFACTS_DIR:",
    "npm run test:integration",
    "npm run test:e2e",
    "if: always()",
    "if-no-files-found: ignore",
  ]) {
    assert.match(workflow, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }

  assert.ok(
    workflow.indexOf("run: npm run build") < workflow.indexOf("run: npm run typecheck"),
    "clean CI must build workspace dependencies before typechecking their consumers",
  );

  const qualityJob = workflow.slice(workflow.indexOf("quality:"), workflow.indexOf("integration:"));
  const integrationJob = workflow.slice(
    workflow.indexOf("integration:"),
    workflow.indexOf("system-e2e:"),
  );
  const processE2eJob = workflow.slice(workflow.indexOf("system-e2e:"));
  for (const [name, job] of [
    ["quality", qualityJob],
    ["PostgreSQL integration", integrationJob],
    ["process E2E", processE2eJob],
  ]) {
    assert.match(job, /timeout-minutes: 15/u, `${name} CI must have a bounded job timeout`);
  }
  for (const [name, job] of [
    ["PostgreSQL integration", integrationJob],
    ["process E2E", processE2eJob],
  ]) {
    assert.match(
      job,
      /uses: actions\/upload-artifact@v7/u,
      `${name} CI must upload process diagnostics`,
    );
    assert.match(
      job,
      /TEGO_TEST_ARTIFACTS_DIR:/u,
      `${name} CI must retain process diagnostics for upload`,
    );
  }
  assert.ok(
    integrationJob.indexOf("TEGO_TEST_ARTIFACTS_DIR:") >
      integrationJob.indexOf("- name: Run integration tests"),
    "PostgreSQL diagnostic paths must be resolved inside a runner step",
  );
  assert.ok(
    processE2eJob.indexOf("TEGO_TEST_ARTIFACTS_DIR:") >
      processE2eJob.indexOf("- name: Run real-process system tests"),
    "process E2E diagnostic paths must be resolved inside a runner step",
  );
  const integrationBuild = integrationJob.indexOf("run: npm run build");
  const integrationTests = integrationJob.indexOf("run: npm run test:integration");
  assert.notEqual(integrationBuild, -1, "PostgreSQL CI must build workspace packages");
  assert.ok(
    integrationBuild < integrationTests,
    "PostgreSQL CI must build workspace packages before importing them in integration tests",
  );
});
