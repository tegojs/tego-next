import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflowPath = join(root, ".github", "workflows", "ci.yml");
const requiredStepsByJob = {
  integration: [
    "Check out repository",
    "Set up Node.js",
    "Install pinned npm",
    "Verify npm version",
    "Install dependencies",
    "Build",
    "Run integration tests",
    "Upload integration diagnostics",
  ],
  quality: [
    "Check out repository",
    "Set up Node.js",
    "Install pinned npm",
    "Verify npm version",
    "Install dependencies",
    "Validate commit messages",
    "Check formatting",
    "Lint",
    "Build",
    "Verify deterministic plugin package",
    "Typecheck",
    "Run unit and architecture tests",
    "Validate OpenSpec",
  ],
  "system-e2e": [
    "Check out repository",
    "Set up Node.js",
    "Install pinned npm",
    "Verify npm version",
    "Install dependencies",
    "Build",
    "Run single-Main system smoke",
    "Run multi-Main takeover",
    "Upload process diagnostics",
  ],
};

function jobRange(workflow, jobName) {
  const start = workflow.search(new RegExp(`^  ${jobName}:\\s*$`, "mu"));
  assert.notEqual(start, -1, `missing job ${jobName}`);
  const tail = workflow.slice(start);
  const next = tail.slice(tail.indexOf("\n") + 1).search(/^ {2}[a-zA-Z0-9_-]+:\s*$/mu);
  return {
    end: next === -1 ? workflow.length : start + tail.indexOf("\n") + 1 + next,
    start,
  };
}

function stepRanges(workflow, jobName) {
  const job = jobRange(workflow, jobName);
  const source = workflow.slice(job.start, job.end);
  const starts = [...source.matchAll(/^ {6}- name:\s*(.+?)\s*$/gmu)].map((match) => ({
    name: match[1],
    start: job.start + match.index,
  }));
  return starts.map((step, index) => ({
    ...step,
    end: starts[index + 1]?.start ?? job.end,
  }));
}

function mutateStepField(workflow, jobName, stepName, field, value) {
  const step = stepRanges(workflow, jobName).find(({ name }) => name === stepName);
  assert.ok(step, `missing step ${jobName}/${stepName}`);
  const block = workflow.slice(step.start, step.end);
  const fieldPattern = new RegExp(`^ {8}${field}:.*$`, "mu");
  const replacement = `        ${field}: ${value}`;
  const mutated = fieldPattern.test(block)
    ? block.replace(fieldPattern, replacement)
    : block.replace(/^ {6}- name:.*$/mu, (line) => `${line}\n${replacement}`);
  return `${workflow.slice(0, step.start)}${mutated}${workflow.slice(step.end)}`;
}

function moveStep(workflow, sourceJob, stepName, targetJob) {
  const step = stepRanges(workflow, sourceJob).find(({ name }) => name === stepName);
  assert.ok(step, `missing step ${sourceJob}/${stepName}`);
  const block = workflow.slice(step.start, step.end);
  const without = `${workflow.slice(0, step.start)}${workflow.slice(step.end)}`;
  const target = jobRange(without, targetJob);
  const stepsHeader = without.slice(target.start, target.end).match(/^ {4}steps:\s*$/mu);
  assert.ok(stepsHeader?.index !== undefined, `missing steps in ${targetJob}`);
  const insertion = target.start + stepsHeader.index + stepsHeader[0].length + 1;
  return `${without.slice(0, insertion)}${block}${without.slice(insertion)}`;
}

function replaceStepCommandWithNoop(workflow, jobName, stepName) {
  const step = stepRanges(workflow, jobName).find(({ name }) => name === stepName);
  assert.ok(step, `missing step ${jobName}/${stepName}`);
  const block = workflow.slice(step.start, step.end);
  const mutated = /^ {8}run:/mu.test(block)
    ? block.replace(/^ {8}run:.*$/mu, "        run: ':'")
    : block.replace(/^ {8}uses:.*$/mu, "        # uses: intentionally disabled");
  assert.notEqual(mutated, block, `${jobName}/${stepName} must have a command`);
  return `${workflow.slice(0, step.start)}${mutated}${workflow.slice(step.end)}`;
}

function swapStepOrder(workflow, jobName, stepName) {
  const steps = stepRanges(workflow, jobName);
  const index = steps.findIndex(({ name }) => name === stepName);
  assert.notEqual(index, -1, `missing step ${jobName}/${stepName}`);
  const leftIndex = index === steps.length - 1 ? index - 1 : index;
  const left = steps[leftIndex];
  const right = steps[leftIndex + 1];
  return [
    workflow.slice(0, left.start),
    workflow.slice(right.start, right.end),
    workflow.slice(left.start, left.end),
    workflow.slice(right.end),
  ].join("");
}

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
  assert.equal(packageJson.devDependencies["js-yaml"], "4.3.0");
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
  const valid = {
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
    workflow: await readFile(workflowPath, "utf8"),
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

test("CI workflow validation rejects every disabled, soft-fail, misplaced, no-op, or reordered required step", async (t) => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateReleasePreflight } = await import(
    new URL(`../../scripts/verify-release.mjs?mutations=${Date.now()}`, import.meta.url)
  );
  const base = {
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
  };
  const wrongJobs = {
    integration: "system-e2e",
    quality: "integration",
    "system-e2e": "quality",
  };

  for (const [jobName, stepNames] of Object.entries(requiredStepsByJob)) {
    for (const stepName of stepNames) {
      const mutations = {
        "commented or no-op command": replaceStepCommandWithNoop(workflow, jobName, stepName),
        disabled: mutateStepField(workflow, jobName, stepName, "if", "false"),
        misplaced: moveStep(workflow, jobName, stepName, wrongJobs[jobName]),
        reordered: swapStepOrder(workflow, jobName, stepName),
        "soft fail": mutateStepField(workflow, jobName, stepName, "continue-on-error", "true"),
      };
      for (const [mutationName, mutation] of Object.entries(mutations)) {
        await t.test(`${jobName}/${stepName}: ${mutationName}`, () => {
          assert.notEqual(mutation, workflow);
          const diagnostics = validateReleasePreflight({ ...base, workflow: mutation });
          assert.equal(
            diagnostics.some(({ code }) => code === "ci_contract_incomplete"),
            true,
          );
        });
      }
    }
  }
});

test("CI workflow validation requires automatic pull-request and main push triggers", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateReleasePreflight } = await import(
    new URL(`../../scripts/verify-release.mjs?trigger-mutations=${Date.now()}`, import.meta.url)
  );
  const base = {
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
  };
  const triggerBlock = [
    "on:",
    "  pull_request:",
    "    branches: [main]",
    "  push:",
    "    branches: [main]",
    "  workflow_dispatch:",
  ].join("\n");
  const mutations = [
    workflow.replace(triggerBlock, "on:\n  workflow_dispatch:"),
    workflow.replace("    branches: [main]", "    branches: [release]", 1),
    workflow.replace("  push:\n    branches: [main]\n", ""),
    workflow.replace("  pull_request:\n    branches: [main]\n", ""),
  ];

  for (const mutation of mutations) {
    assert.notEqual(mutation, workflow);
    const diagnostics = validateReleasePreflight({ ...base, workflow: mutation });
    assert.equal(
      diagnostics.some(({ code }) => code === "ci_contract_incomplete"),
      true,
    );
  }
});

test("CI workflow validation requires the deterministic package step after build", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateReleasePreflight } = await import(
    new URL(`../../scripts/verify-release.mjs?package-mutation=${Date.now()}`, import.meta.url)
  );
  const step = stepRanges(workflow, "quality").find(
    ({ name }) => name === "Verify deterministic plugin package",
  );
  assert.ok(step);
  const mutation = `${workflow.slice(0, step.start)}${workflow.slice(step.end)}`;
  const diagnostics = validateReleasePreflight({
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
    workflow: mutation,
  });

  assert.equal(
    diagnostics.some(({ code }) => code === "ci_contract_incomplete"),
    true,
  );
});

test("CI workflow validation rejects extra or duplicate PostgreSQL health flags", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateReleasePreflight } = await import(
    new URL(`../../scripts/verify-release.mjs?health-mutations=${Date.now()}`, import.meta.url)
  );
  const base = {
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
  };
  const mutations = [
    workflow.replace(
      "          --health-retries 30",
      "          --health-retries 30\n          --no-healthcheck",
    ),
    workflow.replace(
      "          --health-retries 30",
      "          --health-retries 30\n          --health-retries 30",
    ),
    workflow.replace(
      '          --health-cmd "pg_isready -U tego_test -d tego_next_test"',
      '          --health-cmd "pg_isready -U tego_test -d tego_next_test"\n          --health-cmd "true"',
    ),
  ];

  for (const mutation of mutations) {
    const diagnostics = validateReleasePreflight({ ...base, workflow: mutation });
    assert.equal(
      diagnostics.some(({ code }) => code === "ci_contract_incomplete"),
      true,
    );
  }
});

test("CI workflow validation binds action review comments to their required steps", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateReleasePreflight } = await import(
    new URL(
      `../../scripts/verify-release.mjs?action-comment-mutations=${Date.now()}`,
      import.meta.url,
    )
  );
  const checkout = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0";
  const checkoutReference = checkout.split(" # ")[0];
  const mutations = [
    workflow
      .replace(`        uses: ${checkout}`, `        uses: ${checkoutReference}`)
      .replace(
        "permissions:\n  contents: read",
        `permissions:\n  contents: read\n\nenv:\n  ACTION_REVIEW_SPOOF: |\n    uses: ${checkout}`,
      ),
    workflow
      .replace(`        uses: ${checkout}`, `        uses: ${checkoutReference}`)
      .replace(
        "name: CI",
        [
          "name: |",
          "  quality:",
          "    steps:",
          "      - name: Check out repository",
          `        uses: ${checkout}`,
          "      - name: Set up Node.js",
          "        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0",
        ].join("\n"),
      ),
    workflow
      .replace("name: CI", `name: CI\n\nx-checkout: &checkout ${checkoutReference} # v6.1.0`)
      .replace(`        uses: ${checkout}`, "        uses: *checkout"),
  ];

  for (const mutation of mutations) {
    const diagnostics = validateReleasePreflight({
      gitStatus: "",
      nodeVersion: "v26.5.0",
      npmVersion: "11.13.0",
      postgresUrl: "postgresql://localhost/tego",
      workflow: mutation,
    });
    assert.equal(
      diagnostics.some(({ code }) => code === "ci_contract_incomplete"),
      true,
    );
  }
});

test("deterministic package gate compares independent artifacts and manifests without residue", async () => {
  const beforeStatus = spawnSync("git", ["status", "--porcelain=v1"], {
    cwd: root,
    encoding: "utf8",
  }).stdout;
  const beforeTemporaryDirectories = (await readdir(tmpdir()))
    .filter((name) => name.startsWith("tego-release-package-"))
    .sort();
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts", "verify-release.mjs"), "--deterministic-package"],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"artifactSha256":"[a-f0-9]{64}"/u);
  assert.match(result.stdout, /"manifestSha256":"[a-f0-9]{64}"/u);
  assert.equal(
    spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout,
    beforeStatus,
  );
  assert.deepEqual(
    (await readdir(tmpdir())).filter((name) => name.startsWith("tego-release-package-")).sort(),
    beforeTemporaryDirectories,
  );
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
        "--ready-pattern",
        "child-pid:",
        "--startup-timeout-ms",
        "2000",
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
        "--ready-pattern",
        "spawned-grandchild-pid:",
        "--startup-timeout-ms",
        "2000",
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
      canTerminateAfterLeaderExit: true,
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
      canTerminateAfterLeaderExit: true,
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
    ["probe:pid", "terminate:pid:SIGTERM", "probe:pid", "terminate:pid:SIGKILL", "probe:pid"],
  );
});

test("managed runner never targets a closed Windows leader without stable tree ownership", async () => {
  const { runManagedProcessTree } = await import(
    new URL(`../../scripts/run-ci-test.mjs?windows-closed-leader=${Date.now()}`, import.meta.url)
  );
  const metadata = await runManagedProcessTree({
    name: "windows-closed-leader",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 1_000,
    platform: "win32",
  });

  assert.equal(metadata.timedOut, false);
  assert.equal(metadata.childExitCode, 0);
  assert.equal(metadata.terminationSignal, null);
  assert.equal(metadata.exitCode, 125);
  assert.equal(metadata.processTreeTerminated, false);
  assert.match(metadata.error, /stable Windows process-tree ownership.*closed PID/iu);
});

test("managed runner converts POSIX signaling permission failures into fail-closed metadata", async () => {
  const { runManagedProcessTree } = await import(
    new URL(`../../scripts/run-ci-test.mjs?posix-eperm=${Date.now()}`, import.meta.url)
  );
  const originalKill = process.kill;
  process.kill = () => {
    const denied = new Error("operation not permitted");
    denied.code = "EPERM";
    throw denied;
  };
  try {
    const metadata = await runManagedProcessTree({
      name: "posix-eperm",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 1_000,
      platform: "linux",
    });

    assert.equal(metadata.timedOut, false);
    assert.equal(metadata.childExitCode, 0);
    assert.equal(metadata.exitCode, 125);
    assert.equal(metadata.processTreeTerminated, false);
    assert.match(metadata.error, /process tree did not terminate/iu);
  } finally {
    process.kill = originalKill;
  }
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
