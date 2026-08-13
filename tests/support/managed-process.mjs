import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

function deferred() {
  let resolvePromise;
  const state = {
    settled: false,
    promise: new Promise((resolve) => {
      resolvePromise = resolve;
    }),
    resolve(value) {
      if (state.settled) return;
      state.settled = true;
      resolvePromise(value);
    },
  };
  return state;
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function endStream(stream) {
  if (stream.closed || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("close", resolve);
    stream.end();
  });
}

function fileExists(path) {
  return stat(path).then(
    (entry) => entry.isFile(),
    () => false,
  );
}

function processExitDiagnostic(exit, name, stderrPath) {
  return new Error(`PROCESS_EXIT_NON_ZERO:${name}:code=${exit.code}:stderr=${stderrPath}`);
}

function processSpawnDiagnostic(error, name) {
  return new Error(`PROCESS_SPAWN_ERROR:${name}:${error.code ?? "UNKNOWN"}:${error.message}`);
}

function assertProcessId(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error(`INVALID_MANAGED_PROCESS_PID:${String(processId)}`);
  }
}

function adapterTimeout(stage) {
  return new Error(`PROCESS_TREE_ADAPTER_TIMEOUT:${stage}`);
}

async function beforeDeadline(operation, deadline, stage) {
  const remaining = Math.max(0, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(adapterTimeout(stage)), remaining);
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

export async function runBoundedProcessHelper(
  command,
  args,
  deadline,
  { reapGraceMs = 100, spawnProcess = spawn } = {},
) {
  return new Promise((resolve, reject) => {
    const output = [];
    let helper;
    try {
      helper = spawnProcess(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    const remaining = Math.max(0, deadline - Date.now());
    let timedOut = false;
    let settled = false;
    let reapTimer;
    const timeoutError = new Error(`PROCESS_TREE_HELPER_TIMEOUT:${command}`);
    const onData = (chunk) => output.push(chunk);
    const observeEventualEvents = () => {
      helper.removeListener("error", onError);
      helper.removeListener("close", onClose);
      helper.stdout?.removeListener("data", onData);
      helper.on("error", () => undefined);
      helper.once("close", () => undefined);
    };
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(reapTimer);
      operation();
    };
    const forceDetach = () => {
      helper.stdin?.destroy();
      helper.stdout?.destroy();
      helper.stderr?.destroy();
      observeEventualEvents();
      finish(() => reject(timeoutError));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        helper.kill("SIGKILL");
      } catch {
        // The bounded reap grace below remains authoritative.
      }
      reapTimer = setTimeout(forceDetach, reapGraceMs);
    }, remaining);
    helper.stdout.on("data", onData);
    const onError = (error) => {
      if (timedOut) {
        observeEventualEvents();
        finish(() => reject(timeoutError));
        return;
      }
      finish(() => reject(error));
    };
    const onClose = (status) => {
      if (timedOut) {
        finish(() => reject(timeoutError));
      } else {
        finish(() => resolve({ status, stdout: Buffer.concat(output).toString("utf8") }));
      }
    };
    helper.once("error", onError);
    helper.once("close", onClose);
  });
}

async function readWindowsProcesses(deadline) {
  const script = [
    "Get-CimInstance Win32_Process |",
    "Select-Object ProcessId,ParentProcessId,CreationDate |",
    "ConvertTo-Json -Compress",
  ].join(" ");
  const result = await runBoundedProcessHelper(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    deadline,
  );
  if (result.status !== 0) throw new Error(`WINDOWS_PROCESS_SNAPSHOT_FAILED:${result.status}`);
  const parsed = JSON.parse(result.stdout || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).map((process_) => ({
    pid: Number(process_.ProcessId),
    parentPid: Number(process_.ParentProcessId),
    creationDate: String(process_.CreationDate),
  }));
}

async function terminateWindowsPid(processId, force, deadline, tree = false) {
  const result = await runBoundedProcessHelper(
    "taskkill",
    ["/pid", String(processId), ...(tree ? ["/T"] : []), ...(force ? ["/F"] : [])],
    deadline,
  );
  return result.status === 0;
}

function tokenKey(process_) {
  return `${process_.pid}:${process_.creationDate}`;
}

function validateWindowsProcess(process_) {
  assertProcessId(process_.pid);
  if (!Number.isSafeInteger(process_.parentPid) || process_.parentPid < 0) {
    throw new Error(`INVALID_MANAGED_PROCESS_PARENT_PID:${String(process_.parentPid)}`);
  }
  return process_;
}

function recursiveDescendants(processes, rootPids) {
  const result = new Map();
  const pending = [...rootPids];
  const visitedParents = new Set();
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (visitedParents.has(parentPid)) continue;
    visitedParents.add(parentPid);
    for (const process_ of processes) {
      if (process_.parentPid !== parentPid) continue;
      validateWindowsProcess(process_);
      result.set(tokenKey(process_), process_);
      pending.push(process_.pid);
    }
  }
  return result;
}

function refreshWindowsOwnership(ownership, processes) {
  const live = new Map(processes.map((process_) => [tokenKey(process_), process_]));
  const leader = live.get(tokenKey(ownership.leader));
  const reusedLeader = processes.some((process_) => process_.pid === ownership.processId);
  if (leader === undefined && reusedLeader) {
    throw new Error(`PROCESS_TREE_LEADER_IDENTITY_CHANGED:${ownership.processId}`);
  }
  const liveOwned = [...ownership.descendants]
    .filter(([key]) => live.has(key))
    .map(([, process_]) => process_.pid);
  const roots = leader === undefined ? liveOwned : [leader.pid, ...liveOwned];
  for (const [key, process_] of recursiveDescendants(processes, roots)) {
    ownership.descendants.set(key, process_);
  }
  return live;
}

export function createWindowsTreeStrategy({
  readProcesses = readWindowsProcesses,
  terminatePid = terminateWindowsPid,
} = {}) {
  return {
    async capture(processId, deadline) {
      const processes = await readProcesses(deadline);
      const leader = processes.find((process_) => process_.pid === processId);
      if (leader === undefined)
        throw new Error(`PROCESS_TREE_LEADER_IDENTITY_MISSING:${processId}`);
      return { processId, leader: validateWindowsProcess(leader), descendants: new Map() };
    },
    async snapshot(ownership, deadline) {
      refreshWindowsOwnership(ownership, await readProcesses(deadline));
    },
    async probe(ownership, deadline) {
      const live = refreshWindowsOwnership(ownership, await readProcesses(deadline));
      return (
        !live.has(tokenKey(ownership.leader)) &&
        [...ownership.descendants.keys()].every((key) => !live.has(key))
      );
    },
    async terminate(ownership, signal, deadline) {
      const live = refreshWindowsOwnership(ownership, await readProcesses(deadline));
      const leaderLive = live.has(tokenKey(ownership.leader));
      let successful = true;
      if (leaderLive) {
        successful = await terminatePid(ownership.processId, signal === "SIGKILL", deadline, true);
      }
      for (const [key, descendant] of ownership.descendants) {
        if (!live.has(key)) continue;
        successful =
          (await terminatePid(descendant.pid, signal === "SIGKILL", deadline, false)) && successful;
      }
      return successful;
    },
  };
}

async function readPosixProcesses(deadline) {
  const result = await runBoundedProcessHelper(
    "ps",
    ["-axo", "pid=,pgid=,state=,lstart="],
    deadline,
  );
  if (result.status !== 0) throw new Error(`POSIX_PROCESS_SNAPSHOT_FAILED:${result.status}`);
  return result.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      groupId: Number(match[2]),
      state: match[3],
      startToken: match[4],
    }))
    .filter((process_) => !process_.state.startsWith("Z"));
}

export function createPosixTreeStrategy({
  readProcesses = readPosixProcesses,
  signalGroup = (groupId, signal) => process.kill(-groupId, signal),
} = {}) {
  return {
    async capture(processId, deadline) {
      const leader = (await readProcesses(deadline)).find((process_) => process_.pid === processId);
      if (leader === undefined || leader.groupId !== processId) {
        throw new Error(`PROCESS_TREE_LEADER_IDENTITY_MISSING:${processId}`);
      }
      return { processId, leader, members: new Map() };
    },
    async snapshot(ownership, deadline) {
      const processes = await readProcesses(deadline);
      const leader = processes.find(
        (process_) =>
          process_.pid === ownership.leader.pid &&
          process_.startToken === ownership.leader.startToken &&
          process_.groupId === ownership.processId,
      );
      const reusedLeader = processes.some((process_) => process_.pid === ownership.processId);
      if (leader === undefined && reusedLeader) {
        throw new Error(`PROCESS_TREE_LEADER_IDENTITY_CHANGED:${ownership.processId}`);
      }
      if (leader === undefined && ownership.members.size > 1) return;
      if (leader === undefined) {
        ownership.members.clear();
        return;
      }
      ownership.members = new Map(
        processes
          .filter((process_) => process_.groupId === ownership.processId)
          .map((process_) => [`${process_.pid}:${process_.startToken}`, process_]),
      );
    },
    async probe(ownership, deadline) {
      const live = new Map(
        (await readProcesses(deadline)).map((process_) => [
          `${process_.pid}:${process_.startToken}`,
          process_,
        ]),
      );
      return [...ownership.members.keys()].every((key) => !live.has(key));
    },
    async terminate(ownership, signal, deadline) {
      const processes = await readProcesses(deadline);
      const leaderLive = processes.some(
        (process_) =>
          process_.pid === ownership.leader.pid &&
          process_.startToken === ownership.leader.startToken &&
          process_.groupId === ownership.processId,
      );
      const memberLive = processes.some((process_) =>
        ownership.members.has(`${process_.pid}:${process_.startToken}`),
      );
      if (!leaderLive && !memberLive) return false;
      try {
        signalGroup(ownership.processId, signal);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return true;
        if (error?.code === "EPERM") return false;
        throw error;
      }
    },
  };
}

function wrapLegacyWindowsStrategy(strategy) {
  return {
    async capture(processId) {
      return { processId };
    },
    async snapshot() {},
    async probe(ownership, deadline) {
      return strategy.probe(ownership.processId, deadline);
    },
    async terminate(ownership, signal, deadline) {
      return strategy.terminate(ownership.processId, signal, deadline);
    },
  };
}

function createCaptureFailureStrategy(platform) {
  if (platform === "win32") {
    return {
      async snapshot(ownership, deadline) {
        const processes = await readWindowsProcesses(deadline);
        if (ownership.leader === undefined) {
          const leader = processes.find((process_) => process_.pid === ownership.processId);
          if (leader === undefined) {
            throw new Error(`PROCESS_TREE_LEADER_IDENTITY_MISSING:${ownership.processId}`);
          }
          ownership.leader = validateWindowsProcess(leader);
          ownership.descendants = new Map();
        }
        refreshWindowsOwnership(ownership, processes);
      },
      async probe(ownership, deadline) {
        if (!ownership.treeTerminationSucceeded) return false;
        const live = new Map(
          (await readWindowsProcesses(deadline)).map((process_) => [tokenKey(process_), process_]),
        );
        return (
          !live.has(tokenKey(ownership.leader)) &&
          [...ownership.descendants.keys()].every((key) => !live.has(key))
        );
      },
      async terminate(ownership, signal, deadline) {
        const processes = await readWindowsProcesses(deadline);
        if (!processes.some((process_) => tokenKey(process_) === tokenKey(ownership.leader))) {
          return false;
        }
        ownership.treeTerminationSucceeded = await terminateWindowsPid(
          ownership.processId,
          signal === "SIGKILL",
          deadline,
          true,
        );
        return ownership.treeTerminationSucceeded;
      },
    };
  }
  return {
    async snapshot() {},
    async probe(ownership, deadline) {
      return !(await readPosixProcesses(deadline)).some(
        (process_) => process_.groupId === ownership.processId,
      );
    },
    async terminate(ownership, signal) {
      try {
        process.kill(-ownership.processId, signal);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return true;
        if (error?.code === "EPERM") return false;
        throw error;
      }
    },
  };
}

export async function spawnManagedProcess({
  artifacts,
  command,
  args,
  env = {},
  name,
  platform = process.platform,
  processTreeStrategy,
  windowsTreeStrategy,
}) {
  await artifacts.initialize(name);
  const strategy =
    processTreeStrategy ??
    (windowsTreeStrategy === undefined
      ? platform === "win32"
        ? createWindowsTreeStrategy()
        : createPosixTreeStrategy()
      : wrapLegacyWindowsStrategy(windowsTreeStrategy));
  const child = spawn(command, args, {
    detached: platform !== "win32",
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const managed = new ManagedProcess({
    artifacts,
    captureFailureStrategy: createCaptureFailureStrategy(platform),
    child,
    name,
    processTreeStrategy: strategy,
    spawnPending: child.pid === undefined,
  });
  if (child.pid === undefined) return managed;
  try {
    await managed.initializeOwnership({ timeoutMs: 2_000 });
  } catch (error) {
    await managed.cleanupAfterOwnershipFailure(error, { timeoutMs: 2_000 });
  }
  return managed;
}

export class ManagedProcess {
  #artifacts;
  #captureFailureStrategy;
  #child;
  #cleanupAbortController = new AbortController();
  #cleanupError;
  #events = [];
  #exit = deferred();
  #finalized = deferred();
  #finalizationStarted = false;
  #name;
  #ownershipInitialization;
  #processingErrors = [];
  #readyListeners = new Set();
  #spawnError;
  #spawnState = deferred();
  #stopActions = [];
  #streamErrors = [];
  #streams;
  #treeOwnership;

  constructor({
    artifacts,
    captureFailureStrategy,
    child,
    name,
    processTreeStrategy,
    spawnPending = false,
  }) {
    if (!spawnPending) assertProcessId(child.pid);
    this.#artifacts = artifacts;
    this.#captureFailureStrategy = captureFailureStrategy;
    this.#child = child;
    this.#name = name;
    this.#treeOwnership = spawnPending
      ? { closed: true, identity: undefined, strategy: undefined }
      : { closed: false, identity: undefined, strategy: processTreeStrategy };
    this.#streams = {
      stdout: createWriteStream(artifacts.stdout(name), { flags: "a" }),
      stderr: createWriteStream(artifacts.stderr(name), { flags: "a" }),
      events: createWriteStream(artifacts.events(name), { flags: "a" }),
      transcript: createWriteStream(artifacts.transcript(name), { flags: "a" }),
    };

    for (const [streamName, stream] of Object.entries(this.#streams)) {
      stream.on("error", (error) => this.#recordStreamError(streamName, error));
    }
    child.once("spawn", () => this.#spawnState.resolve({ kind: "spawned" }));
    child.on("error", (error) => {
      if (!this.#spawnState.settled) {
        this.#spawnError = error;
        this.#spawnState.resolve({ error, kind: "spawn-error" });
        return;
      }
      this.#recordStreamError("process", error);
    });
    child.stdin.on("error", (error) => this.#recordStreamError("stdin", error));
    child.stdout.on("error", (error) => this.#recordStreamError("stdout", error));
    child.stderr.on("error", (error) => this.#recordStreamError("stderr", error));

    this.#captureStream(child.stdout, "stdout");
    this.#captureStream(child.stderr, "stderr");
    child.once("exit", (code, signal) => this.#exit.resolve({ code, signal }));
    child.once("close", (code, signal) => void this.#finalize({ code, signal }));
  }

  get pid() {
    return this.#child.pid;
  }

  async initializeOwnership({ timeoutMs }) {
    if (this.#treeOwnership.closed) return;
    const deadline = Date.now() + timeoutMs;
    this.#ownershipInitialization ??= beforeDeadline(
      () => this.#treeOwnership.strategy.capture(this.pid, deadline),
      deadline,
      "capture",
    ).then((identity) => {
      this.#treeOwnership.identity = identity;
    });
    await this.#ownershipInitialization;
  }

  async cleanupAfterOwnershipFailure(primaryError, { timeoutMs }) {
    const errors = [primaryError];
    this.#treeOwnership = {
      closed: false,
      identity: {
        descendants: new Map(),
        processId: this.pid,
        treeTerminationSucceeded: false,
      },
      strategy: this.#captureFailureStrategy,
    };
    const deadline = Date.now() + timeoutMs;
    try {
      await this.#treeAdapterCall("snapshot", deadline);
      this.#stopActions.push("signal:SIGKILL:ownership-failure-tree");
      if (!(await this.#signalProcessTree("SIGKILL", deadline))) {
        throw new Error(`PROCESS_TREE_TERMINATION_UNPROVEN:${this.#name}:${this.pid}`);
      }
      if (!(await this.#waitForProcessTreeExit(deadline))) {
        throw new Error(`PROCESS_TREE_STILL_RUNNING:${this.#name}:${this.pid}`);
      }
      const remaining = Math.max(0, deadline - Date.now());
      if (!this.#exit.settled && !(await settleWithin(this.#exit.promise, remaining)))
        throw new Error(`PROCESS_STOP_TIMEOUT:${this.#name}:${this.pid}`);
      await this.#waitForFinalization(Math.max(1, deadline - Date.now()));
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(
      errors,
      `Managed process ownership initialization failed:${this.#name}`,
    );
  }

  async ready(predicate, { timeoutMs }) {
    for (const event of this.#events) {
      try {
        if (predicate(event)) {
          await this.#treeAdapterCall("snapshot", Date.now() + timeoutMs);
          return event;
        }
      } catch (error) {
        this.#recordProcessingError(error);
        throw error;
      }
    }

    const event = await new Promise((resolve, reject) => {
      const listener = (event) => {
        try {
          if (!predicate(event)) return;
          clearTimeout(timer);
          this.#readyListeners.delete(listener);
          resolve(event);
        } catch (error) {
          clearTimeout(timer);
          this.#readyListeners.delete(listener);
          this.#recordProcessingError(error);
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        this.#readyListeners.delete(listener);
        reject(
          new Error(
            `PROCESS_READY_TIMEOUT:${this.#name}:${timeoutMs}ms:stdout=${this.#artifacts.stdout(this.#name)}`,
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.#readyListeners.add(listener);
    });
    await this.#treeAdapterCall("snapshot", Date.now() + timeoutMs);
    return event;
  }

  async stop({ timeoutMs }) {
    if (!(await settleWithin(this.#spawnState.promise, timeoutMs))) {
      throw new Error(`PROCESS_SPAWN_STATE_TIMEOUT:${this.#name}:${timeoutMs}ms`);
    }
    if (this.#spawnError !== undefined) {
      await this.#waitForFinalization(timeoutMs);
      return;
    }
    if (this.#treeOwnership.closed) {
      await this.#waitForFinalization(timeoutMs);
      return;
    }

    await this.#treeAdapterCall("snapshot", Date.now() + timeoutMs);
    this.#stopActions.push("stdin:end");
    this.#child.stdin.end();
    if (!(await this.#waitForProcessTreeExit(Date.now() + timeoutMs))) {
      this.#stopActions.push("signal:SIGTERM");
      const terminateDeadline = Date.now() + timeoutMs;
      await this.#signalProcessTree("SIGTERM", terminateDeadline);
      if (await this.#waitForProcessTreeExit(terminateDeadline)) {
        await this.#waitForFinalization(timeoutMs);
        return;
      }
    }
    if (!this.#treeOwnership.closed) {
      this.#stopActions.push("signal:SIGKILL");
      const killDeadline = Date.now() + timeoutMs;
      await this.#signalProcessTree("SIGKILL", killDeadline);
      if (!(await this.#waitForProcessTreeExit(killDeadline))) {
        throw new Error(`PROCESS_STOP_TIMEOUT:${this.#name}:${this.pid}`);
      }
    }
    await this.#waitForFinalization(timeoutMs);
  }

  async assertClean(options = {}) {
    const timeoutMs = options.timeoutMs ?? 2_000;
    if (!(await settleWithin(this.#spawnState.promise, timeoutMs))) {
      throw new Error(`PROCESS_SPAWN_STATE_TIMEOUT:${this.#name}:${timeoutMs}ms`);
    }
    if (this.#spawnError !== undefined) {
      await this.#waitForFinalization(timeoutMs);
      throw processSpawnDiagnostic(this.#spawnError, this.#name);
    }
    if (
      !this.#exit.settled &&
      (options.timeoutMs === undefined || !(await settleWithin(this.#exit.promise, timeoutMs)))
    ) {
      throw new Error(`PROCESS_STILL_RUNNING:${this.#name}:${this.pid}`);
    }
    const exit = await this.#exit.promise;
    if (!(await this.#processTreeTerminated(Date.now() + timeoutMs))) {
      throw new Error(`PROCESS_TREE_STILL_RUNNING:${this.#name}:${this.pid}`);
    }
    if (this.#cleanupError !== undefined) throw this.#cleanupError;
    await this.#waitForFinalization(timeoutMs);
    if (exit.code !== 0 && exit.signal === null) {
      throw processExitDiagnostic(exit, this.#name, this.#artifacts.stderr(this.#name));
    }
    if (this.#streamErrors.length > 0) {
      const first = this.#streamErrors[0];
      throw new Error(`PROCESS_STREAM_ERROR:${first.stream}:${first.error.message}`);
    }
    if (this.#processingErrors.length > 0) {
      throw new Error(`PROCESS_EVENT_PROCESSING_ERROR:${this.#processingErrors[0].message}`);
    }
  }

  async artifactsExist() {
    return (
      await Promise.all(
        [
          this.#artifacts.stdout(this.#name),
          this.#artifacts.stderr(this.#name),
          this.#artifacts.events(this.#name),
          this.#artifacts.transcript(this.#name),
          this.#artifacts.cleanup(this.#name),
        ].map(fileExists),
      )
    ).every(Boolean);
  }

  #captureStream(input, streamName) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    input.on("data", (chunk) => {
      this.#writeArtifact(streamName, chunk);
      pending += decoder.write(chunk);
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) this.#recordLine(streamName, line);
    });
    input.once("end", () => {
      pending += decoder.end();
      if (pending.length > 0) this.#recordLine(streamName, pending);
    });
  }

  async #finalize(exit) {
    if (this.#finalizationStarted) return;
    this.#finalizationStarted = true;
    try {
      await Promise.all(Object.values(this.#streams).map(endStream));
      await writeFile(
        this.#artifacts.cleanup(this.#name),
        `${JSON.stringify({
          pid: this.pid,
          exit,
          actions: this.#stopActions,
          streamErrors: this.#streamErrors.map(({ stream, error }) => ({
            stream,
            message: error.message,
          })),
          processingErrors: this.#processingErrors.map((error) => error.message),
        })}\n`,
        { signal: this.#cleanupAbortController.signal },
      );
    } catch (error) {
      this.#recordStreamError("cleanup", error);
    } finally {
      this.#finalized.resolve();
    }
  }

  #recordLine(streamName, line) {
    this.#writeArtifact(
      "transcript",
      `${JSON.stringify({ timestamp: new Date().toISOString(), stream: streamName, line })}\n`,
    );
    if (streamName !== "stdout") return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON stdout remains available in stdout.log and transcript.ndjson.
      return;
    }
    this.#events.push(event);
    this.#writeArtifact("events", `${JSON.stringify(event)}\n`);
    for (const listener of this.#readyListeners) {
      try {
        listener(event);
      } catch (error) {
        this.#recordProcessingError(error);
      }
    }
  }

  #recordStreamError(stream, error) {
    this.#streamErrors.push({ stream, error });
  }

  #recordProcessingError(error) {
    this.#processingErrors.push(error instanceof Error ? error : new Error(String(error)));
  }

  #writeArtifact(stream, value) {
    try {
      this.#streams[stream].write(value);
    } catch (error) {
      this.#recordProcessingError(
        new Error(`${stream}:${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }

  #forceCloseResources() {
    this.#cleanupAbortController.abort();
    this.#child.stdin.destroy();
    this.#child.stdout.destroy();
    this.#child.stderr.destroy();
    for (const stream of Object.values(this.#streams)) stream.destroy();
  }

  async #treeAdapterCall(method, deadline, ...args) {
    const ownership = this.#treeOwnership;
    return beforeDeadline(
      () => ownership.strategy[method](ownership.identity, ...args, deadline),
      deadline,
      method,
    );
  }

  async #processTreeTerminated(deadline) {
    const ownership = this.#treeOwnership;
    if (ownership.closed) return true;
    const terminated = await this.#treeAdapterCall("probe", deadline);
    if (terminated) ownership.closed = true;
    return terminated;
  }

  async #signalProcessTree(signal, deadline) {
    const ownership = this.#treeOwnership;
    if (ownership.closed) return false;
    return this.#treeAdapterCall("terminate", deadline, signal);
  }

  async #waitForProcessTreeExit(deadline) {
    while (deadline - Date.now() > 100) {
      try {
        if (await this.#processTreeTerminated(deadline)) return true;
      } catch (error) {
        if (error?.message?.startsWith("PROCESS_TREE_ADAPTER_TIMEOUT:") === true) return false;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  async #waitForFinalization(timeoutMs) {
    if (await settleWithin(this.#finalized.promise, timeoutMs)) return;
    this.#cleanupError = new Error(
      `PROCESS_CLEANUP_TIMEOUT:${this.#name}:${this.pid}:${timeoutMs}ms`,
    );
    this.#forceCloseResources();
    await settleWithin(this.#finalized.promise, timeoutMs);
    throw this.#cleanupError;
  }
}
