import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpmCli } from "./run-ci-test.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const expectedNodeVersion = "v26.5.0";
const expectedNpmVersion = "11.13.0";
const npmCli = resolveNpmCli();

function npmCommand(name, ...args) {
  return { name, command: process.execPath, args: [npmCli, ...args] };
}

export const openspecInvocation = npmCommand(
  "strict OpenSpec validation",
  "exec",
  "--yes",
  "--package=@fission-ai/openspec@1.4.1",
  "--",
  "openspec",
  "validate",
  "runtime-kernel-phase-1",
  "--strict",
  "--no-interactive",
);

export const releaseCommands = [
  npmCommand("clean lockfile install", "ci"),
  npmCommand("format", "run", "format:check"),
  npmCommand("lint", "run", "lint"),
  npmCommand("build", "run", "build"),
  npmCommand("typecheck", "run", "typecheck"),
  npmCommand("unit and architecture tests", "test"),
  npmCommand("integration tests", "run", "test:integration"),
  {
    name: "deterministic plugin package",
    command: "internal:deterministic-plugin-package",
    args: [],
  },
  npmCommand("single-Main smoke", "run", "test:e2e:single-main"),
  npmCommand("multi-Main takeover", "run", "test:e2e:multi-main"),
  npmCommand("strict OpenSpec validation", "run", "openspec:validate"),
];

function diagnostic(code, message, details = {}) {
  return { level: "error", code, message, ...details };
}

export function parseWorkflowJobs(workflow) {
  const jobsHeader = workflow.match(/^jobs:\s*$/mu);
  if (jobsHeader === null || jobsHeader.index === undefined) return new Map();

  const jobsSource = workflow.slice(jobsHeader.index + jobsHeader[0].length);
  const headers = [...jobsSource.matchAll(/^ {2}([a-zA-Z0-9_-]+):\s*$/gmu)];
  const jobs = new Map();
  for (const [index, header] of headers.entries()) {
    const start = header.index;
    const end = headers[index + 1]?.index ?? jobsSource.length;
    jobs.set(header[1], jobsSource.slice(start, end));
  }
  return jobs;
}

function requireMarkers(errors, jobName, job, markers) {
  for (const marker of markers) {
    if (!job.includes(marker)) errors.push(`${jobName} is missing ${marker}`);
  }
}

function requireOrder(errors, jobName, job, markers) {
  let previous = -1;
  for (const marker of markers) {
    const current = job.indexOf(marker, previous + 1);
    if (current === -1 || current <= previous) {
      errors.push(`${jobName} has an invalid step order at ${marker}`);
      return;
    }
    previous = current;
  }
}

export function validateWorkflowContract(workflow) {
  const jobs = parseWorkflowJobs(workflow);
  const errors = [];
  const expectedJobs = ["quality", "integration", "system-e2e"];
  if (
    jobs.size !== expectedJobs.length ||
    expectedJobs.some((jobName, index) => [...jobs.keys()][index] !== jobName)
  ) {
    errors.push("jobs must be exactly quality, integration, and system-e2e in that order");
    return errors;
  }

  const quality = jobs.get("quality");
  const integration = jobs.get("integration");
  const system = jobs.get("system-e2e");
  requireMarkers(errors, "quality", quality, [
    "timeout-minutes: 15",
    "run: npm run commitlint:ci",
    "run: npm run openspec:validate",
  ]);
  requireOrder(errors, "quality", quality, [
    "run: npm install --global npm@11.13.0",
    "run: npm --version",
    "run: npm ci",
    "run: npm run commitlint:ci",
    "run: npm run format:check",
    "run: npm run lint",
    "run: npm run build",
    "run: npm run typecheck",
    "run: npm test",
    "run: npm run openspec:validate",
  ]);
  if (quality.includes("npx --yes @fission-ai/openspec")) {
    errors.push("quality must invoke pinned OpenSpec through the repository npm script");
  }

  for (const [jobName, job] of [
    ["integration", integration],
    ["system-e2e", system],
  ]) {
    requireMarkers(errors, jobName, job, [
      "timeout-minutes: 15",
      "image: postgres:16.14-alpine",
      "- 5432/tcp",
      "job.services.postgres.ports['5432']",
      "TEGO_POSTGRES_URL:",
      "TEGO_TEST_ARTIFACTS_DIR:",
      "uses: actions/upload-artifact@v7",
      "if-no-files-found: error",
    ]);
  }
  requireMarkers(errors, "integration", integration, [
    "- name: Run integration tests",
    "if: always()",
    "node scripts/run-ci-test.mjs --name integration",
    "-- npm run test:integration",
  ]);
  requireOrder(errors, "integration", integration, [
    "run: npm run build",
    "- name: Run integration tests",
    "if: always()",
    "node scripts/run-ci-test.mjs --name integration",
    "- name: Upload integration diagnostics",
    "if: always()",
    "uses: actions/upload-artifact@v7",
  ]);

  requireMarkers(errors, "system-e2e", system, [
    "- name: Run single-Main system smoke",
    "node scripts/run-ci-test.mjs --name single-main",
    "-- npm run test:e2e:single-main",
    "- name: Run multi-Main takeover",
    "node scripts/run-ci-test.mjs --name multi-main",
    "-- npm run test:e2e:multi-main",
    "if: always()",
  ]);
  requireOrder(errors, "system-e2e", system, [
    "run: npm run build",
    "- name: Run single-Main system smoke",
    "if: always()",
    "node scripts/run-ci-test.mjs --name single-main",
    "- name: Run multi-Main takeover",
    "if: always()",
    "node scripts/run-ci-test.mjs --name multi-main",
    "- name: Upload process diagnostics",
    "if: always()",
    "uses: actions/upload-artifact@v7",
  ]);
  return errors;
}

export function validateReleasePreflight({
  gitStatus,
  nodeVersion,
  npmVersion,
  postgresUrl,
  workflow,
}) {
  const diagnostics = [];
  if (gitStatus.trim().length > 0) {
    diagnostics.push(
      diagnostic("dirty_worktree", "Release verification requires a clean working tree.", {
        files: gitStatus.trim().split("\n"),
      }),
    );
  }
  if (nodeVersion.trim() !== expectedNodeVersion) {
    diagnostics.push(
      diagnostic("node_version_mismatch", `Expected Node.js ${expectedNodeVersion}.`, {
        actual: nodeVersion.trim(),
      }),
    );
  }
  if (npmVersion.trim() !== expectedNpmVersion) {
    diagnostics.push(
      diagnostic("npm_version_mismatch", `Expected npm ${expectedNpmVersion}.`, {
        actual: npmVersion.trim(),
      }),
    );
  }
  if (postgresUrl?.trim().length === 0 || postgresUrl === undefined) {
    diagnostics.push(
      diagnostic(
        "postgres_url_missing",
        "TEGO_POSTGRES_URL is required; PostgreSQL verification is never skipped.",
      ),
    );
  }
  const workflowErrors = validateWorkflowContract(workflow);
  if (workflowErrors.length > 0) {
    diagnostics.push(
      diagnostic("ci_contract_incomplete", "Required CI release gates are missing.", {
        missing: workflowErrors,
      }),
    );
  }
  return diagnostics;
}

function commandOutput(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

function readPreflightState() {
  return {
    gitStatus: commandOutput("git", ["status", "--porcelain=v1"]),
    nodeVersion: process.version,
    npmVersion: commandOutput(process.execPath, [npmCli, "--version"]),
    postgresUrl: process.env.TEGO_POSTGRES_URL,
    workflow: readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"),
  };
}

function printDiagnostics(diagnostics) {
  process.stderr.write(`${JSON.stringify({ ok: false, diagnostics }, null, 2)}\n`);
}

export function runReleaseCommand({ name, command, args }) {
  process.stdout.write(`\n[verify:release] ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error !== undefined || result.status !== 0) {
    const cause = result.error?.message ?? `exit status ${String(result.status)}`;
    throw diagnostic("command_failed", `${name} failed: ${cause}`, { command, args });
  }
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function verifyDeterministicPluginPackage() {
  const directory = await mkdtemp(join(tmpdir(), "tego-release-package-"));
  const first = join(directory, "echo-first.tego");
  const second = join(directory, "echo-second.tego");
  const cli = join(root, "packages", "cli", "dist", "src", "bin.js");
  const plugin = join(root, "examples", "echo-plugin");
  try {
    runReleaseCommand({
      name: "first deterministic echo package",
      command: process.execPath,
      args: [cli, "plugin", "pack", plugin, "--output", first, "--json"],
    });
    runReleaseCommand({
      name: "second deterministic echo package",
      command: process.execPath,
      args: [cli, "plugin", "pack", plugin, "--output", second, "--json"],
    });
    const [firstDigest, secondDigest] = await Promise.all([sha256(first), sha256(second)]);
    if (firstDigest !== secondDigest) {
      throw diagnostic("package_not_reproducible", "Echo plugin package digests differ.", {
        firstDigest,
        secondDigest,
      });
    }
    process.stdout.write(`[verify:release] package sha256:${firstDigest}\n`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--openspec") {
    try {
      runReleaseCommand(openspecInvocation);
    } catch (error) {
      printDiagnostics([
        typeof error === "object" && error !== null && "code" in error
          ? error
          : diagnostic("openspec_validation_failed", "OpenSpec validation failed.", {
              cause: error instanceof Error ? error.message : String(error),
            }),
      ]);
      process.exitCode = 1;
    }
    return;
  }

  const unsupported = process.argv.slice(2).filter((argument) => argument !== "--preflight");
  if (unsupported.length > 0) {
    printDiagnostics([
      diagnostic("unsupported_argument", "Only --preflight is supported.", {
        arguments: unsupported,
      }),
    ]);
    process.exitCode = 1;
    return;
  }

  let diagnostics;
  try {
    diagnostics = validateReleasePreflight(readPreflightState());
  } catch (error) {
    diagnostics = [
      diagnostic("preflight_command_failed", "Could not collect release preflight evidence.", {
        cause: error instanceof Error ? error.message : String(error),
      }),
    ];
  }
  if (diagnostics.length > 0) {
    printDiagnostics(diagnostics);
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--preflight")) {
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "preflight" })}\n`);
    return;
  }

  try {
    for (const releaseCommand of releaseCommands) {
      if (releaseCommand.command === "internal:deterministic-plugin-package") {
        process.stdout.write(`\n[verify:release] ${releaseCommand.name}\n`);
        await verifyDeterministicPluginPackage();
      } else {
        runReleaseCommand(releaseCommand);
      }
    }
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "release" })}\n`);
  } catch (error) {
    printDiagnostics([
      typeof error === "object" && error !== null && "code" in error
        ? error
        : diagnostic("release_verification_failed", "Release verification failed.", {
            cause: error instanceof Error ? error.message : String(error),
          }),
    ]);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
