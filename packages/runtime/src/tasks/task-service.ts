import { randomUUID } from "node:crypto";
import {
  type AttemptId,
  type Clock,
  DiagnosticError,
  diagnosticCode,
  type ExecutionHandle,
  type ExecutionResult,
  type Executor,
  indeterminateTaskDiagnostic,
  type JsonValue,
  parseAttemptId,
  parseExecutionResult,
  parseRunTaskRequest,
  parseTaskId,
  parseTaskRecord,
  type Revision,
  type RunTaskRequest,
  type RuntimeAuthority,
  type RuntimeTaskLifecycle,
  runtimeDiagnostic,
  type StateFencing,
  type StateKey,
  type StateStore,
  type TaskId,
  type TaskRecord,
} from "@tegojs/contracts";

const namespace = "tego";
const maxResultBytes = 1_048_576;

export interface TaskIdentity {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
}

export interface TaskServiceOptions {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly selectExecutor: (
    request: RunTaskRequest,
    binding?: TaskRecord["executor"],
  ) => Executor | Promise<Executor>;
  readonly createIdentity?: (request: RunTaskRequest) => TaskIdentity;
}

interface TaskOperationIdentity {
  readonly [key: string]: JsonValue;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly fingerprint: string;
}

interface LoadedTask {
  readonly record: TaskRecord;
  readonly revision: Revision;
}

interface ExecutorRegistration {
  readonly executor: Executor;
  readonly authority: RuntimeAuthority;
}

type ObservationOutcome =
  | { readonly kind: "observed"; readonly value: Awaited<ReturnType<Executor["observe"]>> }
  | { readonly kind: "timeout" };

const definiteAdmissionRejections = {
  EXECUTOR_ATTEMPT_CAPACITY_EXCEEDED: { retryable: true },
  EXECUTOR_DRAINING: { retryable: true },
  EXECUTOR_INPUT_LIMIT_EXCEEDED: { retryable: false },
  EXECUTOR_QUEUE_CAPACITY_EXCEEDED: { retryable: true },
} as const;

interface DeferredWaiter {
  readonly resolve: (record: TaskRecord) => void;
  readonly reject: (error: unknown) => void;
}

function taskKey(taskId: TaskId): StateKey<TaskRecord> {
  return { namespace, collection: "tasks", id: taskId };
}

function operationKey(operationId: string): StateKey<TaskOperationIdentity> {
  return { namespace, collection: "task-operations", id: operationId };
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key] as JsonValue)}`)
    .join(",")}}`;
}

function defaultIdentity(): TaskIdentity {
  const id = randomUUID();
  return {
    taskId: parseTaskId(`task-${id}`),
    attemptId: parseAttemptId(`attempt-${id}`),
  };
}

export class TaskService implements RuntimeTaskLifecycle {
  readonly #state: StateStore;
  readonly #clock: Clock;
  readonly #selectExecutor: TaskServiceOptions["selectExecutor"];
  readonly #createIdentity: NonNullable<TaskServiceOptions["createIdentity"]>;
  readonly #records = new Map<TaskId, LoadedTask>();
  readonly #executors = new Map<TaskId, ExecutorRegistration>();
  readonly #dispatches = new Map<TaskId, Promise<TaskRecord>>();
  readonly #cancellations = new Map<TaskId, Promise<TaskRecord>>();
  readonly #waiters = new Map<TaskId, Set<DeferredWaiter>>();
  readonly #ephemeralTerminal = new Map<TaskId, TaskRecord>();
  readonly #observationControllers = new Set<AbortController>();
  #authority: RuntimeAuthority | undefined;
  #closed = false;

  constructor(options: TaskServiceOptions) {
    this.#state = options.state;
    this.#clock = options.clock;
    this.#selectExecutor = options.selectExecutor;
    this.#createIdentity = options.createIdentity ?? defaultIdentity;
  }

  count(): number {
    return this.#records.size;
  }

  async recover(): Promise<void> {
    this.#assertOpen();
    this.#records.clear();
    for await (const stored of this.#state.scan<TaskRecord>({
      namespace,
      collection: "tasks",
    })) {
      const record = parseTaskRecord(stored.value);
      this.#records.set(record.taskId, { record, revision: stored.revision });
    }
  }

  async setAuthority(authority: RuntimeAuthority | undefined): Promise<void> {
    this.#assertOpen();
    this.#authority = authority === undefined ? undefined : structuredClone(authority);
    if (authority === undefined) return;
    const pending = [...this.#records.values()]
      .map((entry) => entry.record)
      .filter((record) => record.state !== "terminal");
    await Promise.all(
      pending.map((record) =>
        this.#recoverRecord(record, authority).catch(async (error) => {
          if (record.executor?.type !== "remote") {
            await this.#settleUncertain(record, error, authority, true);
          }
        }),
      ),
    );
  }

  async run(input: RunTaskRequest): Promise<TaskRecord> {
    this.#assertOpen();
    const authority = this.#requireAuthority();
    const request = parseRunTaskRequest(input);
    const fingerprint = canonical(request);
    const replay = await this.#findReplay(request, fingerprint);
    if (replay !== undefined) {
      const active = this.#dispatches.get(replay.taskId);
      if (active !== undefined) return structuredClone(await active);
      await this.#recoverRecord(replay);
      return structuredClone((await this.status(replay.taskId)) ?? replay);
    }
    const selected = await this.#selectExecutor(request);
    this.#assertAuthority(authority);
    const proposed = this.#createIdentity(request);
    const admitted = await this.#admit(request, fingerprint, proposed, selected, authority);
    if (admitted.executor?.id === selected.id && admitted.executor.type === selected.type) {
      this.#executors.set(admitted.taskId, { executor: selected, authority });
    }
    const existingDispatch = this.#dispatches.get(admitted.taskId);
    if (existingDispatch !== undefined) return structuredClone(await existingDispatch);
    if (admitted.state === "terminal" || admitted.state === "running") {
      return structuredClone(admitted);
    }
    return structuredClone(await this.#ensureDispatch(admitted, authority));
  }

  async status(taskIdInput: TaskId): Promise<TaskRecord | undefined> {
    this.#assertOpen();
    const taskId = parseTaskId(taskIdInput);
    const loaded = await this.#load(taskId);
    if (loaded?.record.state === "terminal") {
      this.#ephemeralTerminal.delete(taskId);
      return structuredClone(loaded.record);
    }
    const ephemeral = this.#ephemeralTerminal.get(taskId);
    return structuredClone(ephemeral ?? loaded?.record);
  }

  async wait(taskIdInput: TaskId): Promise<TaskRecord> {
    this.#assertOpen();
    const taskId = parseTaskId(taskIdInput);
    const current = await this.status(taskId);
    if (current === undefined) throw this.#missing(taskId);
    if (current.state === "terminal") return current;

    const deferred = Promise.withResolvers<TaskRecord>();
    const waiter: DeferredWaiter = { resolve: deferred.resolve, reject: deferred.reject };
    const waiters = this.#waiters.get(taskId) ?? new Set<DeferredWaiter>();
    waiters.add(waiter);
    this.#waiters.set(taskId, waiters);

    if (this.#closed) {
      waiter.reject(this.#stoppedError());
    } else {
      try {
        const afterRegistration = await this.status(taskId);
        if (afterRegistration?.state === "terminal") this.#notify(afterRegistration);
      } catch (error) {
        waiter.reject(error);
      }
    }
    return deferred.promise.finally(() => {
      const registered = this.#waiters.get(taskId);
      registered?.delete(waiter);
      if (registered?.size === 0) this.#waiters.delete(taskId);
    });
  }

  async cancel(taskIdInput: TaskId): Promise<TaskRecord> {
    this.#assertOpen();
    this.#requireAuthority();
    const taskId = parseTaskId(taskIdInput);
    const existing = this.#cancellations.get(taskId);
    if (existing !== undefined) return existing;
    const cancellation = this.#cancel(taskId);
    this.#cancellations.set(taskId, cancellation);
    void cancellation.catch(() => {
      if (this.#cancellations.get(taskId) === cancellation) {
        this.#cancellations.delete(taskId);
      }
    });
    return cancellation;
  }

  async #cancel(taskId: TaskId): Promise<TaskRecord> {
    const authority = this.#requireAuthority();
    const current = await this.status(taskId);
    if (current === undefined) throw this.#missing(taskId);
    if (current.state === "terminal") return current;
    const intended =
      current.cancellation === undefined
        ? await this.#transition(taskId, authority, (record) => ({
            ...record,
            cancellation: {
              requestedAt: this.#clock.now().toISOString(),
              authority,
            },
            updatedAt: this.#clock.now().toISOString(),
          }))
        : current;
    this.#assertAuthority(authority);
    const executor = this.#executors.get(taskId)?.executor;
    if (executor === undefined) {
      const dispatch = this.#dispatches.get(taskId);
      if (dispatch !== undefined) await dispatch.catch(() => undefined);
    }
    const activeRegistration = this.#executors.get(taskId);
    const active = activeRegistration?.executor;
    if (active !== undefined) {
      this.#assertAuthority(authority);
      await this.#boundedEffect(active.cancel(intended.taskId, intended.attemptId));
      this.#assertAuthority(authority);
    }
    const observed =
      active === undefined
        ? undefined
        : await this.#observeBounded(active, intended.taskId, intended.attemptId);
    this.#assertAuthority(authority);
    if (observed?.kind === "observed" && observed.value?.state === "terminal") {
      await this.#complete(intended, observed.value.result, authority, activeRegistration);
    }
    const completed = await this.#waitBounded(taskId);
    if (completed !== undefined) return completed;
    const after = await this.status(taskId);
    if (after?.state === "terminal") return after;
    await this.#settleUncertain(
      intended,
      new Error("Cancellation completion could not be proved"),
      authority,
      true,
    );
    return (await this.status(taskId)) ?? intended;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#authority = undefined;
    for (const controller of this.#observationControllers) {
      controller.abort(this.#stoppedError());
    }
    this.#observationControllers.clear();
    const error = this.#stoppedError();
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.#waiters.clear();
  }

  async #admit(
    request: RunTaskRequest,
    fingerprint: string,
    proposed: TaskIdentity,
    executor: Executor,
    authority: RuntimeAuthority,
  ): Promise<TaskRecord> {
    this.#assertAuthority(authority);
    const createdAt = this.#clock.now().toISOString();
    const candidate = parseTaskRecord({
      taskId: proposed.taskId,
      attemptId: proposed.attemptId,
      request,
      state: "accepted",
      executor: { id: executor.id, type: executor.type },
      createdAt,
      updatedAt: createdAt,
      authority,
    });
    const fencing = this.#fencing(authority);
    const admitted = await this.#state.transact(
      request.operationId === undefined
        ? { fencing }
        : {
            fencing,
            idempotencyKey: `task:${request.operationId}`,
            idempotencyFingerprint: fingerprint,
          },
      async (transaction) => {
        if (request.operationId !== undefined) {
          const existingIdentity = await transaction.get(operationKey(request.operationId));
          if (existingIdentity !== undefined) {
            if (existingIdentity.value.fingerprint !== fingerprint) {
              throw this.#idempotencyConflict(request.operationId);
            }
            const existing = await transaction.get(taskKey(existingIdentity.value.taskId));
            if (existing === undefined) {
              throw this.#corrupt(existingIdentity.value.taskId);
            }
            return parseTaskRecord(existing.value);
          }
        }
        const existing = await transaction.get(taskKey(candidate.taskId));
        if (existing !== undefined) {
          const record = parseTaskRecord(existing.value);
          if (canonical(record.request) !== fingerprint) {
            throw this.#idempotencyConflict(request.operationId ?? candidate.taskId);
          }
          return record;
        }
        await transaction.put(taskKey(candidate.taskId), candidate, { expectedRevision: "absent" });
        if (request.operationId !== undefined) {
          await transaction.put(
            operationKey(request.operationId),
            {
              taskId: candidate.taskId,
              attemptId: candidate.attemptId,
              fingerprint,
            },
            { expectedRevision: "absent" },
          );
        }
        return candidate;
      },
    );
    this.#assertAuthority(authority);
    const loaded = await this.#load(admitted.taskId);
    if (loaded === undefined) throw this.#corrupt(admitted.taskId);
    return loaded.record;
  }

  #ensureDispatch(record: TaskRecord, authority: RuntimeAuthority): Promise<TaskRecord> {
    const existing = this.#dispatches.get(record.taskId);
    if (existing !== undefined) return existing;
    const dispatch = this.#dispatch(record, authority);
    this.#dispatches.set(record.taskId, dispatch);
    void dispatch.then(
      () => {
        if (this.#dispatches.get(record.taskId) === dispatch)
          this.#dispatches.delete(record.taskId);
      },
      () => {
        if (this.#dispatches.get(record.taskId) === dispatch)
          this.#dispatches.delete(record.taskId);
      },
    );
    return dispatch;
  }

  async #dispatch(record: TaskRecord, authority: RuntimeAuthority): Promise<TaskRecord> {
    this.#assertAuthority(authority);
    const executor = await this.#resolveExecutor(record, authority);
    this.#assertAuthority(authority);
    const registration = { executor, authority };
    this.#executors.set(record.taskId, registration);
    const request = {
      taskId: record.taskId,
      attemptId: record.attemptId,
      applicationId: record.request.applicationId,
      pluginId: record.request.pluginId,
      componentId: record.request.componentId,
      input: record.request.input,
      deadline: record.request.deadline,
      orphanPolicy: record.request.orphanPolicy,
    };
    let handle: ExecutionHandle;
    try {
      handle = await executor.submit(request);
    } catch (error) {
      const rejection = this.#classifyDefiniteAdmissionRejection(error);
      if (rejection !== undefined) {
        return this.#rejectAdmission(record, error, authority, rejection.retryable);
      }
      const outcome = await this.#observeBounded(executor, record.taskId, record.attemptId).catch(
        () => undefined,
      );
      if (outcome?.kind === "observed" && outcome.value?.state === "terminal") {
        await this.#complete(record, outcome.value.result, authority, registration);
      } else if (executor.type !== "remote") {
        await this.#settleUncertain(record, error, authority, true);
      } else {
        await this.#markUnknown(record, authority, "EXECUTOR_SUBMISSION_UNKNOWN");
      }
      return (await this.status(record.taskId)) ?? record;
    }
    const completion = handle.result.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (handle.taskId !== record.taskId || handle.attemptId !== record.attemptId) {
      await this.#settleUncertain(
        record,
        this.#invalidResult(record.taskId, "Executor handle identity does not match the task"),
        authority,
        true,
      );
      void completion;
      return (await this.status(record.taskId)) ?? record;
    }
    let running: TaskRecord;
    try {
      running = await this.#transition(record.taskId, authority, (current) => ({
        ...current,
        state: "running",
        executor: { id: executor.id, type: executor.type },
        authority,
        updatedAt: this.#clock.now().toISOString(),
      }));
    } catch (error) {
      await this.#settleUncertain(record, error, authority, true);
      const uncertain = this.#ephemeralTerminal.get(record.taskId);
      if (uncertain !== undefined) return uncertain;
      const persisted = await this.status(record.taskId);
      if (persisted !== undefined) return persisted;
      throw error;
    }
    void completion
      .then((outcome) =>
        outcome.ok
          ? this.#complete(running, outcome.result, authority, registration)
          : this.#settleUncertain(running, outcome.error, authority, true),
      )
      .catch(() => undefined);
    return running;
  }

  async #complete(
    record: TaskRecord,
    input: ExecutionResult,
    authority: RuntimeAuthority,
    registration?: ExecutorRegistration,
  ): Promise<void> {
    try {
      const result = structuredClone(parseExecutionResult(input));
      if (result.taskId !== record.taskId || result.attemptId !== record.attemptId) {
        throw this.#invalidResult(
          record.taskId,
          "Executor result identity does not match the task",
        );
      }
      if (
        result.output !== undefined &&
        Buffer.byteLength(JSON.stringify(result.output), "utf8") > maxResultBytes
      ) {
        throw this.#invalidResult(
          record.taskId,
          "Executor output exceeds the durable result limit",
        );
      }
      const terminal = await this.#transition(record.taskId, authority, (current) => ({
        ...current,
        state: "terminal",
        authority,
        result,
        updatedAt: this.#clock.now().toISOString(),
      }));
      this.#notify(terminal);
    } catch (error) {
      await this.#settleUncertain(record, error, authority, true);
    } finally {
      if (registration === undefined || this.#executors.get(record.taskId) === registration) {
        this.#executors.delete(record.taskId);
      }
    }
  }

  async #recoverRecord(
    record: TaskRecord,
    authority: RuntimeAuthority = this.#requireAuthority(),
  ): Promise<void> {
    if (record.executor === undefined) {
      await this.#settleUncertain(
        record,
        new Error("Task executor identity is missing"),
        authority,
        true,
      );
      return;
    }
    let executor: Executor;
    try {
      executor = await this.#resolveExecutor(record, authority);
    } catch (error) {
      if (record.executor.type === "remote") {
        await this.#markUnknown(record, authority, "EXECUTOR_OBSERVATION_UNKNOWN");
        return;
      }
      await this.#settleUncertain(record, error, authority, true);
      return;
    }
    this.#assertAuthority(authority);
    const registration = { executor, authority };
    this.#executors.set(record.taskId, registration);
    if (record.cancellation !== undefined) {
      this.#assertAuthority(authority);
      await this.#boundedEffect(executor.cancel(record.taskId, record.attemptId));
      this.#assertAuthority(authority);
    }
    let observed: Awaited<ReturnType<Executor["observe"]>>;
    try {
      const outcome = await this.#observeBounded(executor, record.taskId, record.attemptId);
      if (outcome.kind === "timeout") {
        await this.#markUnknown(record, authority, "EXECUTOR_OBSERVATION_UNKNOWN");
        return;
      }
      observed = outcome.value;
    } catch (error) {
      if (record.executor.type === "remote") return;
      await this.#settleUncertain(record, error, authority, true);
      return;
    }
    this.#assertAuthority(authority);
    if (observed?.state === "terminal") {
      await this.#complete(record, observed.result, authority, registration);
    } else if (observed?.state === "running" && record.state === "accepted") {
      await this.#transition(record.taskId, authority, (current) => ({
        ...current,
        state: "running",
        authority,
        updatedAt: this.#clock.now().toISOString(),
      }));
    } else if (observed === undefined && record.executor.type !== "remote") {
      if (record.state === "accepted") {
        await this.#ensureDispatch(record, authority);
      } else {
        await this.#settleUncertain(
          record,
          new Error("Executor cannot prove the attempt state"),
          authority,
          true,
        );
      }
    } else if (observed === undefined) {
      await this.#markUnknown(record, authority, "EXECUTOR_OBSERVATION_UNKNOWN");
    }
  }

  async #resolveExecutor(record: TaskRecord, authority: RuntimeAuthority): Promise<Executor> {
    const binding = record.executor;
    if (binding === undefined) {
      throw this.#invalidResult(record.taskId, "Task executor binding is missing");
    }
    const registration = this.#executors.get(record.taskId);
    const retained = registration?.executor;
    if (
      registration?.authority.resource === authority.resource &&
      registration.authority.epoch === authority.epoch &&
      retained?.id === binding.id &&
      retained.type === binding.type
    ) {
      return retained;
    }
    const resolved = await this.#selectExecutor(record.request, binding);
    if (resolved.id !== binding.id || resolved.type !== binding.type) {
      throw this.#invalidResult(
        record.taskId,
        "Resolved executor does not match the durable task binding",
      );
    }
    return resolved;
  }

  async #findReplay(request: RunTaskRequest, fingerprint: string): Promise<TaskRecord | undefined> {
    if (request.operationId === undefined) return undefined;
    const identity = await this.#state.read(operationKey(request.operationId));
    if (identity === undefined) return undefined;
    if (identity.value.fingerprint !== fingerprint) {
      throw this.#idempotencyConflict(request.operationId);
    }
    const task = await this.#load(identity.value.taskId);
    if (task === undefined) throw this.#corrupt(identity.value.taskId);
    return task.record;
  }

  async #transition(
    taskId: TaskId,
    authority: RuntimeAuthority,
    update: (record: TaskRecord) => TaskRecord,
  ): Promise<TaskRecord> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      this.#assertAuthority(authority);
      const loaded = await this.#load(taskId);
      if (loaded === undefined) throw this.#missing(taskId);
      if (loaded.record.state === "terminal") return loaded.record;
      const next = parseTaskRecord(update(loaded.record));
      try {
        await this.#state.transact({ fencing: this.#fencing(authority) }, async (transaction) => {
          this.#assertAuthority(authority);
          await transaction.put(taskKey(taskId), next, { expectedRevision: loaded.revision });
          return next;
        });
        this.#assertAuthority(authority);
        const persisted = await this.#load(taskId);
        if (persisted === undefined) throw this.#corrupt(taskId);
        return persisted.record;
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("diagnostic" in error) ||
          (error as { diagnostic?: { code?: unknown } }).diagnostic?.code !==
            "STATE_REVISION_CONFLICT"
        ) {
          throw error;
        }
      }
    }
    throw this.#corrupt(taskId);
  }

  async #settleUncertain(
    record: TaskRecord,
    _error: unknown,
    authority: RuntimeAuthority,
    allowEphemeral: boolean,
  ): Promise<void> {
    if (this.#ephemeralTerminal.has(record.taskId)) return;
    try {
      this.#assertAuthority(authority);
    } catch {
      return;
    }
    const timestamp = this.#clock.now().toISOString();
    const indeterminate = parseTaskRecord({
      ...record,
      state: "terminal",
      updatedAt: timestamp,
      result: {
        taskId: record.taskId,
        attemptId: record.attemptId,
        executor: { kind: record.executor?.type ?? "process" },
        status: "indeterminate",
        diagnostic: indeterminateTaskDiagnostic(
          record.taskId,
          "The execution or persistence boundary cannot prove an authoritative task result",
          timestamp,
        ),
        startedAt: record.createdAt,
        completedAt: timestamp,
      },
    });
    try {
      const persisted = await this.#transition(record.taskId, authority, () => indeterminate);
      this.#notify(persisted);
      return;
    } catch (error) {
      try {
        this.#assertAuthority(authority);
      } catch {
        return;
      }
      const code = diagnosticCode(error);
      if (
        code === "STATE_REVISION_CONFLICT" ||
        code === "COORDINATION_FENCE_REJECTED" ||
        code === "COORDINATION_NOT_LEADER"
      ) {
        return;
      }
      if (!allowEphemeral) return;
    }
    this.#ephemeralTerminal.set(record.taskId, indeterminate);
    this.#notify(indeterminate);
  }

  async #observeBounded(
    executor: Executor,
    taskId: TaskId,
    attemptId: AttemptId,
  ): Promise<ObservationOutcome> {
    const controller = new AbortController();
    this.#observationControllers.add(controller);
    const observation = Promise.resolve(executor.observe(taskId, attemptId)).then(
      (value) => ({ kind: "observed" as const, value }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    const timeout = this.#clock.sleep(5_000, controller.signal).then(
      () => ({ kind: "timeout" as const }),
      (error: unknown) => ({ kind: "aborted" as const, error }),
    );
    const outcome = await Promise.race([observation, timeout]);
    controller.abort();
    this.#observationControllers.delete(controller);
    if (outcome.kind === "observed") return outcome;
    if (outcome.kind === "failed" || outcome.kind === "aborted") throw outcome.error;
    return { kind: "timeout" };
  }

  async #markUnknown(
    record: TaskRecord,
    authority: RuntimeAuthority,
    code: "EXECUTOR_OBSERVATION_UNKNOWN" | "EXECUTOR_SUBMISSION_UNKNOWN",
  ): Promise<void> {
    await this.#transition(record.taskId, authority, (current) => ({
      ...current,
      authority,
      diagnostic: runtimeDiagnostic({
        code,
        message: "Executor acknowledgement is unavailable; durable reconciliation remains pending",
        source: { kind: "executor", id: record.taskId },
        retryable: true,
        observedAt: this.#clock.now().toISOString(),
      }),
      updatedAt: this.#clock.now().toISOString(),
    }));
  }

  #classifyDefiniteAdmissionRejection(
    error: unknown,
  ): (typeof definiteAdmissionRejections)[keyof typeof definiteAdmissionRejections] | undefined {
    const code = diagnosticCode(error);
    return code === undefined || !Object.hasOwn(definiteAdmissionRejections, code)
      ? undefined
      : definiteAdmissionRejections[code as keyof typeof definiteAdmissionRejections];
  }

  async #rejectAdmission(
    record: TaskRecord,
    error: unknown,
    authority: RuntimeAuthority,
    retryable: boolean,
  ): Promise<TaskRecord> {
    const timestamp = this.#clock.now().toISOString();
    const code = diagnosticCode(error) ?? "EXECUTOR_SUBMISSION_REJECTED";
    const terminal = await this.#transition(record.taskId, authority, (current) => ({
      ...current,
      state: "terminal",
      authority,
      updatedAt: timestamp,
      result: {
        taskId: record.taskId,
        attemptId: record.attemptId,
        executor: { kind: record.executor?.type ?? "process" },
        status: "rejected",
        diagnostic: runtimeDiagnostic({
          code,
          message: "Executor rejected the task before creating an attempt",
          source: { kind: "executor", id: record.taskId },
          retryable,
          observedAt: timestamp,
        }),
        startedAt: record.createdAt,
        completedAt: timestamp,
      },
    }));
    this.#notify(terminal);
    return terminal;
  }

  async #boundedEffect(effect: Promise<void>): Promise<void> {
    const controller = new AbortController();
    this.#observationControllers.add(controller);
    const outcome = await Promise.race([
      effect.then(
        () => ({ kind: "completed" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      this.#clock.sleep(5_000, controller.signal).then(
        () => ({ kind: "timeout" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
    ]);
    controller.abort();
    this.#observationControllers.delete(controller);
    if (outcome.kind === "failed") throw outcome.error;
  }

  async #waitBounded(taskId: TaskId): Promise<TaskRecord | undefined> {
    const controller = new AbortController();
    this.#observationControllers.add(controller);
    const outcome = await Promise.race([
      this.wait(taskId).then(
        (record) => ({ kind: "completed" as const, record }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      this.#clock.sleep(5_000, controller.signal).then(
        () => ({ kind: "timeout" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
    ]);
    controller.abort();
    this.#observationControllers.delete(controller);
    if (outcome.kind === "failed") throw outcome.error;
    return outcome.kind === "completed" ? outcome.record : undefined;
  }

  async #load(taskId: TaskId): Promise<LoadedTask | undefined> {
    const stored = await this.#state.read(taskKey(taskId));
    if (stored === undefined) return undefined;
    const loaded = { record: parseTaskRecord(stored.value), revision: stored.revision };
    this.#records.set(taskId, loaded);
    return loaded;
  }

  #notify(record: TaskRecord): void {
    for (const waiter of this.#waiters.get(record.taskId) ?? []) {
      waiter.resolve(structuredClone(record));
    }
    this.#waiters.delete(record.taskId);
  }

  #requireAuthority(): RuntimeAuthority {
    const authority = this.#authority;
    if (authority === undefined) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "COORDINATION_NOT_LEADER",
          message: "Task mutation requires active runtime leadership",
          source: { kind: "coordination", id: "tasks" },
          observedAt: this.#clock.now().toISOString(),
        }),
      );
    }
    return structuredClone(authority);
  }

  #assertAuthority(expected: RuntimeAuthority): void {
    const current = this.#authority;
    if (current?.resource !== expected.resource || current.epoch !== expected.epoch) {
      this.#requireAuthority();
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "COORDINATION_FENCE_REJECTED",
          message: "Task authority changed while the operation was active",
          source: { kind: "coordination", id: expected.resource },
          observedAt: this.#clock.now().toISOString(),
        }),
      );
    }
  }

  #fencing(authority: RuntimeAuthority): StateFencing {
    return { resource: authority.resource, epoch: authority.epoch };
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw this.#stoppedError();
    }
  }

  #stoppedError(): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "BOOTSTRAP_STOPPED",
        message: "Task service stopped before the task reached a terminal state",
        source: { kind: "runtime", id: "tasks" },
        observedAt: this.#clock.now().toISOString(),
      }),
    );
  }

  #missing(taskId: TaskId): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "EXECUTOR_TASK_NOT_FOUND",
        message: "Task record does not exist",
        source: { kind: "executor", id: taskId },
        observedAt: this.#clock.now().toISOString(),
      }),
    );
  }

  #corrupt(taskId: TaskId): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "STATE_TASK_CORRUPT",
        message: "Task identity refers to a missing durable record",
        source: { kind: "state", id: taskId },
        observedAt: this.#clock.now().toISOString(),
      }),
    );
  }

  #idempotencyConflict(id: string): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "STATE_IDEMPOTENCY_CONFLICT",
        message: "Task operation identity was reused with a different payload",
        source: { kind: "state", id },
        observedAt: this.#clock.now().toISOString(),
      }),
    );
  }

  #invalidResult(taskId: TaskId, message: string): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "EXECUTOR_RESULT_INVALID",
        message,
        source: { kind: "executor", id: taskId },
        observedAt: this.#clock.now().toISOString(),
      }),
    );
  }
}
