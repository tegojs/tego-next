import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflowPath = join(root, ".github", "workflows", "ci.yml");

test("@spec:runtime-operations/ci-authoritative-system-acceptance/workflow-gates", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const verifier = await import(
    new URL(`../../scripts/verify-release.mjs?workflow=${Date.now()}`, import.meta.url)
  );
  const jobs = verifier.parseWorkflowJobs(workflow);

  assert.deepEqual([...jobs.keys()], ["quality", "integration", "system-e2e"]);
  assert.deepEqual(verifier.validateWorkflowContract(workflow), []);
});

test("release verification is strict, complete, and non-recursive", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["verify:release"], "node scripts/verify-release.mjs");
  assert.equal(
    packageJson.scripts.verify,
    "npm run format:check && npm run lint && npm run build && npm run typecheck && npm test && npm run test:integration:local && npm run test:e2e:single-main",
  );
  assert.equal(
    packageJson.scripts["test:integration:local"],
    "node --test tests/integration/*.test.mjs",
  );
  assert.equal(
    packageJson.scripts["test:integration"],
    "npm run test:integration:local && npm run test:integration --workspaces --if-present",
  );
  assert.equal(
    packageJson.scripts["openspec:validate"],
    "node scripts/verify-release.mjs --openspec",
  );
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
  assert.equal(verifier.openspecInvocation.command, process.execPath);
  assert.deepEqual(verifier.openspecInvocation.args.slice(1), [
    "exec",
    "--yes",
    "--package=@fission-ai/openspec@1.4.1",
    "--",
    "openspec",
    "validate",
    "runtime-kernel-phase-1",
    "--strict",
    "--no-interactive",
  ]);
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
    if (command !== "internal:deterministic-plugin-package") {
      assert.equal(command, process.execPath);
    }
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
  const expressionPrefix = "$";
  const runnerTemp = `${expressionPrefix}{{ runner.temp }}`;
  const postgresPort = `${expressionPrefix}{{ job.services.postgres.ports['5432'] }}`;
  const valid = {
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
    workflow: [
      "jobs:",
      "  quality:",
      "    timeout-minutes: 15",
      "    steps:",
      "      - run: npm install --global npm@11.13.0",
      "      - run: npm --version",
      "      - run: npm ci",
      "      - run: npm run commitlint:ci",
      "      - run: npm run format:check",
      "      - run: npm run lint",
      "      - run: npm run build",
      "      - run: npm run typecheck",
      "      - run: npm test",
      "      - run: npm run openspec:validate",
      "  integration:",
      "    timeout-minutes: 15",
      "    services:",
      "      postgres:",
      "        image: postgres:16.14-alpine",
      "        ports:",
      "          - 5432/tcp",
      "    steps:",
      "      - run: npm run build",
      "      - name: Run integration tests",
      "        if: always()",
      `        run: node scripts/run-ci-test.mjs --name integration --artifacts ${runnerTemp}/tego-test-artifacts -- npm run test:integration`,
      "        env:",
      `          TEGO_POSTGRES_URL: postgresql://localhost:${postgresPort}/tego`,
      `          TEGO_TEST_ARTIFACTS_DIR: ${runnerTemp}/tego-test-artifacts`,
      "      - name: Upload integration diagnostics",
      "        if: always()",
      "        uses: actions/upload-artifact@v7",
      "        with:",
      `          path: ${runnerTemp}/tego-test-artifacts`,
      "          if-no-files-found: error",
      "  system-e2e:",
      "    timeout-minutes: 15",
      "    services:",
      "      postgres:",
      "        image: postgres:16.14-alpine",
      "        ports:",
      "          - 5432/tcp",
      "    steps:",
      "      - run: npm run build",
      "      - name: Run single-Main system smoke",
      "        if: always()",
      `        run: node scripts/run-ci-test.mjs --name single-main --artifacts ${runnerTemp}/tego-test-artifacts -- npm run test:e2e:single-main`,
      "        env:",
      `          TEGO_POSTGRES_URL: postgresql://localhost:${postgresPort}/tego`,
      `          TEGO_TEST_ARTIFACTS_DIR: ${runnerTemp}/tego-test-artifacts`,
      "      - name: Run multi-Main takeover",
      "        if: always()",
      `        run: node scripts/run-ci-test.mjs --name multi-main --artifacts ${runnerTemp}/tego-test-artifacts -- npm run test:e2e:multi-main`,
      "        env:",
      `          TEGO_POSTGRES_URL: postgresql://localhost:${postgresPort}/tego`,
      `          TEGO_TEST_ARTIFACTS_DIR: ${runnerTemp}/tego-test-artifacts`,
      "      - name: Upload process diagnostics",
      "        if: always()",
      "        uses: actions/upload-artifact@v7",
      "        with:",
      `          path: ${runnerTemp}/tego-test-artifacts`,
      "          if-no-files-found: error",
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
    assert.equal(
      diagnostics.some((diagnostic) => diagnostic.code === code),
      true,
    );
    assert.equal(
      diagnostics.every((diagnostic) => diagnostic.level === "error"),
      true,
    );
  }
});

test("CI workflow validation rejects evidence and commands placed in the wrong job", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateWorkflowContract } = await import(
    new URL(`../../scripts/verify-release.mjs?mutations=${Date.now()}`, import.meta.url)
  );
  const misplacedOpenSpec = workflow.replace(
    "        run: npm run openspec:validate",
    "        run: npm test",
  );
  const staleSystemAnchor = workflow.replace(
    "node scripts/run-ci-test.mjs --name single-main",
    "node scripts/run-ci-test.mjs --name real-process",
  );
  const conditionalUpload = workflow.replace(
    "- name: Upload integration diagnostics\n        if: always()",
    "- name: Upload integration diagnostics\n        if: success()",
  );

  assert.ok(validateWorkflowContract(misplacedOpenSpec).length > 0);
  assert.ok(validateWorkflowContract(staleSystemAnchor).length > 0);
  assert.ok(validateWorkflowContract(conditionalUpload).length > 0);
});

test("CI reporter always writes nonempty JSON metadata and process logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-ci-reporter-"));
  const reporter = join(root, "scripts", "run-ci-test.mjs");
  try {
    for (const probe of [
      { name: "success", code: 0 },
      { name: "failure", code: 7 },
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          reporter,
          "--name",
          probe.name,
          "--artifacts",
          directory,
          "--",
          process.execPath,
          "-e",
          `console.log("stdout-${probe.name}"); console.error("stderr-${probe.name}"); process.exit(${probe.code})`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, probe.code);
      assert.match(result.stdout, new RegExp(`stdout-${probe.name}`, "u"));
      assert.match(result.stderr, new RegExp(`stderr-${probe.name}`, "u"));

      const metadata = JSON.parse(
        await readFile(join(directory, `${probe.name}-result.json`), "utf8"),
      );
      const log = await readFile(join(directory, `${probe.name}-process.log`), "utf8");
      assert.equal(metadata.name, probe.name);
      assert.equal(metadata.exitCode, probe.code);
      assert.equal(metadata.command, process.execPath);
      assert.ok(metadata.startedAt.length > 0);
      assert.ok(metadata.finishedAt.length > 0);
      assert.match(log, new RegExp(`stdout-${probe.name}`, "u"));
      assert.match(log, new RegExp(`stderr-${probe.name}`, "u"));
    }

    const npmProbe = spawnSync(
      process.execPath,
      [reporter, "--name", "npm", "--artifacts", directory, "--", "npm", "--version"],
      { encoding: "utf8" },
    );
    assert.equal(npmProbe.status, 0);
    const npmMetadata = JSON.parse(await readFile(join(directory, "npm-result.json"), "utf8"));
    assert.equal(npmMetadata.command, "npm");
    assert.equal(npmMetadata.actualCommand, process.execPath);
    assert.match(npmMetadata.actualArgs[0], /npm-cli\.js$/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("release verification converts command failures into structured diagnostics", async () => {
  const { runReleaseCommand } = await import(
    new URL(`../../scripts/verify-release.mjs?command=${Date.now()}`, import.meta.url)
  );

  assert.throws(
    () =>
      runReleaseCommand({
        name: "failing probe",
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
      }),
    (error) => error.code === "command_failed" && error.command === process.execPath,
  );
});
