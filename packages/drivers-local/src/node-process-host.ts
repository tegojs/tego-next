import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  DiagnosticError,
  runtimeDiagnostic,
  type Clock,
  type DriverHealth,
  type HostedProcess,
  type HostedProcessExit,
  type HostedProcessSignal,
  type ProcessHost,
  type ProcessSpawnRequest,
} from "@tegojs/contracts";

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 128;
const MAX_ENVIRONMENT_BYTES = 64 * 1024;
const SENSITIVE_ENVIRONMENT_NAME = /(?:credential|key|password|secret|token)/iu;

const systemClock: Clock = {
  now: () => new Date(),
  sleep: async (delayMs, signal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  },
};

function processHostError(code: string, message: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: `EXECUTOR_${code}`,
      message,
      source: { kind: "executor", id: "node-process-host" },
    }),
  );
}

function validateSpawnRequest(request: ProcessSpawnRequest): void {
  if (!isAbsolute(request.entrypoint) || request.entrypoint.includes("\0")) {
    throw processHostError("PROCESS_ENTRYPOINT_INVALID", "Process entrypoint must be absolute");
  }
  const arguments_ = request.arguments ?? [];
  if (
    arguments_.length > MAX_ARGUMENTS ||
    arguments_.some((value) => typeof value !== "string" || value.includes("\0")) ||
    Buffer.byteLength(JSON.stringify(arguments_), "utf8") > MAX_ARGUMENT_BYTES
  ) {
    throw processHostError("PROCESS_ARGUMENTS_INVALID", "Process arguments exceed safe bounds");
  }
  const environment = request.environment ?? {};
  const entries = Object.entries(environment);
  if (
    entries.length > MAX_ENVIRONMENT_ENTRIES ||
    entries.some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
        SENSITIVE_ENVIRONMENT_NAME.test(key) ||
        typeof value !== "string" ||
        value.includes("\0"),
    ) ||
    Buffer.byteLength(JSON.stringify(environment), "utf8") > MAX_ENVIRONMENT_BYTES
  ) {
    throw processHostError(
      "PROCESS_ENVIRONMENT_INVALID",
      "Process environment is invalid, secret-like, or exceeds safe bounds",
    );
  }
}

class NodeHostedProcess implements HostedProcess {
  readonly pid: number | undefined;
  readonly stdin: HostedProcess["stdin"];
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exit: Promise<HostedProcessExit>;
  #inputClosed = false;
  #closePromise: Promise<void> | undefined;

  constructor(child: ChildProcessWithoutNullStreams, onExit: (process: NodeHostedProcess) => void) {
    this.#child = child;
    this.pid = child.pid;
    this.stdout = child.stdout as AsyncIterable<Uint8Array>;
    this.stderr = child.stderr as AsyncIterable<Uint8Array>;
    this.#exit = new Promise<HostedProcessExit>((resolve) => {
      let settled = false;
      const finish = (exit: HostedProcessExit) => {
        if (settled) return;
        settled = true;
        onExit(this);
        resolve(exit);
      };
      child.once("exit", (code, signal) =>
        finish({
          ...(code === null ? {} : { code }),
          ...(signal === null ? {} : { signal }),
        }),
      );
      child.once("error", () => finish({}));
    });
    this.stdin = Object.freeze({
      write: async (bytes: Uint8Array): Promise<void> => {
        if (this.#inputClosed || child.stdin.destroyed) {
          throw processHostError("PROCESS_STDIN_CLOSED", "Hosted process input is closed");
        }
        const copy = Buffer.from(bytes);
        await new Promise<void>((resolve, reject) => {
          child.stdin.write(copy, (error) => {
            if (error !== null && error !== undefined) reject(error);
            else resolve();
          });
        });
      },
      close: async (): Promise<void> => {
        if (this.#inputClosed) return;
        this.#inputClosed = true;
        if (child.stdin.destroyed || child.stdin.writableEnded) return;
        await new Promise<void>((resolve) => child.stdin.end(resolve));
      },
    });
  }

  async signal(signal: HostedProcessSignal): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    if (!this.#child.kill(signal)) {
      throw processHostError("PROCESS_SIGNAL_FAILED", `Failed to deliver ${signal}`);
    }
  }

  async kill(): Promise<HostedProcessExit> {
    if (
      this.#child.exitCode === null &&
      this.#child.signalCode === null &&
      !this.#child.kill("SIGKILL")
    ) {
      throw processHostError("PROCESS_KILL_FAILED", "Failed to deliver SIGKILL");
    }
    return this.#exit;
  }

  wait(): Promise<HostedProcessExit> {
    return this.#exit;
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      await this.stdin.close().catch(() => undefined);
      await this.wait();
    })();
    return this.#closePromise;
  }
}

export interface NodeProcessHostOptions {
  readonly clock?: Clock;
}

export class NodeProcessHost implements ProcessHost {
  readonly #clock: Clock;
  readonly #processes = new Set<NodeHostedProcess>();
  #state: "closed" | "closing" | "new" | "open" | "opening" = "new";
  #openPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: NodeProcessHostOptions = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  get activeProcessCount(): number {
    return this.#processes.size;
  }

  open(): Promise<void> {
    if (this.#state === "open") return Promise.resolve();
    if (this.#state === "closed" || this.#state === "closing") {
      return Promise.reject(processHostError("PROCESS_HOST_CLOSED", "Process host is closed"));
    }
    this.#openPromise ??= Promise.resolve().then(() => {
      if (this.#state === "opening") this.#state = "open";
    });
    this.#state = "opening";
    return this.#openPromise;
  }

  async health(): Promise<DriverHealth> {
    return {
      status: this.#state === "open" ? "healthy" : "unhealthy",
      checkedAt: this.#clock.now().toISOString(),
      message:
        this.#state === "open"
          ? `${this.#processes.size} active hosted processes`
          : "Process host is not open",
    };
  }

  async spawn(request: ProcessSpawnRequest): Promise<HostedProcess> {
    if (this.#state !== "open") {
      throw processHostError("PROCESS_HOST_NOT_OPEN", "Process host must be opened before spawn");
    }
    validateSpawnRequest(request);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.execPath, [request.entrypoint, ...(request.arguments ?? [])], {
        env: { ...(request.environment ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "EXECUTOR_PROCESS_SPAWN_FAILED",
          message: "Failed to spawn hosted process",
          source: { kind: "executor", id: "node-process-host" },
          cause: {
            name: error instanceof Error ? error.name : "UnknownCause",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
    const hosted = new NodeHostedProcess(child, (process_) => this.#processes.delete(process_));
    this.#processes.add(hosted);
    return hosted;
  }

  close(): Promise<void> {
    if (this.#state === "closed") return Promise.resolve();
    this.#closePromise ??= (async () => {
      this.#state = "closing";
      const processes = [...this.#processes];
      await Promise.all(processes.map((process_) => process_.kill()));
      this.#processes.clear();
      this.#state = "closed";
    })();
    return this.#closePromise;
  }
}
