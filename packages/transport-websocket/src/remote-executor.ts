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
  REMOTE_CANCEL_ACK,
  REMOTE_INVENTORY,
  REMOTE_RESULT,
  REMOTE_RESULT_ACK,
  asObject,
  attemptKey,
  cloneJson,
  jsonFingerprint,
  jsonBytes,
  isRemoteAttemptRevisionError,
  parseAttemptRevision,
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
const DEFAULT_MAX_CONTROL_PAYLOAD_BYTES = 48 * 1024;
const DEFAULT_MAX_ASSIGNMENT_BYTES = DEFAULT_MAX_CONTROL_PAYLOAD_BYTES;
const DEFAULT_MAX_RESULT_BYTES = DEFAULT_MAX_CONTROL_PAYLOAD_BYTES;
const DEFAULT_MAX_INFLIGHT = 64;
const DEFAULT_MAX_INVENTORY = 512;
const MAX_CLOCK_SLEEP_MS = 2_147_483_647;
const MAX_PERSISTENCE_ATTEMPTS = 8;
const PERSISTENCE_SETTLEMENT_GRACE_MS = 26;

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
  readonly maxInventoryBytes?: number;
  readonly orphanTimeoutMs?: number;
  readonly persistenceTimeoutMs?: number;
  readonly retentionMs?: number;
}

interface RemoteAttempt {
  readonly request: ExecutionRequest;
  readonly fingerprint: string;
  readonly handle: ExecutionHandle;
  readonly result: PromiseWithResolvers<ExecutionResult>;
  readonly deadline: AbortController;
  revision: string;
  transition: Promise<void>;
  state: "acknowledged" | "assigned" | "running" | "terminal" | "unknown";
  epoch: string;
  terminal?: ExecutionResult;
  settled: boolean;
  persistenceFailed?: boolean;
  cancellation?: "cancelled" | "timed-out";
  terminalAt?: number;
  publication?: {
    readonly fingerprint: string;
    readonly promise: Promise<void>;
  };
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
  readonly #maxInventoryBytes: number;
  readonly #orphanTimeoutMs: number;
  readonly #persistenceTimeoutMs: number;
  readonly #retentionMs: number;
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
  #submitChain = Promise.resolve();
  #drainPromise: Promise<void> | undefined;
  #orphanRecovery = new AbortController();
  #persistenceDegraded = false;

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
    this.#maxInventoryBytes = positiveLimit(
      options.maxInventoryBytes,
      DEFAULT_MAX_CONTROL_PAYLOAD_BYTES,
      "maxInventoryBytes",
    );
    this.#orphanTimeoutMs = positiveLimit(options.orphanTimeoutMs, 30_000, "orphanTimeoutMs");
    this.#persistenceTimeoutMs = positiveLimit(
      options.persistenceTimeoutMs,
      Math.min(this.#orphanTimeoutMs, 1_000),
      "persistenceTimeoutMs",
    );
    this.#retentionMs = positiveLimit(options.retentionMs, 24 * 60 * 60 * 1000, "retentionMs");
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
      this.#session.acceptingAssignments &&
      !this.#persistenceDegraded;
    return {
      id: this.id,
      type: this.type,
      available,
      maxConcurrency: this.#maxConcurrency,
      availableCapacity: available ? Math.max(0, this.#maxConcurrency - active) : 0,
      securityIsolation: true,
    };
  }

  submit(requestValue: ExecutionRequest): Promise<ExecutionHandle> {
    const submitted = this.#submitChain.then(async () => this.#submit(requestValue));
    this.#submitChain = submitted.then(
      () => undefined,
      () => undefined,
    );
    return submitted;
  }

  async #submit(requestValue: ExecutionRequest): Promise<ExecutionHandle> {
    this.#assertPersistenceAvailable();
    await this.#pruneTerminals();
    this.#assertPersistenceAvailable();
    if (jsonBytes(requestValue) > this.#maxAssignmentBytes) {
      throw remoteError(
        "EXECUTOR_REMOTE_ADMISSION_EXHAUSTED",
        "RemoteExecutor assignment exceeds maxAssignmentBytes",
        this.id,
        this.#clock.now().toISOString(),
      );
    }
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
    const persisted = await this.#storeOperation(
      this.#attemptStore.load(request.taskId, request.attemptId),
    );
    if (persisted !== undefined) parseAttemptRevision(persisted.revision);
    if (persisted?.state === "expired") {
      if (persisted.fingerprint !== fingerprint) {
        throw remoteError(
          "EXECUTOR_REMOTE_IDENTITY_CONFLICT",
          "Expired remote attempt identity has a different request fingerprint",
          this.id,
          this.#clock.now().toISOString(),
        );
      }
      throw remoteError(
        "EXECUTOR_REMOTE_ATTEMPT_EXPIRED",
        "Remote attempt result retention expired; the attempt identity cannot be reused",
        this.id,
        this.#clock.now().toISOString(),
      );
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
      revision: "0",
      transition: Promise.resolve(),
      state: "assigned",
      epoch: this.#session.epoch,
      settled: false,
    };
    await this.#create(attempt);
    this.#attempts.set(key, attempt);
    this.#background(this.#assign(attempt, this.#session));
    this.#background(this.#watchDeadline(attempt));
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
        attempt.state === "assigned" || attempt.state === "acknowledged" ? "accepted" : "running",
    };
  }

  async cancel(taskId: TaskId, attemptId: AttemptId): Promise<void> {
    const attempt = this.#attempts.get(attemptKey(taskId, attemptId));
    if (attempt === undefined || attempt.state === "terminal") return;
    await this.#transition(attempt, async () => {
      if (attempt.state === "terminal") return;
      attempt.cancellation = attempt.cancellation ?? "cancelled";
      await this.#commit(attempt);
    });
    const session = this.#session;
    if (session === undefined || session.state !== "ready") {
      await this.#transition(attempt, async () => {
        if (attempt.state === "terminal") return;
        await this.#commit(attempt, "unknown");
      });
      return;
    }
    await this.#requestCancel(attempt, session);
  }

  drain(options: DrainOptions): Promise<void> {
    const deadline = options.deadline === undefined ? undefined : Date.parse(options.deadline);
    if (deadline !== undefined && Number.isNaN(deadline)) {
      return Promise.reject(new TypeError("drain deadline must be an ISO date"));
    }
    this.#draining = true;
    this.#accepting = false;
    this.#drainPromise ??= (async () => {
      await this.#submitChain;
      const controller = new AbortController();
      const active = [...this.#attempts.values()].filter((attempt) => attempt.state !== "terminal");
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
      !this.#persistenceDegraded &&
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
    await this.#hydrate();
    if (this.#persistenceDegraded) {
      throw remoteError(
        "EXECUTOR_REMOTE_STATE_UNAVAILABLE",
        "Remote attempt persistence is degraded",
        this.id,
        this.#clock.now().toISOString(),
      );
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
    this.#orphanRecovery.abort("remote-reconnected");
    this.#orphanRecovery = new AbortController();
    this.#detachSession(true);
    this.#session = session;
    this.#highestEpoch = epoch;
    this.#removeMessageListener = session.onMessage((message) => {
      if (this.#session === session) {
        this.#background(this.#receive(session, message));
      }
    });
    this.#removeStateListener = session.onStateChange((state) => {
      if (this.#session === session && state !== "ready") {
        this.#background(this.#sessionLost(session));
      }
    });
    try {
      await this.#reconcile(session);
      if (this.#session === session && session.state === "ready") {
        this.#accepting = !this.#draining && !this.#persistenceDegraded;
      }
    } catch (error) {
      if (this.#session === session) await this.#sessionLost(session);
      throw error;
    }
  }

  async #hydrate(): Promise<void> {
    if (this.#hydrated) return;
    this.#assertPersistenceAvailable();
    const records = await this.#storeOperation(this.#attemptStore.list(this.#workerId));
    for (const record of records) parseAttemptRevision(record.revision);
    const activeRecords = records.filter((record) => record.state !== "expired");
    if (activeRecords.length > this.#maxInventoryItems) {
      throw remoteError(
        "EXECUTOR_REMOTE_INVENTORY_EXHAUSTED",
        "Persisted RemoteExecutor inventory exceeds maxInventoryItems",
        this.id,
        this.#clock.now().toISOString(),
      );
    }
    for (const record of records) {
      const persistedEpoch = BigInt(record.epoch);
      if (persistedEpoch > this.#highestEpoch) this.#highestEpoch = persistedEpoch;
      if (record.state === "expired") continue;
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
        revision: parseAttemptRevision(record.revision),
        transition: Promise.resolve(),
        state: record.state,
        epoch: record.epoch,
        settled: record.result !== undefined,
        ...(record.cancellation === undefined ? {} : { cancellation: record.cancellation }),
        ...(record.result === undefined ? {} : { terminal: record.result }),
        ...(record.result === undefined
          ? {}
          : { terminalAt: Date.parse(record.result.completedAt) }),
      };
      this.#attempts.set(attemptKey(record.request.taskId, record.request.attemptId), attempt);
      if (record.result !== undefined) {
        attempt.deadline.abort();
        result.resolve(record.result);
      } else {
        this.#background(this.#watchDeadline(attempt));
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
      this.#assertResponseIdentity(payload, attempt, "assignment acknowledgement");
      if (payload.error !== undefined) {
        throw new Error("Remote assignment acknowledgement contains an error");
      }
      if (payload.accepted === false) {
        if (payload.result === undefined) {
          await this.#publish(
            attempt,
            this.#failure(
              attempt.request,
              "rejected",
              "EXECUTOR_REMOTE_ASSIGNMENT_REJECTED",
              "Worker rejected the remote assignment without a terminal result",
            ),
          );
        } else {
          await this.#publish(attempt, parseExecutionResult(payload.result));
        }
        return;
      }
      if (payload.accepted !== true)
        throw new Error("Remote assignment acknowledgement is invalid");
      if (payload.result !== undefined) {
        await this.#publish(attempt, parseExecutionResult(payload.result), false);
        if (this.#session === session && session.state === "ready") {
          await session.send(REMOTE_RESULT_ACK, {
            kind: "result",
            taskId: attempt.request.taskId,
            attemptId: attempt.request.attemptId,
          });
        }
        this.#settle(attempt);
      } else {
        await this.#transition(attempt, async () => {
          if (
            this.#session !== session ||
            attempt.state === "terminal" ||
            attempt.epoch !== session.epoch
          ) {
            return;
          }
          await this.#commit(attempt, "running");
        });
      }
    } catch (error) {
      if (this.#session === session && attempt.terminal === undefined) {
        if (
          error instanceof Error &&
          (/assignment response|assignment acknowledgement|identity/iu.test(error.message) ||
            ("diagnostic" in error &&
              (error as { diagnostic?: { code?: unknown } }).diagnostic?.code ===
                "EXECUTOR_REMOTE_RESULT_IDENTITY_MISMATCH"))
        ) {
          await this.#publish(
            attempt,
            this.#failure(
              attempt.request,
              "failed",
              /identity/iu.test(error.message)
                ? "EXECUTOR_REMOTE_RESULT_IDENTITY_MISMATCH"
                : "EXECUTOR_REMOTE_ASSIGNMENT_REJECTED",
              /identity/iu.test(error.message)
                ? "Remote assignment returned a response for a different attempt identity"
                : "Worker returned an invalid remote assignment acknowledgement",
            ),
          );
        } else {
          await this.#transition(attempt, async () => {
            if (
              this.#session !== session ||
              attempt.state === "terminal" ||
              attempt.epoch !== session.epoch
            ) {
              return;
            }
            await this.#commit(attempt, "unknown");
          });
        }
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
      await this.#publish(attempt, result, false);
      if (this.#session === session && session.state === "ready") {
        await session.send(
          REMOTE_RESULT_ACK,
          {
            kind: "result",
            taskId: result.taskId,
            attemptId: result.attemptId,
          },
          { correlationId: message.messageId },
        );
      }
      this.#settle(attempt);
    } catch {
      // Invalid or stale application results never overwrite authoritative state.
    }
  }

  async #publish(
    attempt: RemoteAttempt,
    candidate: ExecutionResult,
    settle = true,
    boundedPersistence = false,
  ): Promise<void> {
    if (
      candidate.taskId !== attempt.request.taskId ||
      candidate.attemptId !== attempt.request.attemptId
    ) {
      throw remoteError(
        "EXECUTOR_REMOTE_RESULT_IDENTITY_MISMATCH",
        "Remote result does not match the assigned attempt identity",
        this.id,
        this.#clock.now().toISOString(),
      );
    }
    const candidateBytes = jsonBytes(candidate);
    let result = parseExecutionResult(candidate);
    if (attempt.cancellation === "timed-out" && result.status === "cancelled") {
      result = {
        ...result,
        status: "timed-out",
      };
    }
    if (candidateBytes > this.#maxResultBytes) {
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
    const fingerprint = jsonFingerprint(result);
    if (attempt.terminal !== undefined) {
      if (jsonFingerprint(attempt.terminal) !== fingerprint) {
        throw remoteError(
          "EXECUTOR_REMOTE_RESULT_CONFLICT",
          "Remote attempt produced conflicting terminal results",
          this.id,
          this.#clock.now().toISOString(),
        );
      }
      if (settle) this.#settle(attempt);
      return;
    }
    if (attempt.publication !== undefined) {
      if (attempt.publication.fingerprint !== fingerprint) {
        throw remoteError(
          "EXECUTOR_REMOTE_RESULT_CONFLICT",
          "Remote attempt produced conflicting terminal results",
          this.id,
          this.#clock.now().toISOString(),
        );
      }
      await attempt.publication.promise;
      if (settle) this.#settle(attempt);
      return;
    }
    const terminal = cloneJson(result);
    const promise = this.#transition(attempt, async () => {
      if (attempt.terminal !== undefined) {
        if (jsonFingerprint(attempt.terminal) !== fingerprint) {
          throw remoteError(
            "EXECUTOR_REMOTE_RESULT_CONFLICT",
            "Remote attempt produced conflicting terminal results",
            this.id,
            this.#clock.now().toISOString(),
          );
        }
        return;
      }
      await this.#commit(attempt, "terminal", terminal, attempt.epoch, boundedPersistence);
      const authoritative = attempt.terminal ?? terminal;
      if (jsonFingerprint(authoritative) !== fingerprint) {
        throw remoteError(
          "EXECUTOR_REMOTE_RESULT_CONFLICT",
          "Remote attempt lost terminal commit authority to a conflicting result",
          this.id,
          this.#clock.now().toISOString(),
        );
      }
      attempt.terminalAt = this.#clock.now().getTime();
      attempt.deadline.abort();
    });
    const publication = { fingerprint, promise };
    attempt.publication = publication;
    try {
      await promise;
      if (settle) this.#settle(attempt);
    } finally {
      if (attempt.publication === publication) {
        delete attempt.publication;
      }
    }
  }

  async #reconcile(session: RemoteSession): Promise<void> {
    const response = await session.request(REMOTE_INVENTORY, {
      workerId: this.#workerId,
      epoch: session.epoch,
    });
    if (this.#session !== session) throw new Error("Remote session changed during reconciliation");
    const payload = asObject(response.payload, REMOTE_INVENTORY);
    if (jsonBytes(response.payload) > this.#maxInventoryBytes) {
      throw remoteError(
        "EXECUTOR_REMOTE_INVENTORY_EXHAUSTED",
        "Remote inventory exceeds maxInventoryBytes",
        this.id,
        this.#clock.now().toISOString(),
      );
    }
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
        if (attempt.terminal === undefined) {
          await this.#publish(attempt, result, false);
        }
        await session.send(REMOTE_RESULT_ACK, {
          kind: "result",
          taskId: result.taskId,
          attemptId: result.attemptId,
        });
        this.#settle(attempt);
      }
    }
    const missing: RemoteAttempt[] = [];
    const cancellations: RemoteAttempt[] = [];
    for (const [key, attempt] of this.#attempts) {
      if (attempt.state === "terminal" || terminalKeys.has(key)) continue;
      if (running.has(key)) {
        await this.#transition(attempt, async () => {
          if (attempt.state !== "terminal") {
            await this.#commit(attempt, "running", undefined, session.epoch);
          }
        });
      } else if (acknowledged.has(key)) {
        await this.#transition(attempt, async () => {
          if (attempt.state !== "terminal") {
            await this.#commit(attempt, "acknowledged", undefined, session.epoch);
          }
        });
      } else {
        if (attempt.cancellation === undefined) {
          await this.#transition(attempt, async () => {
            if (attempt.state !== "terminal") {
              await this.#commit(attempt, "assigned", undefined, session.epoch);
            }
          });
          missing.push(attempt);
        }
      }
      if (attempt.cancellation !== undefined) {
        cancellations.push(attempt);
      }
    }
    for (let index = 0; index < missing.length; index += this.#maxInflight) {
      await Promise.all(
        missing.slice(index, index + this.#maxInflight).map(async (attempt) => {
          await this.#assign(attempt, session);
        }),
      );
    }
    for (const attempt of cancellations) {
      await this.#requestCancel(attempt, session);
    }
  }

  async #sessionLost(session: RemoteSession): Promise<void> {
    if (this.#session !== session) return;
    this.#accepting = false;
    this.#detachSession(true);
    const recovery = this.#orphanRecovery;
    const orphaned = [...this.#attempts.values()].filter(
      (attempt) => attempt.state !== "terminal" && attempt.epoch === session.epoch,
    );
    const persisted = Promise.allSettled(
      orphaned.map(async (attempt) =>
        this.#transition(attempt, async () => {
          if (attempt.state !== "terminal" && attempt.epoch === session.epoch) {
            await this.#commit(attempt, "unknown", undefined, attempt.epoch, true);
          }
        }),
      ),
    );
    const persistence = {
      promise: persisted,
      settled: false,
    };
    void persisted.then(() => {
      persistence.settled = true;
    });
    this.#background(persisted);
    this.#background(this.#expireOrphans(recovery, orphaned, persistence));
  }

  async #expireOrphans(
    recovery: AbortController,
    orphaned: readonly RemoteAttempt[],
    persistence: {
      readonly promise: Promise<readonly PromiseSettledResult<void>[]>;
      settled: boolean;
    },
  ): Promise<void> {
    const expiresAt = this.#clock.now().getTime() + this.#orphanTimeoutMs;
    try {
      await this.#waitUntil(expiresAt, recovery.signal);
    } catch {
      return;
    }
    if (this.#session !== undefined || recovery !== this.#orphanRecovery) return;
    if (!persistence.settled) {
      try {
        await Promise.race([
          persistence.promise,
          this.#clock.sleep(PERSISTENCE_SETTLEMENT_GRACE_MS, recovery.signal),
        ]);
      } catch {
        return;
      }
      if (this.#session !== undefined || recovery !== this.#orphanRecovery) return;
    }
    if (persistence.settled) await persistence.promise;
    const publications: {
      readonly attempt: RemoteAttempt;
      readonly result: ExecutionResult;
      readonly promise: Promise<void>;
    }[] = [];
    for (const attempt of orphaned) {
      if (attempt.terminal !== undefined) continue;
      const result = this.#failure(
        attempt.request,
        "failed",
        "EXECUTOR_REMOTE_ORPHAN_UNAVAILABLE",
        "Remote Worker did not reconnect within the orphan recovery window",
      );
      if (!persistence.settled) {
        this.#publishVolatile(attempt, result);
        continue;
      }
      const promise = this.#publish(attempt, result, true, true);
      this.#background(promise);
      publications.push({ attempt, result, promise });
    }
    if (publications.length === 0) return;
    const published = Promise.allSettled(publications.map(({ promise }) => promise));
    let publicationSettled = false;
    void published.then(() => {
      publicationSettled = true;
    });
    if (!publicationSettled) {
      try {
        await Promise.race([
          published,
          this.#clock.sleep(PERSISTENCE_SETTLEMENT_GRACE_MS, recovery.signal),
        ]);
      } catch {
        return;
      }
    }
    if (this.#session !== undefined || recovery !== this.#orphanRecovery) return;
    for (const { attempt, result } of publications) {
      if (attempt.terminal === undefined) this.#publishVolatile(attempt, result);
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
        await this.#clock.sleep(Math.min(remaining, MAX_CLOCK_SLEEP_MS), attempt.deadline.signal);
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

  #record(
    attempt: RemoteAttempt,
    state = attempt.state,
    result = attempt.terminal,
    epoch = attempt.epoch,
  ): RemoteAttemptRecord {
    return {
      workerId: this.#workerId,
      request: attempt.request,
      fingerprint: attempt.fingerprint,
      state,
      epoch,
      updatedAt: this.#clock.now().toISOString(),
      ...(result === undefined ? {} : { result }),
      ...(attempt.cancellation === undefined ? {} : { cancellation: attempt.cancellation }),
      revision: attempt.revision,
    };
  }

  async #create(attempt: RemoteAttempt): Promise<void> {
    const committed = await this.#storeOperation(
      this.#attemptStore.commit(this.#record(attempt), {
        expectedRevision: null,
      }),
    );
    if (committed === undefined) {
      throw remoteError(
        "EXECUTOR_REMOTE_IDENTITY_CONFLICT",
        "Remote attempt identity was concurrently created",
        this.id,
        this.#clock.now().toISOString(),
      );
    }
    attempt.revision = parseAttemptRevision(committed.revision);
  }

  async #commit(
    attempt: RemoteAttempt,
    state = attempt.state,
    result = attempt.terminal,
    epoch = attempt.epoch,
    boundedPersistence = false,
  ): Promise<void> {
    let immediateRetries = 0;
    while (true) {
      try {
        const record = this.#record(attempt, state, result, epoch);
        const condition = {
          expectedRevision: attempt.revision,
          expectedEpoch: attempt.epoch,
        };
        const useBoundedPersistence = boundedPersistence || state === "terminal";
        const timeout = useBoundedPersistence ? undefined : this.#watchPersistence(attempt);
        let committed: RemoteAttemptRecord | undefined;
        try {
          committed = useBoundedPersistence
            ? await this.#storeCommit(record, condition)
            : await this.#attemptStore.commit(record, condition);
        } finally {
          timeout?.abort("remote-persistence-completed");
        }
        if (attempt.persistenceFailed) return;
        if (committed !== undefined) {
          const revision = parseAttemptRevision(committed.revision);
          if (attempt.terminal !== undefined && state !== "terminal") return;
          attempt.revision = revision;
          attempt.state = state;
          attempt.epoch = epoch;
          if (result !== undefined) attempt.terminal = result;
          return;
        }
        const latest = await this.#storeOperation(
          this.#attemptStore.load(attempt.request.taskId, attempt.request.attemptId),
        );
        if (latest === undefined) {
          throw new Error("Remote attempt state disappeared during a conditional commit");
        }
        attempt.revision = parseAttemptRevision(latest.revision);
        attempt.epoch = latest.epoch;
        attempt.state = latest.state === "expired" ? "terminal" : latest.state;
        if (latest.cancellation === undefined) {
          delete attempt.cancellation;
        } else {
          attempt.cancellation = latest.cancellation;
        }
        if (latest.result !== undefined) {
          attempt.terminal = latest.result;
          attempt.state = "terminal";
        }
        if (attempt.state === "terminal") return;
        throw remoteError(
          "EXECUTOR_REMOTE_STALE_EPOCH",
          "Remote attempt transition lost conditional authority",
          this.id,
          this.#clock.now().toISOString(),
        );
      } catch (error) {
        immediateRetries += 1;
        if (attempt.persistenceFailed) {
          throw remoteError(
            "EXECUTOR_REMOTE_STATE_UNAVAILABLE",
            "Remote attempt persistence is unavailable",
            this.id,
            this.#clock.now().toISOString(),
          );
        }
        if (this.#isStateUnavailable(error)) {
          this.#failAttemptPersistence(attempt, "Remote attempt persistence operation timed out");
          throw error;
        }
        if (
          error instanceof Error &&
          "diagnostic" in error &&
          (error as { diagnostic?: { code?: string } }).diagnostic?.code ===
            "EXECUTOR_REMOTE_STALE_EPOCH"
        ) {
          throw error;
        }
        if (isRemoteAttemptRevisionError(error)) throw error;
        if (immediateRetries >= MAX_PERSISTENCE_ATTEMPTS) {
          const unavailable = remoteError(
            "EXECUTOR_REMOTE_STATE_UNAVAILABLE",
            "Remote attempt persistence remained unavailable after bounded retries",
            this.id,
            this.#clock.now().toISOString(),
          );
          this.#failAttemptPersistence(
            attempt,
            "Remote attempt persistence remained unavailable after bounded retries",
          );
          throw unavailable;
        }
        if (immediateRetries >= 3) {
          await this.#clock.sleep(25);
        } else {
          await Promise.resolve();
        }
      }
    }
  }

  #transition<T>(attempt: RemoteAttempt, operation: () => Promise<T>): Promise<T> {
    const transitioned = attempt.transition.then(operation, operation);
    attempt.transition = transitioned.then(
      () => undefined,
      () => undefined,
    );
    return transitioned;
  }

  async #storeCommit(
    record: RemoteAttemptRecord,
    condition: Parameters<RemoteAttemptStore["commit"]>[1],
  ): Promise<RemoteAttemptRecord | undefined> {
    return this.#storeOperation(this.#attemptStore.commit(record, condition), false);
  }

  async #storeOperation<T>(operation: Promise<T>, latchFailure = true): Promise<T> {
    const timeout = new AbortController();
    try {
      return await Promise.race([
        operation,
        this.#clock.sleep(this.#persistenceTimeoutMs, timeout.signal).then<T>(() => {
          this.#degradePersistence();
          throw remoteError(
            "EXECUTOR_REMOTE_STATE_UNAVAILABLE",
            "Remote attempt persistence operation timed out",
            this.id,
            this.#clock.now().toISOString(),
          );
        }),
      ]);
    } catch (error) {
      if (latchFailure) this.#degradePersistence();
      throw error;
    } finally {
      timeout.abort("remote-persistence-completed");
    }
  }

  #watchPersistence(attempt: RemoteAttempt): AbortController {
    const timeout = new AbortController();
    this.#background(
      this.#clock.sleep(this.#persistenceTimeoutMs, timeout.signal).then(() => {
        this.#failAttemptPersistence(attempt, "Remote attempt persistence operation timed out");
      }),
    );
    return timeout;
  }

  #failAttemptPersistence(attempt: RemoteAttempt, message: string): void {
    if (attempt.persistenceFailed) return;
    attempt.persistenceFailed = true;
    this.#publishVolatile(
      attempt,
      this.#failure(attempt.request, "failed", "EXECUTOR_REMOTE_STATE_UNAVAILABLE", message),
    );
  }

  #assertPersistenceAvailable(): void {
    if (!this.#persistenceDegraded) return;
    throw remoteError(
      "EXECUTOR_REMOTE_STATE_UNAVAILABLE",
      "Remote attempt persistence is degraded",
      this.id,
      this.#clock.now().toISOString(),
    );
  }

  #isStateUnavailable(error: unknown): boolean {
    return (
      error instanceof Error &&
      "diagnostic" in error &&
      (error as { diagnostic?: { code?: string } }).diagnostic?.code ===
        "EXECUTOR_REMOTE_STATE_UNAVAILABLE"
    );
  }

  #failure(
    request: ExecutionRequest,
    status: ExecutionResult["status"],
    code: `EXECUTOR_${string}`,
    message: string,
  ): ExecutionResult {
    const now = this.#clock.now().toISOString();
    return {
      taskId: request.taskId,
      attemptId: request.attemptId,
      status,
      diagnostic: remoteError(code, message, this.id, now).diagnostic,
      executor: { kind: "remote", workerId: this.#workerId },
      startedAt: now,
      completedAt: now,
    };
  }

  #settle(attempt: RemoteAttempt): void {
    if (attempt.settled || attempt.terminal === undefined) return;
    attempt.settled = true;
    attempt.result.resolve(attempt.terminal);
  }

  #publishVolatile(attempt: RemoteAttempt, result: ExecutionResult): void {
    this.#degradePersistence();
    if (attempt.terminal === undefined) {
      attempt.terminal = cloneJson(result);
      attempt.state = "terminal";
      attempt.terminalAt = this.#clock.now().getTime();
      attempt.deadline.abort();
    }
    this.#settle(attempt);
  }

  #degradePersistence(): void {
    this.#persistenceDegraded = true;
    this.#accepting = false;
  }

  async #requestCancel(attempt: RemoteAttempt, session: RemoteSession): Promise<void> {
    try {
      const response = await session.request(REMOTE_CANCEL, { request: attempt.request });
      if (response.type !== REMOTE_ACK) {
        throw new Error("Remote cancellation response is not an acknowledgement");
      }
      const payload = asObject(response.payload, REMOTE_CANCEL_ACK);
      this.#assertResponseIdentity(payload, attempt, "cancellation acknowledgement");
      if (payload.error !== undefined) {
        throw new Error("Remote cancellation acknowledgement contains an error");
      }
      if (typeof payload.found !== "boolean") {
        throw new Error("Remote cancellation acknowledgement is invalid");
      }
      if (payload.result !== undefined) {
        await this.#publish(attempt, parseExecutionResult(payload.result), false);
        if (this.#session === session && session.state === "ready") {
          await session.send(REMOTE_RESULT_ACK, {
            kind: "result",
            taskId: attempt.request.taskId,
            attemptId: attempt.request.attemptId,
          });
        }
        this.#settle(attempt);
      } else if (payload.found === false && attempt.terminal === undefined) {
        await this.#publish(
          attempt,
          this.#failure(
            attempt.request,
            attempt.cancellation === "timed-out" ? "timed-out" : "cancelled",
            attempt.cancellation === "timed-out"
              ? "EXECUTOR_REMOTE_DEADLINE_EXCEEDED"
              : "EXECUTOR_REMOTE_CANCELLED",
            "Worker confirmed that the cancelled remote attempt was never admitted",
          ),
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /identity|acknowledgement|contains an error|invalid/iu.test(error.message)
      ) {
        throw error;
      }
      if (this.#session === session && attempt.terminal === undefined) {
        await this.#transition(attempt, async () => {
          if (attempt.state !== "terminal" && attempt.epoch === session.epoch) {
            await this.#commit(attempt, "unknown");
          }
        });
      }
    }
  }

  #assertResponseIdentity(
    payload: Record<string, JsonValue>,
    attempt: RemoteAttempt,
    name: string,
  ): void {
    if (
      payload.taskId !== attempt.request.taskId ||
      payload.attemptId !== attempt.request.attemptId
    ) {
      throw new Error(`${name} identity does not match the requested attempt`);
    }
  }

  #background(promise: Promise<unknown>): void {
    void promise.catch(() => undefined);
  }

  #activeCount(): number {
    let active = 0;
    for (const attempt of this.#attempts.values()) {
      if (attempt.state !== "terminal") active += 1;
    }
    return active;
  }

  async #pruneTerminals(): Promise<void> {
    const cutoff = this.#clock.now().getTime() - this.#retentionMs;
    for (const [key, attempt] of this.#attempts) {
      if (
        attempt.terminal !== undefined &&
        attempt.terminalAt !== undefined &&
        attempt.terminalAt <= cutoff
      ) {
        await this.#transition(attempt, async () => {
          if (attempt.state !== "terminal") return;
          const { result: _result, ...record } = this.#record(attempt);
          const committed = await this.#storeOperation(
            this.#attemptStore.commit(
              {
                ...record,
                state: "expired",
              },
              {
                expectedRevision: attempt.revision,
                expectedEpoch: attempt.epoch,
              },
            ),
          );
          if (committed === undefined) {
            throw new Error("Remote terminal tombstone lost conditional authority");
          }
          parseAttemptRevision(committed.revision);
          this.#attempts.delete(key);
        });
      }
    }
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
