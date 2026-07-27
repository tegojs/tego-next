import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { resolveNpmCli, runManagedProcessTree } from "./run-ci-test.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const expectedNodeVersion = "v26.5.0";
const expectedNpmVersion = "11.13.0";
const defaultReleaseTimeoutMs = 10 * 60 * 1000;
const npmCli = resolveNpmCli();
const expressionPrefix = "$";
const runnerTemp = `${expressionPrefix}{{ runner.temp }}`;
const postgresPort = `${expressionPrefix}{{ job.services.postgres.ports['5432'] }}`;
const commitlintFrom = `${expressionPrefix}{{ github.event.pull_request.base.sha || github.event.before }}`;
const commitlintTo = `${expressionPrefix}{{ github.event.pull_request.head.sha || github.sha }}`;
const integrationReporterCommand = `node scripts/run-ci-test.mjs --name integration --artifacts "${runnerTemp}/tego-test-artifacts" --timeout-ms 540000 -- npm run test:integration`;
const singleMainReporterCommand = `node scripts/run-ci-test.mjs --name single-main --artifacts "${runnerTemp}/tego-test-artifacts" --timeout-ms 420000 -- npm run test:e2e:single-main`;
const multiMainReporterCommand = `node scripts/run-ci-test.mjs --name multi-main --artifacts "${runnerTemp}/tego-test-artifacts" --timeout-ms 420000 -- npm run test:e2e:multi-main`;
const deterministicPackageCommand = "node scripts/verify-release.mjs --deterministic-package";
const actionPins = {
  checkout: {
    reference: "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    version: "v6.1.0",
  },
  setupNode: {
    reference: "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    version: "v6.5.0",
  },
  uploadArtifact: {
    reference: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    version: "v7.0.1",
  },
};

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
export const releaseStageResults = [];

function diagnostic(code, message, details = {}) {
  return { level: "error", code, message, ...details };
}

function workflowDocument(workflow) {
  try {
    const document = parseYaml(workflow);
    return typeof document === "object" && document !== null ? document : undefined;
  } catch {
    return undefined;
  }
}

export function parseWorkflowJobs(workflow) {
  const jobs = workflowDocument(workflow)?.jobs;
  if (typeof jobs !== "object" || jobs === null || Array.isArray(jobs)) return new Map();
  return new Map(Object.entries(jobs));
}

function sameValue(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function validateJobShape(errors, jobName, job) {
  if (typeof job !== "object" || job === null || Array.isArray(job)) {
    errors.push(`${jobName} must be a job mapping`);
    return false;
  }
  if (job["runs-on"] !== "ubuntu-latest" || job["timeout-minutes"] !== 15) {
    errors.push(`${jobName} must run on ubuntu-latest with a 15 minute bound`);
  }
  if (
    job.if !== undefined ||
    (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false)
  ) {
    errors.push(`${jobName} cannot be conditional or soft-fail`);
  }
  if (!Array.isArray(job.steps)) {
    errors.push(`${jobName} must define active steps`);
    return false;
  }
  return true;
}

function validateRequiredSteps(errors, jobName, job, specifications) {
  if (!validateJobShape(errors, jobName, job)) return;
  let previousIndex = -1;
  for (const specification of specifications) {
    const matches = job.steps
      .map((step, index) => ({ index, step }))
      .filter(({ step }) => step?.name === specification.name);
    if (matches.length !== 1) {
      errors.push(`${jobName} must contain exactly one ${specification.name} step`);
      continue;
    }
    const { index, step } = matches[0];
    if (index <= previousIndex) {
      errors.push(`${jobName} step ${specification.name} is out of order`);
    }
    previousIndex = index;
    const commandField = specification.run === undefined ? "uses" : "run";
    const otherCommandField = commandField === "run" ? "uses" : "run";
    if (
      step[commandField] !== specification[commandField] ||
      step[otherCommandField] !== undefined
    ) {
      errors.push(
        `${jobName} step ${specification.name} must set ${commandField}: ${specification[commandField]}`,
      );
    }
    if (step["continue-on-error"] !== undefined && step["continue-on-error"] !== false) {
      errors.push(`${jobName} step ${specification.name} cannot soft-fail`);
    }
    if (specification.if === undefined) {
      if (step.if !== undefined) {
        errors.push(`${jobName} step ${specification.name} cannot be conditional`);
      }
    } else if (step.if !== specification.if) {
      errors.push(`${jobName} step ${specification.name} must set if: ${specification.if}`);
    }
    for (const field of ["timeout-minutes", "env", "with"]) {
      if (Object.hasOwn(specification, field) && !sameValue(step[field], specification[field])) {
        errors.push(`${jobName} step ${specification.name} has invalid ${field}`);
      }
    }
  }
}

function commonSteps({ checkoutWith } = {}) {
  return [
    {
      name: "Check out repository",
      uses: actionPins.checkout.reference,
      ...(checkoutWith === undefined ? {} : { with: checkoutWith }),
    },
    {
      name: "Set up Node.js",
      uses: actionPins.setupNode.reference,
      with: { "node-version-file": ".node-version", cache: "npm" },
    },
    { name: "Install pinned npm", run: "npm install --global npm@11.13.0" },
    { name: "Verify npm version", run: "npm --version" },
    { name: "Install dependencies", run: "npm ci" },
  ];
}

function postgresServiceIsValid(job) {
  const postgres = job.services?.postgres;
  const options =
    typeof postgres?.options === "string"
      ? postgres.options.trim().replaceAll(/\s+/gu, " ")
      : undefined;
  const expectedOptions = [
    '--health-cmd "pg_isready -U tego_test -d tego_next_test"',
    "--health-interval 1s",
    "--health-timeout 3s",
    "--health-retries 30",
  ].join(" ");
  return (
    postgres?.image === "postgres:16.14-alpine" &&
    sameValue(postgres.env, {
      POSTGRES_DB: "tego_next_test",
      POSTGRES_PASSWORD: "tego_test",
      POSTGRES_USER: "tego_test",
    }) &&
    sameValue(postgres.ports, ["5432/tcp"]) &&
    options === expectedOptions
  );
}

function validateActionVersionComments(errors, workflow) {
  for (const [name, pin, expectedCount] of [
    ["checkout", actionPins.checkout, 3],
    ["setup-node", actionPins.setupNode, 3],
    ["upload-artifact", actionPins.uploadArtifact, 2],
  ]) {
    const expected = `uses: ${pin.reference} # ${pin.version}`;
    const count = workflow.split("\n").filter((line) => line.trim() === expected).length;
    if (count !== expectedCount) {
      errors.push(
        `${name} must use ${pin.reference} with ${pin.version} review comments exactly ${expectedCount} times`,
      );
    }
  }
}

export function validateWorkflowContract(workflow) {
  const document = workflowDocument(workflow);
  const jobs = parseWorkflowJobs(workflow);
  const errors = [];
  if (document === undefined) {
    return ["workflow must be valid active YAML"];
  }
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
  if (!sameValue(document.permissions, { contents: "read" })) {
    errors.push("workflow permissions must be exactly contents: read");
  }
  validateActionVersionComments(errors, workflow);
  validateRequiredSteps(errors, "quality", quality, [
    ...commonSteps({ checkoutWith: { "fetch-depth": 0 } }),
    {
      name: "Validate commit messages",
      run: "npm run commitlint:ci",
      env: {
        COMMITLINT_FROM: commitlintFrom,
        COMMITLINT_TO: commitlintTo,
      },
    },
    { name: "Check formatting", run: "npm run format:check" },
    { name: "Lint", run: "npm run lint" },
    { name: "Build", run: "npm run build" },
    {
      name: "Verify deterministic plugin package",
      run: deterministicPackageCommand,
      "timeout-minutes": 2,
    },
    { name: "Typecheck", run: "npm run typecheck" },
    { name: "Run unit and architecture tests", run: "npm test" },
    { name: "Validate OpenSpec", run: "npm run openspec:validate" },
  ]);
  const reporterEnvironment = {
    TEGO_POSTGRES_URL: `postgresql://tego_test:tego_test@127.0.0.1:${postgresPort}/tego_next_test`,
    TEGO_TEST_ARTIFACTS_DIR: `${runnerTemp}/tego-test-artifacts`,
  };
  validateRequiredSteps(errors, "integration", integration, [
    ...commonSteps(),
    { name: "Build", run: "npm run build" },
    {
      name: "Run integration tests",
      if: "always()",
      run: integrationReporterCommand,
      "timeout-minutes": 10,
      env: reporterEnvironment,
    },
    {
      name: "Upload integration diagnostics",
      if: "always()",
      uses: actionPins.uploadArtifact.reference,
      "timeout-minutes": 2,
      with: {
        name: "postgres-integration-diagnostics",
        path: `${runnerTemp}/tego-test-artifacts`,
        "if-no-files-found": "error",
        "retention-days": 7,
      },
    },
  ]);
  validateRequiredSteps(errors, "system-e2e", system, [
    ...commonSteps(),
    { name: "Build", run: "npm run build" },
    {
      name: "Run single-Main system smoke",
      if: "always()",
      run: singleMainReporterCommand,
      "timeout-minutes": 8,
      env: reporterEnvironment,
    },
    {
      name: "Run multi-Main takeover",
      if: "always()",
      run: multiMainReporterCommand,
      "timeout-minutes": 8,
      env: reporterEnvironment,
    },
    {
      name: "Upload process diagnostics",
      if: "always()",
      uses: actionPins.uploadArtifact.reference,
      "timeout-minutes": 2,
      with: {
        name: "process-e2e-diagnostics",
        path: `${runnerTemp}/tego-test-artifacts`,
        "if-no-files-found": "error",
        "retention-days": 7,
      },
    },
  ]);
  for (const [jobName, job] of [
    ["integration", integration],
    ["system-e2e", system],
  ]) {
    if (!postgresServiceIsValid(job)) {
      errors.push(`${jobName} must use the bounded PostgreSQL 16.14 health-checked service`);
    }
  }
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

export async function runReleaseCommand({
  name,
  command,
  args,
  captureStdout = false,
  timeoutMs = defaultReleaseTimeoutMs,
}) {
  process.stdout.write(`\n[verify:release] ${name}\n`);
  let stdout = "";
  const stage = await runManagedProcessTree({
    name,
    command,
    args,
    timeoutMs,
    cwd: root,
    env: process.env,
    onStdout: (chunk) => {
      if (captureStdout) stdout += chunk;
      process.stdout.write(chunk);
    },
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  releaseStageResults.push(structuredClone(stage));
  if (stage.timedOut) {
    throw diagnostic("command_timed_out", `${name} timed out after ${timeoutMs}ms.`, {
      command,
      args,
      stage,
    });
  }
  if (stage.error !== undefined || stage.exitCode !== 0) {
    const cause = stage.error ?? `exit status ${String(stage.exitCode)}`;
    throw diagnostic("command_failed", `${name} failed: ${cause}`, {
      command,
      args,
      stage,
    });
  }
  return captureStdout ? { ...stage, stdout } : stage;
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function packageResult(stdout, name) {
  const jsonLine = stdout
    .trim()
    .split("\n")
    .toReversed()
    .find((line) => line.trim().startsWith("{"));
  if (jsonLine === undefined) {
    throw diagnostic("package_output_invalid", `${name} did not emit a JSON result.`);
  }
  try {
    const result = JSON.parse(jsonLine);
    if (typeof result !== "object" || result === null || result.manifest === undefined) {
      throw new TypeError("manifest is missing");
    }
    return result;
  } catch (error) {
    throw diagnostic("package_output_invalid", `${name} emitted invalid JSON.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function verifyDeterministicPluginPackage() {
  const directory = await mkdtemp(join(tmpdir(), "tego-release-package-"));
  const first = join(directory, "echo-first.tego");
  const second = join(directory, "echo-second.tego");
  const cli = join(root, "packages", "cli", "dist", "src", "bin.js");
  const plugin = join(root, "examples", "echo-plugin");
  try {
    const firstStage = await runReleaseCommand({
      name: "first deterministic echo package",
      command: process.execPath,
      args: [cli, "plugin", "pack", plugin, "--output", first, "--json"],
      captureStdout: true,
    });
    const secondStage = await runReleaseCommand({
      name: "second deterministic echo package",
      command: process.execPath,
      args: [cli, "plugin", "pack", plugin, "--output", second, "--json"],
      captureStdout: true,
    });
    const [firstDigest, secondDigest] = await Promise.all([sha256(first), sha256(second)]);
    if (firstDigest !== secondDigest) {
      throw diagnostic("package_not_reproducible", "Echo plugin package digests differ.", {
        firstDigest,
        secondDigest,
      });
    }
    const firstResult = packageResult(firstStage.stdout, "first deterministic echo package");
    const secondResult = packageResult(secondStage.stdout, "second deterministic echo package");
    const firstManifest = JSON.stringify(firstResult.manifest);
    const secondManifest = JSON.stringify(secondResult.manifest);
    if (firstManifest !== secondManifest) {
      throw diagnostic(
        "package_manifest_not_reproducible",
        "Echo plugin package manifests differ.",
      );
    }
    const manifestDigest = createHash("sha256").update(firstManifest).digest("hex");
    const result = {
      ok: true,
      mode: "deterministic-package",
      artifactSha256: firstDigest,
      manifestSha256: manifestDigest,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--openspec") {
    try {
      await runReleaseCommand(openspecInvocation);
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

  if (process.argv.length === 3 && process.argv[2] === "--deterministic-package") {
    try {
      await verifyDeterministicPluginPackage();
    } catch (error) {
      printDiagnostics([
        typeof error === "object" && error !== null && "code" in error
          ? error
          : diagnostic(
              "package_reproducibility_failed",
              "Deterministic package verification failed.",
              {
                cause: error instanceof Error ? error.message : String(error),
              },
            ),
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
        await runReleaseCommand(releaseCommand);
      }
    }
    process.stdout.write(
      `${JSON.stringify({ ok: true, mode: "release", stages: releaseStageResults })}\n`,
    );
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
