import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, Worker, type MessagePort, type Transferable } from "node:worker_threads";
import {
  compileSchemaValidator,
  DiagnosticError,
  parseArtifactDigest,
  parseCapabilityName,
  parseExecutionRequest,
  parseExecutionResult,
  parsePluginManifest,
  runtimeDiagnostic,
  type ArtifactDigest,
  type AttemptId,
  type AttemptStatus,
  type CapabilityDefinition,
  type Clock,
  type ComponentCapabilityBoundary,
  type ComponentPermissionBoundary,
  type DrainOptions,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type ExecutorCapabilities,
  type ExecutorHealth,
  type JsonValue,
  type Permission,
  type PluginManifest,
  type RuntimeDiagnostic,
  type SecretProvider,
  type TaskId,
} from "@tegojs/contracts";
import {
  COMPONENT_HOST_PROTOCOL,
  cloneComponentHostValue,
  parseComponentHostResult,
  type ComponentHostCommand,
  type ComponentHostResult,
  type PrepareComponentHostCommand,
} from "../host/protocol.js";

export const THREAD_EXECUTOR_MAX_MESSAGE_BYTES = 1024 * 1024;
export const THREAD_EXECUTOR_MAX_MESSAGE_DEPTH = 64;
export const THREAD_EXECUTOR_MAX_MESSAGE_NODES = 100_000;
export const THREAD_EXECUTOR_MAX_RETAINED_ATTEMPTS = 256;
export const THREAD_EXECUTOR_MAX_QUEUE = 256;
export const THREAD_EXECUTOR_MAX_CONCURRENCY = 64;
const THREAD_CHANNEL_MAX_PENDING = 64;
const THREAD_CHANNEL_MAX_PENDING_BYTES = 4 * THREAD_EXECUTOR_MAX_MESSAGE_BYTES;
const THREAD_CHANNEL_MAX_INBOUND = 64;
const THREAD_CHANNEL_MAX_INBOUND_BYTES = 4 * THREAD_EXECUTOR_MAX_MESSAGE_BYTES;
const MAX_CLOCK_SLEEP_MS = 2_147_483_647;

const systemClock: Clock = {
  now: () => new Date(),
  sleep: async (delayMs, signal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref();
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  },
};

export interface ResolvedThreadComponent {
  readonly artifactDigest: ArtifactDigest;
  readonly artifactRoot: string;
  readonly manifest: PluginManifest;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly configuration: JsonValue;
  readonly permissionGrants: readonly Permission[];
  readonly capabilityDefinitions: readonly CapabilityDefinition[];
}

export type ThreadWorkerEvent = "error" | "exit" | "message" | "messageerror" | "online";

export interface ThreadWorker {
  readonly threadId?: number;
  postMessage(value: unknown, transferList?: readonly Transferable[]): void;
  on(event: ThreadWorkerEvent, listener: (...arguments_: readonly unknown[]) => void): this;
  once(event: ThreadWorkerEvent, listener: (...arguments_: readonly unknown[]) => void): this;
  terminate(): Promise<number>;
}

export interface ThreadWorkerFactory {
  create(entrypoint: string): ThreadWorker;
}

export interface ThreadExecutorLogger {
  debug(...values: readonly unknown[]): void;
  error(...values: readonly unknown[]): void;
  info(...values: readonly unknown[]): void;
  warn(...values: readonly unknown[]): void;
}

export interface ThreadExecutorOptions {
  readonly id: string;
  readonly resolveComponent: (
    request: ExecutionRequest,
  ) => ResolvedThreadComponent | Promise<ResolvedThreadComponent>;
  readonly clock?: Clock;
  readonly maxConcurrency?: number;
  readonly maxQueue?: number;
  readonly cancellationGraceMs?: number;
  readonly cleanupGraceMs?: number;
  readonly workerEntrypoint?: string;
  readonly workerFactory?: ThreadWorkerFactory;
  readonly permissionBoundary?: ComponentPermissionBoundary;
  readonly capabilityBoundary?: ComponentCapabilityBoundary;
  readonly secretProvider?: SecretProvider;
  readonly logger?: ThreadExecutorLogger;
  readonly events?: {
    emit(type: string, payload: JsonValue): Promise<void>;
  };
}

export interface ThreadTransferOptions {
  readonly buffers: readonly ArrayBuffer[];
  readonly ownership: "clone" | "transfer";
}

export interface ThreadExecutionRequest {
  readonly execution: ExecutionRequest;
  readonly transfer: ThreadTransferOptions;
}

const threadExecutionRequests = new WeakSet<ThreadExecutionRequest>();
const threadTransferFingerprints = new WeakMap<ThreadExecutionRequest, string>();

export function threadExecutionRequest(
  execution: ExecutionRequest,
  transfer: ThreadTransferOptions,
): ThreadExecutionRequest {
  const request = Object.freeze({
    execution,
    transfer: Object.freeze({
      buffers: Object.freeze([...transfer.buffers]),
      ownership: transfer.ownership,
    }),
  });
  threadExecutionRequests.add(request);
  return request;
}

interface ClaimedTransfer {
  readonly buffers: readonly ArrayBuffer[];
  readonly fingerprint: string;
}

interface AttemptEntry {
  readonly key: string;
  readonly request: ExecutionRequest;
  readonly fingerprint: string;
  readonly handle: ExecutionHandle;
  readonly result: PromiseWithResolvers<ExecutionResult>;
  readonly completed: PromiseWithResolvers<void>;
  readonly deadlineController: AbortController;
  readonly admissionController: AbortController;
  state: "accepted" | "running" | "terminal";
  decision?: ExecutionResult;
  terminal?: ExecutionResult;
  forced?: ExecutionResult;
  lease?: WorkerLease;
  channel?: ThreadChannel;
  transfer?: ClaimedTransfer;
  cancellation?: "cancelled" | "timed-out";
  cancellationSent?: boolean;
  cancellationEscalation?: Promise<void>;
}

interface IncomingMessage {
  readonly kind: string;
  readonly id?: string;
  readonly result?: unknown;
  readonly code?: string;
  readonly message?: string;
  readonly type?: string;
  readonly payload?: JsonValue;
  readonly level?: keyof ThreadExecutorLogger;
  readonly values?: readonly unknown[];
}

interface WorkerLease {
  readonly worker: ThreadWorker;
  readonly exited: Promise<{ readonly code?: number; readonly error?: Error }>;
}

interface ThreadTerminationOutcome {
  readonly diagnostic?: RuntimeDiagnostic;
  readonly settled: Promise<void>;
}

interface ThreadInboundBudget {
  bytes: number;
  count: number;
}

type AdmissionRace<T> =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly value: T };

interface AdmissionOperation<T> {
  readonly outcome: Promise<AdmissionRace<T>>;
  readonly settled: Promise<void>;
}

function attemptKey(taskId: TaskId, attemptId: AttemptId): string {
  return `${taskId.length}:${taskId}${attemptId}`;
}

function diagnostic(
  code: RuntimeDiagnostic["code"],
  message: string,
  now: Date,
  details?: JsonValue,
): RuntimeDiagnostic {
  return runtimeDiagnostic({
    code,
    message,
    source: { kind: "executor", id: "thread" },
    ...(details === undefined ? {} : { details }),
    observedAt: now.toISOString(),
  });
}

function executorError(
  code: RuntimeDiagnostic["code"],
  message: string,
  now: Date,
): DiagnosticError {
  return new DiagnosticError(diagnostic(code, message, now));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function incoming(input: unknown): IncomingMessage {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Worker thread message must be an object");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.kind !== "string") throw new Error("Worker thread message kind is invalid");
  return {
    kind: value.kind,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(value.payload === undefined ? {} : { payload: value.payload as JsonValue }),
    ...(typeof value.level === "string"
      ? { level: value.level as keyof ThreadExecutorLogger }
      : {}),
    ...(Array.isArray(value.values) ? { values: value.values } : {}),
  };
}

function messageError(code: RuntimeDiagnostic["code"], message: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "protocol", id: "thread-executor" },
    }),
  );
}

interface ThreadMessageMetrics {
  readonly bytes: number;
  readonly nodes: number;
}

function validateThreadMessage(
  value: unknown,
  oversizedCode: RuntimeDiagnostic["code"],
): ThreadMessageMetrics {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (
      nodes > THREAD_EXECUTOR_MAX_MESSAGE_NODES ||
      current.depth > THREAD_EXECUTOR_MAX_MESSAGE_DEPTH
    ) {
      throw messageError(
        "PROTOCOL_THREAD_MESSAGE_COMPLEXITY_EXCEEDED",
        "Thread message exceeds the configured depth or node limit",
      );
    }
    const item = current.value;
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8");
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      bytes += 8;
    } else if (item instanceof ArrayBuffer) {
      bytes += item.byteLength;
    } else if (typeof item === "object" && item !== null) {
      if (seen.has(item)) {
        throw messageError("PROTOCOL_THREAD_MESSAGE_INVALID", "Thread message contains a cycle");
      }
      seen.add(item);
      const prototype = Object.getPrototypeOf(item);
      if (Array.isArray(item)) {
        for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      } else if (prototype === Object.prototype || prototype === null) {
        for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
          bytes += Buffer.byteLength(key, "utf8");
          pending.push({ value: child, depth: current.depth + 1 });
        }
      } else {
        throw messageError(
          "PROTOCOL_THREAD_MESSAGE_INVALID",
          "Thread message contains an unsupported object",
        );
      }
    } else {
      throw messageError(
        "PROTOCOL_THREAD_MESSAGE_INVALID",
        "Thread message contains an unsupported value",
      );
    }
    if (bytes > THREAD_EXECUTOR_MAX_MESSAGE_BYTES) {
      throw messageError(oversizedCode, "Thread message exceeds the configured wire limit");
    }
  }
  return { bytes, nodes };
}

class NodeThreadWorker implements ThreadWorker {
  readonly #worker: Worker;

  constructor(entrypoint: string) {
    this.#worker = new Worker(entrypoint);
  }

  get threadId(): number {
    return this.#worker.threadId;
  }

  postMessage(value: unknown, transferList?: readonly Transferable[]): void {
    this.#worker.postMessage(value, transferList);
  }

  on(event: ThreadWorkerEvent, listener: (...arguments_: readonly unknown[]) => void): this {
    this.#worker.on(event, listener);
    return this;
  }

  once(event: ThreadWorkerEvent, listener: (...arguments_: readonly unknown[]) => void): this {
    this.#worker.once(event, listener);
    return this;
  }

  terminate(): Promise<number> {
    return this.#worker.terminate();
  }
}

const defaultWorkerFactory: ThreadWorkerFactory = {
  create: (entrypoint) => new NodeThreadWorker(entrypoint),
};

class ThreadChannel {
  readonly #port: MessagePort;
  readonly #options: ThreadExecutorOptions;
  readonly #component: ResolvedThreadComponent;
  readonly #inboundBudget: ThreadInboundBudget;
  readonly #capabilityValidators = new Map<
    string,
    {
      readonly request: { parse(input: unknown): JsonValue };
      readonly response: { parse(input: unknown): JsonValue };
    }
  >();
  readonly #pending = new Map<
    string,
    {
      readonly bytes: number;
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  #nextId = 0;
  #pendingBytes = 0;
  #closedError: Error | undefined;
  readonly #onMessage = (value: unknown): void => {
    try {
      const metrics = validateThreadMessage(value, "EXECUTOR_OUTPUT_LIMIT_EXCEEDED");
      const message = incoming(value);
      const tracked = ["diagnostic", "event", "rpc-request"].includes(message.kind);
      if (
        tracked &&
        (this.#inboundBudget.count >= THREAD_CHANNEL_MAX_INBOUND ||
          this.#inboundBudget.bytes + metrics.bytes > THREAD_CHANNEL_MAX_INBOUND_BYTES)
      ) {
        this.#fail(new Error("Thread channel inbound capacity is exhausted"));
        this.#port.close();
        return;
      }
      if (tracked) {
        this.#inboundBudget.count += 1;
        this.#inboundBudget.bytes += metrics.bytes;
      }
      void this.#dispatch(message)
        .catch((error: unknown) => {
          this.#fail(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          if (!tracked) return;
          this.#inboundBudget.count -= 1;
          this.#inboundBudget.bytes -= metrics.bytes;
        });
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  readonly #onMessageError = (): void => {
    this.#fail(new Error("Worker thread message could not be deserialized"));
  };
  readonly #onClose = (): void => {
    this.#fail(new Error("Worker thread broker port closed"));
  };

  constructor(
    lease: WorkerLease,
    options: ThreadExecutorOptions,
    component: ResolvedThreadComponent,
    inboundBudget: ThreadInboundBudget,
  ) {
    this.#options = options;
    this.#component = component;
    this.#inboundBudget = inboundBudget;
    for (const definition of component.capabilityDefinitions) {
      this.#capabilityValidators.set(this.#capabilityKey(definition.identity), {
        request: compileSchemaValidator<JsonValue>(definition.requestSchema),
        response: compileSchemaValidator<JsonValue>(definition.responseSchema),
      });
    }
    const channel = new MessageChannel();
    this.#port = channel.port1;
    this.#port.on("message", this.#onMessage);
    this.#port.on("messageerror", this.#onMessageError);
    this.#port.on("close", this.#onClose);
    this.#port.start();
    try {
      lease.worker.postMessage({ kind: "connect", port: channel.port2 }, [channel.port2]);
    } catch (error) {
      this.#detach();
      channel.port1.close();
      channel.port2.close();
      throw error;
    }
    void lease.exited.then(({ code, error }) => {
      this.#fail(
        error ??
          new Error(
            `Worker thread exited${code === undefined ? "" : ` with code ${String(code)}`}`,
          ),
      );
    });
  }

  abort(error: Error): void {
    this.#fail(error);
  }

  close(): void {
    this.#detach();
    this.#port.close();
  }

  #detach(): void {
    this.#port.off("message", this.#onMessage);
    this.#port.off("messageerror", this.#onMessageError);
    this.#port.off("close", this.#onClose);
  }

  request(
    message: Record<string, unknown>,
    transferList: readonly Transferable[] = [],
  ): Promise<unknown> {
    if (this.#closedError !== undefined) return Promise.reject(this.#closedError);
    if (this.#pending.size >= THREAD_CHANNEL_MAX_PENDING) {
      return Promise.reject(new Error("Thread channel pending request capacity is exhausted"));
    }
    const id = `message-${++this.#nextId}`;
    const value = { ...message, id };
    let metrics: ThreadMessageMetrics;
    try {
      metrics = validateThreadMessage(value, "EXECUTOR_INPUT_LIMIT_EXCEEDED");
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#pendingBytes + metrics.bytes > THREAD_CHANNEL_MAX_PENDING_BYTES) {
      return Promise.reject(new Error("Thread channel pending byte capacity is exhausted"));
    }
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { bytes: metrics.bytes, resolve, reject });
      this.#pendingBytes += metrics.bytes;
      try {
        this.#send(value, transferList);
      } catch (error) {
        this.#pending.delete(id);
        this.#pendingBytes -= metrics.bytes;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #send(value: Record<string, unknown>, transferList: readonly Transferable[] = []): void {
    validateThreadMessage(value, "EXECUTOR_INPUT_LIMIT_EXCEEDED");
    this.#port.postMessage(value, [...transferList]);
  }

  async #dispatch(message: IncomingMessage): Promise<void> {
    if (message.kind === "response" || message.kind === "response-error") {
      if (message.id === undefined) throw new Error("Thread response identity is missing");
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      this.#pendingBytes -= pending.bytes;
      if (message.kind === "response-error") {
        pending.reject(
          executorError(
            message.code === "EXECUTOR_OUTPUT_LIMIT_EXCEEDED"
              ? "EXECUTOR_OUTPUT_LIMIT_EXCEEDED"
              : "PROTOCOL_THREAD_MESSAGE_INVALID",
            message.message ?? "Thread response failed",
            this.#options.clock?.now() ?? new Date(),
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.kind === "rpc-request") {
      await this.#rpc(message);
      return;
    }
    if (message.kind === "diagnostic") {
      if (message.id === undefined) throw new Error("Thread diagnostic identity is missing");
      const level = message.level;
      if (level !== undefined && ["debug", "error", "info", "warn"].includes(level)) {
        try {
          this.#options.logger?.[level](...(message.values ?? []));
        } catch {
          // Diagnostic sinks cannot alter execution state.
        }
      }
      this.#send({ kind: "ack", id: message.id, ok: true });
      return;
    }
    if (message.kind === "event" && message.type !== undefined && message.payload !== undefined) {
      if (message.id === undefined) throw new Error("Thread event identity is missing");
      try {
        await this.#options.events?.emit(message.type, message.payload);
        this.#send({ kind: "ack", id: message.id, ok: true });
      } catch (error) {
        this.#send({
          kind: "ack",
          id: message.id,
          ok: false,
          message: error instanceof Error ? error.message : "Thread event sink failed",
        });
      }
      return;
    }
    if (message.kind === "fatal") {
      throw new Error(message.message ?? "Worker thread protocol failed");
    }
    throw new Error("Worker thread message kind is unsupported");
  }

  async #rpc(message: IncomingMessage): Promise<void> {
    if (message.id === undefined || message.type === undefined || message.payload === undefined) {
      throw new Error("Thread RPC message is invalid");
    }
    try {
      let value: unknown;
      if (message.type === "secret") {
        const payload = this.#exactPayload(message.payload, ["name"]);
        if (
          typeof payload.name !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(payload.name)
        ) {
          throw new Error("Secret RPC name is invalid");
        }
        this.#authorize("secret", payload.name);
        if (this.#options.secretProvider === undefined) {
          throw new Error("Secret provider is unavailable");
        }
        value = await this.#options.secretProvider.get(payload.name);
      } else if (message.type === "capability") {
        const payload = this.#exactPayload(message.payload, ["identity", "method", "input"]);
        const identity = this.#exactPayload(payload.identity, ["name", "protocolVersion"]);
        const name = parseCapabilityName(identity.name);
        if (typeof identity.protocolVersion !== "string" || identity.protocolVersion.length === 0) {
          throw new Error("Capability protocol version is invalid");
        }
        if (typeof payload.method !== "string" || payload.method.length === 0) {
          throw new Error("Capability RPC method is invalid");
        }
        const capabilityIdentity = { name, protocolVersion: identity.protocolVersion };
        this.#authorize("capability", name, payload.method);
        const validators = this.#capabilityValidators.get(this.#capabilityKey(capabilityIdentity));
        if (validators === undefined) throw new Error("Capability RPC is not registered");
        const input = validators.request.parse(payload.input);
        if (this.#options.capabilityBoundary === undefined) {
          throw new Error("Capability boundary is unavailable");
        }
        value = validators.response.parse(
          await this.#options.capabilityBoundary.invoke({
            identity: capabilityIdentity,
            method: payload.method,
            input,
          }),
        );
      } else {
        throw new Error("Thread RPC type is unsupported");
      }
      this.#send({
        kind: "rpc-response",
        id: message.id,
        ok: true,
        ...(value === undefined ? {} : { value }),
      });
    } catch (error) {
      this.#send({
        kind: "rpc-response",
        id: message.id,
        ok: false,
        message: error instanceof Error ? error.message : "Parent RPC failed",
      });
    }
  }

  #exactPayload(input: unknown, fields: readonly string[]): Record<string, JsonValue> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("Thread RPC payload must be an object");
    }
    const payload = input as Record<string, JsonValue>;
    const keys = Object.keys(payload);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !Object.hasOwn(payload, field)) ||
      keys.some((field) => !fields.includes(field))
    ) {
      throw new Error("Thread RPC payload fields are invalid");
    }
    return payload;
  }

  #authorize(kind: "capability" | "secret", name: string, method?: string): void {
    const requested = this.#component.manifest.permissions;
    const granted = this.#component.permissionGrants;
    const permits = (permissions: readonly Permission[]) =>
      permissions.some((permission) => {
        if (kind === "secret") {
          return permission.kind === "secret" && permission.names.includes(name);
        }
        return (
          permission.kind === "capability" &&
          permission.capabilities.some(
            (capability) =>
              capability.name === name &&
              method !== undefined &&
              capability.methods.includes(method),
          )
        );
      });
    const decision = this.#options.permissionBoundary?.authorize(granted, {
      kind,
      name,
      ...(method === undefined ? {} : { method }),
    });
    if (!permits(requested) || !permits(granted) || decision?.allowed === false) {
      throw new Error(`Component ${kind} operation is not granted`);
    }
  }

  #capabilityKey(identity: { readonly name: string; readonly protocolVersion: string }): string {
    return `${identity.name.length}:${identity.name}${identity.protocolVersion}`;
  }

  #fail(error: Error): void {
    if (this.#closedError !== undefined) return;
    this.#closedError = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#pendingBytes = 0;
  }
}

export class ThreadExecutor implements Executor {
  readonly id: string;
  readonly type = "thread" as const;
  readonly #options: ThreadExecutorOptions;
  readonly #clock: Clock;
  readonly #workerFactory: ThreadWorkerFactory;
  readonly #maxConcurrency: number;
  readonly #maxQueue: number;
  readonly #cancellationGraceMs: number;
  readonly #cleanupGraceMs: number;
  readonly #workerEntrypoint: string;
  readonly #attempts = new Map<string, AttemptEntry>();
  readonly #queue: AttemptEntry[] = [];
  readonly #inboundBudget: ThreadInboundBudget = { bytes: 0, count: 0 };
  readonly #termination = new WeakMap<ThreadWorker, Promise<ThreadTerminationOutcome>>();
  readonly #quarantined = new Set<WorkerLease>();
  readonly #quarantineSettlements = new Map<WorkerLease, Promise<void>>();
  #active = 0;
  #accepting = true;
  #drainPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #fatalDiagnostic: RuntimeDiagnostic | undefined;

  constructor(options: ThreadExecutorOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.id)) {
      throw new TypeError("Thread executor identity is invalid");
    }
    const maxConcurrency = options.maxConcurrency ?? 1;
    const maxQueue = options.maxQueue ?? THREAD_EXECUTOR_MAX_QUEUE;
    const cancellationGraceMs = options.cancellationGraceMs ?? 1_000;
    const cleanupGraceMs = options.cleanupGraceMs ?? cancellationGraceMs;
    if (
      !Number.isInteger(maxConcurrency) ||
      maxConcurrency < 1 ||
      maxConcurrency > THREAD_EXECUTOR_MAX_CONCURRENCY
    ) {
      throw new RangeError("maxConcurrency is outside the supported bound");
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > THREAD_EXECUTOR_MAX_QUEUE) {
      throw new RangeError("maxQueue is outside the supported bound");
    }
    if (!Number.isFinite(cancellationGraceMs) || cancellationGraceMs < 0) {
      throw new RangeError("cancellationGraceMs must be finite and non-negative");
    }
    if (!Number.isFinite(cleanupGraceMs) || cleanupGraceMs < 0) {
      throw new RangeError("cleanupGraceMs must be finite and non-negative");
    }
    this.id = options.id;
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.#maxConcurrency = maxConcurrency;
    this.#maxQueue = maxQueue;
    this.#cancellationGraceMs = cancellationGraceMs;
    this.#cleanupGraceMs = cleanupGraceMs;
    this.#workerEntrypoint =
      options.workerEntrypoint ?? fileURLToPath(new URL("./thread-entry.js", import.meta.url));
  }

  async probe(): Promise<ExecutorCapabilities> {
    const available = this.#accepting && this.#fatalDiagnostic === undefined;
    return {
      id: this.id,
      type: this.type,
      available,
      maxConcurrency: this.#maxConcurrency,
      availableCapacity: available ? Math.max(0, this.#maxConcurrency - this.#active) : 0,
      securityIsolation: false,
    };
  }

  submit(request: ExecutionRequest): Promise<ExecutionHandle>;
  submit(request: ThreadExecutionRequest): Promise<ExecutionHandle>;
  async submit(input: ExecutionRequest | ThreadExecutionRequest): Promise<ExecutionHandle> {
    const wrapped = this.#isThreadExecutionRequest(input);
    const parsed = parseExecutionRequest(wrapped?.execution ?? input);
    const request = deepFreeze(parseExecutionRequest(cloneComponentHostValue(parsed)));
    const key = attemptKey(request.taskId, request.attemptId);
    const existing = this.#attempts.get(key);
    const transferFingerprint =
      wrapped === undefined ? "" : this.#transferFingerprint(wrapped, existing !== undefined);
    const fingerprint = `${JSON.stringify(request)}:${transferFingerprint}`;
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw executorError(
          "PROTOCOL_IDEMPOTENCY_CONFLICT",
          "Task attempt identity was reused with a different fingerprint",
          this.#clock.now(),
        );
      }
      this.#touch(existing);
      return existing.handle;
    }
    this.#validateRunEnvelope(request, wrapped?.transfer.buffers ?? []);
    if (!this.#accepting) {
      throw executorError(
        "EXECUTOR_DRAINING",
        "Thread executor is draining and refuses new submissions",
        this.#clock.now(),
      );
    }
    this.#pruneTerminal();
    if (this.#attempts.size >= THREAD_EXECUTOR_MAX_RETAINED_ATTEMPTS) {
      throw executorError(
        "EXECUTOR_ATTEMPT_CAPACITY_EXCEEDED",
        "Thread executor attempt retention is exhausted",
        this.#clock.now(),
      );
    }
    if (this.#active + this.#queue.length >= this.#maxConcurrency + this.#maxQueue) {
      throw executorError(
        "EXECUTOR_QUEUE_CAPACITY_EXCEEDED",
        "Thread executor submission queue is full",
        this.#clock.now(),
      );
    }
    let transfer: ClaimedTransfer | undefined;
    if (wrapped !== undefined) {
      const buffers = this.#claimTransfer(wrapped.transfer);
      if (wrapped.transfer.ownership === "transfer") {
        threadTransferFingerprints.set(wrapped, transferFingerprint);
      }
      transfer = { buffers, fingerprint: transferFingerprint };
    }
    const result = Promise.withResolvers<ExecutionResult>();
    const entry: AttemptEntry = {
      key,
      request,
      fingerprint,
      result,
      completed: Promise.withResolvers<void>(),
      deadlineController: new AbortController(),
      admissionController: new AbortController(),
      state: "accepted",
      ...(transfer === undefined ? {} : { transfer }),
      handle: Object.freeze({
        taskId: request.taskId,
        attemptId: request.attemptId,
        result: result.promise,
      }),
    };
    this.#attempts.set(key, entry);
    this.#armDeadline(entry);
    this.#queue.push(entry);
    void this.#schedule();
    return entry.handle;
  }

  async observe(taskId: TaskId, attemptId: AttemptId): Promise<AttemptStatus | undefined> {
    const entry = this.#attempts.get(attemptKey(taskId, attemptId));
    if (entry === undefined) return undefined;
    this.#touch(entry);
    if (entry.state === "terminal") {
      if (entry.terminal === undefined) throw new Error("Terminal attempt result is missing");
      return { state: "terminal", result: entry.terminal };
    }
    return { state: entry.state };
  }

  async cancel(taskId: TaskId, attemptId: AttemptId): Promise<void> {
    const entry = this.#attempts.get(attemptKey(taskId, attemptId));
    if (entry === undefined) return;
    await this.#requestCancellation(entry, "cancelled");
  }

  drain(options: DrainOptions): Promise<void> {
    let deadline: string | undefined;
    if (options.deadline !== undefined) {
      const deadlineTime = Date.parse(options.deadline);
      if (!Number.isFinite(deadlineTime)) {
        return Promise.reject(new TypeError("Drain deadline must be an ISO timestamp"));
      }
      deadline = new Date(deadlineTime).toISOString();
    }
    this.#accepting = false;
    this.#drainPromise ??= (async () => {
      const deadlineController = new AbortController();
      if (deadline !== undefined) {
        void this.#waitUntilDeadline(deadline, deadlineController.signal)
          .then(async () => {
            await Promise.all(
              [...this.#attempts.values()].map((entry) =>
                this.#requestCancellation(entry, "cancelled"),
              ),
            );
          })
          .catch(() => undefined);
      }
      try {
        await Promise.all([...this.#attempts.values()].map((entry) => entry.completed.promise));
        await Promise.all([...this.#quarantineSettlements.values()]);
      } finally {
        deadlineController.abort("drained");
      }
    })();
    return this.#drainPromise;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.drain({});
    return this.#closePromise;
  }

  async health(): Promise<ExecutorHealth> {
    const attached = new Set(
      [...this.#attempts.values()].flatMap((entry) =>
        entry.lease === undefined ? [] : [entry.lease],
      ),
    );
    const detachedQuarantines = [...this.#quarantined].filter((lease) => !attached.has(lease));
    return {
      status: this.#fatalDiagnostic === undefined ? "healthy" : "unhealthy",
      checkedAt: this.#clock.now().toISOString(),
      ...(this.#fatalDiagnostic === undefined
        ? {}
        : { message: `${this.#fatalDiagnostic.code}: ${this.#fatalDiagnostic.message}` }),
      id: this.id,
      type: this.type,
      accepting: this.#accepting,
      active: this.#active + detachedQuarantines.length,
      queued: this.#queue.length,
      retainedAttempts: this.#attempts.size,
    };
  }

  async #schedule(): Promise<void> {
    if (this.#fatalDiagnostic !== undefined) {
      this.#settleAdmissions(this.#fatalDiagnostic);
      return;
    }
    while (this.#active < this.#maxConcurrency) {
      const entry = this.#queue.shift();
      if (entry === undefined) return;
      if (entry.state === "terminal") continue;
      this.#active += 1;
      entry.state = "running";
      void this.#run(entry).finally(() => {
        this.#publish(entry);
        this.#active -= 1;
        if (entry.terminal !== undefined) entry.result.resolve(entry.terminal);
        entry.completed.resolve();
        void this.#schedule();
      });
    }
  }

  async #run(entry: AttemptEntry): Promise<void> {
    let lease: WorkerLease | undefined;
    let channel: ThreadChannel | undefined;
    let candidate: ExecutionResult | undefined;
    const admissionSettlements: Promise<void>[] = [];
    const startedAt = this.#clock.now().toISOString();
    try {
      const resolutionAdmission = this.#raceAdmission(entry, this.#resolve(entry.request));
      admissionSettlements.push(resolutionAdmission.settled);
      const resolution = await resolutionAdmission.outcome;
      if (resolution.cancelled) {
        candidate = entry.forced ?? this.#cancelledResult(entry, entry.cancellation ?? "cancelled");
        return;
      }
      const component = resolution.value;
      if (entry.forced !== undefined || this.#fatalDiagnostic !== undefined) {
        candidate =
          entry.forced ??
          this.#fatalResult(
            entry,
            this.#fatalDiagnostic ??
              diagnostic(
                "EXECUTOR_THREAD_TERMINATION_FAILED",
                "Thread executor entered fatal containment",
                this.#clock.now(),
              ),
          );
        return;
      }
      if (entry.cancellation !== undefined) {
        candidate = this.#cancelledResult(entry, entry.cancellation);
        return;
      }
      const worker = this.#workerFactory.create(this.#workerEntrypoint);
      lease = this.#lease(worker);
      entry.lease = lease;
      if (entry.cancellation !== undefined) {
        candidate = this.#cancelledResult(entry, entry.cancellation);
        return;
      }
      channel = new ThreadChannel(lease, this.#options, component, this.#inboundBudget);
      entry.channel = channel;
      const bootstrap = await channel.request({
        kind: "bootstrap",
        now: this.#clock.now().toISOString(),
        artifact: {
          artifactDigest: component.artifactDigest,
          artifactRoot: component.artifactRoot,
          manifest: component.manifest,
        },
      });
      if (
        typeof bootstrap !== "object" ||
        bootstrap === null ||
        (bootstrap as { readonly ok?: unknown }).ok !== true
      ) {
        throw new Error("Worker thread bootstrap failed");
      }
      const controlDeadline = new Date(this.#clock.now().getTime() + 86_400_000).toISOString();
      const prepare: PrepareComponentHostCommand = {
        protocol: COMPONENT_HOST_PROTOCOL,
        commandId: "prepare",
        deadline: controlDeadline,
        type: "prepare",
        payload: {
          artifactDigest: component.artifactDigest,
          componentId: entry.request.componentId,
          identity: {
            runtimeId: component.runtimeId,
            applicationId: entry.request.applicationId,
            pluginId: entry.request.pluginId,
            componentId: entry.request.componentId,
            instanceId: component.instanceId,
          },
          configuration: component.configuration,
          permissionGrants: component.permissionGrants,
          capabilityDefinitions: component.capabilityDefinitions,
          runtime: { executor: "thread", mode: "single-main" },
        },
      };
      await this.#hostCommand(channel, prepare);
      await this.#hostCommand(
        channel,
        this.#artifactCommand("import", "import", controlDeadline, component.artifactDigest),
      );
      await this.#hostCommand(
        channel,
        this.#artifactCommand("start", "start", controlDeadline, component.artifactDigest),
      );
      if (entry.state === "terminal") return;
      if (entry.cancellation !== undefined) {
        candidate = this.#cancelledResult(entry, entry.cancellation);
        return;
      }
      const attachments = entry.transfer?.buffers ?? [];
      const run = await this.#hostCommand(
        channel,
        {
          protocol: COMPONENT_HOST_PROTOCOL,
          commandId: "run",
          deadline: entry.request.deadline,
          type: "run",
          payload: {
            artifactDigest: component.artifactDigest,
            execution: entry.request,
          },
        },
        attachments,
      );
      delete entry.transfer;
      const value = run.value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Component run result is invalid");
      }
      const resultValue = value as Record<string, JsonValue>;
      const status =
        entry.cancellation === "timed-out" && resultValue.status === "cancelled"
          ? "timed-out"
          : resultValue.status;
      if (!["cancelled", "failed", "rejected", "succeeded", "timed-out"].includes(String(status))) {
        throw new Error("Component run status is invalid");
      }
      candidate = {
        taskId: entry.request.taskId,
        attemptId: entry.request.attemptId,
        status: status as Exclude<ExecutionResult["status"], "indeterminate">,
        ...(resultValue.output === undefined ? {} : { output: resultValue.output }),
        executor: this.#executorMetadata(lease),
        startedAt,
        completedAt: this.#clock.now().toISOString(),
      };
      this.#decide(entry, candidate);
      await this.#shutdownWorker(channel, lease, component.artifactDigest, controlDeadline);
    } catch (error) {
      if (entry.decision === undefined) {
        const code =
          error instanceof DiagnosticError
            ? error.diagnostic.code
            : lease === undefined
              ? "EXECUTOR_THREAD_SPAWN_FAILED"
              : "EXECUTOR_THREAD_EXIT";
        candidate = {
          taskId: entry.request.taskId,
          attemptId: entry.request.attemptId,
          status: error instanceof DiagnosticError ? "failed" : (entry.cancellation ?? "failed"),
          diagnostic:
            error instanceof DiagnosticError
              ? error.diagnostic
              : diagnostic(
                  code,
                  error instanceof Error ? error.message : "Thread executor attempt failed",
                  this.#clock.now(),
                ),
          executor: this.#executorMetadata(lease),
          startedAt,
          completedAt: this.#clock.now().toISOString(),
        };
        this.#decide(entry, candidate);
      }
    } finally {
      if (entry.forced === undefined) await Promise.all(admissionSettlements);
      const termination = lease === undefined ? undefined : await this.#terminate(lease);
      channel?.close();
      delete entry.lease;
      delete entry.channel;
      delete entry.transfer;
      delete entry.forced;
      if (entry.decision === undefined) {
        this.#decide(
          entry,
          termination?.diagnostic !== undefined
            ? this.#terminationFailureResult(entry, termination.diagnostic, lease, startedAt)
            : entry.cancellation === undefined
              ? (candidate ?? {
                  taskId: entry.request.taskId,
                  attemptId: entry.request.attemptId,
                  status: "failed",
                  diagnostic: diagnostic(
                    "EXECUTOR_THREAD_EXIT",
                    "Thread executor attempt ended without a result",
                    this.#clock.now(),
                  ),
                  executor: this.#executorMetadata(lease),
                  startedAt,
                  completedAt: this.#clock.now().toISOString(),
                })
              : this.#cancelledResult(entry, entry.cancellation),
        );
      }
    }
  }

  async #resolve(request: ExecutionRequest): Promise<ResolvedThreadComponent> {
    const resolved = await this.#options.resolveComponent(request);
    const artifactDigest = parseArtifactDigest(resolved.artifactDigest);
    const manifest = parsePluginManifest(resolved.manifest);
    if (!isAbsolute(resolved.artifactRoot)) {
      throw executorError(
        "ARTIFACT_ENTRY_OUTSIDE_ROOT",
        "Resolved thread artifact root must be absolute",
        this.#clock.now(),
      );
    }
    if (manifest.pluginId !== request.pluginId) {
      throw executorError(
        "EXECUTOR_REQUEST_IDENTITY_MISMATCH",
        "Resolved plugin does not match the execution request",
        this.#clock.now(),
      );
    }
    const component = manifest.components.find(
      (candidate) => candidate.componentId === request.componentId,
    );
    if (component === undefined || !component.executors.includes("thread")) {
      throw executorError(
        "EXECUTOR_COMPONENT_UNSUPPORTED",
        "Component does not support thread execution",
        this.#clock.now(),
      );
    }
    const grantDecision = this.#options.permissionBoundary?.validateGrant(
      manifest.permissions,
      resolved.permissionGrants,
    );
    if (grantDecision !== undefined && !grantDecision.allowed) {
      throw executorError(
        "PERMISSION_GRANT_EXCEEDS_REQUEST",
        grantDecision.diagnostics[0]?.message ?? "Permission grant is invalid",
        this.#clock.now(),
      );
    }
    const threadGranted = resolved.permissionGrants.some(
      (permission) => permission.kind === "executor" && permission.executors.includes("thread"),
    );
    const executorDecision = this.#options.permissionBoundary?.authorize(
      resolved.permissionGrants,
      { kind: "executor", executor: "thread" },
    );
    if (!threadGranted || executorDecision?.allowed === false) {
      throw executorError(
        "PERMISSION_EXECUTOR_DENIED",
        "Thread execution is not granted",
        this.#clock.now(),
      );
    }
    return deepFreeze({
      artifactDigest,
      artifactRoot: resolved.artifactRoot,
      manifest: structuredClone(manifest),
      runtimeId: resolved.runtimeId,
      instanceId: resolved.instanceId,
      configuration: structuredClone(resolved.configuration),
      permissionGrants: structuredClone(resolved.permissionGrants),
      capabilityDefinitions: structuredClone(resolved.capabilityDefinitions),
    });
  }

  #artifactCommand(
    type: "import" | "start" | "drain" | "stop",
    commandId: string,
    deadline: string,
    artifactDigest: ArtifactDigest,
  ): ComponentHostCommand {
    return {
      protocol: COMPONENT_HOST_PROTOCOL,
      commandId,
      deadline,
      type,
      payload: { artifactDigest },
    };
  }

  async #hostCommand(
    channel: ThreadChannel,
    command: ComponentHostCommand,
    attachments: readonly ArrayBuffer[] = [],
  ): Promise<ComponentHostResult> {
    const result = parseComponentHostResult(
      await channel.request(
        {
          kind: "command",
          command,
          ...(attachments.length === 0 ? {} : { attachments }),
        },
        attachments,
      ),
    );
    if (!result.ok) {
      const first = result.diagnostics[0];
      if (command.type === "run" && first?.code === "PROTOCOL_COMPONENT_HOST_COMMAND_INVALID") {
        throw executorError(
          "EXECUTOR_OUTPUT_LIMIT_EXCEEDED",
          "Component output exceeds the executor wire limit",
          this.#clock.now(),
        );
      }
      throw new DiagnosticError(
        first ??
          diagnostic(
            "EXECUTOR_COMPONENT_HOST_FAILED",
            "Component host command failed",
            this.#clock.now(),
          ),
      );
    }
    return result;
  }

  async #shutdownWorker(
    channel: ThreadChannel,
    lease: WorkerLease,
    artifactDigest: ArtifactDigest,
    deadline: string,
  ): Promise<void> {
    const lifecycle = (async () => {
      await this.#hostCommand(
        channel,
        this.#artifactCommand("drain", "drain", deadline, artifactDigest),
      ).catch(() => undefined);
      await this.#hostCommand(
        channel,
        this.#artifactCommand("stop", "stop", deadline, artifactDigest),
      ).catch(() => undefined);
    })();
    await this.#withinCleanupGrace(lifecycle);
    channel.close();
    const termination = await this.#terminate(lease);
    if (termination.diagnostic !== undefined) {
      throw new DiagnosticError(termination.diagnostic);
    }
  }

  async #withinCleanupGrace(operation: Promise<unknown>): Promise<boolean> {
    const controller = new AbortController();
    try {
      return await Promise.race([
        operation.then(
          () => true,
          () => true,
        ),
        this.#clock.sleep(this.#cleanupGraceMs, controller.signal).then(() => false),
      ]);
    } finally {
      controller.abort("cleanup-complete");
    }
  }

  #armDeadline(entry: AttemptEntry): void {
    void this.#waitUntilDeadline(entry.request.deadline, entry.deadlineController.signal)
      .then(() => this.#requestCancellation(entry, "timed-out"))
      .catch(() => undefined);
  }

  async #waitUntilDeadline(deadline: string, signal: AbortSignal): Promise<void> {
    const deadlineTime = Date.parse(deadline);
    while (true) {
      const remaining = deadlineTime - this.#clock.now().getTime();
      if (remaining <= 0) return;
      await this.#clock.sleep(Math.min(remaining, MAX_CLOCK_SLEEP_MS), signal);
    }
  }

  async #requestCancellation(
    entry: AttemptEntry,
    cancellation: "cancelled" | "timed-out",
  ): Promise<void> {
    if (entry.state === "terminal" || entry.decision !== undefined) return;
    entry.cancellation ??= cancellation;
    entry.admissionController.abort(entry.cancellation);
    if (entry.state === "accepted") {
      const index = this.#queue.indexOf(entry);
      if (index >= 0) this.#queue.splice(index, 1);
      delete entry.transfer;
      this.#settle(entry, this.#cancelledResult(entry, entry.cancellation));
      if (entry.terminal !== undefined) entry.result.resolve(entry.terminal);
      entry.completed.resolve();
      return;
    }
    const channel = entry.channel;
    if (channel !== undefined && entry.cancellationSent !== true) {
      entry.cancellationSent = true;
      void channel
        .request({
          kind: "command",
          command: {
            protocol: COMPONENT_HOST_PROTOCOL,
            commandId: `cancel-${entry.request.attemptId}`,
            deadline: new Date(this.#clock.now().getTime() + 86_400_000).toISOString(),
            type: "cancel",
            payload: {
              taskId: entry.request.taskId,
              attemptId: entry.request.attemptId,
              reason: entry.cancellation,
            },
          },
        })
        .catch(() => undefined);
    }
    entry.cancellationEscalation ??= this.#clock
      .sleep(this.#cancellationGraceMs, entry.deadlineController.signal)
      .then(async () => {
        if (entry.state === "terminal" || entry.lease === undefined) return;
        const termination = await this.#terminate(entry.lease);
        if (termination.diagnostic !== undefined) {
          entry.channel?.abort(new DiagnosticError(termination.diagnostic));
        }
      })
      .catch(() => undefined);
  }

  #cancelledResult(entry: AttemptEntry, status: "cancelled" | "timed-out"): ExecutionResult {
    const now = this.#clock.now().toISOString();
    return {
      taskId: entry.request.taskId,
      attemptId: entry.request.attemptId,
      status,
      executor: {
        kind: "thread",
        metadata: { executorId: this.id, securityIsolation: false },
      },
      startedAt: now,
      completedAt: now,
    };
  }

  #decide(entry: AttemptEntry, result: ExecutionResult): boolean {
    if (entry.decision !== undefined) return false;
    entry.deadlineController.abort("terminal");
    entry.admissionController.abort("terminal");
    entry.decision = deepFreeze(parseExecutionResult(cloneComponentHostValue(result)));
    return true;
  }

  #publish(entry: AttemptEntry): boolean {
    if (entry.state === "terminal") return false;
    if (entry.decision === undefined) {
      throw new Error("Thread attempt decision is missing");
    }
    entry.state = "terminal";
    entry.terminal = entry.decision;
    return true;
  }

  #settle(entry: AttemptEntry, result: ExecutionResult): boolean {
    if (!this.#decide(entry, result)) return false;
    return this.#publish(entry);
  }

  #lease(worker: ThreadWorker): WorkerLease {
    const exit = Promise.withResolvers<{ readonly code?: number; readonly error?: Error }>();
    let error: Error | undefined;
    worker.once("error", (value) => {
      error = value instanceof Error ? value : new Error(String(value));
    });
    worker.once("exit", (value) => {
      const code = typeof value === "number" ? value : undefined;
      exit.resolve({
        ...(code === undefined ? {} : { code }),
        ...(error === undefined ? {} : { error }),
      });
    });
    return { worker, exited: exit.promise };
  }

  async #terminate(lease: WorkerLease): Promise<ThreadTerminationOutcome> {
    const existing = this.#termination.get(lease.worker);
    if (existing !== undefined) return existing;
    const terminating = (async () => {
      const timeoutController = new AbortController();
      const timeout = this.#clock
        .sleep(this.#cleanupGraceMs, timeoutController.signal)
        .then(() => ({ kind: "timeout" as const }));
      const exit = lease.exited.then((value) => ({ kind: "exit" as const, value }));
      const termination = Promise.resolve()
        .then(() => lease.worker.terminate())
        .then(
          () => ({ kind: "terminated" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
      const first = await Promise.race([exit, termination, timeout]);
      if (first.kind === "exit") {
        timeoutController.abort("worker-exited");
        return { settled: Promise.resolve() };
      }
      if (first.kind === "terminated") {
        const settled = await Promise.race([exit, timeout]);
        if (settled.kind === "exit") {
          timeoutController.abort("worker-exited");
          return { settled: Promise.resolve() };
        }
      }
      timeoutController.abort("worker-quarantined");
      const message =
        first.kind === "rejected" && first.error instanceof Error
          ? first.error.message
          : "Worker thread termination did not settle before its cleanup deadline";
      return this.#enterFatalQuarantine(
        diagnostic("EXECUTOR_THREAD_TERMINATION_FAILED", message, this.#clock.now()),
        lease,
      );
    })();
    this.#termination.set(lease.worker, terminating);
    return terminating;
  }

  #enterFatalQuarantine(failure: RuntimeDiagnostic, lease: WorkerLease): ThreadTerminationOutcome {
    const existing = this.#quarantineSettlements.get(lease);
    if (existing !== undefined) {
      return {
        ...(this.#fatalDiagnostic === undefined ? {} : { diagnostic: this.#fatalDiagnostic }),
        settled: existing,
      };
    }
    const transitioning = this.#fatalDiagnostic === undefined;
    this.#fatalDiagnostic ??= failure;
    const fatal = this.#fatalDiagnostic;
    this.#accepting = false;
    this.#quarantined.add(lease);
    const settled = lease.exited.then(() => {
      this.#quarantined.delete(lease);
      this.#quarantineSettlements.delete(lease);
    });
    this.#quarantineSettlements.set(lease, settled);
    this.#settleAdmissions(fatal);
    if (transitioning) {
      try {
        this.#options.logger?.error(fatal.message, fatal);
      } catch {
        // Quarantine must not depend on a logger.
      }
    }
    return { diagnostic: fatal, settled };
  }

  #terminationFailureResult(
    entry: AttemptEntry,
    failure: RuntimeDiagnostic,
    lease: WorkerLease | undefined,
    startedAt: string,
  ): ExecutionResult {
    return {
      taskId: entry.request.taskId,
      attemptId: entry.request.attemptId,
      status: "failed",
      diagnostic: failure,
      executor: this.#executorMetadata(lease),
      startedAt,
      completedAt: this.#clock.now().toISOString(),
    };
  }

  #fatalResult(entry: AttemptEntry, failure: RuntimeDiagnostic): ExecutionResult {
    const now = this.#clock.now().toISOString();
    return {
      taskId: entry.request.taskId,
      attemptId: entry.request.attemptId,
      status: "failed",
      diagnostic: failure,
      executor: {
        kind: "thread",
        metadata: { executorId: this.id, securityIsolation: false },
      },
      startedAt: now,
      completedAt: now,
    };
  }

  #raceAdmission<T>(entry: AttemptEntry, operation: Promise<T>): AdmissionOperation<T> {
    const signal = entry.admissionController.signal;
    const outcome = Promise.withResolvers<AdmissionRace<T>>();
    const settled = Promise.withResolvers<void>();
    let waiting = true;
    const cleanup = () => signal.removeEventListener("abort", cancel);
    const cancel = () => {
      if (!waiting) return;
      waiting = false;
      cleanup();
      outcome.resolve({ cancelled: true });
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    void operation.then(
      (value) => {
        if (waiting) {
          waiting = false;
          cleanup();
          outcome.resolve({ cancelled: false, value });
        }
        settled.resolve();
      },
      (error: unknown) => {
        if (waiting) {
          waiting = false;
          cleanup();
          outcome.reject(error);
        }
        settled.resolve();
      },
    );
    return { outcome: outcome.promise, settled: settled.promise };
  }

  #settleAdmissions(failure: RuntimeDiagnostic): void {
    this.#queue.splice(0);
    for (const entry of this.#attempts.values()) {
      if (entry.state === "terminal" || entry.channel !== undefined || entry.lease !== undefined) {
        continue;
      }
      const queued = entry.state === "accepted";
      delete entry.transfer;
      const fatal = this.#fatalResult(entry, failure);
      if (queued) {
        this.#settle(entry, fatal);
      } else {
        entry.forced ??= fatal;
        this.#decide(entry, entry.forced);
      }
      if (queued) {
        if (entry.terminal !== undefined) entry.result.resolve(entry.terminal);
        entry.completed.resolve();
      }
    }
  }

  #executorMetadata(lease: WorkerLease | undefined): ExecutionResult["executor"] {
    return {
      kind: "thread",
      metadata: {
        executorId: this.id,
        securityIsolation: false,
        ...(lease?.worker.threadId === undefined ? {} : { threadId: lease.worker.threadId }),
      },
    };
  }

  #isThreadExecutionRequest(
    input: ExecutionRequest | ThreadExecutionRequest,
  ): ThreadExecutionRequest | undefined {
    return typeof input === "object" &&
      input !== null &&
      threadExecutionRequests.has(input as ThreadExecutionRequest)
      ? (input as ThreadExecutionRequest)
      : undefined;
  }

  #transferFingerprint(request: ThreadExecutionRequest, allowCached: boolean): string {
    const { transfer } = request;
    if (allowCached && transfer.ownership === "transfer") {
      const cached = threadTransferFingerprints.get(request);
      if (cached !== undefined) return cached;
    }
    if (transfer.ownership !== "clone" && transfer.ownership !== "transfer") {
      throw executorError(
        "EXECUTOR_THREAD_TRANSFER_INVALID",
        "Thread transfer ownership must be clone or transfer",
        this.#clock.now(),
      );
    }
    const seen = new Set<ArrayBuffer>();
    let bytes = 0;
    for (const buffer of transfer.buffers) {
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
        throw executorError(
          "EXECUTOR_THREAD_TRANSFER_INVALID",
          "Thread transfer buffers must be attached, non-empty ArrayBuffers",
          this.#clock.now(),
        );
      }
      if (seen.has(buffer)) {
        throw executorError(
          "EXECUTOR_THREAD_TRANSFER_INVALID",
          "Thread transfer list contains a duplicate buffer",
          this.#clock.now(),
        );
      }
      seen.add(buffer);
      bytes += buffer.byteLength;
      if (bytes > THREAD_EXECUTOR_MAX_MESSAGE_BYTES) {
        throw executorError(
          "EXECUTOR_INPUT_LIMIT_EXCEEDED",
          "Thread transfer buffers exceed the configured wire limit",
          this.#clock.now(),
        );
      }
    }
    const hash = createHash("sha256");
    hash.update(`${transfer.ownership}\0`);
    const count = Buffer.allocUnsafe(4);
    count.writeUInt32BE(transfer.buffers.length);
    hash.update(count);
    for (const buffer of transfer.buffers) {
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(buffer.byteLength);
      hash.update(length);
      hash.update(new Uint8Array(buffer));
    }
    return hash.digest("hex");
  }

  #validateRunEnvelope(request: ExecutionRequest, attachments: readonly ArrayBuffer[]): void {
    validateThreadMessage(
      {
        kind: "command",
        id: "message-99999999999999999999",
        command: {
          protocol: COMPONENT_HOST_PROTOCOL,
          commandId: "run",
          deadline: request.deadline,
          type: "run",
          payload: {
            artifactDigest: `sha256:${"0".repeat(64)}`,
            execution: request,
          },
        },
        ...(attachments.length === 0 ? {} : { attachments }),
      },
      "EXECUTOR_INPUT_LIMIT_EXCEEDED",
    );
  }

  #claimTransfer(transfer: ThreadTransferOptions): readonly ArrayBuffer[] {
    try {
      return transfer.buffers.map((buffer) =>
        transfer.ownership === "transfer"
          ? structuredClone(buffer, { transfer: [buffer] })
          : buffer.slice(0),
      );
    } catch (error) {
      throw executorError(
        "EXECUTOR_THREAD_TRANSFER_INVALID",
        error instanceof Error ? error.message : "Thread transfer ownership could not be claimed",
        this.#clock.now(),
      );
    }
  }

  #touch(entry: AttemptEntry): void {
    this.#attempts.delete(entry.key);
    this.#attempts.set(entry.key, entry);
  }

  #pruneTerminal(): void {
    while (this.#attempts.size >= THREAD_EXECUTOR_MAX_RETAINED_ATTEMPTS) {
      const terminal = [...this.#attempts].find(([, entry]) => entry.state === "terminal");
      if (terminal === undefined) return;
      this.#attempts.delete(terminal[0]);
    }
  }
}
