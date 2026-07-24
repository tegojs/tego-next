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
    timer.unref();
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function endStream(stream) {
  if (stream.closed) return Promise.resolve();
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
  #events = [];
  #exit = deferred();
  #finalized = deferred();
  #name;
  #readyListeners = new Set();
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
    child.on("error", (error) => this.#recordStreamError("process", error));
    child.stdin.on("error", (error) => this.#recordStreamError("stdin", error));
    child.stdout.on("error", (error) => this.#recordStreamError("stdout", error));
    child.stderr.on("error", (error) => this.#recordStreamError("stderr", error));

    this.#captureStream(child.stdout, "stdout");
    this.#captureStream(child.stderr, "stderr");
    child.once("close", (code, signal) => {
      const exit = { code, signal };
      this.#exit.resolve(exit);
      void this.#finalize(exit);
    });
  }

  get pid() {
    return this.#child.pid;
  }

  async ready(predicate, { timeoutMs }) {
    for (const event of this.#events) {
      if (predicate(event)) return event;
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
    if (this.#exit.settled) {
      await this.#finalized.promise;
      return;
    }

    this.#stopActions.push("stdin:end");
    this.#child.stdin.end();
    this.#stopActions.push("signal:SIGTERM");
    this.#child.kill("SIGTERM");
    if (!(await settleWithin(this.#exit.promise, timeoutMs))) {
      this.#stopActions.push("signal:SIGKILL");
      this.#child.kill("SIGKILL");
      if (!(await settleWithin(this.#exit.promise, timeoutMs))) {
        throw new Error(`PROCESS_STOP_TIMEOUT:${this.#name}:${this.pid}`);
      }
    }
    await this.#finalized.promise;
  }

  async assertClean() {
    const exit = await this.#exit.promise;
    await this.#finalized.promise;
    if (exit.code !== 0 && exit.signal === null) {
      throw processExitDiagnostic(exit, this.#name, this.#artifacts.stderr(this.#name));
    }
    if (this.#streamErrors.length > 0) {
      const first = this.#streamErrors[0];
      throw new Error(`PROCESS_STREAM_ERROR:${first.stream}:${first.error.message}`);
    }
    if (this.pid !== undefined && isProcessAlive(this.pid)) {
      throw new Error(`PROCESS_LEAK:${this.pid}`);
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
      this.#streams[streamName].write(chunk);
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
        })}\n`,
      );
    } catch (error) {
      this.#recordStreamError("cleanup", error);
    } finally {
      this.#finalized.resolve();
    }
  }

  #recordLine(streamName, line) {
    this.#streams.transcript.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), stream: streamName, line })}\n`,
    );
    if (streamName !== "stdout") return;
    try {
      const event = JSON.parse(line);
      this.#events.push(event);
      this.#streams.events.write(`${JSON.stringify(event)}\n`);
      for (const listener of this.#readyListeners) listener(event);
    } catch {
      // Non-JSON stdout remains available in stdout.log and transcript.ndjson.
    }
  }

  #recordStreamError(stream, error) {
    this.#streamErrors.push({ stream, error });
  }
}
