import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnosticCode,
  parseApplicationId,
  parseAttemptId,
  parseComponentId,
  parseFencingEpoch,
  parsePluginId,
  parseRevision,
  parseTaskId,
  parseRunTaskRequest,
  parseArtifactDigest,
  parsePluginInstallation,
  parseOperationId,
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
import {
  RuntimeOperationController,
  TaskService,
  type TaskIdentity,
} from "../src/index.js";

const now = new Date("2026-07-25T00:00:00.000Z");
const clock: Clock = {
  now: () => now,
  sleep: (_delay, signal) =>
    signal?.aborted === true ? Promise.reject(signal.reason) : Promise.resolve(),
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
        this.writes.push(`${item.key.collection}:${String((item.value as { state?: unknown }).state)}`);
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
  readonly id = "executor-01";
  readonly type = "process" as const;
  readonly submitted: ExecutionRequest[] = [];
  readonly cancelled: string[] = [];
  readonly result = Promise.withResolvers<ExecutionResult>();
  submitGate: Promise<void> = Promise.resolve();

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
    return { taskId: request.taskId, attemptId: request.attemptId, result: this.result.promise };
  }
  observe() {
    return Promise.resolve(undefined);
  }
  cancel(taskId: ExecutionRequest["taskId"], attemptId: ExecutionRequest["attemptId"]) {
    this.cancelled.push(`${taskId}/${attemptId}`);
    return Promise.resolve();
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

function serviceFixture() {
  const state = new TransactionalState();
  const executor = new ControlledExecutor();
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
  await Promise.resolve();
  await Promise.resolve();
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

test("leadership loss fences terminal commit and reports indeterminate without output", async () => {
  const { executor, service } = serviceFixture();
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
  const terminal = await service.wait(identity.taskId);
  assert.equal(terminal.result?.status, "indeterminate");
  assert.equal(terminal.result?.output, undefined);
  assert.equal(terminal.result?.diagnostic?.retryable, false);
});

test("cancel is idempotent and close releases all waiters", async () => {
  const { executor, service } = serviceFixture();
  await service.setAuthority(authority);
  await service.run(request);
  const first = service.cancel(identity.taskId);
  const second = service.cancel(identity.taskId);
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

  currentAuthority = undefined;
  operations.closeMutations();
  const status = await operations.pluginStatus({
    applicationId: request.applicationId,
    pluginId: request.pluginId,
  });
  assert.equal(status.desired?.generation, "2");
});
