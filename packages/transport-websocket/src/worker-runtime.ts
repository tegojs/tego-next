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
  isRemoteAttemptRevisionError,
  parseAttemptRevision,
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
const MAX_PERSISTENCE_ATTEMPTS = 8;

class AttemptPersistenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttemptPersistenceUnavailableError";
  }
}

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
  readonly persistenceTimeoutMs?: number;
  readonly retentionMs?: number;
  readonly resultBuffer?: ResultBufferOptions;
}

interface WorkerAttempt {
  readonly request: ExecutionRequest;
  readonly fingerprint: string;
  revision: string;
  transition: Promise<void>;
  state: "acknowledged" | "running" | "terminal";
  epoch: string;
  reservedBytes: number;
  executor?: Executor;
  handle?: ExecutionHandle;
  result?: ExecutionResult;
  acknowledgedAt?: number;
  cancellation?: "cancelled" | "timed-out";
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
  readonly #persistenceTimeoutMs: number;
  readonly #retentionMs: number;
  readonly #results: ResultBuffer;
  readonly #attempts = new Map<string, WorkerAttempt>();
  #session: RemoteSession | undefined;
  #removeMessageListener: (() => void) | undefined;
  #removeStateListener: (() => void) | undefined;
  #receiveChain = Promise.resolve();
  #attachChain = Promise.resolve();
  #highestEpoch = 0n;
  #hydrated = false;
  #recovered = false;
  #closed = false;
  #reservedResults = 0;
  #reservedResultBytes = 0;
  #persistenceAvailable = true;
  #attemptPersistenceAvailable = true;

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
    this.#maxBufferedResults = positiveLimit(options.resultBuffer?.maxCount, 256, "maxResultCount");
    this.#persistenceTimeoutMs = positiveLimit(
      options.persistenceTimeoutMs,
      1_000,
      "persistenceTimeoutMs",
    );
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
    this.#maxResultBytes = positiveLimit(
      options.maxResultBytes,
      Math.min(
        DEFAULT_MAX_CONTROL_PAYLOAD_BYTES - INVENTORY_ENVELOPE_RESERVE_BYTES,
        resultBufferBytes,
      ),
      "maxResultBytes",
    );
    if (this.#maxResultBytes > recoverableResultBytes || this.#maxResultBytes > resultBufferBytes) {
      throw new RangeError("maxResultBytes must fit in one recovery result buffer");
    }
    this.#results = new ResultBuffer({
      ...options.resultBuffer,
      maxBytes: resultBufferBytes,
    });
  }

  get bufferedResultCount(): number {
    return this.#results.count;
  }

  attach(session: RemoteSession): Promise<void> {
    const attached = this.#attachChain.then(async () => this.#attach(session));
    this.#attachChain = attached.catch(() => undefined);
    return attached;
  }

  async #attach(session: RemoteSession): Promise<void> {
    if (this.#closed) throw new Error("Worker runtime is closed");
    if (session.state !== "ready" || !session.available) {
      throw new Error("Worker session must be ready before attaching execution");
    }
    await this.#hydrate();
    const epoch = BigInt(session.epoch);
    if (epoch <= this.#highestEpoch && this.#session !== session) {
      throw new Error("Worker runtime session epoch is stale");
    }
    const current = this.#session;
    if (current !== undefined && current !== session) {
      await this.#sessionLost(current);
    }
    this.#removeMessageListener?.();
    this.#removeStateListener?.();
    this.#highestEpoch = epoch;
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
        if (attempt.state === "terminal") return;
        await this.#markCancelled(attempt);
        if (attempt.executor === undefined) {
          await this.#terminal(
            attempt,
            this.#result(
              attempt.request,
              "cancelled",
              "EXECUTOR_REMOTE_CANCELLED",
              "Worker runtime closed before local execution completed",
            ),
          );
          return;
        }
        await attempt.executor.cancel(attempt.request.taskId, attempt.request.attemptId);
        await attempt.handle?.result;
      }),
    );
  }

  async #hydrate(): Promise<void> {
    if (this.#hydrated) return;
    this.#assertAttemptPersistenceAvailable();
    const records = await this.#storeOperation(this.#attemptStore.list(this.#workerId));
    for (const record of records) this.#acceptRevision(record.revision);
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
      const persistedEpoch = BigInt(record.epoch);
      if (persistedEpoch > this.#highestEpoch) this.#highestEpoch = persistedEpoch;
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
          revision: this.#acceptRevision(record.revision),
          transition: Promise.resolve(),
          state: "terminal",
          epoch: record.epoch,
          reservedBytes: 0,
          result: durableResult,
          ...(record.cancellation === undefined ? {} : { cancellation: record.cancellation }),
          ...(record.acknowledgedAt === undefined
            ? {}
            : { acknowledgedAt: Date.parse(record.acknowledgedAt) }),
        };
        this.#attempts.set(key, attempt);
        this.#results.put(durableResult);
        durableResults.delete(key);
        await this.#commit(attempt, "terminal", durableResult);
        continue;
      }
      if (record.state === "terminal" && record.result !== undefined) {
        const attempt: WorkerAttempt = {
          request: record.request,
          fingerprint: record.fingerprint,
          revision: this.#acceptRevision(record.revision),
          transition: Promise.resolve(),
          state: "terminal",
          epoch: record.epoch,
          reservedBytes: 0,
          result: record.result,
          ...(record.cancellation === undefined ? {} : { cancellation: record.cancellation }),
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
          revision: this.#acceptRevision(record.revision),
          transition: Promise.resolve(),
          state: "acknowledged",
          epoch: record.epoch,
          reservedBytes: this.#resultReservationBytes(record.request),
          ...(record.cancellation === undefined ? {} : { cancellation: record.cancellation }),
        });
      }
    }
    for (const result of durableResults.values()) {
      this.#results.put(result);
    }
    this.#reservedResults =
      [...this.#attempts.values()].filter((attempt) => attempt.state !== "terminal").length +
      this.#results.count;
    this.#reservedResultBytes = [...this.#attempts.values()].reduce(
      (total, attempt) => total + attempt.reservedBytes,
      0,
    );
    if (
      [...this.#attempts.values()].some(
        (attempt) =>
          attempt.state !== "terminal" &&
          this.#minimumTerminalBytes(attempt.request) > this.#maxResultBytes,
      )
    ) {
      throw new Error("Configured maxResultBytes cannot retain mandatory terminal evidence");
    }
    if (this.#results.bytes + this.#reservedResultBytes > this.#results.maxBytes) {
      throw new Error("Persisted Worker result reservations exceed recovery buffer bytes");
    }
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
          if (
            asObject(message.payload, REMOTE_ACK).kind === "result" &&
            asObject(message.payload, REMOTE_ACK).error === undefined
          ) {
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
    if (await this.#rejectUnavailableAttemptStore(session, message.messageId, request)) return;
    try {
      await this.#pruneAcknowledged();
    } catch (error) {
      if (!(error instanceof AttemptPersistenceUnavailableError)) throw error;
      await this.#rejectUnavailableAttemptStore(session, message.messageId, request);
      return;
    }
    if (await this.#rejectUnavailableAttemptStore(session, message.messageId, request)) return;
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
    let persisted: RemoteAttemptRecord | undefined;
    try {
      persisted = await this.#storeOperation(
        this.#attemptStore.load(request.taskId, request.attemptId),
      );
    } catch (error) {
      if (!(error instanceof AttemptPersistenceUnavailableError)) throw error;
      await this.#rejectUnavailableAttemptStore(session, message.messageId, request);
      return;
    }
    if (persisted !== undefined) this.#acceptRevision(persisted.revision);
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
      this.#reservedResults >= this.#maxBufferedResults ||
      this.#minimumTerminalBytes(request) > this.#maxResultBytes ||
      this.#results.bytes + this.#reservedResultBytes + this.#resultReservationBytes(request) >
        this.#results.maxBytes
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
      revision: "0",
      transition: Promise.resolve(),
      state: "acknowledged",
      epoch: session.epoch,
      reservedBytes: this.#resultReservationBytes(request),
    };
    try {
      await this.#create(attempt);
    } catch {
      this.#attemptPersistenceAvailable = false;
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
    this.#reservedResultBytes += attempt.reservedBytes;
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
      if (this.#isStopped(attempt)) return;
      const executor = await this.#selectExecutor(attempt.request);
      if (this.#isStopped(attempt)) return;
      if (executor.type === "remote") {
        throw new Error("Worker runtime cannot delegate an assignment to another RemoteExecutor");
      }
      attempt.executor = executor;
      const handle = await executor.submit(attempt.request);
      attempt.handle = handle;
      if (this.#isTerminal(attempt)) {
        await executor.cancel(attempt.request.taskId, attempt.request.attemptId);
        return;
      }
      if (attempt.cancellation !== undefined || this.#closed) {
        await executor.cancel(attempt.request.taskId, attempt.request.attemptId);
      } else {
        await this.#transition(attempt, async () => {
          if (attempt.state !== "terminal" && attempt.cancellation === undefined && !this.#closed) {
            await this.#commit(attempt, "running");
          }
        });
      }
      if (this.#isTerminal(attempt)) {
        await executor.cancel(attempt.request.taskId, attempt.request.attemptId);
        return;
      }
      if (attempt.cancellation !== undefined || this.#closed) {
        await executor.cancel(attempt.request.taskId, attempt.request.attemptId);
      }
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
      if (attempt.state === "terminal") return;
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
    if (
      jsonBytes(result) > attempt.reservedBytes &&
      candidate.diagnostic?.code !== "EXECUTOR_REMOTE_RESULT_TOO_LARGE"
    ) {
      result = this.#result(
        attempt.request,
        "failed",
        "EXECUTOR_REMOTE_RESULT_TOO_LARGE",
        "Worker terminal diagnostic exceeds maxResultBytes",
      );
    }
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
    const terminal = cloneJson(result);
    try {
      await this.#transition(attempt, async () => {
        if (attempt.state === "terminal") return;
        await this.#commit(attempt, "terminal", terminal);
        const authoritative = attempt.result ?? terminal;
        if (JSON.stringify(authoritative) !== JSON.stringify(terminal)) {
          throw new Error("Worker attempt lost terminal commit authority to a conflicting result");
        }
        this.#results.put(authoritative);
        this.#reservedResultBytes = Math.max(0, this.#reservedResultBytes - attempt.reservedBytes);
        attempt.reservedBytes = 0;
      });
    } catch (error) {
      if (
        !isRemoteAttemptRevisionError(error) &&
        !(error instanceof AttemptPersistenceUnavailableError) &&
        this.#attemptPersistenceAvailable
      ) {
        throw error;
      }
      if (isRemoteAttemptRevisionError(error)) this.#attemptPersistenceAvailable = false;
      this.#terminalVolatile(
        attempt,
        this.#result(
          attempt.request,
          "failed",
          "EXECUTOR_REMOTE_STATE_UNAVAILABLE",
          isRemoteAttemptRevisionError(error)
            ? "Worker attempt persistence returned an invalid revision"
            : "Worker attempt persistence is unavailable",
        ),
      );
    }
    this.#background(this.#publish(attempt.result ?? terminal));
  }

  #terminalVolatile(attempt: WorkerAttempt, result: ExecutionResult): void {
    const terminal = cloneJson(result);
    attempt.result = terminal;
    attempt.state = "terminal";
    this.#results.put(terminal);
    this.#reservedResultBytes = Math.max(0, this.#reservedResultBytes - attempt.reservedBytes);
    attempt.reservedBytes = 0;
  }

  async #publish(result: ExecutionResult): Promise<void> {
    const session = this.#session;
    if (session === undefined || session.state !== "ready" || !session.available) return;
    try {
      const response = await session.request(REMOTE_RESULT, { result });
      if (response.type !== REMOTE_ACK) {
        throw new Error("Remote result response is not an acknowledgement");
      }
      const payload = asObject(response.payload, REMOTE_RESULT_ACK);
      const identity = identityFrom(payload);
      if (
        payload.kind !== "result" ||
        identity.taskId !== result.taskId ||
        identity.attemptId !== result.attemptId ||
        payload.error !== undefined
      ) {
        throw new Error("Remote result acknowledgement is invalid");
      }
      await this.#acknowledgeResult(payload);
    } catch {
      // The retained result is replayed from reconnect inventory.
    }
  }

  async #cancel(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    const payload = asObject(message.payload, REMOTE_CANCEL);
    const request = parseRemoteRequest(payload.request);
    const attempt = this.#attempts.get(attemptKey(request.taskId, request.attemptId));
    if (attempt !== undefined && attempt.state !== "terminal") {
      await this.#markCancelled(attempt);
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
        found: attempt !== undefined,
        ...(attempt?.result === undefined ? {} : { result: attempt.result }),
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
    if (retained !== undefined) {
      const attempt = this.#attempts.get(attemptKey(request.taskId, request.attemptId));
      if (attempt !== undefined) {
        if (!this.#attemptPersistenceAvailable) {
          this.#failAttemptPersistence(attempt, "Worker attempt persistence is unavailable");
          return;
        }
        await this.#transition(attempt, async () => {
          if (attempt.acknowledgedAt === undefined) {
            attempt.acknowledgedAt = this.#clock.now().getTime();
            try {
              await this.#commit(attempt);
            } catch (error) {
              delete attempt.acknowledgedAt;
              throw error;
            }
          }
        });
      }
      await this.#resultStore?.delete(request.taskId, request.attemptId);
      this.#results.acknowledge(request.taskId, request.attemptId);
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

  async #sessionLost(session: RemoteSession): Promise<void> {
    if (this.#session !== session) return;
    this.#removeMessageListener?.();
    this.#removeStateListener?.();
    this.#removeMessageListener = undefined;
    this.#removeStateListener = undefined;
    this.#session = undefined;
    for (const attempt of this.#attempts.values()) {
      if (attempt.state !== "terminal" && attempt.request.orphanPolicy === "cancel") {
        await this.#markCancelled(attempt);
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

  async #rejectUnavailableAttemptStore(
    session: RemoteSession,
    correlationId: string,
    request: ExecutionRequest,
  ): Promise<boolean> {
    if (this.#attemptPersistenceAvailable) return false;
    await this.#sendRejected(
      session,
      correlationId,
      request,
      "EXECUTOR_REMOTE_STATE_UNAVAILABLE",
      "Worker attempt persistence is unavailable",
    );
    return true;
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

  #acceptRevision(revision: unknown): string {
    try {
      return parseAttemptRevision(revision);
    } catch (error) {
      if (isRemoteAttemptRevisionError(error)) {
        this.#attemptPersistenceAvailable = false;
      }
      throw error;
    }
  }

  #record(
    attempt: WorkerAttempt,
    state = attempt.state,
    result = attempt.result,
  ): RemoteAttemptRecord {
    return {
      workerId: this.#workerId,
      request: attempt.request,
      fingerprint: attempt.fingerprint,
      state,
      epoch: attempt.epoch,
      updatedAt: this.#clock.now().toISOString(),
      revision: attempt.revision,
      ...(result === undefined ? {} : { result }),
      ...(attempt.cancellation === undefined ? {} : { cancellation: attempt.cancellation }),
      ...(attempt.acknowledgedAt === undefined
        ? {}
        : { acknowledgedAt: new Date(attempt.acknowledgedAt).toISOString() }),
    };
  }

  async #create(attempt: WorkerAttempt): Promise<void> {
    const committed = await this.#storeOperation(
      this.#attemptStore.commit(this.#record(attempt), {
        expectedRevision: null,
      }),
    );
    if (committed === undefined) {
      throw new Error("Remote attempt was concurrently admitted by another Worker session");
    }
    attempt.revision = this.#acceptRevision(committed.revision);
  }

  async #commit(
    attempt: WorkerAttempt,
    state = attempt.state,
    result = attempt.result,
  ): Promise<void> {
    let failures = 0;
    while (true) {
      try {
        const record = this.#record(attempt, state, result);
        const condition = {
          expectedRevision: attempt.revision,
          expectedEpoch: attempt.epoch,
        };
        const timeout = this.#watchPersistence(attempt);
        let committed: RemoteAttemptRecord | undefined;
        try {
          committed = await this.#attemptStore.commit(record, condition);
        } finally {
          timeout.abort("worker-persistence-completed");
        }
        if (!this.#attemptPersistenceAvailable) return;
        if (committed !== undefined) {
          attempt.revision = this.#acceptRevision(committed.revision);
          attempt.state = state;
          if (result !== undefined) attempt.result = result;
          return;
        }
        const latest = await this.#storeOperation(
          this.#attemptStore.load(attempt.request.taskId, attempt.request.attemptId),
        );
        if (latest === undefined) {
          throw new Error("Worker attempt disappeared during a conditional commit");
        }
        attempt.revision = this.#acceptRevision(latest.revision);
        attempt.epoch = latest.epoch;
        if (latest.cancellation === undefined) {
          delete attempt.cancellation;
        } else {
          attempt.cancellation = latest.cancellation;
        }
        if (latest.result !== undefined || latest.state === "terminal") {
          attempt.state = "terminal";
          if (latest.result !== undefined) attempt.result = latest.result;
          return;
        }
        throw new Error("Worker attempt transition lost epoch or revision authority");
      } catch (error) {
        if (isRemoteAttemptRevisionError(error)) {
          this.#failAttemptPersistence(
            attempt,
            "Worker attempt persistence returned an invalid revision",
          );
          throw error;
        }
        if (!this.#attemptPersistenceAvailable) {
          this.#failAttemptPersistence(attempt, "Worker attempt persistence is unavailable");
          throw new AttemptPersistenceUnavailableError("Worker attempt persistence is unavailable");
        }
        if (error instanceof AttemptPersistenceUnavailableError) throw error;
        if (
          error instanceof Error &&
          /lost epoch or revision authority|disappeared/iu.test(error.message)
        ) {
          throw error;
        }
        failures += 1;
        if (failures >= MAX_PERSISTENCE_ATTEMPTS) {
          this.#failAttemptPersistence(
            attempt,
            "Worker attempt persistence remained unavailable after bounded retries",
          );
          throw new AttemptPersistenceUnavailableError(
            "Worker attempt persistence remained unavailable after bounded retries",
          );
        }
        if (failures < 3) {
          await Promise.resolve();
        } else {
          await this.#clock.sleep(25);
        }
      }
    }
  }

  #transition<T>(attempt: WorkerAttempt, operation: () => Promise<T>): Promise<T> {
    const transitioned = attempt.transition.then(operation, operation);
    attempt.transition = transitioned.then(
      () => undefined,
      () => undefined,
    );
    return transitioned;
  }

  async #storeOperation<T>(operation: Promise<T>): Promise<T> {
    const timeout = new AbortController();
    try {
      return await Promise.race([
        operation,
        this.#clock.sleep(this.#persistenceTimeoutMs, timeout.signal).then<T>(() => {
          this.#attemptPersistenceAvailable = false;
          throw new AttemptPersistenceUnavailableError(
            "Worker attempt persistence operation timed out",
          );
        }),
      ]);
    } catch (error) {
      this.#attemptPersistenceAvailable = false;
      if (error instanceof AttemptPersistenceUnavailableError) throw error;
      throw new AttemptPersistenceUnavailableError(
        error instanceof Error
          ? `Worker attempt persistence failed: ${error.message}`
          : "Worker attempt persistence failed",
      );
    } finally {
      timeout.abort("worker-persistence-completed");
    }
  }

  #assertAttemptPersistenceAvailable(): void {
    if (this.#attemptPersistenceAvailable) return;
    throw new AttemptPersistenceUnavailableError("Worker attempt persistence is unavailable");
  }

  #watchPersistence(attempt: WorkerAttempt): AbortController {
    const timeout = new AbortController();
    this.#background(
      this.#clock.sleep(this.#persistenceTimeoutMs, timeout.signal).then(() => {
        this.#failAttemptPersistence(attempt, "Worker attempt persistence operation timed out");
      }),
    );
    return timeout;
  }

  #failAttemptPersistence(attempt: WorkerAttempt, message: string): void {
    this.#attemptPersistenceAvailable = false;
    if (attempt.state === "terminal") return;
    const failure = this.#result(
      attempt.request,
      "failed",
      "EXECUTOR_REMOTE_STATE_UNAVAILABLE",
      message,
    );
    this.#terminalVolatile(attempt, failure);
    this.#background(this.#publish(failure));
  }

  async #markCancelled(attempt: WorkerAttempt): Promise<void> {
    if (attempt.state === "terminal") return;
    attempt.cancellation = "cancelled";
    await this.#transition(attempt, async () => {
      if (attempt.state === "terminal") return;
      await this.#commit(attempt);
    });
  }

  async #pruneAcknowledged(): Promise<void> {
    const cutoff = this.#clock.now().getTime() - this.#retentionMs;
    for (const [key, attempt] of this.#attempts) {
      if (
        attempt.state === "terminal" &&
        attempt.acknowledgedAt !== undefined &&
        attempt.acknowledgedAt <= cutoff
      ) {
        const expired = await this.#storeOperation(
          this.#attemptStore.commit(
            {
              ...this.#record(attempt),
              state: "expired",
              updatedAt: this.#clock.now().toISOString(),
            },
            {
              expectedRevision: attempt.revision,
              expectedEpoch: attempt.epoch,
            },
          ),
        );
        if (expired === undefined) continue;
        this.#acceptRevision(expired.revision);
        this.#attempts.delete(key);
      }
    }
  }

  async #recoverHydrated(): Promise<void> {
    if (this.#recovered) return;
    this.#recovered = true;
    for (const attempt of this.#attempts.values()) {
      if (attempt.state === "terminal") continue;
      const cancelled =
        attempt.cancellation !== undefined || attempt.request.orphanPolicy === "cancel";
      if (cancelled && attempt.cancellation === undefined) await this.#markCancelled(attempt);
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

  #isStopped(attempt: WorkerAttempt): boolean {
    return attempt.state === "terminal" || attempt.cancellation !== undefined || this.#closed;
  }

  #isTerminal(attempt: WorkerAttempt): boolean {
    return attempt.state === "terminal";
  }

  #resultReservationBytes(request: ExecutionRequest): number {
    return Math.max(this.#maxResultBytes, this.#minimumTerminalBytes(request));
  }

  #minimumTerminalBytes(request: ExecutionRequest): number {
    const failures = [
      this.#result(
        request,
        "cancelled",
        "EXECUTOR_REMOTE_CANCELLED",
        "Worker runtime closed before local execution completed",
      ),
      this.#result(
        request,
        "cancelled",
        "EXECUTOR_REMOTE_ORPHAN_CANCELLED",
        "Assignment acknowledgement was interrupted",
      ),
      this.#result(
        request,
        "failed",
        "EXECUTOR_REMOTE_RESULT_IDENTITY_MISMATCH",
        "Worker local Executor returned a result for a different attempt identity",
      ),
      this.#result(
        request,
        "failed",
        "EXECUTOR_REMOTE_LOCAL_FAILURE",
        "Worker local executor failed to run the remote assignment",
      ),
      this.#result(
        request,
        "failed",
        "EXECUTOR_REMOTE_RESULT_TOO_LARGE",
        "Worker terminal diagnostic exceeds maxResultBytes",
      ),
      this.#result(
        request,
        "failed",
        "EXECUTOR_REMOTE_PERSISTENCE_FAILED",
        "Worker durable result persistence failed",
      ),
      this.#result(
        request,
        "failed",
        "EXECUTOR_REMOTE_RESTART_UNCERTAIN",
        "Worker restart cannot safely re-execute an unfinished remote attempt",
      ),
    ];
    return Math.max(...failures.map((result) => jsonBytes(result)));
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
