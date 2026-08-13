import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const WINDOWS_CONTROL_GATE_MARKER = "TEGO_WINDOWS_CONTROL_GATE_OK";

const gateProgram = fileURLToPath(
  new URL("../packages/cli/dist/test/windows-control-gate.js", import.meta.url),
);

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
  if (result.stdout.trim() !== WINDOWS_CONTROL_GATE_MARKER) {
    throw new Error("Windows control security gate completion marker is missing");
  }
}

export function runWindowsControlGate(platform = process.platform) {
  if (platform !== "win32") {
    throw new Error("Windows control security gate requires Windows");
  }
  const result = spawnSync(process.execPath, [gateProgram], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    shell: false,
    timeout: 60_000,
    windowsHide: true,
  });
  try {
    assertWindowsControlGateResult(platform, result);
  } catch (error) {
    if (typeof result.stdout === "string" && result.stdout !== "") {
      process.stderr.write(result.stdout);
    }
    if (typeof result.stderr === "string" && result.stderr !== "") {
      process.stderr.write(result.stderr);
    }
    throw error;
  }
  process.stdout.write(`${WINDOWS_CONTROL_GATE_MARKER}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runWindowsControlGate();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Windows gate failed"}\n`);
    process.exitCode = 1;
  }
}
