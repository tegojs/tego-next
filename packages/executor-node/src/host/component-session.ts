import {
  type AttemptId,
  type AttemptStatus,
  type Clock,
  DiagnosticError,
  type DrainOptions,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type ExecutorCapabilities,
  type ExecutorHealth,
  type JsonValue,
  parseExecutionRequest,
  parseExecutionResult,
  parseTaskExecutionTarget,
  type RuntimeDiagnostic,
  runtimeDiagnostic,
  type TaskExecutionTarget,
  type TaskId,
} from "@tegojs/contracts";

export interface ComponentSessionRunResult {
  readonly status: Exclude<ExecutionResult["status"], "indeterminate">;
  readonly output?: JsonValue;
}

export interface ComponentSessionTransport {
  readonly executor: ExecutionResult["executor"];
  run(request: ExecutionRequest): Promise<ComponentSessionRunResult>;
  cancel(taskId: TaskId, attemptId: AttemptId, reason: "cancelled" | "timed-out"): Promise<void>;
  health(): Promise<{
    readonly status: ExecutorHealth["status"];
    readonly message?: string;
  }>;
  drain(): Promise<void>;
  close(): Promise<void>;
  terminate(): Promise<void>;
}

export interface ComponentSandboxSessionOptions {
  readonly id: string;
  readonly type: "process" | "thread";
  readonly target: TaskExecutionTarget;
  readonly identity: Pick<ExecutionRequest, "applicationId" | "componentId" | "pluginId">;
  readonly transport: ComponentSessionTransport;
  readonly clock: Clock;
  readonly maxConcurrency: number;
  readonly maxQueue: number;
  readonly maxRetainedAttempts?: number;
  readonly shutdownGraceMs: number;
}

interface SessionAttempt {
  readonly request: ExecutionRequest;
  readonly fingerprint: string;
  readonly handle: ExecutionHandle;
  readonly result: PromiseWithResolvers<ExecutionResult>;
  readonly completed: PromiseWithResolvers<void>;
  readonly deadlineController: AbortController;
  state: "accepted" | "running" | "terminal";
  cancellation?: "cancelled" | "timed-out";
  terminal?: ExecutionResult;
}

const MAX_CLOCK_SLEEP_MS = 2_147_483_647;
export const COMPONENT_SESSION_CONTROL_TIMEOUT_MS = 30_000;
export const COMPONENT_SESSION_MAX_RETAINED_ATTEMPTS = 256;

function attemptKey(taskId: TaskId, attemptId: AttemptId): string {
  return `${taskId.length}:${taskId}${attemptId}`;
}

export function taskExecutionTargetsEqual(
  left: TaskExecutionTarget,
  right: TaskExecutionTarget,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.deploymentGeneration === right.deploymentGeneration &&
    left.artifactDigest === right.artifactDigest &&
    left.executor.id === right.executor.id &&
    left.executor.type === right.executor.type &&
    left.executor.workerId === right.executor.workerId
  );
}

function diagnostic(
  code: RuntimeDiagnostic["code"],
  message: string,
  type: "process" | "thread",
  now: Date,
): RuntimeDiagnostic {
  return runtimeDiagnostic({
    code,
    message,
    source: { kind: "executor", id: type },
    observedAt: now.toISOString(),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

export async function raceComponentSessionOperation<T>(
  operation: Promise<T>,
  clock: Clock,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  const timeoutController = new AbortController();
  try {
    const outcome = await Promise.race([
      operation.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      clock.sleep(timeoutMs, timeoutController.signal).then(() => ({ kind: "timeout" as const })),
    ]);
    if (outcome.kind === "error") throw outcome.error;
    if (outcome.kind === "timeout") throw timeoutError();
    return outcome.value;
  } finally {
    timeoutController.abort("parent-operation-settled");
  }
}

function throwCollected(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

export class ComponentSandboxSession implements Executor {
  readonly id: string;
  readonly type: "process" | "thread";
  readonly target: TaskExecutionTarget;
  readonly #identity: Pick<ExecutionRequest, "applicationId" | "componentId" | "pluginId">;
  readonly #transport: ComponentSessionTransport;
  readonly #clock: Clock;
  readonly #maxConcurrency: number;
  readonly #maxQueue: number;
  readonly #maxRetainedAttempts: number;
  readonly #shutdownGraceMs: number;
  readonly #attempts = new Map<string, SessionAttempt>();
  readonly #queue: SessionAttempt[] = [];
  #active = 0;
  #accepting = true;
  #drainPromise: Promise<void> | undefined;
  #lifecycleDrainPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: ComponentSandboxSessionOptions) {
    this.id = options.id;
    this.type = options.type;
    this.target = deepFreeze(structuredClone(parseTaskExecutionTarget(options.target)));
    this.#identity = Object.freeze({ ...options.identity });
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#maxConcurrency = options.maxConcurrency;
    this.#maxQueue = options.maxQueue;
    this.#maxRetainedAttempts =
      options.maxRetainedAttempts ?? COMPONENT_SESSION_MAX_RETAINED_ATTEMPTS;
    this.#shutdownGraceMs = options.shutdownGraceMs;
    if (
      !Number.isInteger(this.#maxRetainedAttempts) ||
      this.#maxRetainedAttempts < 1 ||
      this.#maxRetainedAttempts > COMPONENT_SESSION_MAX_RETAINED_ATTEMPTS
    ) {
      throw new RangeError("maxRetainedAttempts is outside the supported bound");
    }
    if (!Number.isFinite(this.#shutdownGraceMs) || this.#shutdownGraceMs < 0) {
      throw new RangeError("shutdownGraceMs must be finite and non-negative");
    }
  }

  async probe(): Promise<ExecutorCapabilities> {
    const available = this.#accepting;
    return {
      id: this.id,
      type: this.type,
      available,
      maxConcurrency: this.#maxConcurrency,
      availableCapacity: available ? Math.max(0, this.#maxConcurrency - this.#active) : 0,
      securityIsolation: this.type === "process",
    };
  }

  async submit(input: ExecutionRequest): Promise<ExecutionHandle> {
    const request = Object.freeze(structuredClone(parseExecutionRequest(input)));
    this.#assertTarget(request);
    const key = attemptKey(request.taskId, request.attemptId);
    const fingerprint = canonicalJson(request);
    const existing = this.#attempts.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new DiagnosticError(
          diagnostic(
            "PROTOCOL_IDEMPOTENCY_CONFLICT",
            "Task attempt identity was reused with a different fingerprint",
            this.type,
            this.#clock.now(),
          ),
        );
      }
      this.#touch(existing);
      return existing.handle;
    }
    if (!this.#accepting) {
      throw new DiagnosticError(
        diagnostic(
          "EXECUTOR_DRAINING",
          "Component session is draining and refuses new submissions",
          this.type,
          this.#clock.now(),
        ),
      );
    }
    if (this.#active + this.#queue.length >= this.#maxConcurrency + this.#maxQueue) {
      throw new DiagnosticError(
        diagnostic(
          "EXECUTOR_QUEUE_CAPACITY_EXCEEDED",
          "Component session submission queue is full",
          this.type,
          this.#clock.now(),
        ),
      );
    }
    this.#pruneTerminal();
    if (this.#attempts.size >= this.#maxRetainedAttempts) {
      throw new DiagnosticError(
        diagnostic(
          "EXECUTOR_ATTEMPT_CAPACITY_EXCEEDED",
          "Component session attempt retention is exhausted",
          this.type,
          this.#clock.now(),
        ),
      );
    }
    const result = Promise.withResolvers<ExecutionResult>();
    const entry: SessionAttempt = {
      request,
      fingerprint,
      result,
      completed: Promise.withResolvers<void>(),
      deadlineController: new AbortController(),
      state: "accepted",
      handle: Object.freeze({
        taskId: request.taskId,
        attemptId: request.attemptId,
        result: result.promise,
      }),
    };
    this.#attempts.set(key, entry);
    this.#queue.push(entry);
    this.#armDeadline(entry);
    this.#schedule();
    return entry.handle;
  }

  async observe(taskId: TaskId, attemptId: AttemptId): Promise<AttemptStatus | undefined> {
    const entry = this.#attempts.get(attemptKey(taskId, attemptId));
    if (entry === undefined) return undefined;
    this.#touch(entry);
    return entry.state === "terminal"
      ? { state: "terminal", result: entry.terminal as ExecutionResult }
      : { state: entry.state };
  }

  async cancel(taskId: TaskId, attemptId: AttemptId): Promise<void> {
    const entry = this.#attempts.get(attemptKey(taskId, attemptId));
    if (entry === undefined || entry.state === "terminal") return;
    entry.cancellation ??= "cancelled";
    if (entry.state === "accepted") {
      const index = this.#queue.indexOf(entry);
      if (index >= 0) this.#queue.splice(index, 1);
      this.#settle(entry, this.#cancelledResult(entry));
      entry.completed.resolve();
      return;
    }
    await this.#transport
      .cancel(entry.request.taskId, entry.request.attemptId, entry.cancellation)
      .catch(() => undefined);
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
    this.#drainPromise ??= this.#converge(deadline);
    return this.#drainPromise;
  }

  drainLifecycle(options: DrainOptions): Promise<void> {
    if (this.#lifecycleDrainPromise === undefined) {
      const lifecycleDrainPromise = (async () => {
        await this.drain(options);
        await this.#transport.drain();
      })();
      this.#lifecycleDrainPromise = lifecycleDrainPromise;
      void lifecycleDrainPromise.catch(() => {
        if (this.#lifecycleDrainPromise === lifecycleDrainPromise) {
          this.#lifecycleDrainPromise = undefined;
        }
      });
    }
    return this.#lifecycleDrainPromise;
  }

  close(): Promise<void> {
    this.#accepting = false;
    this.#closePromise ??= (async () => {
      const deadline = new Date(this.#clock.now().getTime() + this.#shutdownGraceMs).toISOString();
      const errors: unknown[] = [];
      try {
        await this.#converge(deadline);
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.#transport.close();
      } catch (error) {
        errors.push(error);
      }
      throwCollected(errors, "Component session shutdown failed");
    })();
    return this.#closePromise;
  }

  async health(): Promise<ExecutorHealth> {
    const health = await this.#transport.health();
    return {
      status: health.status,
      checkedAt: this.#clock.now().toISOString(),
      ...(health.message === undefined ? {} : { message: health.message }),
      id: this.id,
      type: this.type,
      accepting: this.#accepting && health.status !== "unhealthy",
      active: this.#active,
      queued: this.#queue.length,
      retainedAttempts: this.#attempts.size,
    };
  }

  #assertTarget(request: ExecutionRequest): void {
    if (
      !taskExecutionTargetsEqual(request.target, this.target) ||
      request.applicationId !== this.#identity.applicationId ||
      request.pluginId !== this.#identity.pluginId ||
      request.componentId !== this.#identity.componentId
    ) {
      throw new DiagnosticError(
        diagnostic(
          "EXECUTOR_REQUEST_TARGET_MISMATCH",
          "Execution request does not match the component session target",
          this.type,
          this.#clock.now(),
        ),
      );
    }
  }

  #schedule(): void {
    while (this.#active < this.#maxConcurrency) {
      const entry = this.#queue.shift();
      if (entry === undefined) return;
      if (entry.state === "terminal") continue;
      entry.state = "running";
      this.#active += 1;
      void this.#run(entry).finally(() => {
        this.#active -= 1;
        entry.completed.resolve();
        this.#schedule();
      });
    }
  }

  async #run(entry: SessionAttempt): Promise<void> {
    const startedAt = this.#clock.now().toISOString();
    try {
      const run = await this.#transport.run(entry.request);
      const status =
        entry.cancellation === "timed-out" && run.status === "cancelled" ? "timed-out" : run.status;
      this.#settle(entry, {
        taskId: entry.request.taskId,
        attemptId: entry.request.attemptId,
        status,
        ...(run.output === undefined ? {} : { output: run.output }),
        executor: this.#transport.executor,
        startedAt,
        completedAt: this.#clock.now().toISOString(),
      });
    } catch (error) {
      const status = entry.cancellation ?? "failed";
      this.#settle(entry, {
        taskId: entry.request.taskId,
        attemptId: entry.request.attemptId,
        status,
        diagnostic:
          error instanceof DiagnosticError
            ? error.diagnostic
            : diagnostic(
                this.type === "thread" ? "EXECUTOR_THREAD_EXIT" : "EXECUTOR_PROCESS_EXIT",
                "Component session run failed",
                this.type,
                this.#clock.now(),
              ),
        executor: this.#transport.executor,
        startedAt,
        completedAt: this.#clock.now().toISOString(),
      });
    }
  }

  #settle(entry: SessionAttempt, result: ExecutionResult): void {
    if (entry.state === "terminal") return;
    entry.state = "terminal";
    entry.terminal = deepFreeze(parseExecutionResult(structuredClone(result)));
    entry.deadlineController.abort("terminal");
    entry.result.resolve(entry.terminal);
  }

  #cancelledResult(entry: SessionAttempt): ExecutionResult {
    const now = this.#clock.now().toISOString();
    return {
      taskId: entry.request.taskId,
      attemptId: entry.request.attemptId,
      status: entry.cancellation ?? "cancelled",
      executor: this.#transport.executor,
      startedAt: now,
      completedAt: now,
    };
  }

  #armDeadline(entry: SessionAttempt): void {
    void this.#waitUntilDeadline(entry.request.deadline, entry.deadlineController.signal)
      .then(async () => {
        if (entry.state === "terminal") return;
        entry.cancellation = "timed-out";
        if (entry.state === "accepted") {
          const index = this.#queue.indexOf(entry);
          if (index >= 0) this.#queue.splice(index, 1);
          this.#settle(entry, this.#cancelledResult(entry));
          entry.completed.resolve();
          return;
        }
        await this.#transport
          .cancel(entry.request.taskId, entry.request.attemptId, "timed-out")
          .catch(() => undefined);
      })
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

  async #converge(deadline: string | undefined): Promise<void> {
    const entries = [...this.#attempts.values()];
    const completed = Promise.all(entries.map((entry) => entry.completed.promise)).then(
      () => undefined,
    );
    if (deadline === undefined) {
      await completed;
      return;
    }
    const deadlineController = new AbortController();
    try {
      const outcome = await Promise.race([
        completed.then(() => "completed" as const),
        this.#waitUntilDeadline(deadline, deadlineController.signal).then(
          () => "deadline" as const,
        ),
      ]);
      if (outcome === "completed") return;
      for (const entry of entries) this.#cancelForShutdown(entry);
      await this.#boundedTermination();
      await completed;
    } finally {
      deadlineController.abort("session-converged");
    }
  }

  #cancelForShutdown(entry: SessionAttempt): void {
    if (entry.state === "terminal") return;
    entry.cancellation ??= "cancelled";
    if (entry.state === "accepted") {
      const index = this.#queue.indexOf(entry);
      if (index >= 0) this.#queue.splice(index, 1);
      this.#settle(entry, this.#cancelledResult(entry));
      entry.completed.resolve();
      return;
    }
    void this.#transport
      .cancel(entry.request.taskId, entry.request.attemptId, entry.cancellation)
      .catch(() => undefined);
  }

  async #boundedTermination(): Promise<void> {
    const timeoutController = new AbortController();
    try {
      const outcome = await Promise.race([
        this.#transport.terminate().then(
          () => ({ kind: "terminated" as const }),
          (error: unknown) => ({ kind: "error" as const, error }),
        ),
        this.#clock.sleep(this.#shutdownGraceMs, timeoutController.signal).then(() => ({
          kind: "timeout" as const,
        })),
      ]);
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.kind === "timeout") {
        throw new DiagnosticError(
          diagnostic(
            "EXECUTOR_SESSION_TERMINATION_TIMEOUT",
            "Component session transport termination exceeded its parent-side deadline",
            this.type,
            this.#clock.now(),
          ),
        );
      }
    } finally {
      timeoutController.abort("termination-race-settled");
    }
  }

  #touch(entry: SessionAttempt): void {
    const key = attemptKey(entry.request.taskId, entry.request.attemptId);
    this.#attempts.delete(key);
    this.#attempts.set(key, entry);
  }

  #pruneTerminal(): void {
    while (this.#attempts.size >= this.#maxRetainedAttempts) {
      const terminal = [...this.#attempts].find(([, entry]) => entry.state === "terminal");
      if (terminal === undefined) return;
      this.#attempts.delete(terminal[0]);
    }
  }
}
