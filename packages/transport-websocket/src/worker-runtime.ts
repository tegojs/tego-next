import {
  parseExecutionResult,
  type Clock,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type JsonValue,
  type RuntimeDiagnostic,
  type WorkerId,
} from "@tegojs/contracts";
import { ResultBuffer, type ResultBufferOptions } from "./result-buffer.js";
import {
  REMOTE_ACK,
  REMOTE_ASSIGN,
  REMOTE_CANCEL,
  REMOTE_CANCEL_ACK,
  REMOTE_INVENTORY,
  REMOTE_INVENTORY_RESULT,
  REMOTE_RESULT,
  REMOTE_RESULT_ACK,
  asObject,
  attemptKey,
  cloneJson,
  jsonBytes,
  parseRemoteRequest,
  positiveLimit,
  remoteDiagnostic,
  requestFingerprint,
  type RemoteAttemptRecord,
  type RemoteAttemptStore,
  type RemoteResultStore,
  type RemoteSession,
  type RemoteSessionMessage,
} from "./remote-protocol.js";

const DEFAULT_MAX_ASSIGNMENTS = 256;
const DEFAULT_MAX_CONTROL_PAYLOAD_BYTES = 48 * 1024;
const DEFAULT_MAX_ASSIGNMENT_BYTES = DEFAULT_MAX_CONTROL_PAYLOAD_BYTES;
const DEFAULT_MAX_INVENTORY = 512;
const INVENTORY_ENVELOPE_RESERVE_BYTES = 4 * 1024;

export interface WorkerRuntimeOptions {
  readonly workerId: WorkerId;
  readonly clock: Clock;
  readonly attemptStore: RemoteAttemptStore;
  readonly resultStore?: RemoteResultStore;
  readonly selectExecutor: (request: ExecutionRequest) => Executor | Promise<Executor>;
  readonly preparedArtifacts?: () => readonly string[] | Promise<readonly string[]>;
  readonly maxAssignments?: number;
  readonly maxAssignmentBytes?: number;
  readonly maxInventoryItems?: number;
  readonly maxInventoryBytes?: number;
  readonly maxResultBytes?: number;
  readonly retentionMs?: number;
  readonly resultBuffer?: ResultBufferOptions;
}

interface WorkerAttempt {
  readonly request: ExecutionRequest;
  readonly fingerprint: string;
  state: "acknowledged" | "running" | "terminal";
  epoch: string;
  executor?: Executor;
  handle?: ExecutionHandle;
  result?: ExecutionResult;
  acknowledgedAt?: number;
  cancellation?: "cancelled";
}

export class WorkerRuntime {
  readonly #workerId: WorkerId;
  readonly #clock: Clock;
  readonly #attemptStore: RemoteAttemptStore;
  readonly #resultStore: RemoteResultStore | undefined;
  readonly #selectExecutor: WorkerRuntimeOptions["selectExecutor"];
  readonly #preparedArtifacts: WorkerRuntimeOptions["preparedArtifacts"];
  readonly #maxAssignments: number;
  readonly #maxAssignmentBytes: number;
  readonly #maxInventoryItems: number;
  readonly #maxInventoryBytes: number;
  readonly #maxResultBytes: number;
  readonly #maxBufferedResults: number;
  readonly #retentionMs: number;
  readonly #results: ResultBuffer;
  readonly #attempts = new Map<string, WorkerAttempt>();
  #session: RemoteSession | undefined;
  #removeMessageListener: (() => void) | undefined;
  #removeStateListener: (() => void) | undefined;
  #receiveChain = Promise.resolve();
  #hydrated = false;
  #recovered = false;
  #closed = false;
  #reservedResults = 0;
  #persistenceAvailable = true;

  constructor(options: WorkerRuntimeOptions) {
    this.#workerId = options.workerId;
    this.#clock = options.clock;
    this.#attemptStore = options.attemptStore;
    this.#resultStore = options.resultStore;
    this.#selectExecutor = options.selectExecutor;
    this.#preparedArtifacts = options.preparedArtifacts;
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
    this.#maxResultBytes = positiveLimit(
      options.maxResultBytes,
      DEFAULT_MAX_CONTROL_PAYLOAD_BYTES - INVENTORY_ENVELOPE_RESERVE_BYTES,
      "maxResultBytes",
    );
    this.#maxBufferedResults = positiveLimit(options.resultBuffer?.maxCount, 256, "maxResultCount");
    this.#retentionMs = positiveLimit(options.retentionMs, 24 * 60 * 60 * 1000, "retentionMs");
    const recoverableResultBytes = this.#maxInventoryBytes - INVENTORY_ENVELOPE_RESERVE_BYTES;
    if (recoverableResultBytes <= 0) {
      throw new RangeError("maxInventoryBytes is too small for recovery metadata");
    }
    const resultBufferBytes = positiveLimit(
      options.resultBuffer?.maxBytes,
      recoverableResultBytes,
      "maxResultBytes",
    );
    if (resultBufferBytes > recoverableResultBytes) {
      throw new RangeError("result buffer bytes must fit in one recovery inventory");
    }
    if (this.#maxResultBytes > recoverableResultBytes) {
      throw new RangeError("maxResultBytes must fit in one recovery inventory");
    }
    this.#results = new ResultBuffer({
      ...options.resultBuffer,
      maxBytes: resultBufferBytes,
    });
  }

  get bufferedResultCount(): number {
    return this.#results.count;
  }

  async attach(session: RemoteSession): Promise<void> {
    if (this.#closed) throw new Error("Worker runtime is closed");
    if (session.state !== "ready" || !session.available) {
      throw new Error("Worker session must be ready before attaching execution");
    }
    const current = this.#session;
    if (current !== undefined && current !== session) {
      await this.#sessionLost(current);
    }
    this.#removeMessageListener?.();
    this.#removeStateListener?.();
    await this.#hydrate();
    this.#session = session;
    this.#removeMessageListener = session.onMessage((message) => {
      if (this.#session === session) {
        this.#receiveChain = this.#receiveChain
          .then(async () => this.#receive(session, message))
          .catch(() => undefined);
      }
    });
    this.#removeStateListener = session.onStateChange((state) => {
      if (this.#session === session && state !== "ready") {
        this.#background(this.#sessionLost(session));
      }
    });
    await this.#recoverHydrated();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const session = this.#session;
    if (session !== undefined) await this.#sessionLost(session);
    await Promise.all(
      [...this.#attempts.values()].map(async (attempt) => {
        if (attempt.state !== "terminal" && attempt.executor !== undefined) {
          await attempt.executor.cancel(attempt.request.taskId, attempt.request.attemptId);
          await attempt.handle?.result;
        }
      }),
    );
  }

  async #hydrate(): Promise<void> {
    if (this.#hydrated) return;
    const records = await this.#attemptStore.list(this.#workerId);
    const activeRecords = records.filter((record) => record.state !== "expired");
    if (activeRecords.length > this.#maxInventoryItems) {
      throw new Error("Worker attempt inventory exceeds maxInventoryItems");
    }
    const durableResults = new Map(
      ((await this.#resultStore?.list()) ?? []).map((result) => [
        attemptKey(result.taskId, result.attemptId),
        parseExecutionResult(result),
      ]),
    );
    for (const record of records) {
      const key = attemptKey(record.request.taskId, record.request.attemptId);
      if (record.state === "expired") continue;
      const durableResult = durableResults.get(key);
      if (durableResult !== undefined) {
        if (
          durableResult.taskId !== record.request.taskId ||
          durableResult.attemptId !== record.request.attemptId
        ) {
          throw new Error("Durable remote result identity does not match its attempt record");
        }
        const attempt: WorkerAttempt = {
          request: record.request,
          fingerprint: record.fingerprint,
          state: "terminal",
          epoch: record.epoch,
          result: durableResult,
        };
        this.#attempts.set(key, attempt);
        this.#results.put(durableResult);
        durableResults.delete(key);
        await this.#save(attempt);
        continue;
      }
      if (record.state === "terminal" && record.result !== undefined) {
        const attempt: WorkerAttempt = {
          request: record.request,
          fingerprint: record.fingerprint,
          state: "terminal",
          epoch: record.epoch,
          result: record.result,
          ...(record.acknowledgedAt === undefined
            ? {}
            : { acknowledgedAt: Date.parse(record.acknowledgedAt) }),
        };
        this.#attempts.set(key, attempt);
        if (record.acknowledgedAt === undefined) this.#results.put(record.result);
      } else if (record.state === "acknowledged" || record.state === "running") {
        this.#attempts.set(key, {
          request: record.request,
          fingerprint: record.fingerprint,
          state: "acknowledged",
          epoch: record.epoch,
        });
      }
    }
    for (const result of durableResults.values()) {
      this.#results.put(result);
    }
    this.#reservedResults =
      [...this.#attempts.values()].filter((attempt) => attempt.state !== "terminal").length +
      this.#results.count;
    this.#hydrated = true;
  }

  async #receive(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    try {
      switch (message.type) {
        case REMOTE_ASSIGN:
          await this.#assign(session, message);
          break;
        case REMOTE_CANCEL:
          await this.#cancel(session, message);
          break;
        case REMOTE_INVENTORY:
          await this.#inventory(session, message);
          break;
        case REMOTE_ACK:
          if (asObject(message.payload, REMOTE_ACK).kind === "result") {
            await this.#acknowledgeResult(message.payload);
          }
          break;
      }
    } catch {
      if (session.state !== "ready") return;
      if (message.type === REMOTE_INVENTORY) {
        await this.#inventoryError(
          session,
          message.messageId,
          "Worker could not produce reconnect inventory",
        );
        return;
      }
      if (message.type === REMOTE_ASSIGN) {
        try {
          const request = parseRemoteRequest(asObject(message.payload, REMOTE_ASSIGN).request);
          await this.#sendRejected(
            session,
            message.messageId,
            request,
            "EXECUTOR_REMOTE_STATE_UNAVAILABLE",
            "Worker could not process the remote assignment",
          );
        } catch {
          await session.send(
            REMOTE_ACK,
            {
              accepted: false,
              error: {
                code: "EXECUTOR_REMOTE_ASSIGNMENT_INVALID",
                message: "Worker could not parse the remote assignment",
              },
            },
            { correlationId: message.messageId },
          );
        }
        return;
      }
      if (message.type === REMOTE_CANCEL) {
        await session.send(
          REMOTE_CANCEL_ACK,
          {
            error: {
              code: "EXECUTOR_REMOTE_CANCEL_FAILED",
              message: "Worker could not process remote cancellation",
            },
          },
          { correlationId: message.messageId },
        );
      }
    }
  }

  async #assign(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    const payload = asObject(message.payload, REMOTE_ASSIGN);
    if (payload.request === undefined || jsonBytes(payload.request) > this.#maxAssignmentBytes) {
      throw new Error("Remote assignment exceeds maxAssignmentBytes");
    }
    const request = parseRemoteRequest(payload.request);
    const key = attemptKey(request.taskId, request.attemptId);
    const fingerprint = requestFingerprint(request);
    await this.#pruneAcknowledged();
    const existing = this.#attempts.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        await this.#sendRejected(
          session,
          message.messageId,
          request,
          "EXECUTOR_REMOTE_IDENTITY_CONFLICT",
          "Remote attempt identity has a different request fingerprint",
        );
        return;
      }
      await session.send(
        REMOTE_ACK,
        {
          accepted: true,
          taskId: request.taskId,
          attemptId: request.attemptId,
          state: existing.state,
          ...(existing.result === undefined ? {} : { result: existing.result }),
        },
        { correlationId: message.messageId },
      );
      if (
        existing.result !== undefined &&
        this.#results.get(existing.result.taskId, existing.result.attemptId) !== undefined
      ) {
        await this.#publish(existing.result);
      }
      return;
    }
    const persisted = await this.#attemptStore.load(request.taskId, request.attemptId);
    if (persisted?.state === "expired") {
      await this.#sendRejected(
        session,
        message.messageId,
        request,
        persisted.fingerprint === fingerprint
          ? "EXECUTOR_REMOTE_ATTEMPT_EXPIRED"
          : "EXECUTOR_REMOTE_IDENTITY_CONFLICT",
        persisted.fingerprint === fingerprint
          ? "Remote attempt identity has expired and cannot be reused"
          : "Expired remote attempt identity has a different request fingerprint",
      );
      return;
    }
    if (
      this.#attempts.size >= this.#maxAssignments ||
      this.#reservedResults >= this.#maxBufferedResults
    ) {
      await this.#sendRejected(
        session,
        message.messageId,
        request,
        "EXECUTOR_REMOTE_ADMISSION_EXHAUSTED",
        "Worker remote assignment capacity is exhausted",
      );
      return;
    }
    if (
      request.orphanPolicy === "finish-and-persist" &&
      (this.#resultStore?.durable !== true || !this.#persistenceAvailable)
    ) {
      await this.#sendRejected(
        session,
        message.messageId,
        request,
        "EXECUTOR_REMOTE_PERSISTENCE_UNAVAILABLE",
        "finish-and-persist requires an injected durable result store",
      );
      return;
    }
    const attempt: WorkerAttempt = {
      request: cloneJson(request),
      fingerprint,
      state: "acknowledged",
      epoch: session.epoch,
    };
    try {
      await this.#save(attempt);
    } catch {
      await this.#sendRejected(
        session,
        message.messageId,
        request,
        "EXECUTOR_REMOTE_STATE_UNAVAILABLE",
        "Worker could not persist assignment acknowledgement",
      );
      return;
    }
    this.#attempts.set(key, attempt);
    this.#reservedResults += 1;
    let acknowledged = false;
    try {
      await session.send(
        REMOTE_ACK,
        {
          accepted: true,
          taskId: request.taskId,
          attemptId: request.attemptId,
          state: "acknowledged",
        },
        { correlationId: message.messageId },
      );
      acknowledged = true;
    } finally {
      if (acknowledged || request.orphanPolicy !== "cancel") {
        this.#background(this.#execute(attempt));
      } else {
        await this.#terminal(
          attempt,
          this.#result(
            attempt.request,
            "cancelled",
            "EXECUTOR_REMOTE_ORPHAN_CANCELLED",
            "Assignment acknowledgement was interrupted",
          ),
        );
      }
    }
  }

  async #execute(attempt: WorkerAttempt): Promise<void> {
    try {
      if (attempt.cancellation !== undefined) return;
      const executor = await this.#selectExecutor(attempt.request);
      if (attempt.state === "terminal" || attempt.cancellation !== undefined) return;
      if (executor.type === "remote") {
        throw new Error("Worker runtime cannot delegate an assignment to another RemoteExecutor");
      }
      attempt.executor = executor;
      const handle = await executor.submit(attempt.request);
      attempt.handle = handle;
      if (attempt.cancellation !== undefined) {
        await executor.cancel(attempt.request.taskId, attempt.request.attemptId);
        return;
      }
      attempt.state = "running";
      await this.#save(attempt);
      const localResult = await handle.result;
      const result: ExecutionResult =
        localResult.taskId !== attempt.request.taskId ||
        localResult.attemptId !== attempt.request.attemptId
          ? this.#result(
              attempt.request,
              "failed",
              "EXECUTOR_REMOTE_RESULT_IDENTITY_MISMATCH",
              "Worker local Executor returned a result for a different attempt identity",
            )
          : {
              ...localResult,
              executor: {
                kind: "remote",
                workerId: this.#workerId,
                metadata: {
                  localExecutorId: executor.id,
                  localExecutorKind: executor.type,
                },
              },
            };
      await this.#terminal(attempt, result);
    } catch {
      await this.#terminal(
        attempt,
        this.#result(
          attempt.request,
          "failed",
          "EXECUTOR_REMOTE_LOCAL_FAILURE",
          "Worker local executor failed to run the remote assignment",
        ),
      );
    }
  }

  async #terminal(attempt: WorkerAttempt, candidate: ExecutionResult): Promise<void> {
    if (attempt.state === "terminal") return;
    let result =
      jsonBytes(candidate) > this.#maxResultBytes
        ? this.#result(
            attempt.request,
            "failed",
            "EXECUTOR_REMOTE_RESULT_TOO_LARGE",
            "Worker local result exceeds maxResultBytes",
          )
        : parseExecutionResult(candidate);
    if (attempt.request.orphanPolicy === "finish-and-persist") {
      try {
        await this.#resultStore?.put(result);
      } catch {
        this.#persistenceAvailable = false;
        result = this.#result(
          attempt.request,
          "failed",
          "EXECUTOR_REMOTE_PERSISTENCE_FAILED",
          "Worker durable result persistence failed",
        );
      }
    }
    try {
      this.#results.put(result);
    } catch {
      result = this.#result(
        attempt.request,
        "failed",
        "EXECUTOR_REMOTE_RESULT_BUFFER_EXHAUSTED",
        "Worker could not retain the unacknowledged terminal result",
      );
      if (attempt.request.orphanPolicy === "finish-and-persist") {
        await this.#resultStore?.put(result);
      }
      this.#results.put(result);
    }
    attempt.state = "terminal";
    attempt.result = result;
    await this.#save(attempt);
    await this.#publish(result);
  }

  async #publish(result: ExecutionResult): Promise<void> {
    const session = this.#session;
    if (session === undefined || session.state !== "ready" || !session.available) return;
    try {
      await session.send(REMOTE_RESULT, { result });
    } catch {
      // The retained result is replayed from reconnect inventory.
    }
  }

  async #cancel(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    const payload = asObject(message.payload, REMOTE_CANCEL);
    const request = parseRemoteRequest(payload.request);
    const attempt = this.#attempts.get(attemptKey(request.taskId, request.attemptId));
    if (attempt !== undefined && attempt.state !== "terminal") {
      attempt.cancellation = "cancelled";
      if (attempt.executor === undefined) {
        await this.#terminal(
          attempt,
          this.#result(
            request,
            "cancelled",
            "EXECUTOR_REMOTE_CANCELLED",
            "Remote attempt was cancelled before local execution",
          ),
        );
      } else {
        await attempt.executor.cancel(request.taskId, request.attemptId);
      }
    }
    await session.send(
      REMOTE_CANCEL_ACK,
      {
        taskId: request.taskId,
        attemptId: request.attemptId,
      },
      { correlationId: message.messageId },
    );
  }

  async #inventory(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    const attempts = [...this.#attempts.values()];
    const buffered = this.#results.list();
    if (attempts.length + buffered.length > this.#maxInventoryItems) {
      await this.#inventoryError(
        session,
        message.messageId,
        "Worker reconnect inventory exceeds maxInventoryItems",
      );
      return;
    }
    const artifacts = [...((await this.#preparedArtifacts?.()) ?? [])];
    if (artifacts.length > this.#maxInventoryItems) {
      await this.#inventoryError(
        session,
        message.messageId,
        "Worker prepared artifact inventory exceeds maxInventoryItems",
      );
      return;
    }
    const inventory = {
      epoch: session.epoch,
      acknowledged: attempts
        .filter((attempt) => attempt.state === "acknowledged")
        .map((attempt) => identity(attempt.request)),
      running: attempts
        .filter((attempt) => attempt.state === "running")
        .map((attempt) => identity(attempt.request)),
      terminalUnacknowledged: buffered.map((result) => ({ result })),
      preparedArtifacts: artifacts,
    } as const;
    if (jsonBytes(inventory) > this.#maxInventoryBytes) {
      await this.#inventoryError(
        session,
        message.messageId,
        "Worker reconnect inventory exceeds maxInventoryBytes",
      );
      return;
    }
    await session.send(REMOTE_INVENTORY_RESULT, inventory, { correlationId: message.messageId });
  }

  async #acknowledgeResult(payloadValue: JsonValue): Promise<void> {
    const payload = asObject(payloadValue, REMOTE_RESULT_ACK);
    const request = identityFrom(payload);
    const retained = this.#results.get(request.taskId, request.attemptId);
    await this.#resultStore?.delete(request.taskId, request.attemptId);
    this.#results.acknowledge(request.taskId, request.attemptId);
    if (retained !== undefined) {
      this.#reservedResults = Math.max(0, this.#reservedResults - 1);
      const attempt = this.#attempts.get(attemptKey(request.taskId, request.attemptId));
      if (attempt !== undefined) {
        attempt.acknowledgedAt = this.#clock.now().getTime();
        await this.#save(attempt);
      }
    }
  }

  async #inventoryError(
    session: RemoteSession,
    correlationId: string,
    message: string,
  ): Promise<void> {
    await session.send(
      REMOTE_INVENTORY_RESULT,
      {
        epoch: session.epoch,
        error: {
          code: "EXECUTOR_REMOTE_INVENTORY_EXHAUSTED",
          message,
        },
        acknowledged: [],
        running: [],
        terminalUnacknowledged: [],
        preparedArtifacts: [],
      },
      { correlationId },
    );
  }

  async #sessionLost(session: RemoteSession): Promise<void> {
    if (this.#session !== session) return;
    this.#removeMessageListener?.();
    this.#removeStateListener?.();
    this.#removeMessageListener = undefined;
    this.#removeStateListener = undefined;
    this.#session = undefined;
    for (const attempt of this.#attempts.values()) {
      if (attempt.state !== "terminal" && attempt.request.orphanPolicy === "cancel") {
        attempt.cancellation = "cancelled";
        if (attempt.executor === undefined) {
          await this.#terminal(
            attempt,
            this.#result(
              attempt.request,
              "cancelled",
              "EXECUTOR_REMOTE_ORPHAN_CANCELLED",
              "Worker session was lost before local execution",
            ),
          );
        } else {
          await attempt.executor.cancel(attempt.request.taskId, attempt.request.attemptId);
        }
      }
    }
  }

  async #sendRejected(
    session: RemoteSession,
    correlationId: string,
    request: ExecutionRequest,
    code: RuntimeDiagnostic["code"],
    message: string,
  ): Promise<void> {
    const result = this.#result(request, "rejected", code, message);
    await session.send(
      REMOTE_ACK,
      {
        accepted: false,
        taskId: request.taskId,
        attemptId: request.attemptId,
        result,
      },
      { correlationId },
    );
  }

  #result(
    request: ExecutionRequest,
    status: ExecutionResult["status"],
    code: RuntimeDiagnostic["code"],
    message: string,
  ): ExecutionResult {
    const now = this.#clock.now().toISOString();
    return {
      taskId: request.taskId,
      attemptId: request.attemptId,
      status,
      diagnostic: remoteDiagnostic(code, message, "worker-runtime", now),
      executor: { kind: "remote", workerId: this.#workerId },
      startedAt: now,
      completedAt: now,
    };
  }

  async #save(attempt: WorkerAttempt): Promise<void> {
    const record: RemoteAttemptRecord = {
      workerId: this.#workerId,
      request: attempt.request,
      fingerprint: attempt.fingerprint,
      state: attempt.state,
      epoch: attempt.epoch,
      updatedAt: this.#clock.now().toISOString(),
      ...(attempt.result === undefined ? {} : { result: attempt.result }),
      ...(attempt.acknowledgedAt === undefined
        ? {}
        : { acknowledgedAt: new Date(attempt.acknowledgedAt).toISOString() }),
    };
    await this.#attemptStore.save(record);
  }

  async #pruneAcknowledged(): Promise<void> {
    const cutoff = this.#clock.now().getTime() - this.#retentionMs;
    for (const [key, attempt] of this.#attempts) {
      if (
        attempt.state === "terminal" &&
        attempt.acknowledgedAt !== undefined &&
        attempt.acknowledgedAt <= cutoff
      ) {
        await this.#attemptStore.save({
          workerId: this.#workerId,
          request: attempt.request,
          fingerprint: attempt.fingerprint,
          state: "expired",
          epoch: attempt.epoch,
          updatedAt: this.#clock.now().toISOString(),
          acknowledgedAt: new Date(attempt.acknowledgedAt).toISOString(),
        });
        this.#attempts.delete(key);
      }
    }
  }

  async #recoverHydrated(): Promise<void> {
    if (this.#recovered) return;
    this.#recovered = true;
    for (const attempt of this.#attempts.values()) {
      if (attempt.state === "terminal") continue;
      const cancelled = attempt.request.orphanPolicy === "cancel";
      if (cancelled) attempt.cancellation = "cancelled";
      await this.#terminal(
        attempt,
        this.#result(
          attempt.request,
          cancelled ? "cancelled" : "failed",
          cancelled ? "EXECUTOR_REMOTE_ORPHAN_CANCELLED" : "EXECUTOR_REMOTE_RESTART_UNCERTAIN",
          cancelled
            ? "Worker restart cancelled an unfinished remote attempt"
            : "Worker restart cannot safely re-execute an unfinished remote attempt",
        ),
      );
    }
  }

  #background(promise: Promise<unknown>): void {
    void promise.catch(() => undefined);
  }
}

function identity(request: ExecutionRequest): {
  readonly taskId: ExecutionRequest["taskId"];
  readonly attemptId: ExecutionRequest["attemptId"];
} {
  return { taskId: request.taskId, attemptId: request.attemptId };
}

function identityFrom(payload: Record<string, JsonValue>): {
  readonly taskId: ExecutionRequest["taskId"];
  readonly attemptId: ExecutionRequest["attemptId"];
} {
  const request = parseRemoteRequest({
    taskId: payload.taskId,
    attemptId: payload.attemptId,
    applicationId: "remote-identity",
    pluginId: "remote.identity",
    componentId: "identity",
    input: null,
    deadline: new Date(0).toISOString(),
    orphanPolicy: "cancel",
  });
  return identity(request);
}
