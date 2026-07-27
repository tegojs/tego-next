import {
  type Clock,
  DiagnosticError,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type JsonValue,
  parseAttemptId,
  parseExecutionResult,
  parseTaskExecutionTarget,
  parseTaskId,
  type RuntimeDiagnostic,
  serializeWireValue,
  type TaskExecutionTarget,
  type WorkerId,
  type WorkerMessageType,
} from "@tegojs/contracts";
import {
  countPendingCapabilityEntries,
  getCapabilityEntry,
  reserveCapabilityEntry,
} from "./capability-dedupe.js";
import {
  asObject,
  attemptKey,
  capabilityInvocationFingerprint,
  cloneJson,
  isRemoteAttemptRevisionError,
  jsonBytes,
  jsonFingerprint,
  parseAttemptRevision,
  parseRemoteAttemptRecord,
  parseRemoteCapabilityInvocation,
  parseRemoteCapabilityResponse,
  parseRemoteComponentActivation,
  parseRemoteRequest,
  positiveLimit,
  REMOTE_ACK,
  REMOTE_ASSIGN,
  REMOTE_CANCEL,
  REMOTE_CANCEL_ACK,
  REMOTE_CAPABILITY_INVOKE,
  REMOTE_COMPONENT_ACTIVATE,
  REMOTE_COMPONENT_ACTIVATED,
  REMOTE_COMPONENT_DRAIN,
  REMOTE_COMPONENT_STOP,
  REMOTE_INVENTORY,
  REMOTE_INVENTORY_RESULT,
  REMOTE_RESULT,
  REMOTE_RESULT_ACK,
  RemoteAttemptRevisionError,
  type RemoteAttemptRecord,
  type RemoteAttemptRecordExpectation,
  type RemoteAttemptStore,
  type RemoteCapabilityInvocation,
  type RemoteCapabilityInvocationResponse,
  type RemoteComponentActivation,
  type RemoteComponentLifecycleResponse,
  type RemoteResultStore,
  type RemoteSession,
  type RemoteSessionMessage,
  remoteDiagnostic,
  requestFingerprint,
} from "./remote-protocol.js";
import { ResultBuffer, type ResultBufferOptions } from "./result-buffer.js";

const DEFAULT_MAX_ASSIGNMENTS = 256;
const DEFAULT_MAX_CONTROL_PAYLOAD_BYTES = 48 * 1024;
const DEFAULT_MAX_ASSIGNMENT_BYTES = DEFAULT_MAX_CONTROL_PAYLOAD_BYTES;
const DEFAULT_MAX_INVENTORY = 512;
const DEFAULT_MAX_CAPABILITY_INVOCATIONS = 256;
const DEFAULT_MAX_COMPONENT_ACTIVATIONS = 256;
const INVENTORY_ENVELOPE_RESERVE_BYTES = 4 * 1024;
const MAX_PERSISTENCE_ATTEMPTS = 8;

export interface WorkerAssignmentRejection {
  readonly code: RuntimeDiagnostic["code"];
  readonly message: string;
}

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
  readonly validateAssignment?: (
    request: ExecutionRequest,
  ) => Promise<WorkerAssignmentRejection | undefined> | WorkerAssignmentRejection | undefined;
  readonly preparedArtifacts?: () => readonly string[] | Promise<readonly string[]>;
  readonly invokeCapability?: (
    request: RemoteCapabilityInvocation,
  ) => JsonValue | Promise<JsonValue>;
  readonly maxCapabilityInvocations?: number;
  readonly maxIndeterminateCapabilityInvocations?: number;
  readonly maxCapabilityInvocationBytes?: number;
  readonly validateActivation?: (activation: RemoteComponentActivation) => void | Promise<void>;
  readonly activateComponent?: (activation: RemoteComponentActivation) => void | Promise<void>;
  readonly drainComponent?: (activation: RemoteComponentActivation) => void | Promise<void>;
  readonly stopComponent?: (activation: RemoteComponentActivation) => void | Promise<void>;
  readonly maxComponentActivations?: number;
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
  readonly completion: PromiseWithResolvers<void>;
}

interface WorkerActivation {
  readonly activation: RemoteComponentActivation;
  state: "active" | "draining";
}

function attemptCompletion(completed = false): PromiseWithResolvers<void> {
  const completion = Promise.withResolvers<void>();
  if (completed) completion.resolve();
  return completion;
}

export class WorkerRuntime {
  readonly #workerId: WorkerId;
  readonly #clock: Clock;
  readonly #attemptStore: RemoteAttemptStore;
  readonly #resultStore: RemoteResultStore | undefined;
  readonly #selectExecutor: WorkerRuntimeOptions["selectExecutor"];
  readonly #validateAssignment: WorkerRuntimeOptions["validateAssignment"];
  readonly #preparedArtifacts: WorkerRuntimeOptions["preparedArtifacts"];
  readonly #invokeCapability: WorkerRuntimeOptions["invokeCapability"];
  readonly #maxCapabilityInvocations: number;
  readonly #maxIndeterminateCapabilityInvocations: number;
  readonly #maxCapabilityInvocationBytes: number;
  readonly #validateActivation: WorkerRuntimeOptions["validateActivation"];
  readonly #activateComponentCallback: WorkerRuntimeOptions["activateComponent"];
  readonly #drainComponentCallback: WorkerRuntimeOptions["drainComponent"];
  readonly #stopComponentCallback: WorkerRuntimeOptions["stopComponent"];
  readonly #maxComponentActivations: number;
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
  readonly #capabilityInvocations = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly response: Promise<RemoteCapabilityInvocationResponse>;
      readonly target: TaskExecutionTarget;
      settled: boolean;
    }
  >();
  readonly #mainCapabilityInvocations = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly result: Promise<JsonValue>;
      readonly target: TaskExecutionTarget;
      settled: boolean;
    }
  >();
  readonly #indeterminateMainCapabilityInvocations = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly error: DiagnosticError;
      readonly target: TaskExecutionTarget;
    }
  >();
  readonly #activations = new Map<string, WorkerActivation>();
  #session: RemoteSession | undefined;
  #removeMessageListener: (() => void) | undefined;
  #removeStateListener: (() => void) | undefined;
  #receiveChain = Promise.resolve();
  #attachChain = Promise.resolve();
  #highestEpoch = 0n;
  #hydrated = false;
  #initialization?: Promise<void>;
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
    this.#validateAssignment = options.validateAssignment;
    this.#preparedArtifacts = options.preparedArtifacts;
    this.#invokeCapability = options.invokeCapability;
    this.#maxCapabilityInvocations = positiveLimit(
      options.maxCapabilityInvocations,
      DEFAULT_MAX_CAPABILITY_INVOCATIONS,
      "maxCapabilityInvocations",
    );
    this.#maxIndeterminateCapabilityInvocations = positiveLimit(
      options.maxIndeterminateCapabilityInvocations,
      DEFAULT_MAX_CAPABILITY_INVOCATIONS,
      "maxIndeterminateCapabilityInvocations",
    );
    this.#maxCapabilityInvocationBytes = positiveLimit(
      options.maxCapabilityInvocationBytes,
      DEFAULT_MAX_CONTROL_PAYLOAD_BYTES,
      "maxCapabilityInvocationBytes",
    );
    this.#validateActivation = options.validateActivation;
    this.#activateComponentCallback = options.activateComponent;
    this.#drainComponentCallback = options.drainComponent;
    this.#stopComponentCallback = options.stopComponent;
    this.#maxComponentActivations = positiveLimit(
      options.maxComponentActivations,
      DEFAULT_MAX_COMPONENT_ACTIVATIONS,
      "maxComponentActivations",
    );
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

  async invokeMainCapability(requestValue: RemoteCapabilityInvocation): Promise<JsonValue> {
    const request = parseRemoteCapabilityInvocation(requestValue);
    if (
      request.target.executor.type !== "remote" ||
      request.target.executor.workerId !== this.#workerId
    ) {
      throw new DiagnosticError(
        remoteDiagnostic(
          "PROTOCOL_CAPABILITY_TARGET_INVALID",
          "Capability invocation target does not match this authenticated Worker",
          this.#workerId,
          this.#clock.now().toISOString(),
        ),
      );
    }
    if (this.#validateActivation !== undefined) {
      const activation = this.#activations.get(this.#activationKey(request.target));
      if (
        activation === undefined ||
        activation.state !== "active" ||
        activation.activation.bindingFingerprint !== request.bindingFingerprint
      ) {
        throw new DiagnosticError(
          remoteDiagnostic(
            "CAPABILITY_CONSUMER_NOT_READY",
            "Capability invocation does not match an active exact remote consumer binding",
            this.#workerId,
            this.#clock.now().toISOString(),
          ),
        );
      }
    }
    const fingerprint = capabilityInvocationFingerprint(request);
    const existing = getCapabilityEntry(this.#mainCapabilityInvocations, request.invocationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new DiagnosticError(
          remoteDiagnostic(
            "PROTOCOL_CAPABILITY_INVOCATION_CONFLICT",
            "Capability invocation identity has a different canonical fingerprint",
            this.#workerId,
            this.#clock.now().toISOString(),
          ),
        );
      }
      return existing.result;
    }
    const indeterminate = this.#indeterminateMainCapabilityInvocations.get(request.invocationId);
    if (indeterminate !== undefined) {
      if (indeterminate.fingerprint !== fingerprint) {
        throw new DiagnosticError(
          remoteDiagnostic(
            "PROTOCOL_CAPABILITY_INVOCATION_CONFLICT",
            "Capability invocation identity has a different canonical fingerprint",
            this.#workerId,
            this.#clock.now().toISOString(),
          ),
        );
      }
      throw indeterminate.error;
    }
    if (!reserveCapabilityEntry(this.#mainCapabilityInvocations, this.#maxCapabilityInvocations)) {
      throw new DiagnosticError(
        remoteDiagnostic(
          "CAPABILITY_INVOCATION_EXHAUSTED",
          "Worker to Main capability invocation capacity is exhausted",
          this.#workerId,
          this.#clock.now().toISOString(),
        ),
      );
    }
    if (
      this.#indeterminateMainCapabilityInvocations.size +
        countPendingCapabilityEntries(this.#mainCapabilityInvocations) >=
      this.#maxIndeterminateCapabilityInvocations
    ) {
      throw new DiagnosticError(
        remoteDiagnostic(
          "CAPABILITY_INVOCATION_EXHAUSTED",
          "Worker indeterminate capability tombstone capacity is exhausted until component stop",
          this.#workerId,
          this.#clock.now().toISOString(),
        ),
      );
    }
    const session = this.#session;
    if (session === undefined || session.state !== "ready" || !session.available) {
      throw new DiagnosticError(
        remoteDiagnostic(
          "CAPABILITY_REMOTE_NOT_AVAILABLE",
          "Main capability invocation requires an authenticated ready session",
          this.#workerId,
          this.#clock.now().toISOString(),
        ),
      );
    }
    const result = this.#requestMainCapability(session, request, fingerprint);
    const entry = {
      fingerprint,
      result,
      target: cloneJson(request.target),
      settled: false,
    };
    this.#mainCapabilityInvocations.set(request.invocationId, entry);
    void result.then(
      () => {
        entry.settled = true;
      },
      (error: unknown) => {
        if (
          error instanceof DiagnosticError &&
          error.diagnostic.code === "CAPABILITY_INVOCATION_INDETERMINATE"
        ) {
          this.#mainCapabilityInvocations.delete(request.invocationId);
          this.#indeterminateMainCapabilityInvocations.set(request.invocationId, {
            fingerprint,
            error,
            target: cloneJson(request.target),
          });
          return;
        }
        entry.settled = true;
      },
    );
    return result;
  }

  async #requestMainCapability(
    session: RemoteSession,
    request: RemoteCapabilityInvocation,
    fingerprint: string,
  ): Promise<JsonValue> {
    let response: RemoteSessionMessage;
    try {
      response = await session.request(REMOTE_CAPABILITY_INVOKE, { request, fingerprint });
    } catch {
      throw new DiagnosticError(
        remoteDiagnostic(
          "CAPABILITY_INVOCATION_INDETERMINATE",
          "Main capability invocation is indeterminate because the session ended before an authoritative response",
          this.#workerId,
          this.#clock.now().toISOString(),
          { invocationId: request.invocationId, fingerprint },
        ),
      );
    }
    if (
      this.#session !== session ||
      session.state !== "ready" ||
      response.type !== REMOTE_CAPABILITY_INVOKE
    ) {
      throw new DiagnosticError(
        remoteDiagnostic(
          "CAPABILITY_INVOCATION_INDETERMINATE",
          "Main capability invocation is indeterminate because session authority changed before its response",
          this.#workerId,
          this.#clock.now().toISOString(),
          { invocationId: request.invocationId, fingerprint },
        ),
      );
    }
    const payload = parseRemoteCapabilityResponse(response.payload);
    if (payload.invocationId !== request.invocationId || payload.fingerprint !== fingerprint) {
      throw new DiagnosticError(
        remoteDiagnostic(
          "PROTOCOL_CAPABILITY_RESPONSE_INVALID",
          "Main capability response identity does not match its invocation",
          this.#workerId,
          this.#clock.now().toISOString(),
        ),
      );
    }
    if (!payload.ok) {
      throw new DiagnosticError(
        remoteDiagnostic(
          payload.error?.code ?? "CAPABILITY_INVOCATION_FAILED",
          payload.error?.message ?? "Main capability invocation failed",
          this.#workerId,
          this.#clock.now().toISOString(),
          { invocationId: request.invocationId, fingerprint },
        ),
      );
    }
    return cloneJson(payload.value ?? null);
  }

  initialize(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Worker runtime is closed"));
    if (this.#initialization === undefined) {
      this.#initialization = this.#hydrate();
    }
    return this.#initialization;
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
    await this.initialize();
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
    this.#capabilityInvocations.clear();
    this.#mainCapabilityInvocations.clear();
    this.#indeterminateMainCapabilityInvocations.clear();
  }

  async #hydrate(): Promise<void> {
    if (this.#hydrated) return;
    this.#assertAttemptPersistenceAvailable();
    const recoveryLimit =
      this.#maxInventoryItems === Number.MAX_SAFE_INTEGER
        ? Number.MAX_SAFE_INTEGER
        : this.#maxInventoryItems + 1;
    const inventory = await this.#storeOperation(
      this.#attemptStore.recover(this.#workerId, recoveryLimit),
    );
    const records = inventory.records;
    if (records.length > this.#maxInventoryItems) {
      throw new Error("Worker attempt inventory exceeds maxInventoryItems");
    }
    const recoveredHighestEpoch = BigInt(parseAttemptRevision(inventory.highestEpoch));
    const parsedRecords = records.map((record) => this.#parseStoredRecord(record));
    const recoveredAttempts = new Set<string>();
    for (const { record, request } of parsedRecords) {
      if (record.state === "expired") {
        throw new TypeError("Worker attempt recovery inventory cannot contain expired records");
      }
      if (BigInt(record.epoch) > recoveredHighestEpoch) {
        throw new TypeError("Worker attempt recovery epoch exceeds its durable watermark");
      }
      const key = attemptKey(request.taskId, request.attemptId);
      if (recoveredAttempts.has(key)) {
        throw new TypeError("Worker attempt recovery inventory contains a duplicate identity");
      }
      recoveredAttempts.add(key);
    }
    const durableResults = new Map(
      ((await this.#resultStore?.list()) ?? []).map((result) => [
        attemptKey(result.taskId, result.attemptId),
        parseExecutionResult(result),
      ]),
    );
    if (recoveredHighestEpoch > this.#highestEpoch) this.#highestEpoch = recoveredHighestEpoch;
    for (const { record, request, result: terminalResult } of parsedRecords) {
      const key = attemptKey(request.taskId, request.attemptId);
      const durableResult = durableResults.get(key);
      if (durableResult !== undefined) {
        if (
          durableResult.taskId !== request.taskId ||
          durableResult.attemptId !== request.attemptId ||
          durableResult.executor.kind !== "remote" ||
          durableResult.executor.workerId !== this.#workerId
        ) {
          throw new Error("Durable remote result identity does not match its attempt record");
        }
        const attempt: WorkerAttempt = {
          request,
          fingerprint: record.fingerprint,
          revision: this.#acceptRevision(record.revision),
          transition: Promise.resolve(),
          state: "terminal",
          epoch: record.epoch,
          reservedBytes: 0,
          result: durableResult,
          completion: attemptCompletion(true),
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
      if (record.state === "terminal" && terminalResult !== undefined) {
        const attempt: WorkerAttempt = {
          request,
          fingerprint: record.fingerprint,
          revision: this.#acceptRevision(record.revision),
          transition: Promise.resolve(),
          state: "terminal",
          epoch: record.epoch,
          reservedBytes: 0,
          result: terminalResult,
          completion: attemptCompletion(true),
          ...(record.cancellation === undefined ? {} : { cancellation: record.cancellation }),
          ...(record.acknowledgedAt === undefined
            ? {}
            : { acknowledgedAt: Date.parse(record.acknowledgedAt) }),
        };
        this.#attempts.set(key, attempt);
        if (record.acknowledgedAt === undefined) this.#results.put(terminalResult);
      } else if (record.state === "acknowledged" || record.state === "running") {
        this.#attempts.set(key, {
          request,
          fingerprint: record.fingerprint,
          revision: this.#acceptRevision(record.revision),
          transition: Promise.resolve(),
          state: "acknowledged",
          epoch: record.epoch,
          reservedBytes: this.#resultReservationBytes(request),
          completion: attemptCompletion(),
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
        case REMOTE_CAPABILITY_INVOKE:
          await this.#capabilityInvoke(session, message);
          break;
        case REMOTE_COMPONENT_ACTIVATE:
          await this.#activateComponent(session, message);
          break;
        case REMOTE_COMPONENT_DRAIN:
          await this.#drainComponent(session, message);
          break;
        case REMOTE_COMPONENT_STOP:
          await this.#stopComponent(session, message);
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
      if (message.type === REMOTE_CAPABILITY_INVOKE) {
        // #capabilityInvoke converts all authoritative failures into responses.
        return;
      }
      if (
        message.type === REMOTE_COMPONENT_ACTIVATE ||
        message.type === REMOTE_COMPONENT_DRAIN ||
        message.type === REMOTE_COMPONENT_STOP
      ) {
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

  async #activateComponent(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    let activation: RemoteComponentActivation;
    try {
      activation = parseRemoteComponentActivation(
        asObject(message.payload, REMOTE_COMPONENT_ACTIVATE).activation,
      );
    } catch {
      return;
    }
    const key = this.#activationKey(activation.target);
    const existing = this.#activations.get(key);
    if (existing !== undefined) {
      if (existing.activation.bindingFingerprint !== activation.bindingFingerprint) {
        await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_ACTIVATED, message.messageId, {
          ok: false,
          target: activation.target,
          bindingFingerprint: activation.bindingFingerprint,
          error: {
            code: "PROTOCOL_COMPONENT_ACTIVATION_CONFLICT",
            message: "Exact component activation has a different binding fingerprint",
          },
        });
        return;
      }
      if (existing.state !== "active") {
        await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_ACTIVATED, message.messageId, {
          ok: false,
          target: activation.target,
          bindingFingerprint: activation.bindingFingerprint,
          error: {
            code: "LIFECYCLE_COMPONENT_NOT_ACTIVE",
            message: "A draining component activation cannot be promoted back to active",
          },
        });
        return;
      }
      await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_ACTIVATED, message.messageId, {
        ok: true,
        target: activation.target,
        bindingFingerprint: activation.bindingFingerprint,
      });
      return;
    }
    if (this.#activations.size >= this.#maxComponentActivations) {
      await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_ACTIVATED, message.messageId, {
        ok: false,
        target: activation.target,
        bindingFingerprint: activation.bindingFingerprint,
        error: {
          code: "LIFECYCLE_COMPONENT_ACTIVATION_EXHAUSTED",
          message: "Worker component activation capacity is exhausted",
        },
      });
      return;
    }
    if (
      activation.target.executor.type !== "remote" ||
      activation.target.executor.workerId !== this.#workerId
    ) {
      await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_ACTIVATED, message.messageId, {
        ok: false,
        target: activation.target,
        bindingFingerprint: activation.bindingFingerprint,
        error: {
          code: "PROTOCOL_COMPONENT_ACTIVATION_TARGET_INVALID",
          message: "Component activation target does not match this authenticated Worker",
        },
      });
      return;
    }
    try {
      await this.#validateActivation?.(cloneJson(activation));
    } catch {
      await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_ACTIVATED, message.messageId, {
        ok: false,
        target: activation.target,
        bindingFingerprint: activation.bindingFingerprint,
        error: {
          code: "LIFECYCLE_COMPONENT_ACTIVATION_INVALID",
          message: "Worker rejected component activation validation",
        },
      });
      return;
    }
    try {
      await this.#activateComponentCallback?.(cloneJson(activation));
    } catch {
      await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_ACTIVATED, message.messageId, {
        ok: false,
        target: activation.target,
        bindingFingerprint: activation.bindingFingerprint,
        error: {
          code: "LIFECYCLE_COMPONENT_ACTIVATION_FAILED",
          message: "Worker could not materialize the component activation",
        },
      });
      return;
    }
    this.#activations.set(key, { activation: cloneJson(activation), state: "active" });
    await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_ACTIVATED, message.messageId, {
      ok: true,
      target: activation.target,
      bindingFingerprint: activation.bindingFingerprint,
    });
  }

  async #drainComponent(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    const payload = asObject(message.payload, REMOTE_COMPONENT_DRAIN);
    const target = parseTaskExecutionTarget(payload.target);
    const activation = this.#activations.get(this.#activationKey(target));
    if (activation === undefined || !this.#sameTarget(activation.activation.target, target)) {
      await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_DRAIN, message.messageId, {
        ok: false,
        target,
        error: {
          code: "LIFECYCLE_COMPONENT_NOT_ACTIVE",
          message: "Worker has no matching exact component activation",
        },
      });
      return;
    }
    if (payload.bindingFingerprint !== activation.activation.bindingFingerprint) {
      await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_DRAIN, message.messageId, {
        ok: false,
        target,
        bindingFingerprint: activation.activation.bindingFingerprint,
        error: {
          code: "PROTOCOL_COMPONENT_ACTIVATION_CONFLICT",
          message: "Worker component drain requires the exact activation binding fingerprint",
        },
      });
      return;
    }
    activation.state = "draining";
    await Promise.all(
      [...this.#attempts.values()]
        .filter(
          (attempt) =>
            attempt.state !== "terminal" &&
            attempt.request.binding.fingerprint === activation.activation.bindingFingerprint &&
            this.#sameTarget(attempt.request.target, target),
        )
        .map(async (attempt) => attempt.completion.promise),
    );
    try {
      await this.#drainComponentCallback?.(cloneJson(activation.activation));
    } catch {
      await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_DRAIN, message.messageId, {
        ok: false,
        target,
        bindingFingerprint: activation.activation.bindingFingerprint,
        error: {
          code: "LIFECYCLE_COMPONENT_DRAIN_FAILED",
          message: "Worker could not drain the materialized component activation",
        },
      });
      return;
    }
    await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_DRAIN, message.messageId, {
      ok: true,
      target,
      bindingFingerprint: activation.activation.bindingFingerprint,
    });
  }

  async #stopComponent(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    const payload = asObject(message.payload, REMOTE_COMPONENT_STOP);
    const target = parseTaskExecutionTarget(payload.target);
    const key = this.#activationKey(target);
    const activation = this.#activations.get(key);
    if (activation === undefined || !this.#sameTarget(activation.activation.target, target)) {
      await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_STOP, message.messageId, {
        ok: false,
        target,
        error: {
          code: "LIFECYCLE_COMPONENT_NOT_ACTIVE",
          message: "Worker has no matching exact component activation",
        },
      });
      return;
    }
    if (payload.bindingFingerprint !== activation.activation.bindingFingerprint) {
      await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_STOP, message.messageId, {
        ok: false,
        target,
        bindingFingerprint: activation.activation.bindingFingerprint,
        error: {
          code: "PROTOCOL_COMPONENT_ACTIVATION_CONFLICT",
          message: "Worker component stop binding fingerprint does not match the activation",
        },
      });
      return;
    }
    activation.state = "draining";
    await Promise.all(
      [...this.#attempts.values()]
        .filter(
          (attempt) =>
            attempt.state !== "terminal" &&
            attempt.request.binding.fingerprint === activation.activation.bindingFingerprint &&
            this.#sameTarget(attempt.request.target, target),
        )
        .map(async (attempt) => attempt.completion.promise),
    );
    try {
      await this.#stopComponentCallback?.(cloneJson(activation.activation));
    } catch {
      await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_STOP, message.messageId, {
        ok: false,
        target,
        bindingFingerprint: activation.activation.bindingFingerprint,
        error: {
          code: "LIFECYCLE_COMPONENT_STOP_FAILED",
          message: "Worker could not stop the materialized component activation",
        },
      });
      return;
    }
    this.#activations.delete(key);
    this.#clearCapabilityHistory(target);
    await this.#sendLifecycleResponse(session, REMOTE_COMPONENT_STOP, message.messageId, {
      ok: true,
      target,
      bindingFingerprint: activation.activation.bindingFingerprint,
    });
  }

  #clearCapabilityHistory(target: TaskExecutionTarget): void {
    for (const [invocationId, entry] of this.#capabilityInvocations) {
      if (this.#sameTarget(entry.target, target)) {
        this.#capabilityInvocations.delete(invocationId);
      }
    }
    for (const [invocationId, entry] of this.#mainCapabilityInvocations) {
      if (this.#sameTarget(entry.target, target)) {
        this.#mainCapabilityInvocations.delete(invocationId);
      }
    }
    for (const [invocationId, entry] of this.#indeterminateMainCapabilityInvocations) {
      if (this.#sameTarget(entry.target, target)) {
        this.#indeterminateMainCapabilityInvocations.delete(invocationId);
      }
    }
  }

  async #sendLifecycleResponse(
    session: RemoteSession,
    type: WorkerMessageType,
    correlationId: string,
    response: RemoteComponentLifecycleResponse,
  ): Promise<void> {
    if (this.#session !== session || session.state !== "ready") return;
    await session.send(type, response, { correlationId });
  }

  #activationKey(target: TaskExecutionTarget): string {
    return jsonFingerprint(target);
  }

  #sameTarget(left: TaskExecutionTarget, right: TaskExecutionTarget): boolean {
    return (
      left.instanceId === right.instanceId &&
      left.deploymentGeneration === right.deploymentGeneration &&
      left.artifactDigest === right.artifactDigest &&
      left.executor.id === right.executor.id &&
      left.executor.type === right.executor.type &&
      left.executor.workerId === right.executor.workerId
    );
  }

  async #capabilityInvoke(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    const payload = asObject(message.payload, REMOTE_CAPABILITY_INVOKE);
    if (jsonBytes(payload) > this.#maxCapabilityInvocationBytes) {
      throw new Error("Remote capability invocation exceeds maxCapabilityInvocationBytes");
    }
    const request = parseRemoteCapabilityInvocation(payload.request);
    const fingerprint = capabilityInvocationFingerprint(request);
    const suppliedFingerprint = payload.fingerprint;
    if (suppliedFingerprint !== fingerprint) {
      await this.#sendCapabilityResponse(session, message.messageId, {
        invocationId: request.invocationId,
        fingerprint,
        ok: false,
        error: {
          code: "PROTOCOL_CAPABILITY_INVOCATION_CONFLICT",
          message: "Capability invocation fingerprint is not canonical",
        },
      });
      return;
    }
    if (
      request.target.executor.type !== "remote" ||
      request.target.executor.workerId !== this.#workerId
    ) {
      await this.#sendCapabilityResponse(session, message.messageId, {
        invocationId: request.invocationId,
        fingerprint,
        ok: false,
        error: {
          code: "PROTOCOL_CAPABILITY_TARGET_INVALID",
          message: "Capability invocation target does not match this authenticated Worker",
        },
      });
      return;
    }
    if (this.#validateActivation !== undefined) {
      const activation = this.#activations.get(this.#activationKey(request.target));
      if (
        activation === undefined ||
        activation.state !== "active" ||
        activation.activation.bindingFingerprint !== request.bindingFingerprint
      ) {
        await this.#sendCapabilityResponse(session, message.messageId, {
          invocationId: request.invocationId,
          fingerprint,
          ok: false,
          error: {
            code: "CAPABILITY_PROVIDER_NOT_READY",
            message: "Capability invocation does not match an active exact provider binding",
          },
        });
        return;
      }
    }
    const existing = getCapabilityEntry(this.#capabilityInvocations, request.invocationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        await this.#sendCapabilityResponse(session, message.messageId, {
          invocationId: request.invocationId,
          fingerprint,
          ok: false,
          error: {
            code: "PROTOCOL_CAPABILITY_INVOCATION_CONFLICT",
            message: "Capability invocation identity has a different canonical fingerprint",
          },
        });
        return;
      }
      await this.#sendCapabilityResponse(session, message.messageId, await existing.response);
      return;
    }
    if (!reserveCapabilityEntry(this.#capabilityInvocations, this.#maxCapabilityInvocations)) {
      await this.#sendCapabilityResponse(session, message.messageId, {
        invocationId: request.invocationId,
        fingerprint,
        ok: false,
        error: {
          code: "CAPABILITY_INVOCATION_EXHAUSTED",
          message: "Worker capability invocation capacity is exhausted",
        },
      });
      return;
    }
    const response = this.#executeCapability(request, fingerprint);
    const entry = {
      fingerprint,
      response,
      target: cloneJson(request.target),
      settled: false,
    };
    this.#capabilityInvocations.set(request.invocationId, entry);
    void response.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      },
    );
    await this.#sendCapabilityResponse(session, message.messageId, await response);
  }

  async #executeCapability(
    request: RemoteCapabilityInvocation,
    fingerprint: string,
  ): Promise<RemoteCapabilityInvocationResponse> {
    if (this.#invokeCapability === undefined) {
      return {
        invocationId: request.invocationId,
        fingerprint,
        ok: false,
        error: {
          code: "CAPABILITY_INVOCATION_UNAVAILABLE",
          message: "Worker has no capability invocation handler",
        },
      };
    }
    try {
      return {
        invocationId: request.invocationId,
        fingerprint,
        ok: true,
        value: serializeWireValue(await this.#invokeCapability(cloneJson(request))),
      };
    } catch {
      return {
        invocationId: request.invocationId,
        fingerprint,
        ok: false,
        error: {
          code: "CAPABILITY_INVOCATION_FAILED",
          message: "Worker capability invocation handler failed",
        },
      };
    }
  }

  async #sendCapabilityResponse(
    session: RemoteSession,
    correlationId: string,
    response: RemoteCapabilityInvocationResponse,
  ): Promise<void> {
    if (this.#session !== session || session.state !== "ready") return;
    await session.send(REMOTE_CAPABILITY_INVOKE, response, { correlationId });
  }

  async #assign(session: RemoteSession, message: RemoteSessionMessage): Promise<void> {
    const payload = asObject(message.payload, REMOTE_ASSIGN);
    if (payload.request === undefined || jsonBytes(payload.request) > this.#maxAssignmentBytes) {
      throw new Error("Remote assignment exceeds maxAssignmentBytes");
    }
    const request = parseRemoteRequest(payload.request);
    if (
      request.target.executor.type !== "remote" ||
      request.target.executor.workerId !== this.#workerId
    ) {
      await this.#sendRejected(
        session,
        message.messageId,
        request,
        "PROTOCOL_EXECUTION_TARGET_INVALID",
        "Execution request target does not match this Worker",
      );
      return;
    }
    if (this.#validateActivation !== undefined) {
      const activation = this.#activations.get(this.#activationKey(request.target));
      if (
        activation === undefined ||
        activation.state !== "active" ||
        activation.activation.bindingFingerprint !== request.binding.fingerprint ||
        activation.activation.identity.applicationId !== request.applicationId ||
        activation.activation.identity.pluginId !== request.pluginId ||
        activation.activation.identity.componentId !== request.componentId ||
        !this.#sameTarget(activation.activation.target, request.target)
      ) {
        await this.#sendRejected(
          session,
          message.messageId,
          request,
          "EXECUTOR_REMOTE_ACTIVATION_NOT_READY",
          "Execution request does not match an active exact component binding",
        );
        return;
      }
    }
    const rejection = await this.#validateAssignment?.(request);
    if (rejection !== undefined) {
      await this.#sendRejected(
        session,
        message.messageId,
        request,
        rejection.code,
        rejection.message,
      );
      return;
    }
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
    if (persisted !== undefined) {
      persisted = this.#parseStoredRecord(persisted, {
        taskId: request.taskId,
        attemptId: request.attemptId,
      }).record;
    }
    if (persisted !== undefined && persisted.fingerprint !== fingerprint) {
      await this.#sendRejected(
        session,
        message.messageId,
        request,
        "EXECUTOR_REMOTE_IDENTITY_CONFLICT",
        "Persisted remote attempt identity has a different request fingerprint",
      );
      return;
    }
    if (persisted?.state === "expired") {
      await this.#sendRejected(
        session,
        message.messageId,
        request,
        "EXECUTOR_REMOTE_ATTEMPT_EXPIRED",
        "Remote attempt identity has expired and cannot be reused",
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
      completion: attemptCompletion(),
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
          "indeterminate",
          "EXECUTOR_REMOTE_STATE_UNAVAILABLE",
          isRemoteAttemptRevisionError(error)
            ? "Worker attempt persistence returned an invalid revision"
            : "Worker attempt persistence is unavailable",
        ),
      );
    }
    attempt.completion.resolve();
    this.#background(this.#publish(attempt.result ?? terminal));
  }

  #terminalVolatile(attempt: WorkerAttempt, result: ExecutionResult): void {
    if (attempt.state === "terminal") return;
    const terminal = cloneJson(result);
    attempt.result = terminal;
    attempt.state = "terminal";
    attempt.completion.resolve();
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
    const payload = asObject(message.payload, REMOTE_INVENTORY);
    if (
      !Array.isArray(payload.activations) ||
      payload.activations.length > this.#maxComponentActivations
    ) {
      await this.#inventoryError(
        session,
        message.messageId,
        "Worker reconnect component activation inventory is invalid",
      );
      return;
    }
    const reconciledActivations: {
      readonly activation: RemoteComponentActivation;
      readonly existing: WorkerActivation | undefined;
      readonly key: string;
      readonly state: "active" | "draining";
    }[] = [];
    const activationKeys = new Set<string>();
    let newActivationCount = 0;
    for (const value of payload.activations) {
      const retained = asObject(value, "Worker reconnect component activation");
      if (retained.state !== "active" && retained.state !== "draining") {
        throw new Error("Worker reconnect component activation state is invalid");
      }
      const activation = parseRemoteComponentActivation(retained.activation);
      const key = this.#activationKey(activation.target);
      if (activationKeys.has(key)) {
        throw new Error("Worker reconnect component activation inventory has a duplicate target");
      }
      activationKeys.add(key);
      const existing = this.#activations.get(key);
      if (existing !== undefined) {
        if (
          existing.activation.bindingFingerprint !== activation.bindingFingerprint ||
          !this.#sameTarget(existing.activation.target, activation.target)
        ) {
          throw new Error("Worker reconnect component activation conflicts with retained state");
        }
        if (existing.state === "draining" && retained.state === "active") {
          throw new Error("Worker reconnect cannot promote a draining component activation");
        }
      } else {
        if (
          activation.target.executor.type !== "remote" ||
          activation.target.executor.workerId !== this.#workerId
        ) {
          throw new Error("Worker reconnect component activation target is invalid");
        }
        newActivationCount += 1;
      }
      reconciledActivations.push({
        activation,
        existing,
        key,
        state: retained.state,
      });
    }
    if (this.#activations.size + newActivationCount > this.#maxComponentActivations) {
      throw new Error("Worker reconnect component activation capacity is exhausted");
    }
    for (const candidate of reconciledActivations) {
      if (candidate.existing !== undefined) continue;
      await this.#validateActivation?.(cloneJson(candidate.activation));
    }
    for (const candidate of reconciledActivations) {
      if (candidate.existing !== undefined) continue;
      await this.#activateComponentCallback?.(cloneJson(candidate.activation));
      this.#activations.set(candidate.key, {
        activation: cloneJson(candidate.activation),
        state: candidate.state,
      });
    }
    for (const candidate of reconciledActivations) {
      if (candidate.existing !== undefined) {
        if (candidate.state === "draining") {
          candidate.existing.state = "draining";
        }
      }
    }
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
      attemptPersistenceAvailable: this.#attemptPersistenceAvailable,
      acknowledged: attempts
        .filter((attempt) => attempt.state === "acknowledged")
        .map((attempt) => identity(attempt.request)),
      running: attempts
        .filter((attempt) => attempt.state === "running")
        .map((attempt) => identity(attempt.request)),
      terminalUnacknowledged: buffered.map((result) => ({ result })),
      preparedArtifacts: artifacts,
      componentActivations: [...this.#activations.values()].map((entry) => ({
        activation: cloneJson(entry.activation),
        state: entry.state,
      })),
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
        attemptPersistenceAvailable: this.#attemptPersistenceAvailable,
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
    const diagnostic = remoteDiagnostic(code, message, "worker-runtime", now);
    const base = {
      taskId: request.taskId,
      attemptId: request.attemptId,
      executor: { kind: "remote", workerId: this.#workerId },
      startedAt: now,
      completedAt: now,
    } as const;
    if (status === "indeterminate") {
      return {
        ...base,
        status,
        diagnostic: { ...diagnostic, retryable: false },
      };
    }
    return {
      ...base,
      status,
      diagnostic,
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

  #parseStoredRecord(
    record: RemoteAttemptRecord,
    expectation: Omit<RemoteAttemptRecordExpectation, "workerId"> = {},
  ) {
    try {
      return parseRemoteAttemptRecord(record, {
        workerId: this.#workerId,
        ...expectation,
      });
    } catch (error) {
      if (isRemoteAttemptRevisionError(error)) {
        this.#attemptPersistenceAvailable = false;
      }
      throw error;
    }
  }

  #parseCommittedRecord(committed: RemoteAttemptRecord, expected: RemoteAttemptRecord) {
    const parsed = this.#parseStoredRecord(committed, {
      taskId: expected.request.taskId,
      attemptId: expected.request.attemptId,
      fingerprint: expected.fingerprint,
    });
    if (BigInt(parsed.record.revision) <= BigInt(parseAttemptRevision(expected.revision))) {
      throw new RemoteAttemptRevisionError("Committed Worker attempt revision must advance");
    }
    const { revision: _committedRevision, ...committedValue } = parsed.record;
    const { revision: _expectedRevision, ...expectedValue } = expected;
    if (jsonFingerprint(committedValue) !== jsonFingerprint(expectedValue)) {
      throw new TypeError("Committed Worker attempt record does not match the requested write");
    }
    return parsed;
  }

  async #create(attempt: WorkerAttempt): Promise<void> {
    const record = this.#record(attempt);
    const committed = await this.#storeOperation(
      this.#attemptStore.commit(record, {
        expectedRevision: null,
      }),
    );
    if (committed === undefined) {
      throw new Error("Remote attempt was concurrently admitted by another Worker session");
    }
    attempt.revision = this.#parseCommittedRecord(committed, record).record.revision;
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
          attempt.revision = this.#parseCommittedRecord(committed, record).record.revision;
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
        const parsedLatest = this.#parseStoredRecord(latest, {
          taskId: attempt.request.taskId,
          attemptId: attempt.request.attemptId,
          fingerprint: attempt.fingerprint,
        }).record;
        if (BigInt(parsedLatest.revision) <= BigInt(parseAttemptRevision(attempt.revision))) {
          throw new RemoteAttemptRevisionError(
            "Reloaded Worker attempt revision must advance after a conditional conflict",
          );
        }
        attempt.revision = parsedLatest.revision;
        attempt.epoch = parsedLatest.epoch;
        if (parsedLatest.cancellation === undefined) {
          delete attempt.cancellation;
        } else {
          attempt.cancellation = parsedLatest.cancellation;
        }
        if (parsedLatest.result !== undefined || parsedLatest.state === "terminal") {
          attempt.state = "terminal";
          if (parsedLatest.result !== undefined) attempt.result = parsedLatest.result;
          attempt.completion.resolve();
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
      "indeterminate",
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
        const expiredRecord = {
          ...this.#record(attempt),
          state: "expired" as const,
          updatedAt: this.#clock.now().toISOString(),
        };
        const expired = await this.#storeOperation(
          this.#attemptStore.commit(expiredRecord, {
            expectedRevision: attempt.revision,
            expectedEpoch: attempt.epoch,
          }),
        );
        if (expired === undefined) continue;
        this.#parseCommittedRecord(expired, expiredRecord);
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
  return {
    taskId: parseTaskId(payload.taskId),
    attemptId: parseAttemptId(payload.attemptId),
  };
}
