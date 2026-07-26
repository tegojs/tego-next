import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expectedNodeVersion = "v26.5.0";
const expectedNpmVersion = "11.13.0";
const requiredWorkflowEvidence = [
  "quality:",
  "integration:",
  "system-e2e:",
  "npm install --global npm@11.13.0",
  "postgres:16.14-alpine",
  "- 5432/tcp",
  "job.services.postgres.ports['5432']",
  "npm run test:integration",
  "npm run test:e2e:single-main",
  "npm run test:e2e:multi-main",
  "actions/upload-artifact@v7",
  "if: always()",
  "npx --yes @fission-ai/openspec@1.4.1 validate runtime-kernel-phase-1 --strict --no-interactive",
];

export const releaseCommands = [
  { name: "clean lockfile install", command: "npm", args: ["ci"] },
  { name: "format", command: "npm", args: ["run", "format:check"] },
  { name: "lint", command: "npm", args: ["run", "lint"] },
  { name: "build", command: "npm", args: ["run", "build"] },
  { name: "typecheck", command: "npm", args: ["run", "typecheck"] },
  { name: "unit and architecture tests", command: "npm", args: ["test"] },
  { name: "integration tests", command: "npm", args: ["run", "test:integration"] },
  {
    name: "deterministic plugin package",
    command: "internal:deterministic-plugin-package",
    args: [],
  },
  { name: "single-Main smoke", command: "npm", args: ["run", "test:e2e:single-main"] },
  { name: "multi-Main takeover", command: "npm", args: ["run", "test:e2e:multi-main"] },
  {
    name: "strict OpenSpec validation",
    command: "openspec",
    args: ["validate", "runtime-kernel-phase-1", "--strict", "--no-interactive"],
  },
];

function diagnostic(code, message, details = {}) {
  return { level: "error", code, message, ...details };
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
  const missing = requiredWorkflowEvidence.filter((marker) => !workflow.includes(marker));
  if (missing.length > 0) {
    diagnostics.push(
      diagnostic("ci_contract_incomplete", "Required CI release gates are missing.", { missing }),
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
    npmVersion: commandOutput("npm", ["--version"]),
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
