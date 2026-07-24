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
const DEFAULT_MAX_ASSIGNMENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_INVENTORY = 512;

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
  readonly #maxBufferedResults: number;
  readonly #results: ResultBuffer;
  readonly #attempts = new Map<string, WorkerAttempt>();
  #session: RemoteSession | undefined;
  #removeMessageListener: (() => void) | undefined;
  #removeStateListener: (() => void) | undefined;
  #receiveChain = Promise.resolve();
  #hydrated = false;
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
    this.#maxBufferedResults = positiveLimit(
      options.resultBuffer?.maxCount,
      256,
      "maxResultCount",
    );
    this.#results = new ResultBuffer(options.resultBuffer);
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
      this.#sessionLost(current);
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
        this.#sessionLost(session);
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const session = this.#session;
    if (session !== undefined) this.#sessionLost(session);
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
    if (records.length > this.#maxInventoryItems) {
      throw new Error("Worker attempt inventory exceeds maxInventoryItems");
    }
    for (const record of records) {
      const key = attemptKey(record.request.taskId, record.request.attemptId);
      if (record.state === "terminal" && record.result !== undefined) {
        this.#attempts.set(key, {
          request: record.request,
          fingerprint: record.fingerprint,
          state: "terminal",
          epoch: record.epoch,
          result: record.result,
        });
      } else if (record.state === "acknowledged" || record.state === "running") {
        this.#attempts.set(key, {
          request: record.request,
          fingerprint: record.fingerprint,
          state: "acknowledged",
          epoch: record.epoch,
        });
      }
    }
    for (const result of (await this.#resultStore?.list()) ?? []) {
      this.#results.put(parseExecutionResult(result));
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
      // A malformed application message cannot escape into the authenticated session.
    }
  }

  async #assign(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    const payload = asObject(message.payload, REMOTE_ASSIGN);
    const request = parseRemoteRequest(payload.request);
    const requestBytes = jsonBytes(request);
    const key = attemptKey(request.taskId, request.attemptId);
    const fingerprint = requestFingerprint(request);
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
    if (
      requestBytes > this.#maxAssignmentBytes ||
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
        void this.#execute(attempt);
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
      const executor = await this.#selectExecutor(attempt.request);
      if (executor.type === "remote") {
        throw new Error("Worker runtime cannot delegate an assignment to another RemoteExecutor");
      }
      attempt.executor = executor;
      const handle = await executor.submit(attempt.request);
      attempt.handle = handle;
      attempt.state = "running";
      await this.#save(attempt);
      const localResult = await handle.result;
      const result: ExecutionResult = {
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
    let result = parseExecutionResult(candidate);
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
      await attempt.executor?.cancel(request.taskId, request.attemptId);
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
    await session.send(
      REMOTE_INVENTORY_RESULT,
      {
        epoch: session.epoch,
        acknowledged: attempts
          .filter((attempt) => attempt.state === "acknowledged")
          .map((attempt) => identity(attempt.request)),
        running: attempts
          .filter((attempt) => attempt.state === "running")
          .map((attempt) => identity(attempt.request)),
        terminalUnacknowledged: buffered.map((result) => ({ result })),
        preparedArtifacts: artifacts,
      },
      { correlationId: message.messageId },
    );
  }

  async #acknowledgeResult(payloadValue: JsonValue): Promise<void> {
    const payload = asObject(payloadValue, REMOTE_RESULT_ACK);
    const request = identityFrom(payload);
    const retained = this.#results.get(request.taskId, request.attemptId);
    await this.#resultStore?.delete(request.taskId, request.attemptId);
    this.#results.acknowledge(request.taskId, request.attemptId);
    if (retained !== undefined) {
      this.#reservedResults = Math.max(0, this.#reservedResults - 1);
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

  #sessionLost(session: RemoteSession): void {
    if (this.#session !== session) return;
    this.#removeMessageListener?.();
    this.#removeStateListener?.();
    this.#removeMessageListener = undefined;
    this.#removeStateListener = undefined;
    this.#session = undefined;
    for (const attempt of this.#attempts.values()) {
      if (
        attempt.state !== "terminal" &&
        attempt.request.orphanPolicy === "cancel" &&
        attempt.executor !== undefined
      ) {
        void attempt.executor.cancel(attempt.request.taskId, attempt.request.attemptId);
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
    };
    await this.#attemptStore.save(record);
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
