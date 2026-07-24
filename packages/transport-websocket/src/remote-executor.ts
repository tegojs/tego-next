import {
  parseExecutionResult,
  type AttemptId,
  type AttemptStatus,
  type Clock,
  type DrainOptions,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type ExecutorCapabilities,
  type ExecutorHealth,
  type JsonValue,
  type TaskId,
  type WorkerId,
} from "@tegojs/contracts";
import {
  REMOTE_ACK,
  REMOTE_ASSIGN,
  REMOTE_CANCEL,
  REMOTE_INVENTORY,
  REMOTE_RESULT,
  REMOTE_RESULT_ACK,
  asObject,
  attemptKey,
  cloneJson,
  jsonBytes,
  parseRemoteRequest,
  positiveLimit,
  remoteError,
  requestFingerprint,
  type RemoteAttemptRecord,
  type RemoteAttemptStore,
  type RemoteSession,
  type RemoteSessionMessage,
} from "./remote-protocol.js";

const DEFAULT_MAX_ASSIGNMENTS = 256;
const DEFAULT_MAX_ASSIGNMENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;
const DEFAULT_MAX_INFLIGHT = 64;
const DEFAULT_MAX_INVENTORY = 512;
const MAX_CLOCK_SLEEP_MS = 2_147_483_647;

export interface RemoteExecutorOptions {
  readonly id: string;
  readonly workerId: WorkerId;
  readonly clock: Clock;
  readonly attemptStore: RemoteAttemptStore;
  readonly maxConcurrency?: number;
  readonly maxAssignments?: number;
  readonly maxAssignmentBytes?: number;
  readonly maxResultBytes?: number;
  readonly maxInflight?: number;
  readonly maxInventoryItems?: number;
}

interface RemoteAttempt {
  readonly request: ExecutionRequest;
  readonly fingerprint: string;
  readonly handle: ExecutionHandle;
  readonly result: PromiseWithResolvers<ExecutionResult>;
  readonly deadline: AbortController;
  state: "acknowledged" | "assigned" | "running" | "terminal" | "unknown";
  epoch: string;
  terminal?: ExecutionResult;
  cancellation?: "cancelled" | "timed-out";
}

export class RemoteExecutor implements Executor {
  readonly id: string;
  readonly type = "remote" as const;
  readonly #workerId: WorkerId;
  readonly #clock: Clock;
  readonly #attemptStore: RemoteAttemptStore;
  readonly #maxConcurrency: number;
  readonly #maxAssignments: number;
  readonly #maxAssignmentBytes: number;
  readonly #maxResultBytes: number;
  readonly #maxInflight: number;
  readonly #maxInventoryItems: number;
  readonly #attempts = new Map<string, RemoteAttempt>();
  #session: RemoteSession | undefined;
  #removeMessageListener: (() => void) | undefined;
  #removeStateListener: (() => void) | undefined;
  #highestEpoch = 0n;
  #inflight = 0;
  #accepting = false;
  #draining = false;
  #closed = false;
  #hydrated = false;
  #attachChain = Promise.resolve();
  #drainPromise: Promise<void> | undefined;

  constructor(options: RemoteExecutorOptions) {
    if (options.id.length === 0) throw new TypeError("RemoteExecutor id must not be empty");
    this.id = options.id;
    this.#workerId = options.workerId;
    this.#clock = options.clock;
    this.#attemptStore = options.attemptStore;
    this.#maxConcurrency = positiveLimit(options.maxConcurrency, 8, "maxConcurrency");
    this.#maxAssignments = positiveLimit(
      options.maxAssignments,
      DEFAULT_MAX_ASSIGNMENTS,
      "maxAssignments",
    );
    this.#maxAssignmentBytes = positiveLimit(
      options.maxAssignmentBytes,
      DEFAULT_MAX_ASSIGNMENT_BYTES,
      "maxAssignmentBytes",
    );
    this.#maxResultBytes = positiveLimit(
      options.maxResultBytes,
      DEFAULT_MAX_RESULT_BYTES,
      "maxResultBytes",
    );
    this.#maxInflight = positiveLimit(options.maxInflight, DEFAULT_MAX_INFLIGHT, "maxInflight");
    this.#maxInventoryItems = positiveLimit(
      options.maxInventoryItems,
      DEFAULT_MAX_INVENTORY,
      "maxInventoryItems",
    );
  }

  attach(session: RemoteSession): Promise<void> {
    const attached = this.#attachChain.then(async () => this.#attach(session));
    this.#attachChain = attached.catch(() => undefined);
    return attached;
  }

  async probe(): Promise<ExecutorCapabilities> {
    const active = this.#activeCount();
    const available =
      this.#accepting &&
      !this.#closed &&
      !this.#draining &&
      this.#session?.state === "ready" &&
      this.#session.acceptingAssignments;
    return {
      id: this.id,
      type: this.type,
      available,
      maxConcurrency: this.#maxConcurrency,
      availableCapacity: available ? Math.max(0, this.#maxConcurrency - active) : 0,
      securityIsolation: true,
    };
  }

  async submit(requestValue: ExecutionRequest): Promise<ExecutionHandle> {
    const request = parseRemoteRequest(requestValue);
    const fingerprint = requestFingerprint(request);
    const key = attemptKey(request.taskId, request.attemptId);
    const existing = this.#attempts.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw remoteError(
          "EXECUTOR_REMOTE_IDENTITY_CONFLICT",
          "Remote attempt identity has a different request fingerprint",
          this.id,
          this.#clock.now().toISOString(),
        );
      }
      return existing.handle;
    }
    if (
      this.#closed ||
      this.#draining ||
      !this.#accepting ||
      this.#session?.state !== "ready" ||
      !this.#session.acceptingAssignments
    ) {
      throw remoteError(
        "EXECUTOR_REMOTE_NOT_AVAILABLE",
        "RemoteExecutor is not accepting assignments",
        this.id,
        this.#clock.now().toISOString(),
      );
    }
    if (
      jsonBytes(request) > this.#maxAssignmentBytes ||
      this.#attempts.size >= this.#maxAssignments ||
      this.#activeCount() >= this.#maxConcurrency ||
      this.#inflight >= this.#maxInflight
    ) {
      throw remoteError(
        "EXECUTOR_REMOTE_ADMISSION_EXHAUSTED",
        "RemoteExecutor assignment capacity is exhausted",
        this.id,
        this.#clock.now().toISOString(),
      );
    }
    const result = Promise.withResolvers<ExecutionResult>();
    const handle = Object.freeze({
      taskId: request.taskId,
      attemptId: request.attemptId,
      result: result.promise,
    });
    const attempt: RemoteAttempt = {
      request: cloneJson(request),
      fingerprint,
      handle,
      result,
      deadline: new AbortController(),
      state: "assigned",
      epoch: this.#session.epoch,
    };
    await this.#save(attempt);
    this.#attempts.set(key, attempt);
    void this.#assign(attempt, this.#session);
    void this.#watchDeadline(attempt);
    return handle;
  }

  async observe(taskId: TaskId, attemptId: AttemptId): Promise<AttemptStatus | undefined> {
    const attempt = this.#attempts.get(attemptKey(taskId, attemptId));
    if (attempt === undefined) return undefined;
    if (attempt.terminal !== undefined) {
      return { state: "terminal", result: attempt.terminal };
    }
    return {
      state:
        attempt.state === "assigned" || attempt.state === "acknowledged"
          ? "accepted"
          : "running",
    };
  }

  async cancel(taskId: TaskId, attemptId: AttemptId): Promise<void> {
    const attempt = this.#attempts.get(attemptKey(taskId, attemptId));
    if (attempt === undefined || attempt.state === "terminal") return;
    attempt.cancellation = attempt.cancellation ?? "cancelled";
    const session = this.#session;
    if (session === undefined || session.state !== "ready") {
      attempt.state = "unknown";
      await this.#save(attempt);
      return;
    }
    try {
      await session.request(REMOTE_CANCEL, { request: attempt.request });
    } catch {
      if (attempt.terminal === undefined) {
        attempt.state = "unknown";
        await this.#save(attempt);
      }
    }
  }

  drain(options: DrainOptions): Promise<void> {
    const deadline =
      options.deadline === undefined ? undefined : Date.parse(options.deadline);
    if (deadline !== undefined && Number.isNaN(deadline)) {
      return Promise.reject(new TypeError("drain deadline must be an ISO date"));
    }
    this.#draining = true;
    this.#accepting = false;
    this.#drainPromise ??= (async () => {
      const controller = new AbortController();
      const active = [...this.#attempts.values()].filter(
        (attempt) => attempt.state !== "terminal",
      );
      if (deadline !== undefined) {
        void this.#waitUntil(deadline, controller.signal)
          .then(async () =>
            Promise.all(
              active.map(async (attempt) =>
                this.cancel(attempt.request.taskId, attempt.request.attemptId),
              ),
            ),
          )
          .catch(() => undefined);
      }
      try {
        await Promise.all(active.map(async (attempt) => attempt.handle.result));
      } finally {
        controller.abort("remote-drained");
      }
    })();
    return this.#drainPromise;
  }

  async health(): Promise<ExecutorHealth> {
    const active = this.#activeCount();
    const accepting =
      this.#accepting &&
      !this.#closed &&
      !this.#draining &&
      this.#session?.state === "ready";
    return {
      id: this.id,
      type: this.type,
      status: this.#closed ? "unhealthy" : accepting ? "healthy" : "degraded",
      checkedAt: this.#clock.now().toISOString(),
      accepting,
      active,
      queued: 0,
      retainedAttempts: this.#attempts.size,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.drain({});
    this.#closed = true;
    this.#accepting = false;
    this.#detachSession();
  }

  async #attach(session: RemoteSession): Promise<void> {
    if (this.#closed) throw new Error("RemoteExecutor is closed");
    if (session.state !== "ready" || !session.available) {
      throw new Error("Remote Worker session must be ready before attaching execution");
    }
    const epoch = BigInt(session.epoch);
    if (epoch <= this.#highestEpoch && this.#session !== session) {
      throw remoteError(
        "EXECUTOR_REMOTE_STALE_EPOCH",
        "Remote Worker session epoch is stale",
        this.id,
        this.#clock.now().toISOString(),
        { epoch: session.epoch, highestEpoch: this.#highestEpoch.toString() },
      );
    }
    this.#accepting = false;
    this.#detachSession(true);
    await this.#hydrate();
    this.#session = session;
    this.#highestEpoch = epoch;
    this.#removeMessageListener = session.onMessage((message) => {
      if (this.#session === session) {
        void this.#receive(session, message);
      }
    });
    this.#removeStateListener = session.onStateChange((state) => {
      if (this.#session === session && state !== "ready") {
        void this.#sessionLost(session);
      }
    });
    try {
      await this.#reconcile(session);
      if (this.#session === session && session.state === "ready") {
        this.#accepting = !this.#draining;
      }
    } catch (error) {
      if (this.#session === session) await this.#sessionLost(session);
      throw error;
    }
  }

  async #hydrate(): Promise<void> {
    if (this.#hydrated) return;
    const records = await this.#attemptStore.list(this.#workerId);
    if (records.length > this.#maxInventoryItems) {
      throw remoteError(
        "EXECUTOR_REMOTE_INVENTORY_EXHAUSTED",
        "Persisted RemoteExecutor inventory exceeds maxInventoryItems",
        this.id,
        this.#clock.now().toISOString(),
      );
    }
    for (const record of records) {
      const result = Promise.withResolvers<ExecutionResult>();
      const handle = Object.freeze({
        taskId: record.request.taskId,
        attemptId: record.request.attemptId,
        result: result.promise,
      });
      const attempt: RemoteAttempt = {
        request: record.request,
        fingerprint: record.fingerprint,
        handle,
        result,
        deadline: new AbortController(),
        state: record.state,
        epoch: record.epoch,
        ...(record.result === undefined ? {} : { terminal: record.result }),
      };
      this.#attempts.set(attemptKey(record.request.taskId, record.request.attemptId), attempt);
      if (record.result !== undefined) {
        attempt.deadline.abort();
        result.resolve(record.result);
      } else {
        void this.#watchDeadline(attempt);
      }
    }
    this.#hydrated = true;
  }

  async #assign(attempt: RemoteAttempt, session: RemoteSession): Promise<void> {
    if (this.#session !== session || attempt.state === "terminal") return;
    this.#inflight += 1;
    try {
      const response = await session.request(REMOTE_ASSIGN, { request: attempt.request });
      if (this.#session !== session || attempt.terminal !== undefined) return;
      if (response.type !== REMOTE_ACK) throw new Error("Remote assignment response is invalid");
      const payload = asObject(response.payload, REMOTE_ACK);
      if (payload.accepted === false) {
        await this.#publish(attempt, parseExecutionResult(payload.result));
        return;
      }
      if (payload.accepted !== true) throw new Error("Remote assignment acknowledgement is invalid");
      attempt.state = "acknowledged";
      attempt.epoch = session.epoch;
      await this.#save(attempt);
      if (payload.result !== undefined) {
        await this.#publish(attempt, parseExecutionResult(payload.result));
        if (this.#session === session && session.state === "ready") {
          await session.send(REMOTE_RESULT_ACK, {
            kind: "result",
            taskId: attempt.request.taskId,
            attemptId: attempt.request.attemptId,
          });
        }
      } else {
        attempt.state = "running";
        await this.#save(attempt);
      }
    } catch {
      if (attempt.terminal === undefined) {
        attempt.state = "unknown";
        attempt.epoch = session.epoch;
        await this.#save(attempt);
      }
    } finally {
      this.#inflight -= 1;
    }
  }

  async #receive(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    if (message.type !== REMOTE_RESULT || this.#session !== session) return;
    try {
      const payload = asObject(message.payload, REMOTE_RESULT);
      const result = parseExecutionResult(payload.result);
      const attempt = this.#attempts.get(attemptKey(result.taskId, result.attemptId));
      if (attempt === undefined || attempt.epoch !== session.epoch) return;
      await this.#publish(attempt, result);
      if (this.#session === session && session.state === "ready") {
        await session.send(REMOTE_RESULT_ACK, {
          kind: "result",
          taskId: result.taskId,
          attemptId: result.attemptId,
        });
      }
    } catch {
      // Invalid or stale application results never overwrite authoritative state.
    }
  }

  async #publish(attempt: RemoteAttempt, candidate: ExecutionResult): Promise<void> {
    if (attempt.terminal !== undefined) {
      if (JSON.stringify(attempt.terminal) !== JSON.stringify(candidate)) {
        throw remoteError(
          "EXECUTOR_REMOTE_RESULT_CONFLICT",
          "Remote attempt produced conflicting terminal results",
          this.id,
          this.#clock.now().toISOString(),
        );
      }
      return;
    }
    let result = parseExecutionResult(candidate);
    if (
      attempt.cancellation === "timed-out" &&
      result.status === "cancelled"
    ) {
      result = {
        ...result,
        status: "timed-out",
      };
    }
    if (jsonBytes(result) > this.#maxResultBytes) {
      const now = this.#clock.now().toISOString();
      result = {
        taskId: attempt.request.taskId,
        attemptId: attempt.request.attemptId,
        status: "failed",
        diagnostic: remoteError(
          "EXECUTOR_REMOTE_RESULT_TOO_LARGE",
          "Remote result exceeds maxResultBytes",
          this.id,
          now,
        ).diagnostic,
        executor: { kind: "remote", workerId: this.#workerId },
        startedAt: now,
        completedAt: now,
      };
    }
    attempt.state = "terminal";
    attempt.terminal = cloneJson(result);
    attempt.deadline.abort();
    await this.#save(attempt);
    attempt.result.resolve(attempt.terminal);
  }

  async #reconcile(session: RemoteSession): Promise<void> {
    const response = await session.request(REMOTE_INVENTORY, {
      workerId: this.#workerId,
      epoch: session.epoch,
    });
    if (this.#session !== session) throw new Error("Remote session changed during reconciliation");
    const payload = asObject(response.payload, REMOTE_INVENTORY);
    if (payload.epoch !== session.epoch) {
      throw new Error("Remote inventory epoch does not match the authoritative session");
    }
    if (payload.error !== undefined) {
      const error = asObject(payload.error, "remote inventory error");
      throw remoteError(
        "EXECUTOR_REMOTE_INVENTORY_EXHAUSTED",
        typeof error.message === "string" ? error.message : "Remote inventory was rejected",
        this.id,
        this.#clock.now().toISOString(),
      );
    }
    if (
      payload.acknowledged === undefined ||
      payload.running === undefined ||
      payload.terminalUnacknowledged === undefined
    ) {
      throw new Error("Remote attempt inventory is incomplete");
    }
    const acknowledged = parseIdentities(payload.acknowledged, this.#maxInventoryItems);
    const running = parseIdentities(payload.running, this.#maxInventoryItems);
    const terminal = parseTerminal(payload.terminalUnacknowledged, this.#maxInventoryItems);
    const prepared = payload.preparedArtifacts;
    if (
      !Array.isArray(prepared) ||
      prepared.length > this.#maxInventoryItems ||
      prepared.some((item) => typeof item !== "string")
    ) {
      throw new Error("Remote prepared artifact inventory is invalid");
    }
    if (acknowledged.size + running.size + terminal.length > this.#maxInventoryItems) {
      throw new Error("Remote attempt inventory exceeds maxInventoryItems");
    }
    const terminalKeys = new Set<string>();
    for (const result of terminal) {
      const key = attemptKey(result.taskId, result.attemptId);
      terminalKeys.add(key);
      const attempt = this.#attempts.get(key);
      if (attempt !== undefined) {
        attempt.epoch = session.epoch;
        await this.#publish(attempt, result);
        await session.send(REMOTE_RESULT_ACK, {
          kind: "result",
          taskId: result.taskId,
          attemptId: result.attemptId,
        });
      }
    }
    for (const [key, attempt] of this.#attempts) {
      if (attempt.state === "terminal" || terminalKeys.has(key)) continue;
      attempt.epoch = session.epoch;
      if (running.has(key)) {
        attempt.state = "running";
        await this.#save(attempt);
      } else if (acknowledged.has(key)) {
        attempt.state = "acknowledged";
        await this.#save(attempt);
      } else {
        attempt.state = "assigned";
        await this.#save(attempt);
        void this.#assign(attempt, session);
      }
    }
  }

  async #sessionLost(session: RemoteSession): Promise<void> {
    if (this.#session !== session) return;
    this.#accepting = false;
    this.#detachSession(true);
    for (const attempt of this.#attempts.values()) {
      if (attempt.state !== "terminal") {
        attempt.state = "unknown";
        await this.#save(attempt);
      }
    }
  }

  #detachSession(preserveSession = false): void {
    this.#removeMessageListener?.();
    this.#removeStateListener?.();
    this.#removeMessageListener = undefined;
    this.#removeStateListener = undefined;
    if (!preserveSession || this.#session !== undefined) this.#session = undefined;
  }

  async #watchDeadline(attempt: RemoteAttempt): Promise<void> {
    try {
      while (attempt.state !== "terminal") {
        const remaining = Date.parse(attempt.request.deadline) - this.#clock.now().getTime();
        if (remaining <= 0) {
          attempt.cancellation = "timed-out";
          await this.cancel(attempt.request.taskId, attempt.request.attemptId);
          return;
        }
        await this.#clock.sleep(
          Math.min(remaining, MAX_CLOCK_SLEEP_MS),
          attempt.deadline.signal,
        );
      }
    } catch {
      // Terminal publication aborts the deadline sleeper.
    }
  }

  async #waitUntil(deadline: number, signal: AbortSignal): Promise<void> {
    while (true) {
      const remaining = deadline - this.#clock.now().getTime();
      if (remaining <= 0) return;
      await this.#clock.sleep(Math.min(remaining, MAX_CLOCK_SLEEP_MS), signal);
    }
  }

  async #save(attempt: RemoteAttempt): Promise<void> {
    const record: RemoteAttemptRecord = {
      workerId: this.#workerId,
      request: attempt.request,
      fingerprint: attempt.fingerprint,
      state: attempt.state,
      epoch: attempt.epoch,
      updatedAt: this.#clock.now().toISOString(),
      ...(attempt.terminal === undefined ? {} : { result: attempt.terminal }),
    };
    await this.#attemptStore.save(record);
  }

  #activeCount(): number {
    let active = 0;
    for (const attempt of this.#attempts.values()) {
      if (attempt.state !== "terminal") active += 1;
    }
    return active;
  }
}

function parseIdentities(value: JsonValue, limit: number): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error("Remote attempt identity inventory is invalid");
  }
  const keys = new Set<string>();
  for (const item of value) {
    const record = asObject(item, "attempt identity");
    const request = parseRemoteRequest({
      taskId: record.taskId,
      attemptId: record.attemptId,
      applicationId: "remote-inventory",
      pluginId: "remote.inventory",
      componentId: "inventory",
      input: null,
      deadline: new Date(0).toISOString(),
      orphanPolicy: "cancel",
    });
    keys.add(attemptKey(request.taskId, request.attemptId));
  }
  return keys;
}

function parseTerminal(value: JsonValue, limit: number): readonly ExecutionResult[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error("Remote terminal inventory is invalid");
  }
  return value.map((item) => {
    const record = asObject(item, "terminal result");
    return parseExecutionResult(record.result);
  });
}
