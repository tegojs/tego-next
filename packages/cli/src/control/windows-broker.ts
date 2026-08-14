import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { accessSync, constants as fsConstants } from "node:fs";
import { Duplex, type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { DiagnosticError } from "@tego/contracts";
import { protocolDiagnostic } from "./protocol.js";
import type { ControlConnection } from "./server.js";
import {
  encodeWindowsBrokerFrame,
  WINDOWS_BROKER_MAX_CONNECTION_BYTES,
  WINDOWS_BROKER_PROTOCOL_VERSION,
  WindowsBrokerConnectionState,
  type WindowsBrokerFrame,
  WindowsBrokerFrameDecoder,
} from "./windows-broker-protocol.js";
import { decodeWindowsBrokerReadyDescriptor } from "./windows-broker-security.js";

const WINDOWS_BROKER_SCRIPT = fileURLToPath(new URL("windows-control-broker.ps1", import.meta.url));
const WINDOWS_BROKER_CSHARP = fileURLToPath(new URL("windows-control-broker.cs", import.meta.url));
const WINDOWS_BROKER_STARTUP_TIMEOUT_MS = 10_000;
const WINDOWS_BROKER_SHUTDOWN_TIMEOUT_MS = 2_000;
const WINDOWS_BROKER_STDERR_LIMIT = 64 * 1024;
const WINDOWS_BROKER_MAX_CONNECTIONS = 64;

const FAILURE_STAGES = new Set([
  "TEGO_WINDOWS_CONTROL_BROKER_ARCH_UNSUPPORTED",
  "TEGO_WINDOWS_CONTROL_BROKER_ARGUMENTS_INVALID",
  "TEGO_WINDOWS_CONTROL_BROKER_COMPILE_FAILED",
  "TEGO_WINDOWS_CONTROL_BROKER_CONNECT_FAILED",
  "TEGO_WINDOWS_CONTROL_BROKER_DESCRIPTOR_FAILED",
  "TEGO_WINDOWS_CONTROL_BROKER_IO_FAILED",
  "TEGO_WINDOWS_CONTROL_BROKER_PARENT_OPEN_FAILED",
  "TEGO_WINDOWS_CONTROL_BROKER_PIPE_CREATE_FAILED",
  "TEGO_WINDOWS_CONTROL_BROKER_PIPE_VERIFY_FAILED",
  "TEGO_WINDOWS_CONTROL_BROKER_PROTOCOL_FAILED",
  "TEGO_WINDOWS_CONTROL_BROKER_RESOURCE_FAILED",
  "TEGO_WINDOWS_CONTROL_BROKER_SELF_TEST_FAILED",
  "TEGO_WINDOWS_CONTROL_BROKER_START_FAILED",
]);

export type WindowsBrokerFailureStage =
  | "TEGO_WINDOWS_CONTROL_BROKER_ARCH_UNSUPPORTED"
  | "TEGO_WINDOWS_CONTROL_BROKER_ARGUMENTS_INVALID"
  | "TEGO_WINDOWS_CONTROL_BROKER_COMPILE_FAILED"
  | "TEGO_WINDOWS_CONTROL_BROKER_CONNECT_FAILED"
  | "TEGO_WINDOWS_CONTROL_BROKER_DESCRIPTOR_FAILED"
  | "TEGO_WINDOWS_CONTROL_BROKER_IO_FAILED"
  | "TEGO_WINDOWS_CONTROL_BROKER_PARENT_OPEN_FAILED"
  | "TEGO_WINDOWS_CONTROL_BROKER_PIPE_CREATE_FAILED"
  | "TEGO_WINDOWS_CONTROL_BROKER_PIPE_VERIFY_FAILED"
  | "TEGO_WINDOWS_CONTROL_BROKER_PROTOCOL_FAILED"
  | "TEGO_WINDOWS_CONTROL_BROKER_RESOURCE_FAILED"
  | "TEGO_WINDOWS_CONTROL_BROKER_SELF_TEST_FAILED"
  | "TEGO_WINDOWS_CONTROL_BROKER_START_FAILED";

export interface WindowsBrokerChildProcess extends EventEmitter {
  readonly exitCode: number | null;
  readonly killed: boolean;
  readonly pid: number | undefined;
  readonly signalCode: NodeJS.Signals | null;
  readonly stderr: Readable;
  readonly stdin: Writable;
  readonly stdout: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface WindowsBrokerSpawnOptions {
  readonly shell: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly windowsHide: true;
}

export type WindowsBrokerSpawner = (
  command: string,
  args: readonly string[],
  options: WindowsBrokerSpawnOptions,
) => WindowsBrokerChildProcess;

export interface WindowsControlBroker {
  readonly endpoint: string;
  start(signal?: AbortSignal): Promise<void>;
  onConnection(listener: (connection: ControlConnection) => void): void;
  onError(listener: (error: Error) => void): void;
  close(): Promise<void>;
}

export interface WindowsControlBrokerOptions {
  readonly endpoint: string;
  readonly maxConnections: number;
  readonly maxQueuedBytes: number;
  readonly onFailureStage?: (stage: WindowsBrokerFailureStage) => void;
  readonly shutdownTimeoutMs?: number;
  readonly spawnBroker?: WindowsBrokerSpawner;
  readonly startupTimeoutMs?: number;
}

function endpointUnsafe(): DiagnosticError {
  return new DiagnosticError(
    protocolDiagnostic("PROTOCOL_CONTROL_ENDPOINT_UNSAFE", "PROTOCOL_CONTROL_ENDPOINT_UNSAFE"),
  );
}

function abortError(): DOMException {
  return new DOMException("Windows control broker startup aborted", "AbortError");
}

function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw endpointUnsafe();
  return result;
}

function aggregate(primary: unknown, cleanup: readonly unknown[], message: string): unknown {
  return cleanup.length === 0 ? primary : new AggregateError([primary, ...cleanup], message);
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(endpointUnsafe()), milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class BrokerConnection extends Duplex implements ControlConnection {
  readonly #broker: WindowsControlBrokerAdapter;
  readonly #connectionId: bigint;
  #consumerPaused = false;
  #pressurePaused = false;
  #protocolPaused = false;
  #remoteClosed = false;
  #trackedInboundBytes = 0;

  constructor(broker: WindowsControlBrokerAdapter, connectionId: bigint, highWaterMark: number) {
    super({
      allowHalfOpen: true,
      readableHighWaterMark: highWaterMark,
      writableHighWaterMark: highWaterMark,
    });
    this.#broker = broker;
    this.#connectionId = connectionId;
  }

  receive(payload: Uint8Array): void {
    if (this.destroyed) throw endpointUnsafe();
    this.#trackedInboundBytes += payload.byteLength;
    const canContinue = this.push(Buffer.from(payload));
    this.#reconcileInbound();
    if (!canContinue) {
      this.#pressurePaused = true;
      this.#updatePause();
    }
  }

  receiveEof(): void {
    if (!this.destroyed) this.push(null);
  }

  receiveClose(error?: Error): void {
    this.#remoteClosed = true;
    this.destroy(error);
  }

  override pause(): this {
    this.#consumerPaused = true;
    const result = super.pause();
    this.#updatePause();
    return result;
  }

  override resume(): this {
    this.#consumerPaused = false;
    const result = super.resume();
    this.#pressurePaused = false;
    this.#reconcileInbound();
    this.#updatePause();
    return result;
  }

  override _read(): void {
    this.#pressurePaused = false;
    this.#reconcileInbound();
    this.#updatePause();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const payload = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    void this.#broker.writeConnectionData(this.#connectionId, payload).then(
      () => callback(),
      (error: unknown) => callback(error instanceof Error ? error : endpointUnsafe()),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#broker.releaseInbound(this.#connectionId, this.#trackedInboundBytes);
    this.#trackedInboundBytes = 0;
    void this.#broker.closeConnection(this.#connectionId).then(
      () => {
        this.#remoteClosed = true;
        callback();
        queueMicrotask(() => this.destroy());
      },
      (error: unknown) => callback(error instanceof Error ? error : endpointUnsafe()),
    );
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.#remoteClosed) {
      this.#broker.releaseInbound(this.#connectionId, this.#trackedInboundBytes);
    }
    this.#trackedInboundBytes = 0;
    if (this.#remoteClosed || this.#broker.isClosing()) {
      callback(error);
      return;
    }
    void this.#broker.closeConnection(this.#connectionId).then(
      () => callback(error),
      (closeError: unknown) =>
        callback(error ?? (closeError instanceof Error ? closeError : endpointUnsafe())),
    );
  }

  #reconcileInbound(): void {
    const retained = this.readableLength;
    if (retained >= this.#trackedInboundBytes) return;
    this.#broker.releaseInbound(this.#connectionId, this.#trackedInboundBytes - retained);
    this.#trackedInboundBytes = retained;
  }

  #updatePause(): void {
    const shouldPause = this.#consumerPaused || this.#pressurePaused;
    if (shouldPause === this.#protocolPaused || this.destroyed) return;
    this.#protocolPaused = shouldPause;
    void this.#broker.setConnectionPaused(this.#connectionId, shouldPause).catch(() => undefined);
  }
}

class WindowsControlBrokerAdapter implements WindowsControlBroker {
  readonly endpoint: string;
  readonly #connectionListeners = new Set<(connection: ControlConnection) => void>();
  readonly #connections = new Map<bigint, BrokerConnection>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly #maxConnections: number;
  readonly #maxQueuedBytes: number;
  readonly #onFailureStage: ((stage: WindowsBrokerFailureStage) => void) | undefined;
  readonly #shutdownTimeoutMs: number;
  readonly #spawnBroker: WindowsBrokerSpawner;
  readonly #startupTimeoutMs: number;
  readonly #state: WindowsBrokerConnectionState;
  readonly #ready = Promise.withResolvers<void>();
  readonly #acknowledged = Promise.withResolvers<void>();
  readonly #childClosed = Promise.withResolvers<void>();
  #child: WindowsBrokerChildProcess | undefined;
  #closePromise: Promise<void> | undefined;
  #decoder = new WindowsBrokerFrameDecoder();
  #failureCleanup: Promise<void> | undefined;
  #phase: "new" | "starting" | "ready" | "closing" | "closed" = "new";
  #stderr = Buffer.alloc(0);
  #terminalCleanupErrors: unknown[] = [];
  #terminalError: Error | undefined;
  #terminating = false;
  #writer = Promise.resolve();

  constructor(options: WindowsControlBrokerOptions) {
    if (
      !/^\\\\\.\\pipe\\[^\\\r\n]{1,200}$/u.test(options.endpoint) ||
      !Number.isSafeInteger(options.maxConnections) ||
      options.maxConnections < 1 ||
      options.maxConnections > WINDOWS_BROKER_MAX_CONNECTIONS ||
      !Number.isSafeInteger(options.maxQueuedBytes) ||
      options.maxQueuedBytes < 1 ||
      options.maxQueuedBytes > WINDOWS_BROKER_MAX_CONNECTION_BYTES
    ) {
      throw endpointUnsafe();
    }
    for (const asset of [WINDOWS_BROKER_SCRIPT, WINDOWS_BROKER_CSHARP]) {
      try {
        accessSync(asset, fsConstants.R_OK);
      } catch {
        throw endpointUnsafe();
      }
    }
    this.endpoint = options.endpoint;
    this.#maxConnections = options.maxConnections;
    this.#maxQueuedBytes = options.maxQueuedBytes;
    this.#onFailureStage = options.onFailureStage;
    this.#shutdownTimeoutMs = duration(
      options.shutdownTimeoutMs,
      WINDOWS_BROKER_SHUTDOWN_TIMEOUT_MS,
    );
    this.#startupTimeoutMs = duration(options.startupTimeoutMs, WINDOWS_BROKER_STARTUP_TIMEOUT_MS);
    this.#spawnBroker =
      options.spawnBroker ??
      ((command, args, spawnOptions) =>
        spawn(command, [...args], spawnOptions as never) as unknown as WindowsBrokerChildProcess);
    this.#state = new WindowsBrokerConnectionState({
      maxConnectionBytes: options.maxQueuedBytes,
      maxTotalBytes: options.maxQueuedBytes,
    });
    this.#ready.promise.catch(() => undefined);
  }

  onConnection(listener: (connection: ControlConnection) => void): void {
    this.#connectionListeners.add(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.#errorListeners.add(listener);
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#phase !== "new") throw endpointUnsafe();
    if (signal?.aborted === true) throw abortError();
    this.#phase = "starting";
    try {
      this.#child = this.#spawnBroker(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          WINDOWS_BROKER_SCRIPT,
          "-Endpoint",
          this.endpoint,
          "-ParentProcessId",
          String(process.pid),
          "-ProtocolVersion",
          String(WINDOWS_BROKER_PROTOCOL_VERSION),
        ],
        { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      this.#observeChild(this.#child);
    } catch {
      this.#phase = "closed";
      throw endpointUnsafe();
    }

    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await withDeadline(
        Promise.race([this.#ready.promise, aborted.promise]),
        this.#startupTimeoutMs,
      );
      if (this.#terminalError !== undefined) throw this.#terminalError;
      this.#phase = "ready";
    } catch (error) {
      const primary =
        error instanceof DOMException && error.name === "AbortError" ? error : endpointUnsafe();
      const cleanupErrors = await this.#terminateChild();
      this.#phase = "closed";
      throw aggregate(primary, cleanupErrors, "Windows control broker startup cleanup failed");
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  isClosing(): boolean {
    return this.#phase === "closing" || this.#phase === "closed";
  }

  writeConnectionData(connectionId: bigint, payload: Uint8Array): Promise<void> {
    return this.#sendFrame({ connectionId, payload, type: "data" }, payload.byteLength);
  }

  closeConnection(connectionId: bigint): Promise<void> {
    if (this.isClosing()) return Promise.resolve();
    return this.#sendFrame({ connectionId, payload: new Uint8Array(), type: "close" });
  }

  setConnectionPaused(connectionId: bigint, paused: boolean): Promise<void> {
    if (this.isClosing()) return Promise.resolve();
    return this.#sendFrame({
      connectionId,
      payload: new Uint8Array(),
      type: paused ? "pause" : "resume",
    });
  }

  releaseInbound(connectionId: bigint, bytes: number): void {
    if (bytes === 0 || this.isClosing()) return;
    try {
      this.#state.drain(connectionId, "broker-to-parent", bytes);
    } catch {
      this.#beginFault(endpointUnsafe());
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    if (this.#phase === "new") {
      this.#phase = "closed";
      return;
    }
    if (this.#terminalError !== undefined) {
      await this.#failureCleanup;
      this.#phase = "closed";
      throw aggregate(
        this.#terminalError,
        this.#terminalCleanupErrors,
        "Windows control broker failure cleanup failed",
      );
    }
    this.#phase = "closing";
    try {
      await this.#sendFrame({ connectionId: 0n, payload: new Uint8Array(), type: "close-all" });
      await withDeadline(this.#acknowledged.promise, this.#shutdownTimeoutMs);
      this.#child?.stdin.end();
      await withDeadline(this.#childClosed.promise, this.#shutdownTimeoutMs);
    } catch {
      const cleanupErrors = await this.#terminateChild();
      if (cleanupErrors.length > 0) {
        this.#phase = "closed";
        throw aggregate(endpointUnsafe(), cleanupErrors, "Windows control broker close failed");
      }
    }
    this.#phase = "closed";
    if (this.#terminalError !== undefined) throw this.#terminalError;
  }

  #observeChild(child: WindowsBrokerChildProcess): void {
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const frame of this.#decoder.push(chunk)) this.#acceptFrame(frame);
      } catch {
        this.#beginFault(endpointUnsafe());
      }
    });
    child.stderr.on("data", (chunk: Buffer) => this.#acceptStderr(chunk));
    child.once("error", () => this.#beginFault(endpointUnsafe()));
    child.once("close", (code, childSignal) => {
      let invalidSettlement = false;
      try {
        this.#decoder.finish();
        if (this.#stderr.byteLength !== 0) invalidSettlement = true;
      } catch {
        invalidSettlement = true;
      }
      this.#childClosed.resolve();
      if (
        invalidSettlement ||
        (this.#phase !== "closing" && this.#phase !== "closed") ||
        (this.#phase === "closing" && !this.#terminating && (code !== 0 || childSignal !== null))
      ) {
        this.#beginFault(endpointUnsafe());
      }
    });
  }

  #acceptStderr(chunk: Buffer): void {
    if (this.#terminalError !== undefined) return;
    if (this.#stderr.byteLength + chunk.byteLength > WINDOWS_BROKER_STDERR_LIMIT) {
      this.#beginFault(endpointUnsafe());
      return;
    }
    this.#stderr = Buffer.concat([this.#stderr, Buffer.from(chunk)]);
    while (true) {
      const newline = this.#stderr.indexOf(0x0a);
      if (newline === -1) return;
      const line = this.#stderr.subarray(0, newline);
      this.#stderr = Buffer.from(this.#stderr.subarray(newline + 1));
      const normalized =
        line.byteLength > 0 && line[line.byteLength - 1] === 0x0d
          ? line.subarray(0, line.byteLength - 1)
          : line;
      const stage = normalized.toString("ascii");
      if (!FAILURE_STAGES.has(stage) || !Buffer.from(stage, "ascii").equals(normalized)) {
        this.#beginFault(endpointUnsafe());
        return;
      }
      try {
        this.#onFailureStage?.(stage as WindowsBrokerFailureStage);
      } catch {
        // Diagnostic observers cannot weaken or replace the stable broker result.
      }
    }
  }

  #acceptFrame(frame: WindowsBrokerFrame): void {
    this.#state.accept(frame, "broker-to-parent");
    switch (frame.type) {
      case "ready":
        decodeWindowsBrokerReadyDescriptor(frame.payload);
        this.#ready.resolve();
        return;
      case "open": {
        if (this.#connections.size >= this.#maxConnections) throw endpointUnsafe();
        const highWaterMark = Math.max(1, Math.floor(this.#maxQueuedBytes / this.#maxConnections));
        const connection = new BrokerConnection(this, frame.connectionId, highWaterMark);
        this.#connections.set(frame.connectionId, connection);
        connection.once("close", () => this.#connections.delete(frame.connectionId));
        for (const listener of this.#connectionListeners) listener(connection);
        return;
      }
      case "data": {
        const connection = this.#connections.get(frame.connectionId);
        if (connection === undefined) throw endpointUnsafe();
        connection.receive(frame.payload);
        return;
      }
      case "eof": {
        const connection = this.#connections.get(frame.connectionId);
        if (connection === undefined) throw endpointUnsafe();
        connection.receiveEof();
        return;
      }
      case "close": {
        const connection = this.#connections.get(frame.connectionId);
        if (connection === undefined) throw endpointUnsafe();
        connection.receiveClose();
        return;
      }
      case "fatal": {
        const stage = Buffer.from(frame.payload).toString("ascii");
        if (!FAILURE_STAGES.has(stage) || !Buffer.from(stage, "ascii").equals(frame.payload)) {
          throw endpointUnsafe();
        }
        this.#beginFault(endpointUnsafe());
        return;
      }
      case "close-all-ack":
        this.#acknowledged.resolve();
        return;
      default:
        throw endpointUnsafe();
    }
  }

  #sendFrame(frame: WindowsBrokerFrame, queuedBytes = 0): Promise<void> {
    const write = this.#writer.then(
      async () => {
        if (this.#child === undefined || this.#terminalError !== undefined) throw endpointUnsafe();
        this.#state.accept(frame, "parent-to-broker");
        const encoded = encodeWindowsBrokerFrame(frame);
        await new Promise<void>((resolve, reject) => {
          this.#child?.stdin.write(encoded, (error?: Error | null) =>
            error === undefined || error === null ? resolve() : reject(error),
          );
        });
        if (queuedBytes > 0) this.#state.drain(frame.connectionId, "parent-to-broker", queuedBytes);
      },
      () => {
        throw endpointUnsafe();
      },
    );
    this.#writer = write.catch((error: unknown) => {
      this.#beginFault(endpointUnsafe());
      throw error;
    });
    this.#writer.catch(() => undefined);
    return write;
  }

  #beginFault(error: Error): void {
    if (this.#terminalError !== undefined || this.#phase === "closed") return;
    this.#terminalError = error;
    for (const connection of this.#connections.values()) connection.receiveClose(error);
    this.#connections.clear();
    for (const listener of this.#errorListeners) {
      try {
        listener(error);
      } catch {
        // Error observers cannot replace the stable broker failure.
      }
    }
    if (this.#phase === "starting") {
      this.#ready.reject(error);
      return;
    }
    if (this.#phase === "ready") {
      this.#failureCleanup = this.#terminateChild().then((errors) => {
        this.#terminalCleanupErrors = errors;
      });
      this.#failureCleanup.catch(() => undefined);
    }
  }

  async #terminateChild(): Promise<unknown[]> {
    const child = this.#child;
    if (child === undefined) return [];
    const errors: unknown[] = [];
    this.#terminating = true;
    try {
      child.stdin.end();
    } catch (error) {
      errors.push(error);
    }
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        child.kill(signal);
      } catch (error) {
        errors.push(error);
      }
      try {
        await withDeadline(this.#childClosed.promise, this.#shutdownTimeoutMs);
        return errors;
      } catch {
        // Escalate once from terminate to kill while retaining cleanup errors.
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await withDeadline(this.#childClosed.promise, this.#shutdownTimeoutMs);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
}

export function createWindowsControlBroker(
  options: WindowsControlBrokerOptions,
): WindowsControlBroker {
  return new WindowsControlBrokerAdapter(options);
}
