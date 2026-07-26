import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultTimeoutMs = 10 * 60 * 1000;
const gracefulTerminationMs = 250;
const forcedTerminationWaitMs = 1000;

export function resolveNpmCli(env = process.env, execPath = process.execPath) {
  if (env.npm_execpath?.trim()) return env.npm_execpath;

  const executableDirectory = dirname(execPath);
  const candidates =
    process.platform === "win32"
      ? [
          join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
          join(executableDirectory, "npm-cli.js"),
        ]
      : [resolve(executableDirectory, "../lib/node_modules/npm/bin/npm-cli.js")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function parseReporterArguments(args) {
  const separator = args.indexOf("--");
  const options = args.slice(0, separator);
  const command = separator === -1 ? [] : args.slice(separator + 1);
  let name;
  let artifacts;
  let timeoutMs = defaultTimeoutMs;
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (option === "--name") name = value;
    else if (option === "--artifacts") artifacts = value;
    else if (option === "--timeout-ms") timeoutMs = Number(value);
    else throw new Error(`Unknown reporter option: ${option ?? ""}`);
  }
  if (
    !name ||
    !artifacts ||
    command.length === 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error(
      "Usage: run-ci-test.mjs --name <name> --artifacts <directory> [--timeout-ms <milliseconds>] -- <command> [args...]",
    );
  }
  return { name, artifacts, timeoutMs, command: command[0], args: command.slice(1) };
}

function signalProcessTree(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    } else {
      child.kill(signal);
    }
    return;
  }
  process.kill(-child.pid, signal);
}

export async function runReportedCommand({
  name,
  artifacts,
  timeoutMs = defaultTimeoutMs,
  command,
  args,
}) {
  mkdirSync(artifacts, { recursive: true });
  const resultPath = join(artifacts, `${name}-result.json`);
  const logPath = join(artifacts, `${name}-process.log`);
  writeFileSync(logPath, `[ci-test] ${command} ${args.join(" ")}\n`);

  const requestedCommand = command;
  const requestedArgs = args;
  const npmInvocation = command === "npm";
  const actualCommand = npmInvocation ? process.execPath : command;
  const actualArgs = npmInvocation ? [resolveNpmCli(), ...args] : args;
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  const outcome = await new Promise((resolveOutcome) => {
    let settled = false;
    let timedOut = false;
    let terminationSignal;
    let forceTimer;
    let finalizationTimer;
    const child = spawn(actualCommand, actualArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      clearTimeout(finalizationTimer);
      resolveOutcome({
        timedOut,
        timeoutMs,
        terminationSignal,
        childPid: child.pid,
        childExitCode: null,
        childSignal: null,
        ...result,
      });
    };
    const terminate = (signal) => {
      terminationSignal = signal;
      try {
        signalProcessTree(child, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") {
          appendFileSync(logPath, `[ci-test] ${signal} failed: ${error.message}\n`);
        }
      }
    };
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      appendFileSync(logPath, chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      appendFileSync(logPath, chunk);
    });
    child.once("error", (error) => finish({ exitCode: 1, error: error.message }));
    child.once("close", (childExitCode, childSignal) =>
      finish({
        exitCode: timedOut ? 124 : (childExitCode ?? 1),
        childExitCode,
        childSignal: childSignal ?? null,
      }),
    );
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      appendFileSync(
        logPath,
        `[ci-test] timed out after ${timeoutMs}ms; terminating process tree\n`,
      );
      terminate("SIGTERM");
      forceTimer = setTimeout(() => {
        terminate("SIGKILL");
        finalizationTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish({
            exitCode: 124,
            childExitCode: null,
            childSignal: null,
            error: "process tree did not report termination after SIGKILL",
          });
        }, forcedTerminationWaitMs);
      }, gracefulTerminationMs);
    }, timeoutMs);
  });

  const finishedAtMs = Date.now();
  const metadata = {
    name,
    command: requestedCommand,
    args: requestedArgs,
    actualCommand,
    actualArgs,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    ...outcome,
  };
  writeFileSync(resultPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata.exitCode;
}

async function main() {
  try {
    process.exitCode = await runReportedCommand(parseReporterArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
