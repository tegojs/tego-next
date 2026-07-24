import {
  parseApplicationId,
  parseAttemptId,
  parseComponentId,
  parsePluginId,
  parseTaskId,
  runtimeDiagnostic,
  type AttemptId,
  type AttemptStatus,
  type DrainOptions,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type ExecutorCapabilities,
  type ExecutorHealth,
  type JsonValue,
  type TaskId,
} from "@tegojs/contracts";
import type {
  RemoteSession,
  RemoteSessionMessage,
  RemoteSessionState,
} from "../src/index.js";

interface PendingRequest {
  readonly resolve: (message: RemoteSessionMessage) => void;
  readonly reject: (error: Error) => void;
}

export class MemoryRemoteSession implements RemoteSession {
  readonly epoch: string;
  #peer?: MemoryRemoteSession;
  #state: RemoteSessionState = "ready";
  #sequence = 0;
  readonly #listeners = new Set<(message: RemoteSessionMessage) => void>();
  readonly #stateListeners = new Set<(state: RemoteSessionState) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  #dropNext = false;
  #gate: Promise<void> | undefined;

  constructor(epoch: string) {
    this.epoch = epoch;
  }

  get state(): RemoteSessionState {
    return this.#state;
  }

  get available(): boolean {
    return this.#state === "ready";
  }

  get acceptingAssignments(): boolean {
    return this.#state === "ready";
  }

  link(peer: MemoryRemoteSession): void {
    this.#peer = peer;
  }

  onMessage(listener: (message: RemoteSessionMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onStateChange(listener: (state: RemoteSessionState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  async send(
    type: string,
    payload: JsonValue,
    options: { readonly correlationId?: string } = {},
  ): Promise<string> {
    const messageId = `message-${this.epoch}-${this.#sequence++}`;
    await this.#deliver({
      messageId,
      type,
      payload,
      ...(options.correlationId === undefined
        ? {}
        : { correlationId: options.correlationId }),
    });
    return messageId;
  }

  async request(type: string, payload: JsonValue): Promise<RemoteSessionMessage> {
    if (this.#state !== "ready") {
      throw new Error("session is closed");
    }
    const messageId = `message-${this.epoch}-${this.#sequence++}`;
    const pending = Promise.withResolvers<RemoteSessionMessage>();
    this.#pending.set(messageId, {
      resolve: pending.resolve,
      reject: pending.reject,
    });
    try {
      await this.#deliver({ messageId, type, payload });
    } catch (error) {
      this.#pending.delete(messageId);
      throw error;
    }
    return pending.promise;
  }

  dropNextMessage(): void {
    this.#dropNext = true;
  }

  gateNextMessage(gate: Promise<void>): void {
    this.#gate = gate;
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    for (const listener of this.#stateListeners) listener(this.#state);
    const error = new Error("session is closed");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#peer?.peerClosed();
  }

  peerClosed(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    for (const listener of this.#stateListeners) listener(this.#state);
    const error = new Error("session is closed");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async #deliver(message: RemoteSessionMessage): Promise<void> {
    if (this.#state !== "ready" || this.#peer?.state !== "ready") {
      throw new Error("session is closed");
    }
    if (this.#dropNext) {
      this.#dropNext = false;
      return;
    }
    const gate = this.#gate;
    this.#gate = undefined;
    await gate;
    queueMicrotask(() => {
      const peer = this.#peer;
      if (peer !== undefined) {
        peer.#receive(message);
      }
    });
  }

  #receive(message: RemoteSessionMessage): void {
    if (this.#state !== "ready") return;
    if (message.correlationId !== undefined) {
      const pending = this.#pending.get(message.correlationId);
      if (pending !== undefined) {
        this.#pending.delete(message.correlationId);
        pending.resolve(message);
        return;
      }
    }
    for (const listener of this.#listeners) listener(message);
  }
}

export function memorySessionPair(epoch: string): readonly [
  MemoryRemoteSession,
  MemoryRemoteSession,
] {
  const main = new MemoryRemoteSession(epoch);
  const worker = new MemoryRemoteSession(epoch);
  main.link(worker);
  worker.link(main);
  return [main, worker];
}

interface LocalAttempt {
  readonly request: ExecutionRequest;
  readonly handle: ExecutionHandle;
  readonly result: PromiseWithResolvers<ExecutionResult>;
  state: "accepted" | "running" | "terminal";
  terminal?: ExecutionResult;
}

export class TestLocalExecutor implements Executor {
  readonly id = "test-local";
  readonly type = "process" as const;
  readonly attempts = new Map<string, LocalAttempt>();
  active = 0;
  executions = 0;
  accepting = true;
  failSubmit = false;

  probe(): Promise<ExecutorCapabilities> {
    return Promise.resolve({
      id: this.id,
      type: this.type,
      available: this.accepting,
      maxConcurrency: 8,
      availableCapacity: this.accepting ? 8 - this.active : 0,
      securityIsolation: true,
    });
  }

  submit(request: ExecutionRequest): Promise<ExecutionHandle> {
    if (this.failSubmit) throw new Error("spawn failed");
    const key = attemptKey(request.taskId, request.attemptId);
    const existing = this.attempts.get(key);
    if (existing !== undefined) return Promise.resolve(existing.handle);
    this.executions += 1;
    this.active += 1;
    const result = Promise.withResolvers<ExecutionResult>();
    const handle = Object.freeze({
      taskId: request.taskId,
      attemptId: request.attemptId,
      result: result.promise,
    });
    const attempt: LocalAttempt = {
      request,
      handle,
      result,
      state: "running",
    };
    this.attempts.set(key, attempt);
    const input: Record<string, JsonValue> =
      typeof request.input === "object" && request.input !== null && !Array.isArray(request.input)
        ? (request.input as Record<string, JsonValue>)
        : {};
    const mode = "mode" in input ? input.mode : undefined;
    if (mode === "echo") {
      queueMicrotask(() => this.#complete(attempt, "succeeded", input.value));
    } else if (mode === "crash") {
      queueMicrotask(() => this.#complete(attempt, "failed"));
    } else if (mode === "large-output") {
      queueMicrotask(() => this.#complete(attempt, "succeeded", "x".repeat(2_000_000)));
    }
    return Promise.resolve(handle);
  }

  observe(taskId: TaskId, attemptId: AttemptId): Promise<AttemptStatus | undefined> {
    const attempt = this.attempts.get(attemptKey(taskId, attemptId));
    if (attempt === undefined) return Promise.resolve(undefined);
    if (attempt.terminal !== undefined) {
      return Promise.resolve({ state: "terminal", result: attempt.terminal });
    }
    return Promise.resolve({ state: attempt.state === "accepted" ? "accepted" : "running" });
  }

  cancel(taskId: TaskId, attemptId: AttemptId): Promise<void> {
    const attempt = this.attempts.get(attemptKey(taskId, attemptId));
    if (attempt !== undefined && attempt.terminal === undefined) {
      this.#complete(attempt, "cancelled");
    }
    return Promise.resolve();
  }

  async drain(_options: DrainOptions): Promise<void> {
    this.accepting = false;
    await Promise.all([...this.attempts.values()].map(async (attempt) => attempt.handle.result));
  }

  health(): Promise<ExecutorHealth> {
    return Promise.resolve({
      id: this.id,
      type: this.type,
      status: "healthy",
      checkedAt: new Date(0).toISOString(),
      accepting: this.accepting,
      active: this.active,
      queued: 0,
      retainedAttempts: this.attempts.size,
    });
  }

  close(): Promise<void> {
    return this.drain({});
  }

  #complete(
    attempt: LocalAttempt,
    status: ExecutionResult["status"],
    output?: JsonValue,
  ): void {
    if (attempt.terminal !== undefined) return;
    const result: ExecutionResult = {
      taskId: attempt.request.taskId,
      attemptId: attempt.request.attemptId,
      status,
      ...(output === undefined ? {} : { output }),
      ...(status === "failed"
        ? {
            diagnostic: runtimeDiagnostic({
              code: "EXECUTOR_TEST_FAILURE",
              message: "test executor failed",
              source: { kind: "executor", id: this.id },
              observedAt: new Date(0).toISOString(),
            }),
          }
        : {}),
      executor: { kind: "process" },
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
    };
    attempt.state = "terminal";
    attempt.terminal = result;
    this.active -= 1;
    attempt.result.resolve(result);
  }
}

function attemptKey(taskId: TaskId, attemptId: AttemptId): string {
  return `${taskId.length}:${taskId}${attemptId}`;
}

export function executionRequest(
  input: JsonValue,
  suffix: string,
  orphanPolicy: ExecutionRequest["orphanPolicy"] = "cancel",
): ExecutionRequest {
  return {
    taskId: parseTaskId(`remote-task-${suffix}`),
    attemptId: parseAttemptId(`remote-attempt-${suffix}`),
    applicationId: parseApplicationId("app"),
    pluginId: parsePluginId("org.example.remote"),
    componentId: parseComponentId("echo"),
    input,
    deadline: new Date(60_000).toISOString(),
    orphanPolicy,
  };
}

export async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
