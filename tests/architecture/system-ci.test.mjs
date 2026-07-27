import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      "        timeout-minutes: 10",
      `        run: node scripts/run-ci-test.mjs --name integration --artifacts "${runnerTemp}/tego-test-artifacts" --timeout-ms 540000 -- npm run test:integration`,
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
      "        timeout-minutes: 8",
      `        run: node scripts/run-ci-test.mjs --name single-main --artifacts "${runnerTemp}/tego-test-artifacts" --timeout-ms 420000 -- npm run test:e2e:single-main`,
      "        env:",
      `          TEGO_POSTGRES_URL: postgresql://localhost:${postgresPort}/tego`,
      `          TEGO_TEST_ARTIFACTS_DIR: ${runnerTemp}/tego-test-artifacts`,
      "      - name: Run multi-Main takeover",
      "        if: always()",
      "        timeout-minutes: 8",
      `        run: node scripts/run-ci-test.mjs --name multi-main --artifacts "${runnerTemp}/tego-test-artifacts" --timeout-ms 420000 -- npm run test:e2e:multi-main`,
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

test("CI workflow validation rejects required gates that only appear in comments", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateWorkflowContract } = await import(
    new URL(`../../scripts/verify-release.mjs?comment-mutations=${Date.now()}`, import.meta.url)
  );
  const mutations = [
    [
      "commented OpenSpec gate",
      workflow.replace(
        "        run: npm run openspec:validate",
        "        # run: npm run openspec:validate",
      ),
    ],
    [
      "commented single-Main command",
      workflow.replace(
        / {8}run: (node scripts\/run-ci-test\.mjs --name single-main[^\n]+)/u,
        "        # run: $1",
      ),
    ],
    [
      "commented multi-Main command",
      workflow.replace(
        / {8}run: (node scripts\/run-ci-test\.mjs --name multi-main[^\n]+)/u,
        "        # run: $1",
      ),
    ],
    [
      "commented upload condition",
      workflow.replace(
        "- name: Upload integration diagnostics\n        if: always()",
        "- name: Upload integration diagnostics\n        # if: always()",
      ),
    ],
  ];

  for (const [name, mutation] of mutations) {
    assert.notEqual(mutation, workflow, `${name} mutation must change the workflow`);
    assert.ok(
      validateWorkflowContract(mutation).length > 0,
      `${name} must not satisfy the active workflow contract`,
    );
  }
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
      assert.equal(metadata.timedOut, false);
      assert.equal(metadata.command, process.execPath);
      assert.ok(metadata.startedAt.length > 0);
      assert.ok(metadata.finishedAt.length > 0);
      assert.ok(metadata.durationMs >= 0);
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

test("CI reporter times out and terminates a child before writing final metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-ci-reporter-timeout-"));
  const reporter = join(root, "scripts", "run-ci-test.mjs");
  const startedAt = Date.now();
  try {
    const result = spawnSync(
      process.execPath,
      [
        reporter,
        "--name",
        "timeout",
        "--artifacts",
        directory,
        "--timeout-ms",
        "200",
        "--",
        process.execPath,
        "-e",
        [
          'console.log("child-pid:" + process.pid);',
          'process.on("SIGTERM", () => console.log("ignored-sigterm"));',
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    const elapsedMs = Date.now() - startedAt;

    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined);
    assert.ok(elapsedMs < 5_000, `reporter exceeded bounded completion: ${elapsedMs}ms`);

    const metadata = JSON.parse(await readFile(join(directory, "timeout-result.json"), "utf8"));
    const log = await readFile(join(directory, "timeout-process.log"), "utf8");
    assert.equal(metadata.name, "timeout");
    assert.equal(metadata.timedOut, true);
    assert.equal(metadata.timeoutMs, 200);
    assert.notEqual(metadata.exitCode, 0);
    assert.ok(Object.hasOwn(metadata, "childExitCode"));
    assert.ok(Object.hasOwn(metadata, "childSignal"));
    assert.equal(metadata.command, process.execPath);
    assert.ok(metadata.startedAt.length > 0);
    assert.ok(metadata.finishedAt.length > 0);
    assert.ok(metadata.durationMs >= 200);
    assert.ok(metadata.terminationSignal);
    assert.match(log, /child-pid:\d+/u);

    const childPid = Number.parseInt(log.match(/child-pid:(\d+)/u)?.[1] ?? "", 10);
    assert.ok(Number.isInteger(childPid));
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("CI reporter reaps a timed-out child and grandchild before final metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-ci-reporter-process-tree-"));
  const reporter = join(root, "scripts", "run-ci-test.mjs");
  const grandchild = [
    'console.log("grandchild-pid:" + process.pid);',
    'process.on("SIGTERM", () => console.log("grandchild-ignored-sigterm"));',
    "setInterval(() => {}, 1000);",
  ].join("");
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}],`,
    "{ stdio: ['ignore', 'inherit', 'inherit'] });",
    'console.log("child-pid:" + process.pid);',
    'console.log("spawned-grandchild-pid:" + grandchild.pid);',
    'process.on("SIGTERM", () => console.log("child-ignored-sigterm"));',
    "setInterval(() => {}, 1000);",
  ].join("");
  try {
    const result = spawnSync(
      process.execPath,
      [
        reporter,
        "--name",
        "process-tree-timeout",
        "--artifacts",
        directory,
        "--timeout-ms",
        "200",
        "--",
        process.execPath,
        "--input-type=commonjs",
        "-e",
        parent,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);

    const metadata = JSON.parse(
      await readFile(join(directory, "process-tree-timeout-result.json"), "utf8"),
    );
    const log = await readFile(join(directory, "process-tree-timeout-process.log"), "utf8");
    const childPid = Number.parseInt(log.match(/child-pid:(\d+)/u)?.[1] ?? "", 10);
    const grandchildPid = Number.parseInt(
      log.match(/spawned-grandchild-pid:(\d+)/u)?.[1] ?? "",
      10,
    );
    assert.ok(Number.isInteger(childPid));
    assert.ok(Number.isInteger(grandchildPid));
    assert.equal(metadata.timedOut, true);
    assert.equal(metadata.processTreeTerminated, true);
    assert.equal(metadata.childPid, childPid);
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("CI reporter reaps a background process after its successful parent exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-ci-reporter-background-tree-"));
  const reporter = join(root, "scripts", "run-ci-test.mjs");
  const background = [
    'process.on("SIGTERM", () => process.exit(0));',
    "setInterval(() => {}, 1000);",
  ].join("");
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const background = spawn(process.execPath, ["-e", ${JSON.stringify(background)}],`,
    "{ stdio: 'ignore' });",
    'console.log("background-pid:" + background.pid);',
    "background.unref();",
  ].join("");
  let processGroupId;
  try {
    const result = spawnSync(
      process.execPath,
      [
        reporter,
        "--name",
        "background-tree",
        "--artifacts",
        directory,
        "--timeout-ms",
        "1000",
        "--",
        process.execPath,
        "--input-type=commonjs",
        "-e",
        parent,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);

    const metadata = JSON.parse(
      await readFile(join(directory, "background-tree-result.json"), "utf8"),
    );
    const log = await readFile(join(directory, "background-tree-process.log"), "utf8");
    const backgroundPid = Number.parseInt(log.match(/background-pid:(\d+)/u)?.[1] ?? "", 10);
    assert.ok(Number.isInteger(backgroundPid));
    processGroupId = metadata.childPid;
    assert.equal(metadata.timedOut, false);
    assert.equal(metadata.childExitCode, 0);
    assert.equal(metadata.exitCode, 0);
    assert.equal(metadata.processTreeTerminated, true);
    assert.throws(() => process.kill(backgroundPid, 0), { code: "ESRCH" });
  } finally {
    if (process.platform !== "win32" && Number.isInteger(processGroupId)) {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {}
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test("managed runner proves Windows normal-close tree cleanup before success", async () => {
  const { runManagedProcessTree } = await import(
    new URL(`../../scripts/run-ci-test.mjs?windows-tree=${Date.now()}`, import.meta.url)
  );
  const events = [];
  let descendantAlive = true;
  const metadata = await runManagedProcessTree({
    name: "windows-proven-tree",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 1_000,
    platform: "win32",
    windowsTreeStrategy: {
      async probe(processId) {
        events.push(`probe:${processId}:${descendantAlive}`);
        return !descendantAlive;
      },
      async terminate(processId, signal) {
        events.push(`terminate:${processId}:${signal}`);
        descendantAlive = false;
        return true;
      },
    },
  });

  assert.equal(metadata.timedOut, false);
  assert.equal(metadata.childExitCode, 0);
  assert.equal(metadata.exitCode, 0);
  assert.equal(metadata.processTreeTerminated, true);
  assert.equal(metadata.terminationSignal, "SIGTERM");
  assert.deepEqual(
    events.map((event) => event.replace(/:\d+:/u, ":pid:")),
    ["probe:pid:true", "terminate:pid:SIGTERM", "probe:pid:false"],
  );
});

test("managed runner fails closed when Windows tree termination cannot be proven", async () => {
  const { runManagedProcessTree } = await import(
    new URL(`../../scripts/run-ci-test.mjs?windows-tree-failure=${Date.now()}`, import.meta.url)
  );
  const events = [];
  const metadata = await runManagedProcessTree({
    name: "windows-unproven-tree",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 1_000,
    platform: "win32",
    windowsTreeStrategy: {
      async probe(processId) {
        events.push(`probe:${processId}`);
        return false;
      },
      async terminate(processId, signal) {
        events.push(`terminate:${processId}:${signal}`);
        return false;
      },
    },
  });

  assert.equal(metadata.timedOut, false);
  assert.equal(metadata.childExitCode, 0);
  assert.equal(metadata.exitCode, 125);
  assert.equal(metadata.processTreeTerminated, false);
  assert.match(metadata.error, /process tree did not terminate/iu);
  assert.deepEqual(
    events.map((event) => event.replace(/:\d+/u, ":pid")),
    ["probe:pid", "terminate:pid:SIGTERM", "probe:pid"],
  );
});

test("release verification bounds stages and reports deterministic process metadata", async () => {
  const { runReleaseCommand } = await import(
    new URL(`../../scripts/verify-release.mjs?command=${Date.now()}`, import.meta.url)
  );

  const success = await runReleaseCommand({
    name: "successful probe",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 1_000,
  });
  assert.equal(success.name, "successful probe");
  assert.equal(success.timedOut, false);
  assert.equal(success.exitCode, 0);
  assert.equal(success.childExitCode, 0);
  assert.equal(success.childSignal, null);
  assert.equal(success.timeoutMs, 1_000);
  assert.ok(success.startedAt.length > 0);
  assert.ok(success.finishedAt.length > 0);
  assert.ok(success.durationMs >= 0);

  await assert.rejects(
    () =>
      runReleaseCommand({
        name: "failing probe",
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        timeoutMs: 1_000,
      }),
    (error) =>
      error.code === "command_failed" &&
      error.command === process.execPath &&
      error.stage.exitCode === 7 &&
      error.stage.timedOut === false,
  );

  const startedAt = Date.now();
  await assert.rejects(
    () =>
      runReleaseCommand({
        name: "hanging probe",
        command: process.execPath,
        args: ["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 750);'],
        timeoutMs: 100,
      }),
    (error) =>
      error.code === "command_timed_out" &&
      error.command === process.execPath &&
      error.stage.name === "hanging probe" &&
      error.stage.timedOut === true &&
      error.stage.timeoutMs === 100 &&
      error.stage.exitCode === 124 &&
      typeof error.stage.startedAt === "string" &&
      typeof error.stage.finishedAt === "string" &&
      error.stage.durationMs >= 100,
  );
  assert.ok(Date.now() - startedAt < 700, "release stage timeout must be bounded");
});
