import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnosticCode,
  parseApplicationId,
  parseFencingEpoch,
  parseNodeId,
  parseOperationId,
  parseRevision,
  parseRuntimeId,
  type ArtifactDigest,
  type ArtifactStore,
  type Clock,
  type CoordinationChange,
  type CoordinationProvider,
  type CoordinationWatchRequest,
  type DriverHealth,
  type JsonValue,
  type OperationJournalQuery,
  type PersistedOperationJournalEntry,
  type RuntimeConfiguration,
  type RuntimeDrivers,
  type ScannedState,
  type StateChange,
  type StateKey,
  type StateQuery,
  type StateStore,
  type StateTransaction,
  type StateTransactionOptions,
  type Versioned,
} from "@tegojs/contracts";
import {
  createRuntime,
  isRuntimeReady,
  transitionRuntimeState,
} from "../src/index.js";

const now = new Date("2026-07-23T00:00:00.000Z");
const clock: Clock = {
  now: () => now,
  sleep: async () => {},
};

const configuration = {
  mode: "single-main",
  runtimeId: parseRuntimeId("runtime-01"),
  applicationId: parseApplicationId("application-01"),
  nodeId: parseNodeId("main-01"),
} satisfies RuntimeConfiguration;

function healthy(): DriverHealth {
  return { status: "healthy", checkedAt: now.toISOString() };
}

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {},
  };
}

class ControlledStateStore implements StateStore {
  readonly log: string[];
  readonly recovered: readonly PersistedOperationJournalEntry[];
  recoveryGate: Promise<void> = Promise.resolve();
  failOpen = false;

  constructor(log: string[], recovered: readonly PersistedOperationJournalEntry[] = []) {
    this.log = log;
    this.recovered = recovered;
  }

  async open(): Promise<void> {
    this.log.push("state.open");
    if (this.failOpen) throw new Error("state open failed");
  }

  async transact<T extends JsonValue>(
    _options: StateTransactionOptions,
    _work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    throw new Error("not used");
  }

  async read<T extends JsonValue>(_key: StateKey<T>): Promise<Versioned<T> | undefined> {
    return undefined;
  }

  scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
    this.log.push(`state.scan:${query.collection}`);
    return emptyAsyncIterable();
  }

  scanRecoverableOperations(
    query: OperationJournalQuery = {},
  ): AsyncIterable<PersistedOperationJournalEntry> {
    const store = this;
    return {
      async *[Symbol.asyncIterator]() {
        store.log.push(`state.recover:${query.limit ?? "all"}`);
        await store.recoveryGate;
        for (const entry of store.recovered) yield entry;
      },
    };
  }

  watch(_cursor: ReturnType<typeof parseRevision>): AsyncIterable<StateChange> {
    return emptyAsyncIterable();
  }

  async health(): Promise<DriverHealth> {
    this.log.push("state.health");
    return healthy();
  }

  async close(): Promise<void> {
    this.log.push("state.close");
  }
}

class ControlledCoordination implements CoordinationProvider {
  readonly scope: "distributed" | "local";
  readonly log: string[];
  failOpen = false;

  constructor(log: string[], scope: "distributed" | "local" = "local") {
    this.log = log;
    this.scope = scope;
  }

  async open(): Promise<void> {
    this.log.push("coordination.open");
    if (this.failOpen) throw new Error("coordination open failed");
  }

  async campaign(request: { readonly resource: string }) {
    this.log.push("coordination.campaign");
    return { resource: request.resource, epoch: parseFencingEpoch("1") };
  }

  async acquireLease(): Promise<never> {
    throw new Error("not used");
  }

  async nextEpoch() {
    return parseFencingEpoch("1");
  }

  async compareAndSet<T extends JsonValue>(): Promise<{ readonly applied: false }> {
    return { applied: false };
  }

  watch(_request: CoordinationWatchRequest): AsyncIterable<CoordinationChange> {
    return emptyAsyncIterable();
  }

  async health(): Promise<DriverHealth> {
    this.log.push("coordination.health");
    return healthy();
  }

  async close(): Promise<void> {
    this.log.push("coordination.close");
  }
}

class ControlledArtifacts implements ArtifactStore {
  readonly log: string[];

  constructor(log: string[]) {
    this.log = log;
  }

  async open(): Promise<void> {
    this.log.push("artifacts.open");
  }

  async put(_digest: ArtifactDigest, _source: AsyncIterable<Uint8Array>): Promise<void> {}

  read(_digest: ArtifactDigest): AsyncIterable<Uint8Array> {
    return emptyAsyncIterable();
  }

  async health(): Promise<DriverHealth> {
    this.log.push("artifacts.health");
    return healthy();
  }

  async close(): Promise<void> {
    this.log.push("artifacts.close");
  }
}

function controlledDrivers(
  recovered: readonly PersistedOperationJournalEntry[] = [],
): {
  readonly drivers: RuntimeDrivers;
  readonly state: ControlledStateStore;
  readonly coordination: ControlledCoordination;
  readonly log: string[];
} {
  const log: string[] = [];
  const state = new ControlledStateStore(log, recovered);
  const coordination = new ControlledCoordination(log);
  return {
    drivers: {
      state,
      coordination,
      artifacts: new ControlledArtifacts(log),
      clock,
    },
    state,
    coordination,
    log,
  };
}

test("@spec:runtime-bootstrap/independent-kernel-lifecycle/empty-runtime-lifecycle", async () => {
  const { drivers, log } = controlledDrivers();
  const runtime = createRuntime(configuration, drivers);

  await runtime.start();
  const status = await runtime.status();

  assert.equal(status.lifecycle, "running");
  assert.equal(status.live, true);
  assert.equal(status.ready, true);
  assert.equal(status.acceptingOperations, true);
  assert.deepEqual(status.identity, {
    runtimeId: configuration.runtimeId,
    applicationId: configuration.applicationId,
    nodeId: configuration.nodeId,
  });
  assert.equal(status.mode, "single-main");
  assert.deepEqual(status.counts, {
    deployments: 0,
    installations: 0,
    recoverableOperations: 0,
    tasks: 0,
    workers: 0,
  });
  assert.deepEqual(
    log.slice(0, 8),
    [
      "state.open",
      "coordination.open",
      "artifacts.open",
      "state.scan:installations",
      "state.scan:deployments",
      "state.scan:tasks",
      "state.recover:100",
      "coordination.campaign",
    ],
  );

  await runtime.stop();
  assert.equal((await runtime.status()).lifecycle, "stopped");
  assert.deepEqual(log.slice(-3), [
    "artifacts.close",
    "coordination.close",
    "state.close",
  ]);
});

test("driver open failure closes previously opened drivers in reverse order", async () => {
  const { coordination, drivers, log } = controlledDrivers();
  coordination.failOpen = true;
  const runtime = createRuntime(configuration, drivers);

  await assert.rejects(runtime.start(), /coordination open failed/u);
  assert.deepEqual(log, ["state.open", "coordination.open", "state.close"]);
  assert.equal((await runtime.status()).lifecycle, "failed");
});

test("@spec:runtime-bootstrap/explicit-runtime-bootstrap/reject-missing-distributed-coordination", async () => {
  const { drivers, log } = controlledDrivers();
  const runtime = createRuntime({ ...configuration, mode: "multi-main" }, drivers);

  await assert.rejects(
    runtime.start(),
    (error: unknown) => diagnosticCode(error) === "BOOTSTRAP_COORDINATION_NOT_DISTRIBUTED",
  );
  assert.deepEqual(log, []);
});

test("@spec:runtime-bootstrap/durable-restart-recovery/recovery-precedes-operations-and-authority", async () => {
  const recovered = [
    {
      operationId: parseOperationId("operation-01"),
      kind: "deploy",
      status: "executing",
      state: { step: "start" },
      updatedAt: now.toISOString(),
      revision: parseRevision("1"),
    },
  ] satisfies readonly PersistedOperationJournalEntry[];
  const { drivers, state, log } = controlledDrivers(recovered);
  const gate = Promise.withResolvers<void>();
  state.recoveryGate = gate.promise;
  const runtime = createRuntime(configuration, drivers);

  const starting = runtime.start();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal((await runtime.status()).acceptingOperations, false);
  await assert.rejects(
    runtime.operations.recoveredOperations(),
    (error: unknown) => diagnosticCode(error) === "BOOTSTRAP_NOT_READY",
  );
  assert.equal(log.includes("coordination.campaign"), false);

  gate.resolve();
  await starting;
  assert.deepEqual(await runtime.operations.recoveredOperations(), recovered);
  assert.ok(log.indexOf("state.recover:100") < log.indexOf("coordination.campaign"));
});

test("concurrent and repeated start and stop calls are idempotent", async () => {
  const { drivers, log } = controlledDrivers();
  const runtime = createRuntime(configuration, drivers);

  const firstStart = runtime.start();
  const secondStart = runtime.start();
  assert.equal(firstStart, secondStart);
  await Promise.all([firstStart, secondStart]);
  await runtime.start();
  assert.equal(log.filter((entry) => entry.endsWith(".open")).length, 3);

  const firstStop = runtime.stop();
  const secondStop = runtime.stop();
  assert.equal(firstStop, secondStop);
  await Promise.all([firstStop, secondStop]);
  await runtime.stop();
  assert.equal(log.filter((entry) => entry.endsWith(".close")).length, 3);
});

test("stop racing with start prevents runtime resurrection", async () => {
  const { drivers, state } = controlledDrivers();
  const gate = Promise.withResolvers<void>();
  state.recoveryGate = gate.promise;
  const runtime = createRuntime(configuration, drivers);

  const starting = runtime.start();
  const stopping = runtime.stop();
  gate.resolve();
  await Promise.all([starting, stopping]);

  const status = await runtime.status();
  assert.equal(status.lifecycle, "stopped");
  assert.equal(status.acceptingOperations, false);
  assert.equal(status.ready, false);
});

test("runtime event iterators terminate on stop, including pending and late iterators", async () => {
  const { drivers } = controlledDrivers();
  const runtime = createRuntime(configuration, drivers);
  const first = runtime.events[Symbol.asyncIterator]();
  const second = runtime.events[Symbol.asyncIterator]();
  const firstPending = first.next();
  const secondPending = second.next();

  await runtime.start();
  assert.equal((await firstPending).done, false);
  assert.equal((await secondPending).done, false);
  await runtime.stop();

  while (!(await first.next()).done) {}
  while (!(await second.next()).done) {}
  assert.deepEqual(await runtime.events[Symbol.asyncIterator]().next(), {
    done: true,
    value: undefined,
  });
});

test("runtime lifecycle transitions are pure and reject illegal edges", () => {
  assert.equal(transitionRuntimeState("created", "opening", now.toISOString()), "opening");
  assert.throws(
    () => transitionRuntimeState("created", "running", now.toISOString()),
    (error: unknown) => diagnosticCode(error) === "LIFECYCLE_TRANSITION_INVALID",
  );
});

test("@spec:runtime-bootstrap/essential-readiness/essential-and-non-essential-health", () => {
  assert.equal(
    isRuntimeReady({
      lifecycle: "running",
      drivers: [healthy(), { ...healthy(), status: "degraded" }],
      deployments: [
        { desired: true, essential: true, ready: true },
        { desired: true, essential: false, ready: false },
      ],
    }),
    true,
  );
  assert.equal(
    isRuntimeReady({
      lifecycle: "running",
      drivers: [healthy()],
      deployments: [{ desired: true, essential: true, ready: false }],
    }),
    false,
  );
  assert.equal(
    isRuntimeReady({
      lifecycle: "running",
      drivers: [{ ...healthy(), status: "unhealthy" }],
      deployments: [],
    }),
    false,
  );
  assert.equal(
    isRuntimeReady({
      lifecycle: "stopped",
      drivers: [healthy()],
      deployments: [],
    }),
    false,
  );
});
