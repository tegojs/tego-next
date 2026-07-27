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
  let readyPattern;
  let startupTimeoutMs = defaultTimeoutMs;
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (option === "--name") name = value;
    else if (option === "--artifacts") artifacts = value;
    else if (option === "--timeout-ms") timeoutMs = Number(value);
    else if (option === "--ready-pattern") readyPattern = value;
    else if (option === "--startup-timeout-ms") startupTimeoutMs = Number(value);
    else throw new Error(`Unknown reporter option: ${option ?? ""}`);
  }
  if (
    !name ||
    !artifacts ||
    command.length === 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(startupTimeoutMs) ||
    startupTimeoutMs <= 0 ||
    (readyPattern !== undefined && readyPattern.length === 0)
  ) {
    throw new Error(
      "Usage: run-ci-test.mjs --name <name> --artifacts <directory> [--timeout-ms <milliseconds>] -- <command> [args...]",
    );
  }
  return {
    name,
    artifacts,
    timeoutMs,
    command: command[0],
    args: command.slice(1),
    ...(readyPattern === undefined ? {} : { readyPattern, startupTimeoutMs }),
  };
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

function createWindowsTreeStrategy() {
  const provenTerminated = new Set();
  return {
    // taskkill only has a numeric PID. Once the leader has closed that PID may
    // be reused, so the default strategy must never target it after close.
    canTerminateAfterLeaderExit: false,
    async probe(processId) {
      return provenTerminated.has(processId);
    },
    async terminate(processId, signal) {
      const terminated = await taskkill(processId, signal === "SIGKILL");
      if (terminated) provenTerminated.add(processId);
      return terminated;
    },
  };
}

async function signalProcessTree(child, signal, platform, windowsTreeStrategy) {
  if (child.pid === undefined) return false;
  if (platform === "win32") {
    return windowsTreeStrategy.terminate(child.pid, signal);
  }
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    throw error;
  }
}

async function isProcessTreeTerminated(processId, platform, windowsTreeStrategy) {
  return platform === "win32"
    ? windowsTreeStrategy.probe(processId)
    : !posixProcessTreeExists(processId);
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
  readyPattern,
  startupTimeoutMs = defaultTimeoutMs,
  platform = process.platform,
  windowsTreeStrategy = createWindowsTreeStrategy(),
}) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let timedOut = false;
  let startupTimedOut = false;
  let terminationSignal = null;
  let processTreeTerminated = false;
  let cleanupError;
  let spawnError;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["inherit", "pipe", "pipe"],
    detached: platform !== "win32",
    windowsHide: true,
  });
  let readinessBuffer = "";
  const ready = Promise.withResolvers();
  if (readyPattern === undefined) ready.resolve();
  child.stdout.on("data", (chunk) => {
    onStdout(chunk);
    if (readyPattern === undefined) return;
    readinessBuffer = `${readinessBuffer}${String(chunk)}`.slice(
      -Math.max(4_096, readyPattern.length),
    );
    if (readinessBuffer.includes(readyPattern)) ready.resolve();
  });
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

  let initial;
  if (readyPattern === undefined) {
    initial = await settleWithin(closed, timeoutMs);
  } else {
    const startup = await settleWithin(
      Promise.race([
        ready.promise.then(() => ({ kind: "ready" })),
        closed.then((value) => ({ kind: "closed", value })),
      ]),
      startupTimeoutMs,
    );
    if (!startup.settled) {
      startupTimedOut = true;
      initial = { settled: false };
    } else if (startup.value.kind === "closed") {
      initial = { settled: true, value: startup.value.value };
    } else {
      initial = await settleWithin(closed, timeoutMs);
    }
  }
  let closeResult;
  if (initial.settled) {
    closeResult = initial.value;
    const closedWindowsLeaderWithoutStableTreeOwnership =
      platform === "win32" &&
      child.pid !== undefined &&
      windowsTreeStrategy.canTerminateAfterLeaderExit !== true;
    if (closedWindowsLeaderWithoutStableTreeOwnership) {
      cleanupError =
        "stable Windows process-tree ownership is unavailable; refusing to target a closed PID";
    } else {
      processTreeTerminated =
        child.pid === undefined ||
        (await isProcessTreeTerminated(child.pid, platform, windowsTreeStrategy));
    }
    if (
      !processTreeTerminated &&
      child.pid !== undefined &&
      !closedWindowsLeaderWithoutStableTreeOwnership
    ) {
      terminationSignal = "SIGTERM";
      const terminated = await signalProcessTree(child, "SIGTERM", platform, windowsTreeStrategy);
      const gracefulTreeExit =
        platform === "win32"
          ? await isProcessTreeTerminated(child.pid, platform, windowsTreeStrategy)
          : await waitForPosixProcessTreeExit(child.pid, gracefulTerminationMs);
      processTreeTerminated = terminated && gracefulTreeExit;
      if (!processTreeTerminated) {
        terminationSignal = "SIGKILL";
        const forced = await signalProcessTree(child, "SIGKILL", platform, windowsTreeStrategy);
        const forcedTreeExit =
          platform === "win32"
            ? await isProcessTreeTerminated(child.pid, platform, windowsTreeStrategy)
            : await waitForPosixProcessTreeExit(child.pid, forcedTerminationWaitMs);
        processTreeTerminated = forced && forcedTreeExit;
      }
    }
  } else {
    timedOut = true;
    terminationSignal = "SIGTERM";
    let treeSignalSucceeded = await signalProcessTree(
      child,
      "SIGTERM",
      platform,
      windowsTreeStrategy,
    );
    const graceful =
      platform === "win32"
        ? await settleWithin(closed, gracefulTerminationMs)
        : {
            settled: await waitForPosixProcessTreeExit(child.pid, gracefulTerminationMs),
          };
    if (!graceful.settled || !treeSignalSucceeded) {
      terminationSignal = "SIGKILL";
      treeSignalSucceeded =
        (await signalProcessTree(child, "SIGKILL", platform, windowsTreeStrategy)) ||
        treeSignalSucceeded;
    }
    if (platform === "win32") {
      const forced = graceful.settled
        ? graceful
        : await settleWithin(closed, forcedTerminationWaitMs);
      closeResult = forced.settled ? forced.value : { childExitCode: null, childSignal: null };
      processTreeTerminated =
        forced.settled &&
        treeSignalSucceeded &&
        (await isProcessTreeTerminated(child.pid, platform, windowsTreeStrategy));
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
    startupTimedOut,
    timeoutMs,
    terminationSignal,
    childPid: child.pid ?? null,
    childExitCode: closeResult.childExitCode,
    childSignal: closeResult.childSignal,
    processTreeTerminated,
    exitCode: timedOut ? 124 : processTreeTerminated ? (closeResult.childExitCode ?? 1) : 125,
    ...(spawnError === undefined ? {} : { error: spawnError.message }),
    ...(!processTreeTerminated
      ? {
          error:
            cleanupError ?? "process tree did not terminate within the bounded cleanup deadline",
        }
      : {}),
  };
}

export async function runReportedCommand({
  name,
  artifacts,
  timeoutMs = defaultTimeoutMs,
  command,
  args,
  readyPattern,
  startupTimeoutMs,
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
    ...(readyPattern === undefined ? {} : { readyPattern, startupTimeoutMs }),
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
