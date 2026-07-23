import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
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
  type HostedProcess,
  type JsonValue,
  type Permission,
  type PluginManifest,
  type ProcessHost,
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
import { authenticateProcessMessage, signProcessMessage } from "./authentication.js";
import { ProcessFrameDecoder, encodeProcessFrame } from "./framing.js";

export const PROCESS_EXECUTOR_MAX_RETAINED_ATTEMPTS = 256;
export const PROCESS_EXECUTOR_MAX_QUEUE = 256;
export const PROCESS_EXECUTOR_MAX_CONCURRENCY = 64;
export const PROCESS_EXECUTOR_MAX_STDERR_BYTES = 64 * 1024;
const PROCESS_CHANNEL_MAX_PENDING = 64;
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

export interface ResolvedProcessComponent {
  readonly artifactDigest: ArtifactDigest;
  readonly artifactRoot: string;
  readonly manifest: PluginManifest;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly configuration: JsonValue;
  readonly permissionGrants: readonly Permission[];
  readonly capabilityDefinitions: readonly CapabilityDefinition[];
}

export interface ProcessExecutorLogger {
  debug(...values: readonly unknown[]): void;
  error(...values: readonly unknown[]): void;
  info(...values: readonly unknown[]): void;
  warn(...values: readonly unknown[]): void;
}

export interface ProcessExecutorOptions {
  readonly id: string;
  readonly processHost: ProcessHost;
  readonly resolveComponent: (
    request: ExecutionRequest,
  ) => ResolvedProcessComponent | Promise<ResolvedProcessComponent>;
  readonly clock?: Clock;
  readonly maxConcurrency?: number;
  readonly maxQueue?: number;
  readonly cancellationGraceMs?: number;
  readonly cleanupGraceMs?: number;
  readonly processEntrypoint?: string;
  readonly permissionBoundary?: ComponentPermissionBoundary;
  readonly capabilityBoundary?: ComponentCapabilityBoundary;
  readonly secretProvider?: SecretProvider;
  readonly logger?: ProcessExecutorLogger;
  readonly events?: {
    emit(type: string, payload: JsonValue): Promise<void>;
  };
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
  terminal?: ExecutionResult;
  process?: HostedProcess;
  channel?: ProcessChannel;
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
  readonly level?: keyof ProcessExecutorLogger;
  readonly values?: readonly unknown[];
}

interface TerminationOutcome {
  readonly exit?: Awaited<ReturnType<HostedProcess["kill"]>>;
  readonly diagnostic?: RuntimeDiagnostic;
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
    source: { kind: "executor", id: "process" },
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

function incoming(input: unknown): IncomingMessage {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Child process message must be an object");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.kind !== "string") throw new Error("Child process message kind is invalid");
  return {
    kind: value.kind,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(value.payload === undefined ? {} : { payload: value.payload as JsonValue }),
    ...(typeof value.level === "string"
      ? { level: value.level as keyof ProcessExecutorLogger }
      : {}),
    ...(Array.isArray(value.values) ? { values: value.values } : {}),
  };
}

function boundedStderr(value: string, secrets: ReadonlySet<string>): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  redacted = redacted
    .replace(
      /(["']?(?:credential|password|secret|token)["']?\s*[:=]\s*)[^\s,;}]+/giu,
      "$1[REDACTED]",
    )
    .replaceAll("\0", "");
  return Buffer.byteLength(redacted, "utf8") <= PROCESS_EXECUTOR_MAX_STDERR_BYTES
    ? redacted
    : `${Buffer.from(redacted).subarray(0, PROCESS_EXECUTOR_MAX_STDERR_BYTES).toString("utf8")}[TRUNCATED]`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

class ProcessChannel {
  readonly #process: HostedProcess;
  readonly #options: ProcessExecutorOptions;
  readonly #component: ResolvedProcessComponent;
  readonly #channelKey = randomBytes(32);
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
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  #nextId = 0;
  #writeChain = Promise.resolve();
  #closedError: Error | undefined;
  #stderr = "";
  #authenticationActive = false;
  #outboundSequence = 0;
  #inboundSequence = 0;
  readonly #secretValues = new Set<string>();

  constructor(
    process_: HostedProcess,
    options: ProcessExecutorOptions,
    component: ResolvedProcessComponent,
  ) {
    this.#process = process_;
    this.#options = options;
    this.#component = component;
    for (const definition of component.capabilityDefinitions) {
      this.#capabilityValidators.set(this.#capabilityKey(definition.identity), {
        request: compileSchemaValidator<JsonValue>(definition.requestSchema),
        response: compileSchemaValidator<JsonValue>(definition.responseSchema),
      });
    }
    void this.#readStdout();
    void this.#readStderr();
    void process_.wait().then((exit) => {
      this.#fail(
        new Error(
          `Child process exited${exit.code === undefined ? "" : ` with code ${exit.code}`}${
            exit.signal === undefined ? "" : ` after ${exit.signal}`
          }`,
        ),
      );
    });
  }

  get stderr(): string {
    return boundedStderr(this.#stderr, this.#secretValues);
  }

  abort(error: Error): void {
    this.#fail(error);
  }

  request(message: Record<string, unknown>): Promise<unknown> {
    if (this.#closedError !== undefined) return Promise.reject(this.#closedError);
    if (this.#pending.size >= PROCESS_CHANNEL_MAX_PENDING) {
      return Promise.reject(new Error("Process channel pending request capacity is exhausted"));
    }
    const id = `message-${++this.#nextId}`;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const bootstrap = message.kind === "bootstrap";
      if (bootstrap && this.#authenticationActive) {
        this.#pending.delete(id);
        reject(new Error("Process channel is already bootstrapped"));
        return;
      }
      const value = bootstrap
        ? { ...message, id, channelKey: this.#channelKey.toString("hex") }
        : { ...message, id };
      if (bootstrap) this.#authenticationActive = true;
      const written = this.#write(value, bootstrap);
      void written.catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async #readStdout(): Promise<void> {
    const decoder = new ProcessFrameDecoder();
    try {
      for await (const chunk of this.#process.stdout) {
        for (const value of decoder.push(chunk)) {
          const authenticated = authenticateProcessMessage(
            this.#channelKey,
            "child-to-parent",
            this.#inboundSequence++,
            value,
          );
          await this.#dispatch(incoming(authenticated));
        }
      }
      decoder.finish();
      this.#fail(new Error("Child process stdout closed"));
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #readStderr(): Promise<void> {
    try {
      for await (const chunk of this.#process.stderr) {
        const used = Buffer.byteLength(this.#stderr, "utf8");
        if (used >= PROCESS_EXECUTOR_MAX_STDERR_BYTES) continue;
        this.#stderr += Buffer.from(chunk)
          .subarray(0, PROCESS_EXECUTOR_MAX_STDERR_BYTES - used)
          .toString("utf8");
      }
    } catch {
      // stderr is diagnostic-only; process exit remains authoritative.
    }
  }

  async #dispatch(message: IncomingMessage): Promise<void> {
    if (message.kind === "response" || message.kind === "response-error") {
      if (message.id === undefined) throw new Error("Child response identity is missing");
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.kind === "response-error") {
        pending.reject(
          executorError(
            message.code === "EXECUTOR_OUTPUT_LIMIT_EXCEEDED"
              ? "EXECUTOR_OUTPUT_LIMIT_EXCEEDED"
              : "PROTOCOL_PROCESS_FRAME_INVALID",
            message.message ?? "Child response failed",
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
      const level = message.level;
      if (level !== undefined && ["debug", "error", "info", "warn"].includes(level)) {
        this.#options.logger?.[level](...(message.values ?? []));
      }
      return;
    }
    if (message.kind === "event" && message.type !== undefined && message.payload !== undefined) {
      await this.#options.events?.emit(message.type, message.payload);
      return;
    }
    if (message.kind === "fatal") {
      throw new Error(message.message ?? "Child process protocol failed");
    }
    throw new Error("Child process message kind is unsupported");
  }

  async #rpc(message: IncomingMessage): Promise<void> {
    if (message.id === undefined || message.type === undefined || message.payload === undefined) {
      throw new Error("Child RPC message is invalid");
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
        if (typeof value === "string" && value.length > 0) this.#secretValues.add(value);
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
        throw new Error("Child RPC type is unsupported");
      }
      await this.#write({
        kind: "rpc-response",
        id: message.id,
        ok: true,
        ...(value === undefined ? {} : { value }),
      });
    } catch (error) {
      await this.#write({
        kind: "rpc-response",
        id: message.id,
        ok: false,
        message: error instanceof Error ? error.message : "Parent RPC failed",
      });
    }
  }

  #write(message: Record<string, unknown>, unsigned = false): Promise<void> {
    const value = unsigned
      ? message
      : signProcessMessage(this.#channelKey, "parent-to-child", this.#outboundSequence++, message);
    const frame = encodeProcessFrame(value, "EXECUTOR_INPUT_LIMIT_EXCEEDED");
    const written = this.#writeChain.then(() => this.#process.stdin.write(frame));
    this.#writeChain = written.catch(() => undefined);
    return written;
  }

  #exactPayload(input: unknown, fields: readonly string[]): Record<string, JsonValue> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("Child RPC payload must be an object");
    }
    const payload = input as Record<string, JsonValue>;
    const keys = Object.keys(payload);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !Object.hasOwn(payload, field)) ||
      keys.some((field) => !fields.includes(field))
    ) {
      throw new Error("Child RPC payload fields are invalid");
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
  }
}

export class ProcessExecutor implements Executor {
  readonly id: string;
  readonly type = "process" as const;
  readonly #options: ProcessExecutorOptions;
  readonly #clock: Clock;
  readonly #maxConcurrency: number;
  readonly #maxQueue: number;
  readonly #cancellationGraceMs: number;
  readonly #cleanupGraceMs: number;
  readonly #processEntrypoint: string;
  readonly #attempts = new Map<string, AttemptEntry>();
  readonly #queue: AttemptEntry[] = [];
  readonly #quarantinedProcesses = new Set<HostedProcess>();
  #active = 0;
  #accepting = true;
  #opened = false;
  #openPromise: Promise<void> | undefined;
  #drainPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #fatalDiagnostic: RuntimeDiagnostic | undefined;

  constructor(options: ProcessExecutorOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.id)) {
      throw new TypeError("Process executor identity is invalid");
    }
    const maxConcurrency = options.maxConcurrency ?? 1;
    const maxQueue = options.maxQueue ?? PROCESS_EXECUTOR_MAX_QUEUE;
    const cancellationGraceMs = options.cancellationGraceMs ?? 1_000;
    const cleanupGraceMs = options.cleanupGraceMs ?? cancellationGraceMs;
    if (
      !Number.isInteger(maxConcurrency) ||
      maxConcurrency < 1 ||
      maxConcurrency > PROCESS_EXECUTOR_MAX_CONCURRENCY
    ) {
      throw new RangeError("maxConcurrency is outside the supported bound");
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > PROCESS_EXECUTOR_MAX_QUEUE) {
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
    this.#maxConcurrency = maxConcurrency;
    this.#maxQueue = maxQueue;
    this.#cancellationGraceMs = cancellationGraceMs;
    this.#cleanupGraceMs = cleanupGraceMs;
    this.#processEntrypoint =
      options.processEntrypoint ?? fileURLToPath(new URL("./process-entry.js", import.meta.url));
  }

  async probe(): Promise<ExecutorCapabilities> {
    await this.#ensureOpen();
    const health = await this.#options.processHost.health();
    const available =
      this.#accepting && this.#fatalDiagnostic === undefined && health.status !== "unhealthy";
    return {
      id: this.id,
      type: this.type,
      available,
      maxConcurrency: this.#maxConcurrency,
      availableCapacity: available ? Math.max(0, this.#maxConcurrency - this.#active) : 0,
      securityIsolation: true,
    };
  }

  async submit(input: ExecutionRequest): Promise<ExecutionHandle> {
    const parsed = parseExecutionRequest(input);
    // Validate the public command against the wire limit before resolver or plugin work.
    encodeProcessFrame({ kind: "execution", request: parsed }, "EXECUTOR_INPUT_LIMIT_EXCEEDED");
    const request = deepFreeze(parseExecutionRequest(cloneComponentHostValue(parsed)));
    const key = attemptKey(request.taskId, request.attemptId);
    const fingerprint = JSON.stringify(request);
    const existing = this.#attempts.get(key);
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
    if (!this.#accepting) {
      throw executorError(
        "EXECUTOR_DRAINING",
        "Process executor is draining and refuses new submissions",
        this.#clock.now(),
      );
    }
    this.#pruneTerminal();
    if (this.#attempts.size >= PROCESS_EXECUTOR_MAX_RETAINED_ATTEMPTS) {
      throw executorError(
        "EXECUTOR_ATTEMPT_CAPACITY_EXCEEDED",
        "Process executor attempt retention is exhausted",
        this.#clock.now(),
      );
    }
    if (this.#active + this.#queue.length >= this.#maxConcurrency + this.#maxQueue) {
      throw executorError(
        "EXECUTOR_QUEUE_CAPACITY_EXCEEDED",
        "Process executor submission queue is full",
        this.#clock.now(),
      );
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
    const hostHealth = await this.#options.processHost.health();
    return {
      status: this.#fatalDiagnostic === undefined ? hostHealth.status : "unhealthy",
      checkedAt: this.#clock.now().toISOString(),
      ...(this.#fatalDiagnostic === undefined
        ? hostHealth.message === undefined
          ? {}
          : { message: hostHealth.message }
        : {
            message: `${this.#fatalDiagnostic.code}: ${this.#fatalDiagnostic.message}`,
          }),
      id: this.id,
      type: this.type,
      accepting: this.#accepting,
      active: this.#active + this.#quarantinedProcesses.size,
      queued: this.#queue.length,
      retainedAttempts: this.#attempts.size,
    };
  }

  #ensureOpen(): Promise<void> {
    if (this.#opened) return Promise.resolve();
    this.#openPromise ??= this.#options.processHost.open().then(() => {
      this.#opened = true;
    });
    return this.#openPromise;
  }

  async #schedule(): Promise<void> {
    if (this.#fatalDiagnostic !== undefined) {
      this.#failQueued(this.#fatalDiagnostic);
      return;
    }
    try {
      await this.#ensureOpen();
    } catch (error) {
      for (const entry of this.#queue.splice(0)) {
        const now = this.#clock.now().toISOString();
        const failure: ExecutionResult = {
          taskId: entry.request.taskId,
          attemptId: entry.request.attemptId,
          status: "failed",
          diagnostic:
            error instanceof DiagnosticError
              ? error.diagnostic
              : diagnostic(
                  "EXECUTOR_PROCESS_HOST_OPEN_FAILED",
                  error instanceof Error ? error.message : "Process host failed to open",
                  this.#clock.now(),
                ),
          executor: { kind: "process", metadata: { executorId: this.id } },
          startedAt: now,
          completedAt: now,
        };
        this.#settle(entry, failure);
        if (entry.terminal !== undefined) entry.result.resolve(entry.terminal);
        entry.completed.resolve();
      }
      return;
    }
    while (this.#active < this.#maxConcurrency) {
      if (this.#fatalDiagnostic !== undefined) {
        this.#failQueued(this.#fatalDiagnostic);
        return;
      }
      const entry = this.#queue.shift();
      if (entry === undefined) return;
      if (entry.state === "terminal") continue;
      this.#active += 1;
      entry.state = "running";
      void this.#run(entry).finally(() => {
        this.#active -= 1;
        if (entry.terminal !== undefined) entry.result.resolve(entry.terminal);
        entry.completed.resolve();
        void this.#schedule();
      });
    }
  }

  async #run(entry: AttemptEntry): Promise<void> {
    let process_: HostedProcess | undefined;
    let channel: ProcessChannel | undefined;
    let admissionSettlement = Promise.resolve();
    const startedAt = this.#clock.now().toISOString();
    try {
      const resolution = await this.#raceAdmission(entry, this.#resolve(entry.request)).outcome;
      if (resolution.cancelled) {
        this.#settle(entry, this.#cancelledResult(entry, entry.cancellation ?? "cancelled"));
        return;
      }
      const component = resolution.value;
      if (this.#fatalDiagnostic !== undefined) {
        this.#settleFatal(entry, this.#fatalDiagnostic);
        return;
      }
      if (entry.cancellation !== undefined) {
        this.#settle(entry, this.#cancelledResult(entry, entry.cancellation));
        return;
      }
      const spawnAdmission = this.#raceAdmission(
        entry,
        this.#options.processHost.spawn({
          entrypoint: this.#processEntrypoint,
          environment: {},
        }),
        async (lateProcess) => {
          await this.#terminate(lateProcess);
        },
      );
      admissionSettlement = spawnAdmission.settled;
      const spawning = await spawnAdmission.outcome;
      if (spawning.cancelled) {
        this.#settle(entry, this.#cancelledResult(entry, entry.cancellation ?? "cancelled"));
        return;
      }
      process_ = spawning.value;
      entry.process = process_;
      if (this.#fatalDiagnostic !== undefined) {
        await this.#terminate(process_);
        this.#settleFatal(entry, this.#fatalDiagnostic);
        return;
      }
      if (entry.cancellation !== undefined) {
        await this.#terminate(process_);
        this.#settle(entry, this.#cancelledResult(entry, entry.cancellation));
        return;
      }
      channel = new ProcessChannel(process_, this.#options, component);
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
        throw new Error("Child process bootstrap failed");
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
          runtime: { executor: "process", mode: "single-main" },
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
        this.#settle(entry, this.#cancelledResult(entry, entry.cancellation));
        return;
      }
      const run = await this.#hostCommand(channel, {
        protocol: COMPONENT_HOST_PROTOCOL,
        commandId: "run",
        deadline: entry.request.deadline,
        type: "run",
        payload: {
          artifactDigest: component.artifactDigest,
          execution: entry.request,
        },
      });
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
      this.#settle(entry, {
        taskId: entry.request.taskId,
        attemptId: entry.request.attemptId,
        status: status as ExecutionResult["status"],
        ...(resultValue.output === undefined ? {} : { output: resultValue.output }),
        executor: this.#executorMetadata(process_, channel),
        startedAt,
        completedAt: this.#clock.now().toISOString(),
      });
      await this.#shutdownChild(channel, process_, component.artifactDigest, controlDeadline);
    } catch (error) {
      if (entry.state !== "terminal") {
        const termination = process_ === undefined ? undefined : await this.#terminate(process_);
        const code =
          termination?.diagnostic !== undefined
            ? termination.diagnostic.code
            : error instanceof DiagnosticError
              ? error.diagnostic.code
              : process_ === undefined
                ? "EXECUTOR_PROCESS_SPAWN_FAILED"
                : "EXECUTOR_PROCESS_EXIT";
        const message =
          termination?.diagnostic?.message ??
          (error instanceof Error ? error.message : "Process executor attempt failed unexpectedly");
        this.#settle(entry, {
          taskId: entry.request.taskId,
          attemptId: entry.request.attemptId,
          status:
            termination?.diagnostic === undefined ? (entry.cancellation ?? "failed") : "failed",
          diagnostic:
            termination?.diagnostic ??
            (error instanceof DiagnosticError
              ? error.diagnostic
              : diagnostic(code, message, this.#clock.now(), {
                  ...(termination?.exit?.code === undefined
                    ? {}
                    : { exitCode: termination.exit.code }),
                  ...(termination?.exit?.signal === undefined
                    ? {}
                    : { signal: termination.exit.signal }),
                  ...(channel?.stderr.length === 0 ? {} : { stderr: channel?.stderr ?? "" }),
                })),
          executor: this.#executorMetadata(process_, channel),
          startedAt,
          completedAt: this.#clock.now().toISOString(),
        });
      }
    } finally {
      entry.deadlineController.abort("terminal");
      await admissionSettlement;
      if (process_ !== undefined) {
        await process_.stdin.close().catch(() => undefined);
        await this.#terminate(process_);
      }
      delete entry.process;
      delete entry.channel;
    }
  }

  async #resolve(request: ExecutionRequest): Promise<ResolvedProcessComponent> {
    const resolved = await this.#options.resolveComponent(request);
    const artifactDigest = parseArtifactDigest(resolved.artifactDigest);
    const manifest = parsePluginManifest(resolved.manifest);
    if (!isAbsolute(resolved.artifactRoot)) {
      throw executorError(
        "ARTIFACT_ENTRY_OUTSIDE_ROOT",
        "Resolved process artifact root must be absolute",
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
    if (component === undefined || !component.executors.includes("process")) {
      throw executorError(
        "EXECUTOR_COMPONENT_UNSUPPORTED",
        "Component does not support process execution",
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
    const processGranted = resolved.permissionGrants.some(
      (permission) => permission.kind === "executor" && permission.executors.includes("process"),
    );
    const executorDecision = this.#options.permissionBoundary?.authorize(
      resolved.permissionGrants,
      { kind: "executor", executor: "process" },
    );
    if (!processGranted || executorDecision?.allowed === false) {
      throw executorError(
        "PERMISSION_EXECUTOR_DENIED",
        "Process execution is not granted",
        this.#clock.now(),
      );
    }
    return { ...resolved, artifactDigest, manifest };
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
    channel: ProcessChannel,
    command: ComponentHostCommand,
  ): Promise<ComponentHostResult> {
    const result = parseComponentHostResult(await channel.request({ kind: "command", command }));
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

  async #shutdownChild(
    channel: ProcessChannel,
    process_: HostedProcess,
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
    if (!(await this.#withinCleanupGrace(lifecycle))) {
      await this.#terminate(process_);
      return;
    }
    await process_.stdin.close().catch(() => undefined);
    await process_.signal("SIGTERM").catch(() => undefined);
    if (!(await this.#withinCleanupGrace(process_.wait()))) {
      await this.#terminate(process_);
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
    if (entry.state === "terminal") return;
    entry.cancellation ??= cancellation;
    entry.admissionController.abort(entry.cancellation);
    if (entry.state === "accepted") {
      const index = this.#queue.indexOf(entry);
      if (index >= 0) this.#queue.splice(index, 1);
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
        if (entry.state === "terminal" || entry.process === undefined) return;
        const termination = await this.#terminate(entry.process);
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
      executor: { kind: "process", metadata: { executorId: this.id } },
      startedAt: now,
      completedAt: now,
    };
  }

  #settle(entry: AttemptEntry, result: ExecutionResult): boolean {
    if (entry.state === "terminal") return false;
    entry.state = "terminal";
    entry.deadlineController.abort("terminal");
    entry.admissionController.abort("terminal");
    entry.terminal = deepFreeze(parseExecutionResult(cloneComponentHostValue(result)));
    return true;
  }

  async #terminate(process_: HostedProcess): Promise<TerminationOutcome> {
    if (this.#quarantinedProcesses.has(process_)) {
      return {
        ...(this.#fatalDiagnostic === undefined ? {} : { diagnostic: this.#fatalDiagnostic }),
      };
    }
    try {
      return { exit: await process_.kill() };
    } catch (error) {
      const failure =
        error instanceof DiagnosticError && error.diagnostic.code === "EXECUTOR_PROCESS_KILL_FAILED"
          ? error.diagnostic
          : diagnostic(
              "EXECUTOR_PROCESS_KILL_FAILED",
              error instanceof Error ? error.message : "Forced process termination failed",
              this.#clock.now(),
            );
      this.#fatalDiagnostic ??= failure;
      this.#accepting = false;
      this.#quarantinedProcesses.add(process_);
      this.#failQueued(this.#fatalDiagnostic);
      try {
        this.#options.logger?.error(failure.message, failure);
      } catch {
        // Quarantine containment must not depend on a diagnostic sink.
      }
      void process_
        .wait()
        .then(() => {
          this.#quarantinedProcesses.delete(process_);
        })
        .catch(() => undefined);
      return { diagnostic: failure };
    }
  }

  #raceAdmission<T>(
    entry: AttemptEntry,
    operation: Promise<T>,
    onLateValue?: (value: T) => void | Promise<void>,
  ): AdmissionOperation<T> {
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
        if (!waiting) {
          void Promise.resolve(onLateValue?.(value)).then(settled.resolve, settled.resolve);
          return;
        }
        waiting = false;
        cleanup();
        outcome.resolve({ cancelled: false, value });
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
    return {
      outcome: outcome.promise,
      settled: settled.promise,
    };
  }

  #failQueued(failure: RuntimeDiagnostic): void {
    for (const entry of this.#queue.splice(0)) {
      if (entry.state === "terminal") continue;
      this.#settleFatal(entry, failure);
      if (entry.terminal !== undefined) entry.result.resolve(entry.terminal);
      entry.completed.resolve();
    }
  }

  #settleFatal(entry: AttemptEntry, failure: RuntimeDiagnostic): void {
    const now = this.#clock.now().toISOString();
    this.#settle(entry, {
      taskId: entry.request.taskId,
      attemptId: entry.request.attemptId,
      status: "failed",
      diagnostic: failure,
      executor: { kind: "process", metadata: { executorId: this.id } },
      startedAt: now,
      completedAt: now,
    });
  }

  #executorMetadata(
    process_: HostedProcess | undefined,
    channel: ProcessChannel | undefined,
  ): ExecutionResult["executor"] {
    const stderr = channel?.stderr;
    return {
      kind: "process",
      metadata: {
        executorId: this.id,
        ...(process_?.pid === undefined ? {} : { pid: process_.pid }),
        ...(stderr === undefined || stderr.length === 0 ? {} : { stderr }),
      },
    };
  }

  #touch(entry: AttemptEntry): void {
    this.#attempts.delete(entry.key);
    this.#attempts.set(entry.key, entry);
  }

  #pruneTerminal(): void {
    while (this.#attempts.size >= PROCESS_EXECUTOR_MAX_RETAINED_ATTEMPTS) {
      const terminal = [...this.#attempts].find(([, entry]) => entry.state === "terminal");
      if (terminal === undefined) return;
      this.#attempts.delete(terminal[0]);
    }
  }
}
