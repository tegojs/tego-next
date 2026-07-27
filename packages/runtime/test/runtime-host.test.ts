import assert from "node:assert/strict";
import { test } from "node:test";
import * as contracts from "@tegojs/contracts";
import {
  type ArtifactDigest,
  type ArtifactStore,
  type CampaignRequest,
  type Clock,
  type CoordinationChange,
  type CoordinationProvider,
  type CoordinationWatchRequest,
  type DriverHealth,
  diagnosticCode,
  type HostedProcess,
  type JsonValue,
  type LeadershipHandle,
  parseArtifactDigest,
  type ProcessHost,
  type ProcessSpawnRequest,
  parseApplicationId,
  parseFencingEpoch,
  parseGeneration,
  parseNodeId,
  parsePluginId,
  parseRevision,
  parseRuntimeId,
  parseTaskId,
  type PluginDeployment,
  type RunTaskRequest,
  type RuntimeAuthority,
  type RuntimeConfiguration,
  type RuntimeDiagnostic,
  type RuntimeDrivers,
  type RuntimeTaskLifecycle,
  type RuntimeWorkerDirectory,
  runtimeDiagnostic,
  type ScannedState,
  type SecretProvider,
  type StateChange,
  type StateKey,
  type StateQuery,
  type StateStore,
  type StateTransaction,
  type StateTransactionOptions,
  type TaskId,
  type TaskRecord,
  type Versioned,
} from "@tegojs/contracts";
import { eventually, FakeClock } from "@tegojs/testkit";
import { wakeReconcilerForAuthority } from "../src/create-runtime.js";
import { createRuntimeHost, type Reconciler, type RuntimeHostServices } from "../src/index.js";

const now = new Date("2026-07-24T00:00:00.000Z");
const clock: Clock = {
  now: () => now,
  sleep: (_delay, signal) =>
    signal?.aborted === true ? Promise.reject(signal.reason) : Promise.resolve(),
};

function healthy(): DriverHealth {
  return { status: "healthy", checkedAt: now.toISOString() };
}

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {},
  };
}

class EmptyState implements StateStore {
  scope: "local" | "shared" = "shared";
  readonly log: string[];
  healthGate: Promise<void> = Promise.resolve();
  readonly records = new Map<
    string,
    {
      readonly key: StateKey<JsonValue>;
      readonly value: JsonValue;
      readonly revision: ReturnType<typeof parseRevision>;
    }
  >();
  transactionReadCount = 0;
  #nextRevision = 1n;

  constructor(log: string[]) {
    this.log = log;
  }

  async open(): Promise<void> {
    this.log.push("state.open");
  }

  async transact<T extends JsonValue>(
    _options: StateTransactionOptions,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactionReadCount += 1;
    const snapshot = new Map(this.records);
    return work({
      get: async <V extends JsonValue>(key: StateKey<V>) => {
        const record = snapshot.get(this.#recordKey(key));
        return record === undefined
          ? undefined
          : {
              value: structuredClone(record.value) as V,
              revision: record.revision,
            };
      },
      scan: <V extends JsonValue>(query: StateQuery<V>) =>
        this.#scanRecords(snapshot, query) as AsyncIterable<ScannedState<V>>,
      put: () => Promise.reject(new Error("test transaction is read-only")),
      delete: () => Promise.reject(new Error("test transaction is read-only")),
      appendOperation: () => Promise.reject(new Error("not used")),
      enqueueOutbox: () => Promise.reject(new Error("not used")),
    });
  }

  read<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined> {
    const record = this.records.get(this.#recordKey(key));
    return Promise.resolve(
      record === undefined
        ? undefined
        : {
            value: structuredClone(record.value) as T,
            revision: record.revision,
          },
    );
  }

  scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
    return this.#scanRecords(this.records, query);
  }

  set(collection: string, id: string, value: JsonValue): void {
    const key = { namespace: "tego", collection, id };
    this.records.set(this.#recordKey(key), {
      key,
      value: structuredClone(value),
      revision: parseRevision((this.#nextRevision++).toString()),
    });
  }

  delete(collection: string, id: string): void {
    this.records.delete(this.#recordKey({ namespace: "tego", collection, id }));
  }

  scanOperations(): AsyncIterable<never> {
    return emptyAsyncIterable();
  }

  scanOperationHistory(): AsyncIterable<never> {
    return emptyAsyncIterable();
  }

  scanRecoverableOperations(): AsyncIterable<never> {
    return emptyAsyncIterable();
  }

  claimOutbox(): ReturnType<StateStore["claimOutbox"]> {
    return Promise.resolve([]);
  }

  acknowledgeOutbox(): ReturnType<StateStore["acknowledgeOutbox"]> {
    return Promise.reject(new Error("not used"));
  }

  watch(_cursor: ReturnType<typeof parseRevision>): AsyncIterable<StateChange> {
    return emptyAsyncIterable();
  }

  async health(): Promise<DriverHealth> {
    this.log.push("state.health");
    await this.healthGate;
    return healthy();
  }

  async close(): Promise<void> {
    this.log.push("state.close");
  }

  #recordKey(key: Pick<StateKey<JsonValue>, "namespace" | "collection" | "id">): string {
    return `${key.namespace}\u0000${key.collection}\u0000${key.id}`;
  }

  #scanRecords<T extends JsonValue>(
    records: ReadonlyMap<
      string,
      {
        readonly key: StateKey<JsonValue>;
        readonly value: JsonValue;
        readonly revision: ReturnType<typeof parseRevision>;
      }
    >,
    query: StateQuery<T>,
  ): AsyncIterable<ScannedState<T>> {
    const matching = [...records.values()]
      .filter(
        (record) =>
          record.key.namespace === query.namespace &&
          record.key.collection === query.collection &&
          (query.idPrefix === undefined || record.key.id.startsWith(query.idPrefix)) &&
          (query.afterId === undefined || record.key.id > query.afterId),
      )
      .sort((left, right) =>
        left.key.id < right.key.id ? -1 : left.key.id > right.key.id ? 1 : 0,
      );
    const page = query.limit === undefined ? matching : matching.slice(0, query.limit);
    return {
      async *[Symbol.asyncIterator]() {
        for (const record of page) {
          yield {
            key: record.key as StateKey<T>,
            value: structuredClone(record.value) as T,
            revision: record.revision,
          };
        }
      },
    };
  }
}

class ControlledCoordination implements CoordinationProvider {
  scope: "distributed" | "local" = "distributed";
  readonly log: string[];
  failRelease = false;
  immediateEpoch: string | undefined;
  #pending: Array<ReturnType<typeof Promise.withResolvers<LeadershipHandle>>> = [];

  constructor(log: string[]) {
    this.log = log;
  }

  async open(): Promise<void> {
    this.log.push("coordination.open");
  }

  campaign(_request: CampaignRequest): Promise<LeadershipHandle> {
    this.log.push("coordination.campaign");
    const pending = Promise.withResolvers<LeadershipHandle>();
    this.#pending.push(pending);
    if (this.immediateEpoch !== undefined) this.acquire(this.immediateEpoch);
    return pending.promise;
  }

  acquire(epoch: string): { readonly lose: () => void } {
    const pending = this.#pending.shift();
    assert.ok(pending, "a campaign must be pending");
    const lost = Promise.withResolvers<ReturnType<typeof runtimeDiagnostic>>();
    const leadership = {
      resource: "runtime:runtime-01",
      epoch: parseFencingEpoch(epoch),
    };
    pending.resolve({
      leadership,
      lost: lost.promise,
      release: async () => {
        this.log.push(`coordination.release:${epoch}`);
        if (this.failRelease) throw new Error("release failed");
        lost.resolve(
          runtimeDiagnostic({
            code: "COORDINATION_LEADERSHIP_RELEASED",
            message: "released",
            source: { kind: "coordination", id: leadership.resource },
            observedAt: now.toISOString(),
          }),
        );
      },
    });
    return {
      lose: () =>
        lost.resolve(
          runtimeDiagnostic({
            code: "COORDINATION_LEADERSHIP_LOST",
            message: "lost",
            source: { kind: "coordination", id: leadership.resource },
            observedAt: now.toISOString(),
          }),
        ),
    };
  }

  acquireLease(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }

  nextEpoch(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }

  compareAndSet<_T extends JsonValue>(): Promise<{ readonly applied: false }> {
    return Promise.resolve({ applied: false });
  }

  watch(_request: CoordinationWatchRequest): AsyncIterable<CoordinationChange> {
    return emptyAsyncIterable();
  }

  health(): Promise<DriverHealth> {
    return Promise.resolve(healthy());
  }

  async close(): Promise<void> {
    this.log.push("coordination.close");
  }
}

class EmptyArtifacts implements ArtifactStore {
  readonly scope = "shared";
  readonly #log: string[];

  constructor(log: string[]) {
    this.#log = log;
  }

  async open(): Promise<void> {
    this.#log.push("artifacts.open");
  }

  put(_digest: ArtifactDigest, _source: AsyncIterable<Uint8Array>): Promise<void> {
    return Promise.resolve();
  }

  read(_digest: ArtifactDigest): AsyncIterable<Uint8Array> {
    return emptyAsyncIterable();
  }

  health(): Promise<DriverHealth> {
    return Promise.resolve(healthy());
  }

  async close(): Promise<void> {
    this.#log.push("artifacts.close");
  }
}

class EmptyProcessHost implements ProcessHost {
  readonly activeProcessCount = 0;
  readonly #log: string[];

  constructor(log: string[]) {
    this.#log = log;
  }

  async open(): Promise<void> {
    this.#log.push("processHost.open");
  }

  spawn(_request: ProcessSpawnRequest): Promise<HostedProcess> {
    return Promise.reject(new Error("not used"));
  }

  health(): Promise<DriverHealth> {
    return Promise.resolve(healthy());
  }

  async close(): Promise<void> {
    this.#log.push("processHost.close");
  }
}

class EmptySecrets implements SecretProvider {
  readonly developmentOnly = false;
  readonly #log: string[];

  constructor(log: string[]) {
    this.#log = log;
  }

  async open(): Promise<void> {
    this.#log.push("secrets.open");
  }

  get(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  health(): Promise<DriverHealth> {
    return Promise.resolve(healthy());
  }

  async close(): Promise<void> {
    this.#log.push("secrets.close");
  }
}

class ControlledTasks implements RuntimeTaskLifecycle {
  readonly log: string[];
  taskCount = 4;
  authorityFailures = 0;

  constructor(log: string[]) {
    this.log = log;
  }

  async recover(): Promise<void> {
    this.log.push("tasks.recover");
  }

  async setAuthority(authority: RuntimeAuthority | undefined): Promise<void> {
    this.log.push(`tasks.authority:${authority?.epoch ?? "none"}`);
    if (authority !== undefined && this.authorityFailures > 0) {
      this.authorityFailures -= 1;
      throw new Error("task authority failed");
    }
  }

  count(): number {
    return this.taskCount;
  }

  async close(): Promise<void> {
    this.log.push("tasks.close");
  }

  run(_request: RunTaskRequest): Promise<TaskRecord> {
    return Promise.reject(new Error("not used"));
  }

  status(_taskId: TaskId): Promise<TaskRecord | undefined> {
    this.log.push("tasks.status");
    return Promise.resolve(undefined);
  }

  wait(_taskId: TaskId): Promise<TaskRecord> {
    return Promise.reject(new Error("not used"));
  }

  cancel(_taskId: TaskId): Promise<TaskRecord> {
    return Promise.reject(new Error("not used"));
  }
}

class ControlledWorkers implements RuntimeWorkerDirectory {
  readonly log: string[];
  workerCount = 2;
  authorityFailures = 0;

  constructor(log: string[]) {
    this.log = log;
  }

  async setAuthority(authority: RuntimeAuthority | undefined): Promise<void> {
    this.log.push(`workers.authority:${authority?.epoch ?? "none"}`);
    if (authority !== undefined && this.authorityFailures > 0) {
      this.authorityFailures -= 1;
      throw new Error("worker authority failed");
    }
  }

  count(): number {
    return this.workerCount;
  }

  placements(): readonly [] {
    return [];
  }

  async close(): Promise<void> {
    this.log.push("workers.close");
  }
}

class ControlledReconciler {
  readonly #authority: RuntimeAuthority;
  readonly #services: ControlledServices;
  #running = false;

  constructor(authority: RuntimeAuthority, services: ControlledServices) {
    this.#authority = authority;
    this.#services = services;
  }

  async start(): Promise<void> {
    this.#services.log.push(`reconciler.start:${this.#authority.epoch}`);
    this.#services.activeReconcilers += 1;
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#services.log.push(`reconciler.stop:${this.#authority.epoch}`);
    if (this.#services.reconcilerStopFailures > 0) {
      this.#services.reconcilerStopFailures -= 1;
      throw new Error("reconciler stop failed");
    }
    if (this.#running) {
      this.#services.activeReconcilers -= 1;
      this.#running = false;
    }
  }
}

class ControlledServices implements RuntimeHostServices {
  readonly log: string[];
  readonly tasks: ControlledTasks;
  readonly workers: ControlledWorkers;
  readonly reconcilerAuthorities: RuntimeAuthority[] = [];
  readonly reconcilerBackgroundErrors: Array<(error: unknown) => void> = [];
  readonly reconcilerCurrentAuthorities: Array<() => RuntimeAuthority | undefined> = [];
  readonly diagnostics: RuntimeDiagnostic[] = [];
  activeReconcilers = 0;
  reconcilerStartFailures = 0;
  reconcilerStopFailures = 0;

  constructor(log: string[]) {
    this.log = log;
    this.tasks = new ControlledTasks(log);
    this.workers = new ControlledWorkers(log);
  }

  readonly authorityAdmission = {
    open: (authority: RuntimeAuthority): void => {
      this.log.push(`capabilities.authority:${authority.epoch}`);
    },
    close: (authority: RuntimeAuthority): void => {
      this.log.push(`capabilities.authority:none:${authority.epoch}`);
    },
  };

  createReconciler = (
    authority: RuntimeAuthority,
    context: {
      readonly currentAuthority: () => RuntimeAuthority | undefined;
      readonly onBackgroundError: (error: unknown) => void;
    },
  ): Reconciler => {
    this.reconcilerAuthorities.push(authority);
    this.reconcilerBackgroundErrors.push(context.onBackgroundError);
    this.reconcilerCurrentAuthorities.push(context.currentAuthority);
    const reconciler = new ControlledReconciler(authority, this);
    if (this.reconcilerStartFailures > 0) {
      this.reconcilerStartFailures -= 1;
      return {
        start: async () => {
          this.log.push(`reconciler.start:${authority.epoch}`);
          throw new Error("reconciler start failed");
        },
        stop: () => reconciler.stop(),
      } as unknown as Reconciler;
    }
    return reconciler as unknown as Reconciler;
  };

  onDiagnostic(diagnostic: RuntimeDiagnostic): void {
    this.diagnostics.push(diagnostic);
  }
}

function configuration(mode: RuntimeConfiguration["mode"]): RuntimeConfiguration {
  return {
    mode,
    runtimeId: parseRuntimeId("runtime-01"),
    applicationId: parseApplicationId("application-01"),
    nodeId: parseNodeId("main-01"),
  };
}

function fixture(
  mode: RuntimeConfiguration["mode"] = "multi-main",
  runtimeClock: Clock = clock,
  sharedState?: EmptyState,
): {
  readonly configuration: RuntimeConfiguration;
  readonly coordination: ControlledCoordination;
  readonly drivers: RuntimeDrivers;
  readonly log: string[];
  readonly services: ControlledServices;
  readonly state: EmptyState;
} {
  const log: string[] = [];
  const coordination = new ControlledCoordination(log);
  const state = sharedState ?? new EmptyState(log);
  const artifacts = new EmptyArtifacts(log);
  if (mode === "single-main") {
    coordination.scope = "local";
    state.scope = "local";
    Object.defineProperty(artifacts, "scope", { value: "local" });
  }
  const services = new ControlledServices(log);
  return {
    configuration: configuration(mode),
    coordination,
    drivers: {
      state,
      coordination,
      artifacts,
      processHost: new EmptyProcessHost(log),
      secrets: new EmptySecrets(log),
      clock: runtimeClock,
    },
    log,
    services,
    state,
  };
}

const liveStatusDeployment = {
  applicationId: parseApplicationId("application-01"),
  pluginId: parsePluginId("plugin-01"),
  version: "1.0.0",
  artifactDigest: parseArtifactDigest(
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  ),
  generation: parseGeneration("1"),
  state: "active",
  essential: true,
  configuration: {},
  permissionGrants: [],
  capabilityBindings: {},
} satisfies PluginDeployment;

function liveStatusObservation(
  status: "blocked" | "degraded" | "disabled" | "failed" | "ready" | "reconciling" | "suspended",
  overrides: Readonly<Record<string, JsonValue>> = {},
): JsonValue {
  return {
    applicationId: liveStatusDeployment.applicationId,
    pluginId: liveStatusDeployment.pluginId,
    generation: liveStatusDeployment.generation,
    status,
    diagnostics:
      status === "failed"
        ? [
            runtimeDiagnostic({
              code: "LIFECYCLE_START_FAILED",
              message: "component failed",
              source: { kind: "deployment", id: "application-01/plugin-01" },
              observedAt: now.toISOString(),
            }),
          ]
        : [],
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function seedLiveDeployment(
  state: EmptyState,
  observation?: JsonValue,
  deployment: PluginDeployment = liveStatusDeployment,
): void {
  state.set("installations", deployment.artifactDigest, {
    pluginId: deployment.pluginId,
    digest: deployment.artifactDigest,
  });
  state.set("deployments", `${deployment.applicationId}/${deployment.pluginId}`, deployment);
  if (observation !== undefined) {
    state.set(
      "deployment-observations",
      `${deployment.applicationId}/${deployment.pluginId}`,
      observation,
    );
  }
}

test("typed deployment observation parser enforces exact canonical public fields", () => {
  const parseObservation = (
    contracts as unknown as {
      readonly parsePluginDeploymentObservation: (input: unknown) => unknown;
    }
  ).parsePluginDeploymentObservation;
  assert.equal(typeof parseObservation, "function");

  for (const status of [
    "blocked",
    "degraded",
    "disabled",
    "failed",
    "ready",
    "reconciling",
    "suspended",
  ] as const) {
    const valid = liveStatusObservation(status);
    assert.deepEqual(parseObservation(valid), valid);
  }
  for (const invalid of [
    liveStatusObservation("ready", { extra: true }),
    liveStatusObservation("ready", { generation: "01" }),
    liveStatusObservation("ready", { status: "converging" }),
    liveStatusObservation("ready", {
      diagnostics: [
        {
          ...runtimeDiagnostic({
            code: "DEPLOYMENT_BLOCKED",
            message: "blocked",
            source: { kind: "deployment" },
            observedAt: now.toISOString(),
          }),
          extra: true,
        },
      ],
    }),
    liveStatusObservation("ready", { updatedAt: "2026-07-24T08:00:00+08:00" }),
  ]) {
    assert.throws(() => parseObservation(invalid));
  }
});

test("live runtime status reads empty durable state and deploy-after-start without recreation", async () => {
  const value = fixture();
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();

  const empty = await runtime.status();
  assert.deepEqual(
    { deployments: empty.counts.deployments, installations: empty.counts.installations },
    { deployments: 0, installations: 0 },
  );
  assert.equal(empty.readiness, true);

  seedLiveDeployment(value.state);
  const reconciling = await runtime.status();
  assert.deepEqual(
    {
      deployments: reconciling.counts.deployments,
      installations: reconciling.counts.installations,
    },
    { deployments: 1, installations: 1 },
  );
  assert.equal(reconciling.readiness, false);

  value.state.set(
    "deployment-observations",
    "application-01/plugin-01",
    liveStatusObservation("ready", { generation: "0" }),
  );
  assert.equal((await runtime.status()).readiness, false);

  value.state.set("deployments", "application-01/plugin-01", {
    ...liveStatusDeployment,
    state: "disabled",
  });
  value.state.delete("deployment-observations", "application-01/plugin-01");
  assert.equal((await runtime.status()).readiness, true);
  assert.ok(value.state.transactionReadCount >= 2);
  await runtime.stop();
});

test("live runtime status follows provider degradation and recovery without recreation", async () => {
  const value = fixture();
  seedLiveDeployment(value.state, liveStatusObservation("ready"));
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();
  assert.equal((await runtime.status()).readiness, true);

  value.state.set(
    "deployment-observations",
    "application-01/plugin-01",
    liveStatusObservation("degraded"),
  );
  assert.equal((await runtime.status()).readiness, false);

  value.state.set(
    "deployment-observations",
    "application-01/plugin-01",
    liveStatusObservation("ready"),
  );
  assert.equal((await runtime.status()).readiness, true);
  await runtime.stop();
});

test("live runtime status reports essential deployment failure from durable observation", async () => {
  const value = fixture();
  seedLiveDeployment(value.state, liveStatusObservation("ready"));
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();
  assert.equal((await runtime.status()).readiness, true);

  value.state.set(
    "deployment-observations",
    "application-01/plugin-01",
    liveStatusObservation("failed"),
  );
  assert.equal((await runtime.status()).readiness, false);
  await runtime.stop();
});

test("live runtime status is identical on a follower reading shared durable state", async () => {
  const value = fixture();
  seedLiveDeployment(value.state, liveStatusObservation("ready"));
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();

  const status = await runtime.status();
  assert.equal(status.authority, undefined);
  assert.equal(status.counts.deployments, 1);
  assert.equal(status.counts.installations, 1);
  assert.equal(status.readiness, true);
  await runtime.stop();
});

test("live runtime status remains durable and live after restart-after-ready", async () => {
  const first = fixture();
  seedLiveDeployment(first.state, liveStatusObservation("ready"));
  const original = createRuntimeHost(first.configuration, first.drivers, first.services);
  await original.start();
  assert.equal((await original.status()).readiness, true);
  await original.stop();

  const restartedValue = fixture("multi-main", clock, first.state);
  const restarted = createRuntimeHost(
    restartedValue.configuration,
    restartedValue.drivers,
    restartedValue.services,
  );
  await restarted.start();
  assert.equal((await restarted.status()).readiness, true);

  first.state.set(
    "deployment-observations",
    "application-01/plugin-01",
    liveStatusObservation("suspended"),
  );
  assert.equal((await restarted.status()).readiness, false);
  await restarted.stop();
});

test("@spec:coordination-provider/fenced-leadership/follower-remains-operable", async () => {
  const value = fixture();
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);

  await runtime.start();
  const status = await runtime.status();
  assert.equal(status.lifecycle, "running");
  assert.equal(status.authority, undefined);
  assert.equal(status.acceptingOperations, false);
  assert.deepEqual(await runtime.operations.recoveredOperations(), []);
  assert.equal(value.services.reconcilerAuthorities.length, 0);
  assert.equal(status.counts.tasks, 4);
  assert.equal(status.counts.workers, 2);
  await runtime.stop();
});

test("@spec:runtime-operations/task-operations/runtime-host-uses-one-canonical-task-service", async () => {
  const value = fixture();
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();
  assert.equal(await runtime.operations.taskStatus(parseTaskId("task-missing")), undefined);
  assert.equal(value.log.includes("tasks.status"), true);
  await runtime.stop();
});

test("@spec:runtime-operations/plugin-operations/runtime-host-rejects-stale-reconciler-wake", async () => {
  let wakes = 0;
  const expected = {
    resource: "runtime:runtime-01",
    epoch: parseFencingEpoch("7"),
  };
  await assert.rejects(
    wakeReconcilerForAuthority(
      expected,
      { ...expected, epoch: parseFencingEpoch("8") },
      expected,
      {
        wake: async () => {
          wakes += 1;
        },
      },
      clock,
    ),
    (error: unknown) => diagnosticCode(error) === "COORDINATION_FENCE_REJECTED",
  );
  assert.equal(wakes, 0);
});

test("@spec:runtime-bootstrap/recovery/leadership-reacquisition", async () => {
  const value = fixture();
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();

  const first = value.coordination.acquire("7");
  await eventually(async () => assert.equal((await runtime.status()).authority?.epoch, "7"));
  assert.equal(value.services.reconcilerAuthorities.at(-1)?.epoch, "7");
  assert.equal(value.services.activeReconcilers, 1);
  assert.equal((await runtime.status()).acceptingOperations, true);

  first.lose();
  await eventually(() => assert.equal(value.services.activeReconcilers, 0));
  await eventually(() =>
    assert.equal(value.log.filter((entry) => entry === "coordination.campaign").length, 2),
  );
  value.coordination.acquire("8");
  await eventually(async () => assert.equal((await runtime.status()).authority?.epoch, "8"));
  assert.equal(value.services.reconcilerAuthorities.at(-1)?.epoch, "8");
  await runtime.stop();
});

test("leadership loss closes mutation admission before task authority and reconciliation", async () => {
  const value = fixture();
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();
  const first = value.coordination.acquire("7");
  await eventually(async () => assert.equal((await runtime.status()).authority?.epoch, "7"));

  first.lose();
  await eventually(() => assert.equal(value.services.activeReconcilers, 0));
  assert.equal(value.services.reconcilerCurrentAuthorities[0]?.(), undefined);
  assert.equal((await runtime.status()).acceptingOperations, false);
  assert.equal((await runtime.status()).authority, undefined);
  assert.notEqual(value.log.indexOf("capabilities.authority:none:7"), -1);
  assert.ok(
    value.log.indexOf("capabilities.authority:none:7") < value.log.indexOf("tasks.authority:none"),
  );
  assert.ok(value.log.indexOf("tasks.authority:none") < value.log.indexOf("reconciler.stop:7"));
  assert.ok(
    value.log.indexOf("tasks.authority:none") < value.log.indexOf("workers.authority:none"),
  );
  assert.ok(value.log.indexOf("reconciler.stop:7") < value.log.indexOf("workers.authority:none"));

  await eventually(() =>
    assert.equal(value.log.filter((entry) => entry === "coordination.campaign").length, 2),
  );
  value.coordination.acquire("8");
  await eventually(async () => assert.equal((await runtime.status()).authority?.epoch, "8"));
  assert.equal(value.services.reconcilerAuthorities.at(-1)?.epoch, "8");
  assert.equal(value.services.activeReconcilers, 1);
  assert.ok(value.log.indexOf("tasks.authority:8") < value.log.indexOf("capabilities.authority:8"));
  await runtime.stop();
});

test("stop is idempotent and retains Worker lifecycle transport until reconciliation closes", async () => {
  const value = fixture();
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();
  value.coordination.acquire("11");
  await eventually(async () => assert.equal((await runtime.status()).authority?.epoch, "11"));

  const first = runtime.stop();
  const second = runtime.stop();
  assert.equal(first, second);
  await first;

  assert.deepEqual(value.log.slice(-12), [
    "capabilities.authority:none:11",
    "tasks.authority:none",
    "reconciler.stop:11",
    "workers.authority:none",
    "coordination.release:11",
    "tasks.close",
    "workers.close",
    "secrets.close",
    "processHost.close",
    "artifacts.close",
    "coordination.close",
    "state.close",
  ]);
  assert.equal(value.log.at(-1), "state.close");
});

test("single-main start waits for authority and initial reconciliation", async () => {
  const value = fixture("single-main");
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);

  const starting = runtime.start();
  await eventually(
    () => assert.equal(value.log.filter((entry) => entry === "coordination.campaign").length, 1),
    { attempts: 100 },
  );
  let settled = false;
  void starting.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  value.coordination.acquire("1");
  await starting;
  assert.equal((await runtime.status()).authority?.epoch, "1");
  assert.equal((await runtime.status()).acceptingOperations, true);
  assert.ok(value.log.indexOf("tasks.recover") < value.log.indexOf("workers.authority:1"));
  assert.ok(value.log.indexOf("workers.authority:1") < value.log.indexOf("reconciler.start:1"));
  assert.ok(value.log.indexOf("reconciler.start:1") < value.log.indexOf("tasks.authority:1"));
  assert.ok(value.log.indexOf("tasks.authority:1") < value.log.indexOf("capabilities.authority:1"));
  await runtime.stop();
});

test("background reconciliation failure closes authority and stops the runtime", async () => {
  const value = fixture("single-main");
  value.coordination.immediateEpoch = "1";
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();

  assert.equal(value.services.reconcilerCurrentAuthorities[0]?.()?.epoch, "1");
  value.services.reconcilerBackgroundErrors[0]?.(new Error("background reconcile failed"));
  assert.equal(value.services.reconcilerCurrentAuthorities[0]?.(), undefined);
  assert.equal(
    value.log.includes("capabilities.authority:none:1"),
    true,
    "background failure must synchronously fence capability admission",
  );
  await eventually(async () => {
    const status = await runtime.status();
    assert.equal(status.lifecycle, "stopped");
    assert.equal(status.authority, undefined);
    assert.equal(status.acceptingOperations, false);
  });

  assert.equal(
    value.services.diagnostics.some(
      (diagnostic) => diagnostic.code === "LIFECYCLE_RECONCILE_BACKGROUND_FAILED",
    ),
    true,
  );
});

test("single-main stop interrupts a pending initial campaign without resurrecting", async () => {
  const value = fixture("single-main");
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);

  const starting = runtime.start();
  await eventually(
    () => assert.equal(value.log.filter((entry) => entry === "coordination.campaign").length, 1),
    { attempts: 100 },
  );
  const stopping = runtime.stop();
  await Promise.all([starting, stopping]);

  assert.equal((await runtime.status()).lifecycle, "stopped");
  assert.equal((await runtime.status()).authority, undefined);
  assert.equal(value.services.activeReconcilers, 0);
});

test("immediate leadership cannot open mutation admission before health and read operations", async () => {
  const value = fixture();
  const health = Promise.withResolvers<void>();
  value.state.healthGate = health.promise;
  value.coordination.immediateEpoch = "13";
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);

  const starting = runtime.start();
  await eventually(() => assert.equal(value.log.includes("state.health"), true));
  assert.equal(value.log.filter((entry) => entry === "coordination.campaign").length, 0);
  await assert.rejects(
    runtime.operations.recoveredOperations(),
    (error: unknown) => diagnosticCode(error) === "BOOTSTRAP_NOT_READY",
  );

  health.resolve();
  await starting;
  await eventually(() => assert.equal(value.services.activeReconcilers, 1));
  assert.equal((await runtime.status()).acceptingOperations, true);
  assert.deepEqual(await runtime.operations.recoveredOperations(), []);
  await runtime.stop();
});

test("stop retries retained reconciler cleanup, closes every service, and aggregates failures", async () => {
  const value = fixture();
  value.coordination.failRelease = true;
  value.services.reconcilerStopFailures = 1;
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();
  value.coordination.acquire("14");
  await eventually(async () => assert.equal((await runtime.status()).authority?.epoch, "14"));

  await assert.rejects(
    runtime.stop(),
    (error: unknown) => diagnosticCode(error) === "BOOTSTRAP_STOP_FAILED",
  );

  assert.equal(value.services.activeReconcilers, 0);
  assert.equal((await runtime.status()).lifecycle, "failed");
  assert.equal((await runtime.status()).acceptingOperations, false);
  const reconcilerStops = value.log
    .map((entry, index) => (entry === "reconciler.stop:14" ? index : -1))
    .filter((index) => index !== -1);
  assert.equal(reconcilerStops.length, 2);
  assert.ok(value.log.indexOf("workers.authority:none") > (reconcilerStops[1] ?? -1));
  for (const entry of [
    "coordination.release:14",
    "tasks.close",
    "workers.close",
    "secrets.close",
    "processHost.close",
    "artifacts.close",
    "coordination.close",
    "state.close",
  ]) {
    assert.equal(value.log.includes(entry), true, `missing cleanup entry ${entry}`);
  }
  assert.equal(
    value.services.diagnostics.some(
      (diagnostic) => diagnostic.code === "COORDINATION_LEADERSHIP_CALLBACK_FAILED",
    ),
    true,
  );
});

test("permanent reconciler stop failure reports failed lifecycle without clean-stop claims", async () => {
  const value = fixture();
  value.services.reconcilerStopFailures = 2;
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();
  value.coordination.acquire("16");
  await eventually(async () => assert.equal((await runtime.status()).authority?.epoch, "16"));

  await assert.rejects(
    runtime.stop(),
    (error: unknown) => diagnosticCode(error) === "BOOTSTRAP_STOP_FAILED",
  );

  const status = await runtime.status();
  assert.equal(status.lifecycle, "failed");
  assert.equal(status.acceptingOperations, false);
  assert.equal(status.authority, undefined);
  assert.equal(value.services.activeReconcilers, 1);
  assert.equal(value.log.filter((entry) => entry === "reconciler.stop:16").length, 2);
  for (const entry of ["tasks.close", "workers.close", "coordination.close", "state.close"]) {
    assert.equal(value.log.includes(entry), true, `missing cleanup entry ${entry}`);
  }
});

test("multi-main activation failure preserves the diagnostic receiver and backs off", async () => {
  const runtimeClock = new FakeClock(now);
  const value = fixture("multi-main", runtimeClock);
  value.services.reconcilerStartFailures = 1;
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();
  value.coordination.acquire("15");

  await eventually(() =>
    assert.equal(
      value.services.diagnostics.some(
        (diagnostic) => diagnostic.code === "COORDINATION_LEADERSHIP_CALLBACK_FAILED",
      ),
      true,
    ),
  );
  await Promise.resolve();
  assert.equal(value.log.filter((entry) => entry === "coordination.campaign").length, 1);
  assert.ok(value.log.indexOf("workers.authority:15") < value.log.indexOf("reconciler.start:15"));
  assert.ok(value.log.indexOf("reconciler.start:15") < value.log.indexOf("workers.authority:none"));
  await runtime.stop();
});

test("task authority activation failure rolls back workers before stopping reconciliation", async () => {
  const runtimeClock = new FakeClock(now);
  const value = fixture("multi-main", runtimeClock);
  value.services.tasks.authorityFailures = 1;
  const runtime = createRuntimeHost(value.configuration, value.drivers, value.services);
  await runtime.start();
  value.coordination.acquire("17");

  await eventually(() =>
    assert.equal(
      value.services.diagnostics.some(
        (diagnostic) => diagnostic.code === "COORDINATION_LEADERSHIP_CALLBACK_FAILED",
      ),
      true,
    ),
  );
  await eventually(() => assert.equal(value.services.activeReconcilers, 0));
  assert.ok(value.log.indexOf("workers.authority:17") < value.log.indexOf("reconciler.start:17"));
  assert.ok(value.log.indexOf("reconciler.start:17") < value.log.indexOf("tasks.authority:17"));
  assert.ok(
    value.log.indexOf("tasks.authority:none") < value.log.indexOf("workers.authority:none"),
  );
  assert.ok(value.log.indexOf("reconciler.stop:17") < value.log.indexOf("workers.authority:none"));
  await runtime.stop();
});
