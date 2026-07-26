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

export async function spawnManagedProcess({ artifacts, command, args, env = {}, name }) {
  await artifacts.initialize(name);
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new ManagedProcess({ artifacts, child, name });
}

export class ManagedProcess {
  #artifacts;
  #child;
  #cleanupAbortController = new AbortController();
  #cleanupError;
  #events = [];
  #exit = deferred();
  #finalized = deferred();
  #finalizationStarted = false;
  #name;
  #processingErrors = [];
  #readyListeners = new Set();
  #spawnError;
  #spawnState = deferred();
  #stopActions = [];
  #streamErrors = [];
  #streams;

  constructor({ artifacts, child, name }) {
    this.#artifacts = artifacts;
    this.#child = child;
    this.#name = name;
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

  async ready(predicate, { timeoutMs }) {
    for (const event of this.#events) {
      try {
        if (predicate(event)) return event;
      } catch (error) {
        this.#recordProcessingError(error);
        throw error;
      }
    }

    return new Promise((resolve, reject) => {
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
  }

  async stop({ timeoutMs }) {
    if (!(await settleWithin(this.#spawnState.promise, timeoutMs))) {
      throw new Error(`PROCESS_SPAWN_STATE_TIMEOUT:${this.#name}:${timeoutMs}ms`);
    }
    if (this.#spawnError !== undefined) {
      await this.#waitForFinalization(timeoutMs);
      return;
    }
    if (this.#exit.settled) {
      await this.#waitForFinalization(timeoutMs);
      return;
    }

    this.#stopActions.push("stdin:end");
    this.#child.stdin.end();
    if (!(await settleWithin(this.#exit.promise, timeoutMs))) {
      this.#stopActions.push("signal:SIGTERM");
      this.#child.kill("SIGTERM");
    }
    if (!(await settleWithin(this.#exit.promise, timeoutMs))) {
      this.#stopActions.push("signal:SIGKILL");
      this.#child.kill("SIGKILL");
      if (!(await settleWithin(this.#exit.promise, timeoutMs))) {
        throw new Error(`PROCESS_STOP_TIMEOUT:${this.#name}:${this.pid}`);
      }
    }
    await this.#waitForFinalization(timeoutMs);
  }

  async assertClean({ timeoutMs = 2_000 } = {}) {
    if (!(await settleWithin(this.#spawnState.promise, timeoutMs))) {
      throw new Error(`PROCESS_SPAWN_STATE_TIMEOUT:${this.#name}:${timeoutMs}ms`);
    }
    if (this.#spawnError !== undefined) {
      await this.#waitForFinalization(timeoutMs);
      throw processSpawnDiagnostic(this.#spawnError, this.#name);
    }
    if (!this.#exit.settled) {
      throw new Error(`PROCESS_STILL_RUNNING:${this.#name}:${this.pid}`);
    }
    const exit = await this.#exit.promise;
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
