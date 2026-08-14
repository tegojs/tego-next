import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packWorkspaceSet, withPackedConsumer } from "./package-contract.mjs";

export const WINDOWS_CONTROL_GATE_MARKER = "TEGO_WINDOWS_CONTROL_GATE_OK";
export const WINDOWS_CONTROL_GATE_CHILD_MARKER = "TEGO_WINDOWS_CONTROL_GATE_INNER_OK";

const root = fileURLToPath(new URL("../", import.meta.url));
const gateSourcePath = fileURLToPath(
  new URL("../packages/cli/test/windows-control-gate.ts", import.meta.url),
);
const runnerSourcePath = fileURLToPath(import.meta.url);

const requiredWindowsControlGateStages = [
  ["packed-clean-consumer", "preparePackedWindowsControlConsumer"],
  ["powershell-csharp-self-test", "runPowerShellSelfTest"],
  ["live-server-handle-descriptor", "startLiveDescriptor"],
  ["status-request", "runStatusRequest"],
  ["malformed-broker-frame-fail-closed", "runMalformedFrameFailure"],
  ["parent-crash-cleanup", "runParentCrashCleanup"],
  ["broker-crash-cleanup", "runBrokerCrashCleanup"],
  ["reconnect-failure", "runReconnectFailure"],
  ["twenty-lifecycle-rounds", "runTwentyLifecycleRounds"],
];

function stageCalls(source) {
  return [
    ...source.matchAll(
      /^\s*await runWindowsControlGateStage\("([a-z0-9-]+)", ([A-Za-z_$][\w$]*)\);\s*$/gmu,
    ),
  ].map((match) => [match[1], match[2]]);
}

function exactAwaitCount(source, expression) {
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...source.matchAll(new RegExp(`^\\s*await ${escaped};\\s*$`, "gmu"))].length;
}

function hasActiveStageExecutor(source) {
  const matches = [...source.matchAll(/^async function runWindowsControlGateStage/gmu)];
  if (matches.length !== 1) return false;
  const start = matches[0].index;
  const end = source.indexOf("\n}", start);
  const invocation = source.indexOf("await operation();", start);
  return end !== -1 && invocation !== -1 && invocation < end;
}

export function validateWindowsControlGateContract({ gateSource, runnerSource }) {
  const errors = [];
  if (typeof gateSource !== "string" || typeof runnerSource !== "string") {
    return ["Windows gate sources must be text"];
  }
  const expectedOuter = requiredWindowsControlGateStages.slice(0, 1);
  const expectedInner = requiredWindowsControlGateStages.slice(1);
  if (JSON.stringify(stageCalls(runnerSource)) !== JSON.stringify(expectedOuter)) {
    errors.push("Windows gate runner stages are missing, reordered, conditional, or replaced");
  }
  if (JSON.stringify(stageCalls(gateSource)) !== JSON.stringify(expectedInner)) {
    errors.push("installed Windows gate stages are missing, reordered, conditional, or replaced");
  }
  if (!hasActiveStageExecutor(runnerSource) || !hasActiveStageExecutor(gateSource)) {
    errors.push("Windows gate stage executors must await their required operation");
  }
  if (exactAwaitCount(runnerSource, "runInstalledWindowsControlGate()") !== 1) {
    errors.push("Windows gate runner must await exactly one installed consumer execution");
  }
  const installedMatch = /^\s*await runInstalledWindowsControlGate\(\);\s*$/mu.exec(runnerSource);
  const packedMatch =
    /^\s*await runWindowsControlGateStage\("packed-clean-consumer", preparePackedWindowsControlConsumer\);\s*$/mu.exec(
      runnerSource,
    );
  const installedIndex = installedMatch?.index ?? -1;
  const packedIndex = packedMatch?.index ?? -1;
  if (packedIndex === -1 || installedIndex === -1 || packedIndex > installedIndex) {
    errors.push("packed Windows consumer preparation must precede installed execution");
  }
  const markerWrite = `process.stdout.write(\`\${WINDOWS_CONTROL_GATE_MARKER}\\n\`);`;
  const markerIndex = runnerSource.indexOf(markerWrite);
  if (
    markerIndex === -1 ||
    markerIndex < installedIndex ||
    runnerSource.indexOf(markerWrite, markerIndex + markerWrite.length) !== -1 ||
    gateSource.includes(markerWrite)
  ) {
    errors.push("Windows gate completion marker must be unique and follow installed execution");
  }
  return errors;
}

const gateProgram = fileURLToPath(
  new URL("../packages/cli/dist/test/windows-control-gate.js", import.meta.url),
);

let preparedConsumer;

async function runWindowsControlGateStage(_stage, operation) {
  await operation();
}

async function preparePackedWindowsControlConsumer() {
  const directory = await mkdtemp(join(tmpdir(), "tego-windows-control-gate-"));
  try {
    const packed = await packWorkspaceSet(root, join(directory, "tarballs"));
    preparedConsumer = { directory, packed };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

async function runInstalledWindowsControlGate() {
  if (preparedConsumer === undefined) throw new Error("Windows gate consumer is unavailable");
  const { directory, packed } = preparedConsumer;
  await withPackedConsumer(packed, directory, async (consumer) => {
    const installedGate = join(consumer.directory, "windows-control-gate.mjs");
    await copyFile(gateProgram, installedGate);
    const result = spawnSync(process.execPath, [installedGate], {
      cwd: consumer.directory,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_PATH: "",
        TEGO_WINDOWS_CONTROL_BROKER_CS: consumer.brokerCSharp,
        TEGO_WINDOWS_CONTROL_BROKER_PS1: consumer.brokerPowerShell,
        TEGO_WINDOWS_CONTROL_CONSUMER_PACKAGES: consumer.packageNames.join(","),
        TEGO_WINDOWS_CONTROL_CONSUMER_ROOT: consumer.directory,
      },
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 12 * 60 * 1000,
      windowsHide: true,
    });
    try {
      assertWindowsControlGateResult(process.platform, result);
    } catch (error) {
      if (typeof result.stdout === "string" && result.stdout !== "") {
        process.stderr.write(result.stdout);
      }
      if (typeof result.stderr === "string" && result.stderr !== "") {
        process.stderr.write(result.stderr);
      }
      throw error;
    }
  });
}

export function assertWindowsControlGateResult(platform, result) {
  if (platform !== "win32") {
    throw new Error("Windows control security gate requires Windows");
  }
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error("Windows control security gate failed");
  }
  if (result.stderr !== "" || !/^[^\r\n]+\r?\n$/u.test(result.stdout)) {
    throw new Error("Windows control security gate did not emit one clean completion marker");
  }
  if (result.stdout.trim() !== WINDOWS_CONTROL_GATE_CHILD_MARKER) {
    throw new Error("Windows control security gate completion marker is missing");
  }
}

export async function runWindowsControlGate(platform = process.platform) {
  if (platform !== "win32") {
    throw new Error("Windows control security gate requires Windows");
  }
  try {
    const [gateSource, runnerSource] = await Promise.all([
      readFile(gateSourcePath, "utf8"),
      readFile(runnerSourcePath, "utf8"),
    ]);
    if (validateWindowsControlGateContract({ gateSource, runnerSource }).length > 0) {
      throw new Error("Windows gate source contract is incomplete");
    }
    await runWindowsControlGateStage("packed-clean-consumer", preparePackedWindowsControlConsumer);
    await runInstalledWindowsControlGate();
  } finally {
    if (preparedConsumer !== undefined) {
      await rm(preparedConsumer.directory, { force: true, recursive: true });
      preparedConsumer = undefined;
    }
  }
  process.stdout.write(`${WINDOWS_CONTROL_GATE_MARKER}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runWindowsControlGate();
  } catch (error) {
    // TEMPORARY NON-AUTHORITATIVE TASK 4 DIAGNOSTIC. Remove after the first Windows RED is localized.
    process.stderr.write(
      `TEGO_TASK4_NON_AUTHORITATIVE_DIAGNOSTIC:${error instanceof Error ? error.stack : typeof error}\n`,
    );
    process.stderr.write("TEGO_WINDOWS_CONTROL_GATE_FAILED\n");
    process.exitCode = 1;
  }
}
