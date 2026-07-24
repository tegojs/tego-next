import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DiagnosticError,
  diagnosticCode,
  compareOperationJournalCursors,
  parseApplicationId,
  parseFencingEpoch,
  parseNodeId,
  parseOperationId,
  parseRevision,
  parseRuntimeId,
  parseRuntimeEvent,
  parseRuntimeStatus,
  type ArtifactDigest,
  type ArtifactStore,
  type Clock,
  type CoordinationChange,
  type CoordinationProvider,
  type CoordinationWatchRequest,
  type DriverHealth,
  type JsonValue,
  type Leadership,
  type LeadershipHandle,
  type OperationJournalQuery,
  type PersistedOperationJournalEntry,
  type HostedProcess,
  type ProcessHost,
  type ProcessSpawnRequest,
  type RuntimeConfiguration,
  type RuntimeDrivers,
  type SecretProvider,
  type ScannedState,
  type StateChange,
  type StateKey,
  type StateQuery,
  type StateStore,
  type StateTransaction,
  type StateTransactionOptions,
  type Versioned,
} from "@tegojs/contracts";
import { createRuntime, isRuntimeReady, transitionRuntimeState } from "../src/index.js";

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
  scope: "local" | "shared" = "local";
  readonly log: string[];
  readonly recovered: readonly PersistedOperationJournalEntry[];
  readonly deployments: readonly JsonValue[];
  recoveryGate: Promise<void> = Promise.resolve();
  failOpen = false;
  failClose = false;
  healthResult: unknown = healthy();

  constructor(
    log: string[],
    recovered: readonly PersistedOperationJournalEntry[] = [],
    deployments: readonly JsonValue[] = [],
  ) {
    this.log = log;
    this.recovered = recovered;
    this.deployments = deployments;
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
    const values = query.collection === "deployments" ? this.deployments : [];
    return {
      async *[Symbol.asyncIterator]() {
        for (const [index, value] of values.entries()) {
          yield {
            key: {
              namespace: query.namespace,
              collection: query.collection,
              id: `record-${String(index)}`,
            },
            value: value as T,
            revision: parseRevision(String(index + 1)),
          };
        }
      },
    };
  }

  scanRecoverableOperations(
    query: OperationJournalQuery = {},
  ): AsyncIterable<PersistedOperationJournalEntry> {
    const store = this;
    return {
      async *[Symbol.asyncIterator]() {
        store.log.push(`state.recover:${query.limit ?? "all"}`);
        await store.recoveryGate;
        const entries = store.recovered
          .filter(
            (entry) =>
              query.after === undefined || compareOperationJournalCursors(entry, query.after) > 0,
          )
          .slice(0, query.limit);
        for (const entry of entries) yield entry;
      },
    };
  }

  claimOutbox(): ReturnType<StateStore["claimOutbox"]> {
    return Promise.resolve([]);
  }

  acknowledgeOutbox(): ReturnType<StateStore["acknowledgeOutbox"]> {
    return Promise.reject(new Error("outbox is not used by bootstrap tests"));
  }

  watch(_cursor: ReturnType<typeof parseRevision>): AsyncIterable<StateChange> {
    return emptyAsyncIterable();
  }

  async health(): Promise<DriverHealth> {
    this.log.push("state.health");
    return this.healthResult as DriverHealth;
  }

  async close(): Promise<void> {
    this.log.push("state.close");
    if (this.failClose) throw new Error("state close failed");
  }
}

class ControlledCoordination implements CoordinationProvider {
  scope: "distributed" | "local";
  readonly log: string[];
  failOpen = false;
  failClose = false;
  campaignResult: unknown;
  healthResult: unknown = healthy();
  releaseCount = 0;

  constructor(log: string[], scope: "distributed" | "local" = "local") {
    this.log = log;
    this.scope = scope;
    this.campaignResult = undefined;
  }

  async open(): Promise<void> {
    this.log.push("coordination.open");
    if (this.failOpen) throw new Error("coordination open failed");
  }

  async campaign(request: { readonly resource: string }): Promise<LeadershipHandle> {
    this.log.push("coordination.campaign");
    const leadership = (this.campaignResult ?? {
      resource: request.resource,
      epoch: parseFencingEpoch("1"),
    }) as Leadership;
    return {
      leadership,
      lost: new Promise(() => undefined),
      release: async () => {
        this.releaseCount += 1;
      },
    };
  }

  async acquireLease(): Promise<never> {
    throw new Error("not used");
  }

  async nextEpoch() {
    return parseFencingEpoch("1");
  }

  async compareAndSet<_T extends JsonValue>(): Promise<{ readonly applied: false }> {
    return { applied: false };
  }

  watch(_request: CoordinationWatchRequest): AsyncIterable<CoordinationChange> {
    return emptyAsyncIterable();
  }

  async health(): Promise<DriverHealth> {
    this.log.push("coordination.health");
    return this.healthResult as DriverHealth;
  }

  async close(): Promise<void> {
    this.log.push("coordination.close");
    if (this.failClose) throw new Error("coordination close failed");
  }
}

class ControlledArtifacts implements ArtifactStore {
  scope: "local" | "shared" = "local";
  readonly log: string[];
  healthResult: unknown = healthy();

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
    return this.healthResult as DriverHealth;
  }

  async close(): Promise<void> {
    this.log.push("artifacts.close");
  }
}

class ControlledSecrets implements SecretProvider {
  readonly developmentOnly = false;
  readonly #log: string[];

  constructor(log: string[]) {
    this.#log = log;
  }

  async open(): Promise<void> {
    this.#log.push("secrets.open");
  }

  async get(_name: string): Promise<string | undefined> {
    return undefined;
  }

  async health(): Promise<DriverHealth> {
    this.#log.push("secrets.health");
    return healthy();
  }

  async close(): Promise<void> {
    this.#log.push("secrets.close");
  }
}

class ControlledProcessHost implements ProcessHost {
  readonly #log: string[];
  readonly activeProcessCount = 0;

  constructor(log: string[]) {
    this.#log = log;
  }

  async open(): Promise<void> {
    this.#log.push("processHost.open");
  }

  async spawn(_request: ProcessSpawnRequest): Promise<HostedProcess> {
    throw new Error("Controlled process host does not spawn");
  }

  async health(): Promise<DriverHealth> {
    this.#log.push("processHost.health");
    return healthy();
  }

  async close(): Promise<void> {
    this.#log.push("processHost.close");
  }
}

function controlledDrivers(recovered: readonly PersistedOperationJournalEntry[] = []): {
  readonly drivers: RuntimeDrivers;
  readonly state: ControlledStateStore;
  readonly coordination: ControlledCoordination;
  readonly artifacts: ControlledArtifacts;
  readonly processHost: ControlledProcessHost;
  readonly secrets: ControlledSecrets;
  readonly log: string[];
} {
  const log: string[] = [];
  const state = new ControlledStateStore(log, recovered);
  const coordination = new ControlledCoordination(log);
  const artifacts = new ControlledArtifacts(log);
  const processHost = new ControlledProcessHost(log);
  const secrets = new ControlledSecrets(log);
  return {
    drivers: {
      state,
      coordination,
      artifacts,
      processHost,
      secrets,
      clock,
    },
    state,
    coordination,
    artifacts,
    processHost,
    secrets,
    log,
  };
}

test("@spec:runtime-bootstrap/independent-kernel-lifecycle/empty-runtime-lifecycle", async () => {
  const { coordination, drivers, log } = controlledDrivers();
  const runtime = createRuntime(configuration, drivers);

  await runtime.start();
  const status = await runtime.status();

  assert.equal(status.lifecycle, "running");
  assert.equal(status.liveness, true);
  assert.equal(status.readiness, true);
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
  assert.deepEqual(log.slice(0, 9), [
    "state.open",
    "coordination.open",
    "artifacts.open",
    "processHost.open",
    "secrets.open",
    "state.scan:installations",
    "state.scan:deployments",
    "state.scan:tasks",
    "state.recover:100",
  ]);
  for (const health of [
    "state.health",
    "coordination.health",
    "artifacts.health",
    "processHost.health",
    "secrets.health",
  ]) {
    assert.ok(log.indexOf(health) < log.indexOf("coordination.campaign"));
  }

  await runtime.stop();
  assert.equal(coordination.releaseCount, 1);
  assert.equal((await runtime.status()).lifecycle, "stopped");
  assert.deepEqual(log.slice(-5), [
    "secrets.close",
    "processHost.close",
    "artifacts.close",
    "coordination.close",
    "state.close",
  ]);
});

test("follower rejects mutation before reading artifact bytes", async () => {
  const { drivers } = controlledDrivers();
  let artifactReads = 0;
  drivers.artifacts.read = (_digest) => {
    artifactReads += 1;
    return emptyAsyncIterable();
  };
  const runtime = createRuntime({ ...configuration, mode: "single-main" }, drivers);

  await assert.rejects(
    runtime.operations.installPlugin({
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    (error: unknown) => diagnosticCode(error) === "COORDINATION_NOT_LEADER",
  );
  assert.equal(artifactReads, 0);
});

test("driver open failure closes previously opened drivers in reverse order", async () => {
  const { coordination, drivers, log, state } = controlledDrivers();
  coordination.failOpen = true;
  coordination.failClose = true;
  state.failClose = true;
  const runtime = createRuntime(configuration, drivers);

  await assert.rejects(runtime.start(), /coordination open failed/u);
  assert.deepEqual(log, ["state.open", "coordination.open", "coordination.close", "state.close"]);
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

test("multi-main rejects every local storage boundary before opening drivers", async () => {
  for (const mismatch of ["artifacts", "state"] as const) {
    const { artifacts, coordination, drivers, log, state } = controlledDrivers();
    coordination.scope = "distributed";
    state.scope = "shared";
    artifacts.scope = "shared";
    if (mismatch === "state") state.scope = "local";
    if (mismatch === "artifacts") artifacts.scope = "local";
    const runtime = createRuntime({ ...configuration, mode: "multi-main" }, drivers);

    await assert.rejects(
      runtime.start(),
      (error: unknown) =>
        diagnosticCode(error) ===
        (mismatch === "state" ? "BOOTSTRAP_STATE_NOT_SHARED" : "BOOTSTRAP_ARTIFACTS_NOT_SHARED"),
    );
    assert.deepEqual(log, []);
  }
});

test("multi-main accepts structurally distributed and shared drivers", async () => {
  const { artifacts, coordination, drivers, state } = controlledDrivers();
  coordination.scope = "distributed";
  state.scope = "shared";
  artifacts.scope = "shared";
  const runtime = createRuntime({ ...configuration, mode: "multi-main" }, drivers);

  await runtime.start();
  assert.equal((await runtime.status()).lifecycle, "running");
  await runtime.stop();
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
  assert.equal(log.filter((entry) => entry.endsWith(".open")).length, 5);

  const firstStop = runtime.stop();
  const secondStop = runtime.stop();
  assert.equal(firstStop, secondStop);
  await Promise.all([firstStop, secondStop]);
  await runtime.stop();
  assert.equal(log.filter((entry) => entry.endsWith(".close")).length, 5);
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
  assert.equal(status.readiness, false);
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

test("runtime validates health, status, events, and acquired authority before exposure", async () => {
  const { drivers, state } = controlledDrivers();
  state.healthResult = { status: "unknown", checkedAt: 1n };
  const runtime = createRuntime(configuration, drivers);
  const events = runtime.events[Symbol.asyncIterator]();

  await runtime.start();
  const status = await runtime.status();
  assert.equal(status.readiness, false);
  assert.equal(status.drivers[0]?.health.status, "unhealthy");
  assert.deepEqual(parseRuntimeStatus(JSON.parse(JSON.stringify(status))), status);
  const event = await events.next();
  assert.equal(event.done, false);
  assert.deepEqual(parseRuntimeEvent(JSON.parse(JSON.stringify(event.value))), event.value);
  await runtime.stop();

  const invalid = controlledDrivers();
  invalid.coordination.campaignResult = { resource: "", epoch: 1n };
  const invalidRuntime = createRuntime(configuration, invalid.drivers);
  await assert.rejects(
    invalidRuntime.start(),
    (error: unknown) => diagnosticCode(error) === "COORDINATION_LEADERSHIP_INVALID",
  );
  assert.equal((await invalidRuntime.status()).lifecycle, "failed");
});

test("runtime rejects leadership for a different campaign resource before running", async () => {
  const { coordination, drivers, log } = controlledDrivers();
  coordination.campaignResult = {
    resource: "runtime:someone-else",
    epoch: parseFencingEpoch("1"),
  };
  const runtime = createRuntime(configuration, drivers);

  await assert.rejects(runtime.start(), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.diagnostic.code, "COORDINATION_LEADERSHIP_RESOURCE_MISMATCH");
    assert.deepEqual(error.diagnostic.details, {
      expectedResource: `runtime:${configuration.runtimeId}`,
      actualResource: "runtime:someone-else",
    });
    JSON.stringify(error.diagnostic.details);
    return true;
  });
  const status = await runtime.status();
  assert.equal(status.lifecycle, "failed");
  assert.equal(status.acceptingOperations, false);
  assert.ok(log.indexOf("state.health") < log.indexOf("coordination.campaign"));
  assert.deepEqual(log.slice(-5), [
    "secrets.close",
    "processHost.close",
    "artifacts.close",
    "coordination.close",
    "state.close",
  ]);
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
