import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnosticCode,
  parseApplicationId,
  parseAttemptId,
  parseComponentId,
  parseDeployPluginRequest,
  parseFencingEpoch,
  parsePluginId,
  parseRevision,
  parseTaskId,
  parseRunTaskRequest,
  parseArtifactDigest,
  parsePluginInstallation,
  parseOperationId,
  parseTaskRecord,
  type Clock,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type JsonValue,
  type RuntimeAuthority,
  type ScannedState,
  type StateChange,
  type StateKey,
  type StateQuery,
  type StateStore,
  type StateTransaction,
  type StateTransactionOptions,
  type StateWriteOptions,
  type Versioned,
} from "@tegojs/contracts";
import { FakeClock } from "@tegojs/testkit";
import { RuntimeOperationController, TaskService, type TaskIdentity } from "../src/index.js";

const now = new Date("2026-07-25T00:00:00.000Z");
const clock: Clock = {
  now: () => now,
  sleep: (_delay, signal) =>
    signal?.aborted === true
      ? Promise.reject(signal.reason)
      : new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
};
const authority: RuntimeAuthority = {
  resource: "runtime:runtime-01",
  epoch: parseFencingEpoch("7"),
};

function clone<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

class TransactionalState implements StateStore {
  readonly scope = "shared" as const;
  readonly records = new Map<string, { value: JsonValue; revision: number }>();
  readonly writes: string[] = [];
  readonly accepted = Promise.withResolvers<void>();
  rejectTerminalWrites = false;
  beforeTransaction: (() => void) | undefined;
  #revision = 0;
  #tail = Promise.resolve();

  open(): Promise<void> {
    return Promise.resolve();
  }

  transact<T extends JsonValue>(
    _options: StateTransactionOptions,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    const execution = this.#tail.then(async () => {
      this.beforeTransaction?.();
      this.beforeTransaction = undefined;
      const staged: Array<{
        key: StateKey<JsonValue>;
        value: JsonValue;
        expected: string | undefined;
      }> = [];
      const transaction: StateTransaction = {
        get: async <V extends JsonValue>(key: StateKey<V>) => {
          const record = this.records.get(this.#key(key));
          return record === undefined
            ? undefined
            : {
                value: clone(record.value) as V,
                revision: parseRevision(String(record.revision)),
              };
        },
        scan: <V extends JsonValue>(_query: StateQuery<V>) => ({
          async *[Symbol.asyncIterator]() {},
        }),
        put: async <V extends JsonValue>(
          key: StateKey<V>,
          value: V,
          options: StateWriteOptions,
        ) => {
          staged.push({
            key: key as StateKey<JsonValue>,
            value: clone(value),
            expected: options.expectedRevision,
          });
        },
        delete: async () => {},
        appendOperation: async () => {},
        enqueueOutbox: async () => {},
      };
      const result = await work(transaction);
      for (const item of staged) {
        if (this.rejectTerminalWrites && (item.value as { state?: unknown }).state === "terminal") {
          throw new Error("terminal persistence unavailable");
        }
        const storageKey = this.#key(item.key);
        const current = this.records.get(storageKey);
        const actual = current === undefined ? "absent" : String(current.revision);
        if (item.expected !== undefined && item.expected !== actual) {
          const error = new Error("revision conflict") as Error & {
            diagnostic?: { readonly code: string };
          };
          error.diagnostic = { code: "STATE_REVISION_CONFLICT" };
          throw error;
        }
        this.#revision += 1;
        this.records.set(storageKey, { value: clone(item.value), revision: this.#revision });
        this.writes.push(
          `${item.key.collection}:${String((item.value as { state?: unknown }).state)}`,
        );
        if ((item.value as { state?: unknown }).state === "accepted") this.accepted.resolve();
      }
      return clone(result);
    });
    this.#tail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  read<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined> {
    const record = this.records.get(this.#key(key));
    return Promise.resolve(
      record === undefined
        ? undefined
        : { value: clone(record.value) as T, revision: parseRevision(String(record.revision)) },
    );
  }

  scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
    const matches = [...this.records.entries()].filter(([key]) =>
      key.startsWith(`${query.namespace}/${query.collection}/`),
    );
    return {
      async *[Symbol.asyncIterator]() {
        for (const [key, record] of matches) {
          yield {
            key: {
              namespace: query.namespace,
              collection: query.collection,
              id: key.split("/").at(-1) ?? "",
            },
            value: clone(record.value) as T,
            revision: parseRevision(String(record.revision)),
          };
        }
      },
    };
  }

  scanRecoverableOperations(): AsyncIterable<never> {
    return { async *[Symbol.asyncIterator]() {} };
  }
  claimOutbox(): Promise<readonly []> {
    return Promise.resolve([]);
  }
  acknowledgeOutbox(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  watch(_cursor: ReturnType<typeof parseRevision>): AsyncIterable<StateChange> {
    return { async *[Symbol.asyncIterator]() {} };
  }
  health() {
    return Promise.resolve({ status: "healthy" as const, checkedAt: now.toISOString() });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  #key(key: StateKey<JsonValue>): string {
    return `${key.namespace}/${key.collection}/${key.id}`;
  }
}

class ControlledExecutor implements Executor {
  readonly id: string;
  readonly type: "process" | "remote" | "thread";
  readonly submitted: ExecutionRequest[] = [];
  readonly cancelled: string[] = [];
  readonly result = Promise.withResolvers<ExecutionResult>();
  submitGate: Promise<void> = Promise.resolve();
  observed: Awaited<ReturnType<Executor["observe"]>> = undefined;
  submitError: Error | undefined;
  observeGate: Promise<void> = Promise.resolve();
  observeError: Error | undefined;
  cancelGate: Promise<void> = Promise.resolve();
  handleTaskId: ExecutionRequest["taskId"] | undefined;

  constructor(type: "process" | "remote" | "thread" = "process", id = "executor-01") {
    this.type = type;
    this.id = id;
  }

  probe() {
    return Promise.resolve({
      id: this.id,
      type: this.type,
      available: true,
      maxConcurrency: 1,
      availableCapacity: 1,
      securityIsolation: true,
    });
  }
  async submit(request: ExecutionRequest): Promise<ExecutionHandle> {
    await this.submitGate;
    this.submitted.push(structuredClone(request));
    if (this.submitError !== undefined) throw this.submitError;
    return {
      taskId: this.handleTaskId ?? request.taskId,
      attemptId: request.attemptId,
      result: this.result.promise,
    };
  }
  async observe() {
    await this.observeGate;
    if (this.observeError !== undefined) throw this.observeError;
    return this.observed;
  }
  async cancel(taskId: ExecutionRequest["taskId"], attemptId: ExecutionRequest["attemptId"]) {
    this.cancelled.push(`${taskId}/${attemptId}`);
    await this.cancelGate;
  }
  drain() {
    return Promise.resolve();
  }
  health() {
    return Promise.resolve({
      id: this.id,
      type: this.type,
      status: "healthy" as const,
      checkedAt: now.toISOString(),
      accepting: true,
      active: 0,
      queued: 0,
      retainedAttempts: 0,
    });
  }
  close() {
    return Promise.resolve();
  }
}

const identity: TaskIdentity = {
  taskId: parseTaskId("task-01"),
  attemptId: parseAttemptId("attempt-01"),
};
const request = {
  applicationId: parseApplicationId("application-01"),
  pluginId: parsePluginId("echo"),
  componentId: parseComponentId("echo"),
  input: { value: "hello" },
  deadline: "2026-07-25T00:05:00.000Z",
  orphanPolicy: "cancel" as const,
};

function serviceFixture(executor = new ControlledExecutor()) {
  const state = new TransactionalState();
  const service = new TaskService({
    state,
    clock,
    selectExecutor: async () => executor,
    createIdentity: () => identity,
  });
  return { executor, service, state };
}

test("@spec:runtime-operations/task-operations/run-example-task", async () => {
  const { executor, service, state } = serviceFixture();
  await service.setAuthority(authority);

  const accepted = await service.run(request);
  assert.equal(accepted.state, "running");
  assert.deepEqual(state.writes.slice(0, 2), ["tasks:accepted", "tasks:running"]);

  executor.result.resolve({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    executor: { kind: "process" },
    status: "succeeded",
    output: { value: "hello" },
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
  });
  const terminal = await service.wait(identity.taskId);
  assert.equal(terminal.state, "terminal");
  assert.equal(terminal.result?.status, "succeeded");
  assert.deepEqual(terminal.result?.output, { value: "hello" });
  assert.deepEqual(await service.status(identity.taskId), terminal);
});

test("@spec:runtime-operations/task-operations/idempotent-run-replay", async () => {
  const { executor, service, state } = serviceFixture();
  await service.setAuthority(authority);
  const gate = Promise.withResolvers<void>();
  executor.submitGate = gate.promise;
  const replayable = { ...request, operationId: parseOperationId("run-01") };

  const first = service.run(replayable);
  await state.accepted.promise;
  const durable = await state.read<JsonValue>({
    namespace: "tego",
    collection: "tasks",
    id: identity.taskId,
  });
  assert.equal(
    typeof durable?.value === "object" && durable.value !== null && !Array.isArray(durable.value)
      ? (durable.value as { readonly state?: JsonValue }).state
      : undefined,
    "accepted",
  );
  assert.deepEqual(
    typeof durable?.value === "object" && durable.value !== null && !Array.isArray(durable.value)
      ? (durable.value as { readonly executor?: JsonValue }).executor
      : undefined,
    { id: executor.id, type: executor.type },
  );
  const duplicate = service.run(structuredClone(replayable));
  gate.resolve();
  assert.equal((await first).taskId, identity.taskId);
  assert.equal((await duplicate).taskId, identity.taskId);
  assert.equal(executor.submitted.length, 1);
});

test("@spec:runtime-operations/task-operations/idempotency-conflict", async () => {
  const { executor, service } = serviceFixture();
  await service.setAuthority(authority);
  const first = { ...request, operationId: parseOperationId("run-01") };
  await service.run(first);
  await assert.rejects(
    service.run({ ...first, input: { value: "different" } }),
    (error: unknown) => diagnosticCode(error) === "STATE_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(executor.submitted.length, 1);
});

test("@spec:runtime-operations/task-operations/unkeyed-runs-are-distinct", async () => {
  const state = new TransactionalState();
  const executors: ControlledExecutor[] = [];
  let sequence = 0;
  const service = new TaskService({
    state,
    clock,
    selectExecutor: async () => {
      const executor = new ControlledExecutor();
      executors.push(executor);
      return executor;
    },
    createIdentity: () => {
      sequence += 1;
      return {
        taskId: parseTaskId(`task-${String(sequence)}`),
        attemptId: parseAttemptId(`attempt-${String(sequence)}`),
      };
    },
  });
  await service.setAuthority(authority);
  const first = await service.run(request);
  const second = await service.run(structuredClone(request));
  assert.notEqual(first.taskId, second.taskId);
  assert.equal(executors.length, 2);
});

test("leadership loss fences terminal commit without borrowing later authority", async () => {
  const { executor, service, state } = serviceFixture();
  await service.setAuthority(authority);
  await service.run(request);
  await service.setAuthority(undefined);
  executor.result.resolve({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    executor: { kind: "process" },
    status: "succeeded",
    output: { secret: true },
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const durable = await state.read<JsonValue>({
    namespace: "tego",
    collection: "tasks",
    id: identity.taskId,
  });
  assert.equal((durable?.value as { readonly state?: JsonValue } | undefined)?.state, "running");
});

test("@spec:runtime-bootstrap/durable-restart-recovery/tasks-recover-before-dispatch", async () => {
  const { executor, service, state } = serviceFixture();
  const accepted = parseTaskRecord({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    request,
    state: "accepted",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    executor: { id: executor.id, type: executor.type },
    authority,
  });
  state.records.set(`tego/tasks/${identity.taskId}`, { value: accepted, revision: 1 });

  await service.recover();
  assert.equal(service.count(), 1);
  assert.equal(executor.submitted.length, 0);
  await service.setAuthority(authority);
  assert.equal(executor.submitted.length, 1);
  assert.equal((await service.status(identity.taskId))?.state, "running");
});

test("recovery commits a locally observed terminal attempt without redispatch", async () => {
  const { executor, service, state } = serviceFixture();
  const running = parseTaskRecord({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    request,
    state: "running",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    executor: { id: executor.id, type: executor.type },
    authority,
  });
  state.records.set(`tego/tasks/${identity.taskId}`, { value: running, revision: 1 });
  executor.observed = {
    state: "terminal",
    result: {
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      executor: { kind: "process" },
      status: "succeeded",
      output: { recovered: true },
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
    },
  };

  await service.recover();
  await service.setAuthority(authority);
  assert.equal(executor.submitted.length, 0);
  assert.equal((await service.status(identity.taskId))?.result?.status, "succeeded");
});

test("missing local running attempt recovers as durable indeterminate without retry", async () => {
  const { executor, service, state } = serviceFixture();
  const running = parseTaskRecord({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    request,
    state: "running",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    executor: { id: executor.id, type: executor.type },
    authority,
  });
  state.records.set(`tego/tasks/${identity.taskId}`, { value: running, revision: 1 });

  await service.recover();
  await service.setAuthority(authority);
  assert.equal(executor.submitted.length, 0);
  assert.equal((await service.status(identity.taskId))?.result?.status, "indeterminate");
});

test("terminal persistence uncertainty retains recoverable evidence for restart observation", async () => {
  const executor = new ControlledExecutor();
  const { service, state } = serviceFixture(executor);
  await service.setAuthority(authority);
  await service.run(request);
  state.rejectTerminalWrites = true;
  const succeeded: ExecutionResult = {
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    executor: { kind: "process" },
    status: "succeeded",
    output: { recovered: true },
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
  };
  executor.result.resolve(succeeded);
  assert.equal((await service.wait(identity.taskId)).result?.status, "indeterminate");
  const durable = await state.read<JsonValue>({
    namespace: "tego",
    collection: "tasks",
    id: identity.taskId,
  });
  assert.equal((durable?.value as { readonly state?: JsonValue } | undefined)?.state, "running");

  state.rejectTerminalWrites = false;
  executor.observed = { state: "terminal", result: succeeded };
  const restarted = new TaskService({
    state,
    clock,
    selectExecutor: async () => executor,
    createIdentity: () => identity,
  });
  await restarted.recover();
  await restarted.setAuthority(authority);
  assert.equal((await restarted.status(identity.taskId))?.result?.status, "succeeded");
  assert.equal(executor.submitted.length, 1);
});

test("@spec:runtime-bootstrap/durable-restart-recovery/accepted-remote-unknown-is-not-redispatched", async () => {
  const executor = new ControlledExecutor("remote", "remote-01");
  const { service, state } = serviceFixture(executor);
  const accepted = parseTaskRecord({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    request,
    state: "accepted",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    executor: { id: executor.id, type: executor.type },
    authority,
  });
  state.records.set(`tego/tasks/${identity.taskId}`, { value: accepted, revision: 1 });

  await service.recover();
  await service.setAuthority(authority);
  assert.equal(executor.submitted.length, 0);
  assert.equal((await service.status(identity.taskId))?.state, "accepted");
});

test("@spec:runtime-bootstrap/durable-restart-recovery/lost-submit-ack-observes-before-retry", async () => {
  const executor = new ControlledExecutor();
  const { service, state } = serviceFixture(executor);
  await service.setAuthority(authority);
  executor.submitError = new Error("ack lost");
  executor.observed = {
    state: "terminal",
    result: {
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      executor: { kind: "process" },
      status: "succeeded",
      output: { executed: true },
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
    },
  };
  assert.equal((await service.run(request)).result?.status, "succeeded");
  assert.equal(executor.submitted.length, 1);

  executor.submitError = undefined;
  const restarted = new TaskService({
    state,
    clock,
    selectExecutor: async () => executor,
    createIdentity: () => identity,
  });
  await restarted.recover();
  await restarted.setAuthority(authority);
  assert.equal(executor.submitted.length, 1);
  assert.equal((await restarted.status(identity.taskId))?.result?.status, "succeeded");
});

test("malformed executor completion becomes one durable indeterminate result for all waiters", async () => {
  const { executor, service } = serviceFixture();
  await service.setAuthority(authority);
  await service.run(request);
  const first = service.wait(identity.taskId);
  const second = service.wait(identity.taskId);
  executor.result.resolve({
    taskId: parseTaskId("wrong-task"),
    attemptId: identity.attemptId,
    executor: { kind: "process" },
    status: "succeeded",
    output: { mustNotLeak: true },
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
  });
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal(left.result?.status, "indeterminate");
  assert.equal(left.result?.output, undefined);
  assert.deepEqual(await service.status(identity.taskId), left);
});

test("@spec:runtime-operations/task-operations/inspect-indeterminate-task", async () => {
  const { executor, service } = serviceFixture();
  await service.setAuthority(authority);
  await service.run(request);
  executor.result.reject(new Error("secret-token-must-not-leak"));
  const terminal = await service.wait(identity.taskId);
  assert.equal(terminal.result?.status, "indeterminate");
  assert.equal(terminal.result?.output, undefined);
  assert.equal(terminal.result?.diagnostic?.retryable, false);
  assert.doesNotMatch(JSON.stringify(terminal), /secret-token-must-not-leak/u);
});

test("cancel is idempotent and close releases all waiters", async () => {
  const { executor, service } = serviceFixture();
  await service.setAuthority(authority);
  await service.run(request);
  const first = service.cancel(identity.taskId);
  const second = service.cancel(identity.taskId);
  while (executor.cancelled.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  executor.result.resolve({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    executor: { kind: "process" },
    status: "cancelled",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
  });
  assert.equal((await first).result?.status, "cancelled");
  assert.deepEqual(await second, await first);
  assert.equal(executor.cancelled.length, 1);

  const other = serviceFixture();
  await other.service.setAuthority(authority);
  await other.service.run(request);
  const waiting = other.service.wait(identity.taskId);
  await other.service.close();
  await assert.rejects(waiting, (error: unknown) => diagnosticCode(error) === "BOOTSTRAP_STOPPED");
});

test("operation requests are strict cloned JSON boundaries", () => {
  const source = { ...request, input: { nested: ["value"] } };
  const parsed = parseRunTaskRequest(source);
  source.input.nested[0] = "changed";
  assert.deepEqual(parsed.input, { nested: ["value"] });
  assert.throws(
    () => parseRunTaskRequest({ ...request, hostPath: "/tmp/plugin.tego" }),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_OPERATION_INVALID",
  );
});

test("deploy is transactional, idempotent, generation-monotonic, and status is follower-readable", async () => {
  const { service: tasks, state } = serviceFixture();
  const digest = parseArtifactDigest(
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const installation = parsePluginInstallation({
    pluginId: "echo",
    version: "1.0.0",
    digest,
    installedAt: now.toISOString(),
    manifest: {
      schemaVersion: "1.0",
      pluginId: "echo",
      version: "1.0.0",
      contractRange: "^1.0.0",
      nodeRange: ">=26.0.0",
      moduleFormat: "esm",
      components: [
        {
          componentId: "echo",
          kind: "task",
          entrypoint: "dist/echo.js",
          executors: ["process"],
        },
      ],
      permissions: [],
      capabilities: { provides: [], requires: [] },
    },
  });
  state.records.set(`tego/installations/echo@1.0.0@${digest}`, {
    value: installation,
    revision: 1,
  });
  let currentAuthority: RuntimeAuthority | undefined = authority;
  let wakes = 0;
  let revokeOnWake = false;
  const operations = new RuntimeOperationController({
    clock,
    state,
    tasks,
    artifactService: {
      install: async () => installation,
    },
    authority: () => currentAuthority,
    wake: async () => {
      wakes += 1;
      if (revokeOnWake) currentAuthority = undefined;
    },
  });
  operations.openReadOnly();
  operations.openMutations();
  const deploymentRequest = {
    applicationId: request.applicationId,
    pluginId: request.pluginId,
    artifactDigest: digest,
    essential: true,
    configuration: { greeting: "hello" },
    permissionGrants: [],
    capabilityBindings: {},
  };

  const first = await operations.deployPlugin(deploymentRequest);
  const duplicate = await operations.deployPlugin(structuredClone(deploymentRequest));
  const second = await operations.deployPlugin({
    ...deploymentRequest,
    configuration: { greeting: "hi" },
  });
  assert.equal(first.generation, "1");
  assert.deepEqual(duplicate, first);
  assert.equal(second.generation, "2");
  assert.equal(wakes, 2);

  revokeOnWake = true;
  await assert.rejects(
    operations.deployPlugin({ ...deploymentRequest, configuration: { greeting: "fenced" } }),
    (error: unknown) => diagnosticCode(error) === "COORDINATION_FENCE_REJECTED",
  );

  currentAuthority = authority;
  revokeOnWake = false;
  state.beforeTransaction = () => {
    state.records.set(`tego/installations/echo@1.0.0@${digest}`, {
      value: { ...installation, pluginId: parsePluginId("other") },
      revision: 100,
    });
  };
  await assert.rejects(
    operations.deployPlugin({ ...deploymentRequest, configuration: { greeting: "stale" } }),
    (error: unknown) => diagnosticCode(error) === "DEPLOYMENT_ARTIFACT_NOT_INSTALLED",
  );

  currentAuthority = undefined;
  operations.closeMutations();
  const status = await operations.pluginStatus({
    applicationId: request.applicationId,
    pluginId: request.pluginId,
  });
  assert.equal(status.desired?.generation, "3");
});

test("@spec:runtime-operations/task-operations/old-epoch-completion-cannot-use-new-authority", async () => {
  const executor = new ControlledExecutor("remote", "remote-01");
  const { service, state } = serviceFixture(executor);
  await service.setAuthority(authority);
  await service.run(request);
  await service.setAuthority({ ...authority, epoch: parseFencingEpoch("8") });
  executor.result.resolve({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    executor: { kind: "process" },
    status: "succeeded",
    output: { secret: true },
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const durable = await state.read<JsonValue>({
    namespace: "tego",
    collection: "tasks",
    id: identity.taskId,
  });
  assert.equal((durable?.value as { state?: unknown }).state, "running");
});

test("@spec:runtime-operations/task-operations/durable-terminal-replaces-ephemeral-uncertainty", async () => {
  const { executor, service, state } = serviceFixture();
  await service.setAuthority(authority);
  await service.run(request);
  state.rejectTerminalWrites = true;
  executor.result.reject(new Error("persistence-secret"));
  assert.equal((await service.wait(identity.taskId)).result?.status, "indeterminate");
  state.rejectTerminalWrites = false;
  const succeeded = parseTaskRecord({
    ...(await service.status(identity.taskId)),
    state: "terminal",
    updatedAt: now.toISOString(),
    result: {
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      executor: { kind: "process" },
      status: "succeeded",
      output: { durable: true },
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
    },
  });
  state.records.set(`tego/tasks/${identity.taskId}`, { value: succeeded, revision: 99 });
  assert.equal((await service.status(identity.taskId))?.result?.status, "succeeded");
});

test("@spec:runtime-operations/task-operations/cancellation-intent-is-durable-before-effect", async () => {
  const { executor, service, state } = serviceFixture();
  await service.setAuthority(authority);
  await service.run(request);
  const gate = Promise.withResolvers<void>();
  executor.cancelGate = gate.promise;
  const cancellation = service.cancel(identity.taskId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const durable = await state.read<JsonValue>({
    namespace: "tego",
    collection: "tasks",
    id: identity.taskId,
  });
  assert.equal(
    (durable?.value as { cancellation?: { authority?: { epoch?: unknown } } }).cancellation
      ?.authority?.epoch,
    authority.epoch,
  );
  gate.resolve();
  executor.result.resolve({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    executor: { kind: "process" },
    status: "cancelled",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
  });
  assert.equal((await cancellation).result?.status, "cancelled");
});

test("@spec:runtime-bootstrap/durable-restart-recovery/remote-observation-failure-stays-nonterminal", async () => {
  const executor = new ControlledExecutor("remote", "remote-01");
  const { service, state } = serviceFixture(executor);
  const running = parseTaskRecord({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    request,
    state: "running",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    executor: { id: executor.id, type: executor.type },
    authority,
  });
  state.records.set(`tego/tasks/${identity.taskId}`, { value: running, revision: 1 });
  executor.observeError = new Error("remote-token-must-not-leak");
  await service.recover();
  await service.setAuthority(authority);
  const recovered = await service.status(identity.taskId);
  assert.notEqual(recovered?.state, "terminal");
  assert.doesNotMatch(JSON.stringify(recovered), /remote-token-must-not-leak/u);
});

test("@spec:runtime-bootstrap/durable-restart-recovery/observation-is-clock-bounded-and-close-settles-recovery", async () => {
  const executor = new ControlledExecutor("remote", "remote-01");
  const state = new TransactionalState();
  const runtimeClock = new FakeClock(now);
  const service = new TaskService({
    state,
    clock: runtimeClock,
    selectExecutor: async () => executor,
    createIdentity: () => identity,
  });
  state.records.set(`tego/tasks/${identity.taskId}`, {
    value: parseTaskRecord({
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      request,
      state: "running",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      executor: { id: executor.id, type: executor.type },
      authority,
    }),
    revision: 1,
  });
  executor.observeGate = new Promise<void>(() => {});
  await service.recover();
  let settled = false;
  const recovery = service.setAuthority(authority).finally(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  runtimeClock.advanceBy(5_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, true);
  await service.close();
  await recovery;
});

test("@spec:runtime-operations/task-operations/rejected-handle-is-consumed-and-classified", async () => {
  const { executor, service } = serviceFixture();
  await service.setAuthority(authority);
  executor.handleTaskId = parseTaskId("wrong-task");
  executor.result.reject(new Error("executor-secret"));
  const record = await service.run(request);
  assert.equal(record.result?.status, "indeterminate");
  assert.doesNotMatch(JSON.stringify(record), /executor-secret/u);
});

test("@spec:runtime-operations/task-operations/complete-operation-payloads-have-one-mebibyte-limit", () => {
  const oversized = "x".repeat(1_048_576);
  assert.throws(
    () => parseRunTaskRequest({ ...request, input: oversized }),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_OPERATION_INVALID",
  );
  assert.throws(
    () =>
      parseDeployPluginRequest({
        applicationId: request.applicationId,
        pluginId: request.pluginId,
        artifactDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        essential: true,
        configuration: oversized,
        permissionGrants: [],
        capabilityBindings: {},
      }),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_OPERATION_INVALID",
  );
  assert.throws(
    () =>
      parseTaskRecord({
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        request,
        state: "terminal",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        executor: { id: "executor-01", type: "process" },
        result: {
          taskId: identity.taskId,
          attemptId: identity.attemptId,
          executor: { kind: "process" },
          status: "succeeded",
          output: oversized,
          startedAt: now.toISOString(),
          completedAt: now.toISOString(),
        },
      }),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_OPERATION_INVALID",
  );
});

test("@spec:runtime-operations/task-operations/task-record-cross-field-invariants", () => {
  const base = {
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    request,
    state: "terminal",
    createdAt: "2026-07-25T00:00:01.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    executor: { id: "executor-01", type: "process" },
    result: {
      taskId: parseTaskId("wrong-task"),
      attemptId: identity.attemptId,
      executor: { kind: "remote" },
      status: "succeeded",
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
    },
  };
  assert.throws(() => parseTaskRecord(base), /updatedAt/u);
  assert.throws(
    () => parseRunTaskRequest({ ...request, deadline: "2026-02-30T00:00:00.000Z" }),
    /canonical UTC timestamp/u,
  );
});

test("@spec:runtime-bootstrap/durable-restart-recovery/replays-durable-cancellation-intent", async () => {
  const { executor, service, state } = serviceFixture();
  state.records.set(`tego/tasks/${identity.taskId}`, {
    value: parseTaskRecord({
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      request,
      state: "running",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      executor: { id: executor.id, type: executor.type },
      authority,
      cancellation: { requestedAt: now.toISOString(), authority },
    }),
    revision: 1,
  });
  await service.recover();
  await service.setAuthority(authority);
  assert.deepEqual(executor.cancelled, [`${identity.taskId}/${identity.attemptId}`]);
});

test("@spec:runtime-operations/task-operations/uncertain-remote-submit-is-redacted-and-recoverable", async () => {
  const executor = new ControlledExecutor("remote", "remote-01");
  const { service } = serviceFixture(executor);
  await service.setAuthority(authority);
  executor.submitError = new Error("remote-submit-secret");
  const accepted = await service.run(request);
  assert.notEqual(accepted.state, "terminal");
  assert.equal(accepted.diagnostic?.code, "EXECUTOR_SUBMISSION_UNKNOWN");
  assert.doesNotMatch(JSON.stringify(accepted), /remote-submit-secret/u);
});
