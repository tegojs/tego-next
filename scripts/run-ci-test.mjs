import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultTimeoutMs = 10 * 60 * 1000;
const gracefulTerminationMs = 250;
const forcedTerminationWaitMs = 1000;
const processTreePollMs = 10;

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

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function posixProcessTreeExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForPosixProcessTreeExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (posixProcessTreeExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await wait(Math.min(processTreePollMs, Math.max(1, deadline - Date.now())));
  }
  return true;
}

async function taskkill(processId, force) {
  const result = await new Promise((resolveTaskkill) => {
    const killer = spawn("taskkill", ["/pid", String(processId), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", (error) => resolveTaskkill({ error, status: null }));
    killer.once("close", (status) => resolveTaskkill({ status }));
  });
  return result.error === undefined && result.status === 0;
}

async function signalProcessTree(child, signal) {
  if (child.pid === undefined) return false;
  if (process.platform === "win32") {
    return taskkill(child.pid, signal === "SIGKILL");
  }
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolveSettlement) => {
    const timer = setTimeout(() => resolveSettlement({ settled: false }), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolveSettlement({ settled: true, value });
    });
  });
}

export async function runManagedProcessTree({
  name,
  timeoutMs = defaultTimeoutMs,
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  onStdout = () => {},
  onStderr = () => {},
}) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let timedOut = false;
  let terminationSignal = null;
  let processTreeTerminated = false;
  let spawnError;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["inherit", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  const closed = new Promise((resolveClose) => {
    child.once("error", (error) => {
      spawnError = error;
      resolveClose({ childExitCode: null, childSignal: null });
    });
    child.once("close", (childExitCode, childSignal) => {
      resolveClose({ childExitCode, childSignal: childSignal ?? null });
    });
  });

  const initial = await settleWithin(closed, timeoutMs);
  let closeResult;
  if (initial.settled) {
    closeResult = initial.value;
    processTreeTerminated =
      child.pid === undefined || process.platform === "win32" || !posixProcessTreeExists(child.pid);
    if (!processTreeTerminated && child.pid !== undefined) {
      terminationSignal = "SIGTERM";
      await signalProcessTree(child, "SIGTERM");
      processTreeTerminated = await waitForPosixProcessTreeExit(child.pid, gracefulTerminationMs);
      if (!processTreeTerminated) {
        terminationSignal = "SIGKILL";
        await signalProcessTree(child, "SIGKILL");
        processTreeTerminated = await waitForPosixProcessTreeExit(
          child.pid,
          forcedTerminationWaitMs,
        );
      }
    }
  } else {
    timedOut = true;
    terminationSignal = "SIGTERM";
    let treeSignalSucceeded = await signalProcessTree(child, "SIGTERM");
    const graceful =
      process.platform === "win32"
        ? await settleWithin(closed, gracefulTerminationMs)
        : {
            settled: await waitForPosixProcessTreeExit(child.pid, gracefulTerminationMs),
          };
    if (!graceful.settled) {
      terminationSignal = "SIGKILL";
      treeSignalSucceeded = (await signalProcessTree(child, "SIGKILL")) || treeSignalSucceeded;
    }
    if (process.platform === "win32") {
      const forced = graceful.settled
        ? graceful
        : await settleWithin(closed, forcedTerminationWaitMs);
      closeResult = forced.settled ? forced.value : { childExitCode: null, childSignal: null };
      processTreeTerminated = forced.settled && treeSignalSucceeded;
    } else {
      processTreeTerminated = await waitForPosixProcessTreeExit(child.pid, forcedTerminationWaitMs);
      const reaped = await settleWithin(closed, forcedTerminationWaitMs);
      closeResult = reaped.settled ? reaped.value : { childExitCode: null, childSignal: null };
      processTreeTerminated &&= reaped.settled;
    }
  }

  if (!processTreeTerminated) {
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  const finishedAtMs = Date.now();
  return {
    name,
    command,
    args,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    timedOut,
    timeoutMs,
    terminationSignal,
    childPid: child.pid ?? null,
    childExitCode: closeResult.childExitCode,
    childSignal: closeResult.childSignal,
    processTreeTerminated,
    exitCode: timedOut ? 124 : processTreeTerminated ? (closeResult.childExitCode ?? 1) : 125,
    ...(spawnError === undefined ? {} : { error: spawnError.message }),
    ...(!processTreeTerminated
      ? { error: "process tree did not terminate within the bounded cleanup deadline" }
      : {}),
  };
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
  const outcome = await runManagedProcessTree({
    name,
    timeoutMs,
    command: actualCommand,
    args: actualArgs,
    onStdout: (chunk) => {
      process.stdout.write(chunk);
      appendFileSync(logPath, chunk);
    },
    onStderr: (chunk) => {
      process.stderr.write(chunk);
      appendFileSync(logPath, chunk);
    },
  });
  if (outcome.timedOut) {
    appendFileSync(
      logPath,
      `[ci-test] timed out after ${timeoutMs}ms; terminated process tree with ${outcome.terminationSignal}\n`,
    );
    if (!outcome.processTreeTerminated) {
      appendFileSync(logPath, "[ci-test] process tree cleanup exceeded the bounded deadline\n");
    }
  }
  const metadata = {
    ...outcome,
    name,
    command: requestedCommand,
    args: requestedArgs,
    actualCommand,
    actualArgs,
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
