import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ArtifactDigest,
  type Clock,
  compareOperationJournalCursors,
  DiagnosticError,
  type DriverHealth,
  type ExecutorKind,
  type FencingEpoch,
  type JsonValue,
  type OperationJournalQuery,
  type OutboxAcknowledgement,
  type OutboxAcknowledgementRequest,
  type OutboxClaim,
  type OutboxClaimRequest,
  type OutboxMessage,
  type PersistedOperationJournalEntry,
  type PluginDeployment,
  type PluginInstallation,
  type PluginManifest,
  parseApplicationId,
  parseArtifactDigest,
  parseCapabilityName,
  parseComponentId,
  parseFencingEpoch,
  parseGeneration,
  parseMessageId,
  parseOperationId,
  parsePluginId,
  parseRevision,
  type Revision,
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
  type ArtifactDeploymentGate,
  type ComponentEffectExecutor,
  type ComponentInstance,
  deterministicRetryDelay,
  type PlacementWorker,
  planReconcile,
  type ReconcileEffect,
  type ReconcileEffectKind,
  type ReconcilePlanStep,
  Reconciler,
  type ReconcileSnapshot,
} from "../src/index.js";
import {
  legacyReconcileEffectIdentities,
  legacyReconcileInstanceId,
  reconcileEffectIdentities,
} from "../src/reconcile/plan.js";
import { inferComponentHasStarted } from "../src/reconcile/reconciler.js";

const applicationId = parseApplicationId("app");
const pluginId = parsePluginId("org.example.echo");
const componentId = parseComponentId("echo-service");
const digestOne = parseArtifactDigest(`sha256:${"1".repeat(64)}`);
const digestTwo = parseArtifactDigest(`sha256:${"2".repeat(64)}`);

function capabilityProvision(
  name: ReturnType<typeof parseCapabilityName>,
  protocolVersion: string,
) {
  return {
    name,
    protocolVersion,
    componentId,
    methods: ["invoke"],
    requestSchema: true,
    responseSchema: true,
  } as const;
}

class ManualClock implements Clock {
  #now = Date.parse("2026-07-23T00:00:00.000Z");

  now(): Date {
    return new Date(this.#now);
  }

  sleep(): Promise<void> {
    return Promise.resolve();
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}

class ScheduledClock implements Clock {
  #now = Date.parse("2026-07-23T00:00:00.000Z");
  readonly #sleepers = new Set<{
    readonly dueAt: number;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
  }>();

  now(): Date {
    return new Date(this.#now);
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (milliseconds <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let sleeper!: {
        readonly dueAt: number;
        readonly resolve: () => void;
        readonly reject: (error: unknown) => void;
        readonly signal?: AbortSignal;
        readonly onAbort?: () => void;
      };
      sleeper = {
        dueAt: this.#now + milliseconds,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(signal === undefined
          ? {}
          : {
              onAbort: () => {
                this.#sleepers.delete(sleeper);
                reject(signal.reason);
              },
            }),
      };
      this.#sleepers.add(sleeper);
      if (sleeper.onAbort !== undefined) {
        signal?.addEventListener("abort", sleeper.onAbort, { once: true });
      }
    });
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (const sleeper of [...this.#sleepers]) {
      if (sleeper.dueAt > this.#now) continue;
      this.#sleepers.delete(sleeper);
      if (sleeper.onAbort !== undefined) {
        sleeper.signal?.removeEventListener("abort", sleeper.onAbort);
      }
      sleeper.resolve();
    }
  }
}

class RejectingSleepClock extends ManualClock {
  override sleep(): Promise<void> {
    return Promise.reject(new Error("scheduler unavailable"));
  }
}

function manifest(
  version: string,
  digest: ArtifactDigest,
  executors: readonly ExecutorKind[] = ["process"],
): PluginManifest {
  void digest;
  return {
    schemaVersion: "1.0",
    pluginId,
    version,
    contractRange: ">=0.0.0",
    nodeRange: ">=26.0.0",
    moduleFormat: "esm",
    components: [
      {
        componentId,
        kind: "service",
        entrypoint: "components/echo.js",
        executors,
      },
    ],
    permissions: [{ kind: "executor", executors: [...executors] }],
    capabilities: { provides: [], requires: [] },
  };
}

function installation(version = "1.0.0", digest: ArtifactDigest = digestOne): PluginInstallation {
  return {
    pluginId,
    version,
    digest,
    manifest: manifest(version, digest),
    installedAt: "2026-07-23T00:00:00.000Z",
  };
}

function deployment(generation = "1", options: Partial<PluginDeployment> = {}): PluginDeployment {
  return {
    applicationId,
    pluginId,
    version: "1.0.0",
    artifactDigest: digestOne,
    generation: parseGeneration(generation),
    state: "active",
    essential: false,
    configuration: {},
    permissionGrants: [{ kind: "executor", executors: ["process"] }],
    capabilityBindings: {},
    ...options,
  };
}

function gate(value: PluginInstallation = installation()): ArtifactDeploymentGate {
  return {
    artifact: {
      digest: value.digest,
      files: {
        schemaVersion: "1.0",
        files: [
          {
            path: "components/echo.js",
            sha256: value.digest,
            size: 1,
          },
        ],
      },
      manifest: value.manifest,
    },
    capabilityResolution: {
      ok: true,
      diagnostics: [],
      providerLossActions: [],
      bindings: [],
      order: [{ applicationId, pluginId }],
    },
    permissionDecision: {
      allowed: true,
      diagnostics: [],
      granted: value.manifest.permissions,
      requested: value.manifest.permissions,
    },
  };
}

function snapshot(
  desired: PluginDeployment = deployment(),
  instances: readonly ComponentInstance[] = [],
  installed: PluginInstallation = installation(),
): ReconcileSnapshot {
  return {
    deployment: desired,
    gate: gate(installed),
    instances,
    now: "2026-07-23T00:00:00.000Z",
    supportedExecutors: ["process", "thread"],
  };
}

test("planReconcile creates stable one-effect steps and duplicate reconciliation converges", () => {
  const first = planReconcile(snapshot());
  const replay = planReconcile(snapshot());
  assert.deepEqual(replay, first);
  assert.deepEqual(
    first.steps.map((step: ReconcilePlanStep) => ({
      effect: step.effect.kind,
      generation: step.deploymentGeneration,
      instanceId: step.instanceId,
      messageId: step.messageId,
      operationId: step.operationId,
    })),
    [
      {
        effect: "prepare",
        generation: "1",
        instanceId: "app.org_dexample_decho.echo-service.g1.a1",
        messageId: "reconcile.app.org_dexample_decho.echo-service.g1.a1.prepare",
        operationId: "reconcile.app.org_dexample_decho.echo-service.g1.a1.prepare",
      },
    ],
  );
  assert.equal(
    first.steps.every((step: ReconcilePlanStep) => Object.keys(step.effect).length > 0),
    true,
  );

  const ready: ComponentInstance = {
    activation: "1",
    applicationId,
    componentId,
    deploymentGeneration: parseGeneration("1"),
    executor: "process",
    instanceId: "app.org.example.echo.echo-service.g1",
    lifecycle: "ready",
    observedGeneration: parseGeneration("1"),
    pluginId,
    revision: parseRevision("1"),
  };
  assert.deepEqual(planReconcile(snapshot(deployment(), [ready])).steps, []);
});

test("activation identity distinguishes same-generation component incarnations", () => {
  const identities = reconcileEffectIdentities as (
    desired: Pick<PluginDeployment, "applicationId" | "generation" | "pluginId">,
    targetComponentId: ComponentInstance["componentId"],
    kind: ReconcileEffectKind,
    activation?: string,
  ) => {
    readonly instanceId: string;
    readonly operationId: string;
    readonly messageId: string;
  };
  const activationOne = identities(deployment("7"), componentId, "prepare", "1");
  const activationTwo = identities(deployment("7"), componentId, "prepare", "2");

  assert.match(activationOne.instanceId, /\.g7\.a1$/);
  assert.match(activationOne.operationId, /\.g7\.a1\.prepare$/);
  assert.match(activationOne.messageId, /\.g7\.a1\.prepare$/);
  assert.match(activationTwo.instanceId, /\.g7\.a2$/);
  assert.notEqual(activationTwo.instanceId, activationOne.instanceId);
  assert.notEqual(activationTwo.operationId, activationOne.operationId);
  assert.notEqual(activationTwo.messageId, activationOne.messageId);
  assert.throws(() => identities(deployment("7"), componentId, "prepare", "01"), /activation/iu);
  assert.throws(
    () => identities(deployment("7"), componentId, "prepare", "18446744073709551616"),
    /activation/iu,
  );
});

test("legacy current instances keep legacy identities through prepare, start, and failed retry", () => {
  const legacyInstanceId = legacyReconcileInstanceId(deployment("7"), componentId);
  const base: ComponentInstance = {
    activation: "1",
    legacyActivation: true,
    applicationId,
    componentId,
    deploymentGeneration: parseGeneration("7"),
    executor: "process",
    instanceId: legacyInstanceId,
    lifecycle: "created",
    observedGeneration: parseGeneration("7"),
    pluginId,
    revision: parseRevision("1"),
    artifactDigest: digestOne,
  };
  const expected = (kind: ReconcileEffectKind) =>
    legacyReconcileEffectIdentities(deployment("7"), componentId, kind);

  for (const [instance, kind] of [
    [base, "prepare"],
    [{ ...base, lifecycle: "preparing" }, "start"],
    [{ ...base, lifecycle: "failed", retryEffect: "prepare" }, "prepare"],
  ] as const) {
    const planned = planReconcile(snapshot(deployment("7"), [instance])).steps[0];
    assert.ok(planned);
    assert.equal(planned.instanceId, expected(kind).instanceId);
    assert.equal(planned.operationId, expected(kind).operationId);
    assert.equal(planned.messageId, expected(kind).messageId);
    assert.equal(planned.legacyActivation, true);
  }
});

test("plans enable, disable, upgrade, drain, and rollback without combining external effects", () => {
  const oldReady: ComponentInstance = {
    activation: "1",
    applicationId,
    componentId,
    deploymentGeneration: parseGeneration("1"),
    executor: "process",
    instanceId: "app.org.example.echo.echo-service.g1",
    lifecycle: "ready",
    observedGeneration: parseGeneration("1"),
    pluginId,
    revision: parseRevision("2"),
  };
  const disabled = planReconcile(snapshot(deployment("2", { state: "disabled" }), [oldReady]));
  assert.deepEqual(
    disabled.steps.map((step: ReconcilePlanStep) => step.effect.kind),
    ["drain"],
  );

  const upgradedInstallation = installation("2.0.0", digestTwo);
  const upgraded = planReconcile(
    snapshot(
      deployment("2", {
        artifactDigest: digestTwo,
        version: "2.0.0",
      }),
      [oldReady],
      upgradedInstallation,
    ),
  );
  assert.deepEqual(
    upgraded.steps.map((step: ReconcilePlanStep) => step.effect.kind),
    ["drain", "prepare"],
  );
  assert.equal(new Set(upgraded.steps.map((step: ReconcilePlanStep) => step.operationId)).size, 2);

  const rollback = planReconcile(
    snapshot(deployment("3"), [
      {
        ...oldReady,
        deploymentGeneration: parseGeneration("2"),
        instanceId: "app.org.example.echo.echo-service.g2",
        observedGeneration: parseGeneration("2"),
      },
    ]),
  );
  assert.deepEqual(
    rollback.steps.map((step: ReconcilePlanStep) => step.effect.kind),
    ["drain", "prepare"],
  );
  assert.equal(rollback.steps.at(-1)?.deploymentGeneration, "3");
});

test("duplicate live instances for one component generation are inconsistent and never execute", () => {
  const first: ComponentInstance = {
    activation: "1",
    applicationId,
    componentId,
    deploymentGeneration: parseGeneration("1"),
    executor: "process",
    instanceId: "app.org.example.echo.echo-service.g1",
    lifecycle: "ready",
    observedGeneration: parseGeneration("1"),
    pluginId,
    revision: parseRevision("1"),
  };
  const result = planReconcile(
    snapshot(deployment(), [
      first,
      {
        ...first,
        instanceId: "app.org.example.echo.echo-service.g1-duplicate",
        revision: parseRevision("2"),
      },
    ]),
  );

  assert.equal(result.blocked, true);
  assert.deepEqual(result.steps, []);
  assert.equal(result.diagnostics[0]?.code, "DEPLOYMENT_INSTANCE_INCONSISTENT");
});

test("instances belonging to another application never satisfy or drain this deployment", () => {
  const foreign: ComponentInstance = {
    activation: "1",
    applicationId: parseApplicationId("other-app"),
    componentId,
    deploymentGeneration: parseGeneration("1"),
    executor: "process",
    instanceId: "other-app.org.example.echo.echo-service.g1",
    lifecycle: "ready",
    observedGeneration: parseGeneration("1"),
    pluginId,
    revision: parseRevision("1"),
  };

  const result = planReconcile(snapshot(deployment(), [foreign]));
  assert.deepEqual(
    result.steps.map((step) => step.effect.kind),
    ["prepare"],
  );
});

test("one unavailable component placement blocks every step for the deployment", () => {
  const value = installation();
  const result = planReconcile({
    ...snapshot(),
    gate: {
      ...gate(value),
      artifact: {
        ...gate(value).artifact,
        manifest: {
          ...value.manifest,
          components: [
            ...(value.manifest.components ?? []),
            {
              componentId: parseComponentId("remote-only"),
              kind: "service",
              entrypoint: "components/remote.js",
              executors: ["remote"],
            },
          ],
        },
      },
    },
  });

  assert.equal(result.blocked, true);
  assert.deepEqual(result.steps, []);
  assert.equal(result.diagnostics[0]?.code, "DEPLOYMENT_EXECUTOR_UNAVAILABLE");
});

test("remote placement requires the target artifact and a compatible Worker-local executor", () => {
  const remoteInstallation = {
    ...installation(),
    manifest: {
      ...manifest("1.0.0", digestOne, ["remote", "thread"]),
      permissions: [
        { kind: "executor" as const, executors: ["remote" as const] },
        {
          kind: "worker" as const,
          labels: {},
          resources: { cpuMillis: 1_000, memoryBytes: 1_024, storageBytes: 1_024 },
        },
      ],
    },
  };
  const base = {
    ...snapshot(deployment(), [], remoteInstallation),
    supportedExecutors: ["remote" as const],
  };
  const worker = {
    workerId: "worker-placement",
    labels: {},
    resources: { cpuMillis: 1_000, memoryBytes: 1_024, storageBytes: 1_024 },
  };

  for (const unavailable of [
    worker,
    {
      ...worker,
      executors: ["thread" as const],
    },
    {
      ...worker,
      preparedArtifacts: [digestOne],
    },
    {
      ...worker,
      executors: ["thread" as const],
      preparedArtifacts: [digestTwo],
    },
    {
      ...worker,
      executors: ["process" as const],
      preparedArtifacts: [digestOne],
    },
  ]) {
    const result = planReconcile({
      ...base,
      workers: [unavailable as PlacementWorker],
    });
    assert.equal(result.blocked, true);
    assert.deepEqual(result.steps, []);
    assert.equal(result.diagnostics[0]?.code, "DEPLOYMENT_EXECUTOR_UNAVAILABLE");
  }

  const available = planReconcile({
    ...base,
    workers: [
      {
        ...worker,
        executors: ["thread"],
        preparedArtifacts: [digestOne],
      },
    ],
  });
  assert.equal(available.blocked, false);
  assert.equal(available.steps[0]?.effect.executor, "remote");
  assert.equal(available.steps[0]?.effect.workerId, worker.workerId);
});

test("stable instance identities cannot collide when identity segments contain dots", () => {
  function customSnapshot(app: string, plugin: string): ReconcileSnapshot {
    const customDeployment = {
      ...deployment(),
      applicationId: parseApplicationId(app),
      pluginId: parsePluginId(plugin),
    };
    const customManifest = {
      ...manifest("1.0.0", digestOne),
      pluginId: customDeployment.pluginId,
    };
    return {
      ...snapshot(customDeployment),
      gate: {
        ...gate(),
        artifact: {
          ...gate().artifact,
          manifest: customManifest,
        },
        capabilityResolution: {
          ok: true,
          diagnostics: [],
          providerLossActions: [],
          bindings: [],
          order: [
            {
              applicationId: customDeployment.applicationId,
              pluginId: customDeployment.pluginId,
            },
          ],
        },
      },
    };
  }

  const left = planReconcile(customSnapshot("a.b", "c")).steps[0];
  const right = planReconcile(customSnapshot("a", "b.c")).steps[0];
  assert.ok(left);
  assert.ok(right);
  assert.notEqual(left.instanceId, right.instanceId);
  assert.notEqual(left.operationId, right.operationId);
});

test("retry delay is capped exponential backoff with deterministic operation jitter", () => {
  const operationId = parseOperationId("reconcile.app.echo.g1.start");
  const delays = [1, 2, 3, 20].map((attempt) =>
    deterministicRetryDelay({
      attempt,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      operationId,
    }),
  );
  assert.equal(delays.length, 4);
  const [firstDelay = 0, secondDelay = 0, thirdDelay = 0, cappedDelay = 0] = delays;
  assert.equal(firstDelay >= 100 && firstDelay < 125, true);
  assert.equal(secondDelay >= 200 && secondDelay < 250, true);
  assert.equal(thirdDelay >= 400 && thirdDelay < 500, true);
  assert.equal(cappedDelay, 1_000);
  assert.deepEqual(
    delays,
    [1, 2, 3, 20].map((attempt) =>
      deterministicRetryDelay({
        attempt,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        operationId,
      }),
    ),
  );
});

interface TestRecord {
  readonly key: StateKey<JsonValue>;
  readonly value: JsonValue;
  readonly revision: Revision;
}

function stateIdentifier(key: StateKey<JsonValue>): string {
  return `${key.namespace}\0${key.collection}\0${key.id}`;
}

class TestStateStore implements StateStore {
  readonly scope = "local" as const;
  readonly records = new Map<string, TestRecord>();
  readonly observationStatuses: Array<{ readonly id: string; readonly status: string }> = [];
  readonly operations = new Map<string, PersistedOperationJournalEntry>();
  readonly outbox = new Map<
    string,
    {
      acknowledgement?: OutboxAcknowledgement;
      attempt: number;
      claim?: OutboxClaim;
      message: OutboxMessage;
    }
  >();
  revision = 0n;
  failNextObservedCommit = false;
  failNextObservedCommitKind: ReconcileEffectKind | undefined;
  observedCommitConflicts = 0;
  failNextFailureCommit = false;
  failNextExecutionPreStateCommit = false;
  failNextAcknowledgement = false;
  failNextProviderLossScan = false;
  beforeNextCapabilityBindingScan: (() => Promise<void>) | undefined;
  beforeProviderLossScan:
    | {
        remaining: number;
        readonly run: () => Promise<void>;
      }
    | undefined;
  beforeNextProviderLossCommit: (() => Promise<void>) | undefined;
  afterNextExecutingCommit: ((effect: ReconcileEffect) => Promise<void>) | undefined;
  capabilityBindingRaceWinner:
    | {
        readonly key: StateKey<JsonValue>;
        readonly beforeCommit?: () => Promise<void>;
        readonly value: JsonValue;
      }
    | undefined;
  readonly #clock: Clock;
  #open = false;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async open(): Promise<void> {
    this.#open = true;
  }

  async transact<T extends JsonValue>(
    options: StateTransactionOptions,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    assert.equal(this.#open, true);
    const puts: Array<{
      key: StateKey<JsonValue>;
      value: JsonValue;
      expectedRevision?: Revision | "absent";
    }> = [];
    const operations: Array<Omit<PersistedOperationJournalEntry, "revision">> = [];
    const messages: OutboxMessage[] = [];
    const deletes: Array<{
      key: StateKey<JsonValue>;
      expectedRevision?: Revision | "absent";
    }> = [];
    const transaction: StateTransaction = {
      get: async <Value extends JsonValue>(key: StateKey<Value>) => {
        const record = this.records.get(stateIdentifier(key));
        return record === undefined
          ? undefined
          : ({
              value: structuredClone(record.value) as Value,
              revision: record.revision,
            } satisfies Versioned<Value>);
      },
      scan: <Value extends JsonValue>(query: StateQuery<Value>) => this.scan(query),
      put: async <Value extends JsonValue>(
        key: StateKey<Value>,
        value: Value,
        writeOptions: { readonly expectedRevision?: Revision | "absent" },
      ) => {
        puts.push({
          key: key as StateKey<JsonValue>,
          value: structuredClone(value),
          ...(writeOptions.expectedRevision === undefined
            ? {}
            : { expectedRevision: writeOptions.expectedRevision }),
        });
      },
      delete: async <Value extends JsonValue>(
        key: StateKey<Value>,
        writeOptions: { readonly expectedRevision?: Revision | "absent" },
      ) => {
        deletes.push({
          key: key as StateKey<JsonValue>,
          ...(writeOptions.expectedRevision === undefined
            ? {}
            : { expectedRevision: writeOptions.expectedRevision }),
        });
      },
      appendOperation: async (entry) => {
        operations.push(structuredClone(entry));
      },
      enqueueOutbox: async (message) => {
        messages.push(structuredClone(message));
      },
    };
    const result = await work(transaction);
    if (
      this.beforeNextProviderLossCommit !== undefined &&
      [...puts, ...deletes].some((mutation) => mutation.key.collection === "provider-loss")
    ) {
      const beforeCommit = this.beforeNextProviderLossCommit;
      this.beforeNextProviderLossCommit = undefined;
      await beforeCommit();
    }
    if (
      this.capabilityBindingRaceWinner !== undefined &&
      puts.some((put) => put.key.collection === "capability-bindings")
    ) {
      const winner = this.capabilityBindingRaceWinner;
      this.capabilityBindingRaceWinner = undefined;
      await winner.beforeCommit?.();
      this.revision += 1n;
      this.records.set(stateIdentifier(winner.key), {
        key: structuredClone(winner.key),
        value: structuredClone(winner.value),
        revision: parseRevision(this.revision.toString()),
      });
    }
    if (
      (this.failNextObservedCommit || this.observedCommitConflicts > 0) &&
      puts.some((put) => put.key.collection === "component-instances") &&
      operations.some(
        (operation) =>
          operation.status === "completed" &&
          (this.failNextObservedCommitKind === undefined ||
            (
              operation.state as {
                readonly effect?: { readonly kind?: ReconcileEffectKind };
              }
            ).effect?.kind === this.failNextObservedCommitKind),
      )
    ) {
      this.failNextObservedCommit = false;
      this.failNextObservedCommitKind = undefined;
      this.observedCommitConflicts = Math.max(0, this.observedCommitConflicts - 1);
      const error = new Error("state revision conflict") as Error & {
        diagnostic?: { code: string };
      };
      error.diagnostic = { code: "STATE_REVISION_CONFLICT" };
      throw error;
    }
    if (
      this.failNextFailureCommit &&
      puts.some((put) => put.key.collection === "component-instances") &&
      operations.some((operation) => operation.status === "failed")
    ) {
      this.failNextFailureCommit = false;
      const error = new Error("state revision conflict") as Error & {
        diagnostic?: { code: string };
      };
      error.diagnostic = { code: "STATE_REVISION_CONFLICT" };
      throw error;
    }
    if (
      this.failNextExecutionPreStateCommit &&
      puts.some((put) => put.key.collection === "component-instances") &&
      operations.some((operation) => operation.status === "executing")
    ) {
      this.failNextExecutionPreStateCommit = false;
      const error = new Error("state revision conflict") as Error & {
        diagnostic?: { code: string };
      };
      error.diagnostic = { code: "STATE_REVISION_CONFLICT" };
      throw error;
    }
    for (const put of puts) {
      const current = this.records.get(stateIdentifier(put.key));
      if (
        (put.expectedRevision === "absent" && current !== undefined) ||
        (put.expectedRevision !== undefined &&
          put.expectedRevision !== "absent" &&
          current?.revision !== put.expectedRevision)
      ) {
        const error = new Error("state revision conflict") as Error & {
          diagnostic?: { code: string };
        };
        error.diagnostic = { code: "STATE_REVISION_CONFLICT" };
        throw error;
      }
    }
    for (const deleted of deletes) {
      const current = this.records.get(stateIdentifier(deleted.key));
      if (
        (deleted.expectedRevision === "absent" && current !== undefined) ||
        (deleted.expectedRevision !== undefined &&
          deleted.expectedRevision !== "absent" &&
          current?.revision !== deleted.expectedRevision)
      ) {
        const error = new Error("state revision conflict") as Error & {
          diagnostic?: { code: string };
        };
        error.diagnostic = { code: "STATE_REVISION_CONFLICT" };
        throw error;
      }
    }
    if (puts.length > 0 || deletes.length > 0 || operations.length > 0 || messages.length > 0) {
      this.revision += 1n;
    }
    const revision = parseRevision(this.revision.toString());
    for (const put of puts) {
      this.records.set(stateIdentifier(put.key), {
        key: structuredClone(put.key),
        value: structuredClone(put.value),
        revision,
      });
      if (put.key.collection === "deployment-observations") {
        const status = (put.value as { readonly status?: string }).status;
        if (status !== undefined) this.observationStatuses.push({ id: put.key.id, status });
      }
    }
    for (const deleted of deletes) {
      this.records.delete(stateIdentifier(deleted.key));
    }
    for (const operation of operations) {
      this.operations.set(operation.operationId, { ...operation, revision });
    }
    for (const message of messages) {
      const existing = this.outbox.get(message.messageId);
      if (existing === undefined || existing.acknowledgement?.outcome === "retry") {
        this.outbox.set(message.messageId, { attempt: 0, message });
      }
    }
    const executing = operations.find((operation) => operation.status === "executing")?.state as
      | ReconcileEffect
      | undefined;
    if (executing !== undefined && this.afterNextExecutingCommit !== undefined) {
      const afterCommit = this.afterNextExecutingCommit;
      this.afterNextExecutingCommit = undefined;
      await afterCommit(executing);
    }
    void options;
    return structuredClone(result);
  }

  async read<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined> {
    const record = this.records.get(stateIdentifier(key));
    return record === undefined
      ? undefined
      : {
          value: structuredClone(record.value) as T,
          revision: record.revision,
        };
  }

  async *scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
    if (query.collection === "provider-loss" && this.failNextProviderLossScan) {
      this.failNextProviderLossScan = false;
      throw new Error("provider loss scan unavailable");
    }
    if (
      query.collection === "provider-loss" &&
      this.beforeProviderLossScan !== undefined &&
      --this.beforeProviderLossScan.remaining === 0
    ) {
      const hook = this.beforeProviderLossScan;
      this.beforeProviderLossScan = undefined;
      await hook.run();
    }
    if (
      query.collection === "capability-bindings" &&
      this.beforeNextCapabilityBindingScan !== undefined
    ) {
      const beforeScan = this.beforeNextCapabilityBindingScan;
      this.beforeNextCapabilityBindingScan = undefined;
      await beforeScan();
    }
    for (const record of [...this.records.values()].sort((left, right) =>
      left.key.id < right.key.id ? -1 : left.key.id > right.key.id ? 1 : 0,
    )) {
      if (
        record.key.namespace === query.namespace &&
        record.key.collection === query.collection &&
        (query.idPrefix === undefined || record.key.id.startsWith(query.idPrefix))
      ) {
        yield {
          key: structuredClone(record.key) as StateKey<T>,
          value: structuredClone(record.value) as T,
          revision: record.revision,
        };
      }
    }
  }

  async *scanRecoverableOperations(
    query: OperationJournalQuery = {},
  ): AsyncIterable<PersistedOperationJournalEntry> {
    const entries = [...this.operations.values()]
      .filter((entry) => entry.status === "executing" || entry.status === "planned")
      .slice(0, query.limit);
    for (const entry of entries) yield structuredClone(entry);
  }

  async *scanOperations(
    query: OperationJournalQuery = {},
  ): AsyncIterable<PersistedOperationJournalEntry> {
    const entries = [...this.operations.values()]
      .sort(compareOperationJournalCursors)
      .filter(
        (entry) =>
          query.after === undefined || compareOperationJournalCursors(entry, query.after) > 0,
      )
      .slice(0, query.limit);
    for (const entry of entries) yield structuredClone(entry);
  }

  scanOperationHistory(
    query: OperationJournalQuery = {},
  ): AsyncIterable<PersistedOperationJournalEntry> {
    return this.scanOperations(query);
  }

  async claimOutbox(request: OutboxClaimRequest): Promise<readonly OutboxClaim[]> {
    const claimedAt = this.#clock.now().toISOString();
    const now = this.#clock.now().getTime();
    const claimed: OutboxClaim[] = [];
    for (const record of [...this.outbox.values()].sort((left, right) =>
      left.message.availableAt < right.message.availableAt
        ? -1
        : left.message.availableAt > right.message.availableAt
          ? 1
          : 0,
    )) {
      if (
        record.acknowledgement?.outcome === "completed" ||
        (request.topic !== undefined && record.message.topic !== request.topic) ||
        Date.parse(record.message.availableAt) > now ||
        (record.claim !== undefined && Date.parse(record.claim.expiresAt) > now)
      ) {
        continue;
      }
      const attempt = record.attempt + 1;
      const claim: OutboxClaim = {
        attempt,
        claimedAt,
        claimEpoch: parseFencingEpoch(attempt.toString()),
        expiresAt: new Date(now + request.leaseDurationMs).toISOString(),
        message: structuredClone(record.message),
        owner: request.owner,
      };
      record.attempt = attempt;
      record.claim = claim;
      delete record.acknowledgement;
      claimed.push(structuredClone(claim));
      if (claimed.length === (request.limit ?? 1)) break;
    }
    return claimed;
  }

  async acknowledgeOutbox(request: OutboxAcknowledgementRequest): Promise<OutboxAcknowledgement> {
    if (this.failNextAcknowledgement) {
      this.failNextAcknowledgement = false;
      throw new Error("acknowledgement unavailable");
    }
    const record = this.outbox.get(request.messageId);
    assert.ok(record?.claim);
    if (record.acknowledgement !== undefined) {
      return { ...structuredClone(record.acknowledgement), duplicate: true };
    }
    assert.equal(record.claim.owner, request.owner);
    assert.equal(record.claim.claimEpoch, request.claimEpoch);
    const acknowledgement: OutboxAcknowledgement = {
      acknowledgedAt: this.#clock.now().toISOString(),
      attempt: record.claim.attempt,
      duplicate: false,
      messageId: request.messageId,
      outcome: request.outcome,
      ...(request.retryAt === undefined ? {} : { retryAt: request.retryAt }),
    };
    record.acknowledgement = acknowledgement;
    if (request.outcome === "retry") {
      record.message = {
        ...record.message,
        availableAt: request.retryAt ?? this.#clock.now().toISOString(),
      };
      delete record.claim;
    }
    return structuredClone(acknowledgement);
  }

  watch(_cursor: Revision): AsyncIterable<StateChange> {
    return {
      async *[Symbol.asyncIterator]() {},
    };
  }

  async health(): Promise<DriverHealth> {
    return {
      checkedAt: "2026-07-23T00:00:00.000Z",
      status: "healthy",
    };
  }

  async close(): Promise<void> {
    this.#open = false;
  }
}

async function createHarnessStore(clock: Clock): Promise<TestStateStore> {
  const store = new TestStateStore(clock);
  await store.open();
  return store;
}

class RecordingEffects implements ComponentEffectExecutor {
  supportedExecutors: readonly ExecutorKind[] = ["process"];
  readonly performed: ReconcileEffect[] = [];
  readonly uniqueOperations = new Set<string>();
  readonly calls: ReconcileEffect[] = [];
  readonly restored: ComponentInstance[] = [];
  readonly live = new Set<string>();
  failStart = false;
  failStop = false;

  async perform(effect: ReconcileEffect): Promise<void> {
    this.calls.push(effect);
    if (this.uniqueOperations.has(effect.operationId)) return;
    this.uniqueOperations.add(effect.operationId);
    this.performed.push(effect);
    if (effect.kind === "start" && this.failStart) {
      throw new Error("component start failed");
    }
    if (effect.kind === "stop" && this.failStop) {
      throw new Error("component stop failed");
    }
    if (effect.kind === "start") this.live.add(effect.instanceId);
    if (effect.kind === "stop") this.live.delete(effect.instanceId);
  }

  async restore(instance: ComponentInstance): Promise<void> {
    this.restored.push(instance);
    this.live.add(instance.instanceId);
  }

  isLive(instance: ComponentInstance): boolean {
    return this.live.has(instance.instanceId);
  }

  async close(): Promise<void> {
    this.live.clear();
  }
}

class GatedRecordingEffects extends RecordingEffects {
  readonly #gates = new Map<
    string,
    {
      readonly entered: PromiseWithResolvers<ReconcileEffect>;
      readonly release: PromiseWithResolvers<void>;
    }
  >();

  gateNext(plugin: string, kind: ReconcileEffectKind) {
    const gate = {
      entered: Promise.withResolvers<ReconcileEffect>(),
      release: Promise.withResolvers<void>(),
    };
    this.#gates.set(`${plugin}/${kind}`, gate);
    return gate;
  }

  override async perform(effect: ReconcileEffect): Promise<void> {
    const gate = this.#gates.get(`${effect.pluginId}/${effect.kind}`);
    if (gate !== undefined) {
      this.#gates.delete(`${effect.pluginId}/${effect.kind}`);
      gate.entered.resolve(effect);
      await gate.release.promise;
    }
    await super.perform(effect);
  }
}

test("legacy activation defaults to one without changing its persisted generation", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const legacyInstanceId = "app.org_dexample_decho.echo-service.g7";
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: legacyInstanceId,
      },
      {
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: parseGeneration("7"),
        executor: "process",
        instanceId: legacyInstanceId,
        lifecycle: "ready",
        observedGeneration: parseGeneration("7"),
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const effects = new RecordingEffects();
  let desired = deployment("7");
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [desired],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.equal(
    (effects.restored[0] as (ComponentInstance & { readonly activation?: string }) | undefined)
      ?.activation,
    "1",
  );
  assert.equal(effects.restored[0]?.deploymentGeneration, parseGeneration("7"));
  const persisted = await state.read({
    namespace: "tego",
    collection: "component-instances",
    id: legacyInstanceId,
  });
  const persistedValue = persisted?.value as
    | { readonly activation?: string; readonly deploymentGeneration?: string }
    | undefined;
  assert.equal(persistedValue?.deploymentGeneration, parseGeneration("7"));
  assert.equal(Object.hasOwn(persistedValue ?? {}, "activation"), false);
  desired = { ...desired, state: "disabled" };
  await reconciler.wake();
  const legacyLifecycleEffects = effects.calls.filter(
    (effect) => effect.instanceId === legacyInstanceId,
  );
  assert.deepEqual(
    legacyLifecycleEffects.map((effect) => effect.kind),
    ["drain", "stop"],
  );
  const stopped = await state.read({
    namespace: "tego",
    collection: "component-instances",
    id: legacyInstanceId,
  });
  assert.equal(
    (stopped?.value as { readonly lifecycle?: string } | undefined)?.lifecycle,
    "stopped",
  );
  assert.equal(
    Object.hasOwn(
      (stopped?.value as { readonly activation?: string } | undefined) ?? {},
      "activation",
    ),
    false,
  );
  assert.equal(
    await state.read({
      namespace: "tego",
      collection: "component-instances",
      id: reconcileEffectIdentities(deployment("7"), componentId, "prepare", "1").instanceId,
    }),
    undefined,
  );
  await reconciler.stop();
});

test("legacy lifecycle payload omission is required for legacy identity claims", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const legacyInstanceId = legacyReconcileInstanceId(deployment("7"), componentId);
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: legacyInstanceId,
      },
      {
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: parseGeneration("7"),
        executor: "process",
        instanceId: legacyInstanceId,
        lifecycle: "created",
        observedGeneration: parseGeneration("7"),
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const effects = new RecordingEffects();
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment("7")],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.deepEqual(
    effects.calls.map(({ kind, instanceId, operationId }) => ({ kind, instanceId, operationId })),
    [
      {
        kind: "prepare",
        ...legacyReconcileEffectIdentities(deployment("7"), componentId, "prepare"),
      },
      {
        kind: "start",
        ...legacyReconcileEffectIdentities(deployment("7"), componentId, "start"),
      },
    ].map(({ messageId: _messageId, ...effect }) => effect),
  );
  const persisted = await state.read({
    namespace: "tego",
    collection: "component-instances",
    id: legacyInstanceId,
  });
  assert.equal(Object.hasOwn((persisted?.value as object | undefined) ?? {}, "activation"), false);
  await reconciler.stop();
});

test("explicit, null, and invalid activation payloads cannot claim a legacy instance", async () => {
  const clock = new ManualClock();
  for (const activation of ["1", null, "01"] as const) {
    const state = await createHarnessStore(clock);
    const legacy = legacyReconcileEffectIdentities(deployment("7"), componentId, "prepare");
    await state.transact({}, async (transaction) => {
      await transaction.put(
        {
          namespace: "tego",
          collection: "component-instances",
          id: legacy.instanceId,
        },
        {
          applicationId,
          artifactDigest: digestOne,
          componentId,
          deploymentGeneration: parseGeneration("7"),
          executor: "process",
          instanceId: legacy.instanceId,
          lifecycle: "created",
          observedGeneration: parseGeneration("7"),
          pluginId,
        },
        { expectedRevision: "absent" },
      );
      const effect = {
        kind: "prepare",
        activation,
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: parseGeneration("7"),
        executor: "process",
        instanceId: legacy.instanceId,
        messageId: legacy.messageId,
        operationId: legacy.operationId,
        pluginId,
      };
      await transaction.enqueueOutbox({
        messageId: legacy.messageId,
        operationId: legacy.operationId,
        topic: "component.lifecycle",
        payload: effect,
        createdAt: clock.now().toISOString(),
        availableAt: clock.now().toISOString(),
      });
      return null;
    });
    const effects = new RecordingEffects();
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate().artifact },
      clock,
      effects,
      state,
      loadDeployments: async () => [],
      loadInstallations: async () => [installation()],
    });
    await reconciler.start();
    assert.equal(effects.calls.length, 0);
    assert.equal(
      reconciler.diagnostics().some((diagnostic) => diagnostic.code === "PROTOCOL_MESSAGE_INVALID"),
      true,
    );
    await reconciler.stop();
  }
});

test("non-canonical activation state is rejected without destructive writes", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const identity = reconcileEffectIdentities(deployment("7"), componentId, "prepare", "1");
  const key = {
    namespace: "tego",
    collection: "component-instances",
    id: identity.instanceId,
  } as const;
  await state.transact({}, async (transaction) => {
    await transaction.put(
      key,
      {
        activation: "01",
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: parseGeneration("7"),
        executor: "process",
        instanceId: identity.instanceId,
        lifecycle: "ready",
        observedGeneration: parseGeneration("7"),
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const before = await state.read(key);
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects: new RecordingEffects(),
    state,
    loadDeployments: async () => [deployment("7")],
    loadInstallations: async () => [installation()],
  });

  await assert.rejects(reconciler.start(), /activation/iu);

  assert.deepEqual(await state.read(key), before);
  await reconciler.stop();
});

test("zero-component suspension recovers vacuously without lifecycle effects", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const desired = deployment("7");
  const emptyInstallation = {
    ...installation(),
    manifest: { ...installation().manifest, components: [] },
  };
  await state.transact({}, async (transaction) => {
    await transaction.put(
      { namespace: "tego", collection: "deployments", id: `${applicationId}/${pluginId}` },
      desired,
      { expectedRevision: "absent" },
    );
    await transaction.put(
      { namespace: "tego", collection: "provider-loss", id: `${applicationId}/${pluginId}` },
      {
        consumer: { applicationId, pluginId },
        deploymentGeneration: desired.generation,
        action: "suspend",
        capabilities: [],
        providers: [],
        updatedAt: clock.now().toISOString(),
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const effects = new RecordingEffects();
  const reconciler = new Reconciler({
    artifactGate: {
      validate: async () => ({
        digest: digestOne,
        files: { schemaVersion: "1.0", files: [] },
        manifest: emptyInstallation.manifest,
      }),
    },
    clock,
    effects,
    state,
    loadInstallations: async () => [emptyInstallation],
  });

  await reconciler.start();

  assert.equal(effects.calls.length, 0);
  assert.equal(
    await state.read({
      namespace: "tego",
      collection: "provider-loss",
      id: `${applicationId}/${pluginId}`,
    }),
    undefined,
  );
  const observation = await state.read({
    namespace: "tego",
    collection: "deployment-observations",
    id: `${applicationId}/${pluginId}`,
  });
  assert.equal((observation?.value as { readonly status?: string } | undefined)?.status, "ready");
  await reconciler.stop();
});

test("activation exhaustion blocks only its deployment and preserves suspension evidence", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const desired = deployment("7");
  const identity = reconcileEffectIdentities(
    desired,
    componentId,
    "prepare",
    "18446744073709551615",
  );
  await state.transact({}, async (transaction) => {
    await transaction.put(
      { namespace: "tego", collection: "deployments", id: `${applicationId}/${pluginId}` },
      desired,
      { expectedRevision: "absent" },
    );
    await transaction.put(
      { namespace: "tego", collection: "provider-loss", id: `${applicationId}/${pluginId}` },
      {
        consumer: { applicationId, pluginId },
        deploymentGeneration: desired.generation,
        action: "suspend",
        capabilities: [],
        providers: [],
        updatedAt: clock.now().toISOString(),
      },
      { expectedRevision: "absent" },
    );
    await transaction.put(
      { namespace: "tego", collection: "component-instances", id: identity.instanceId },
      {
        activation: "18446744073709551615",
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: desired.generation,
        executor: "process",
        instanceId: identity.instanceId,
        lifecycle: "stopped",
        observedGeneration: desired.generation,
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const effects = new RecordingEffects();
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.equal(reconciler.kernelRunning, true);
  assert.equal(effects.calls.length, 0);
  assert.ok(
    await state.read({
      namespace: "tego",
      collection: "provider-loss",
      id: `${applicationId}/${pluginId}`,
    }),
  );
  const observation = await state.read({
    namespace: "tego",
    collection: "deployment-observations",
    id: `${applicationId}/${pluginId}`,
  });
  const observationValue = observation?.value as
    | {
        readonly diagnostics?: readonly { readonly code?: string }[];
        readonly status?: string;
      }
    | undefined;
  assert.equal(observationValue?.status, "blocked");
  assert.equal(observationValue?.diagnostics?.[0]?.code, "DEPLOYMENT_ACTIVATION_EXHAUSTED");
  await reconciler.stop();
});

test("suspended provider drains activation one, holds, and reactivates activation two", async () => {
  const providerId = parsePluginId("suspend-provider");
  const consumerId = parsePluginId("suspend-consumer");
  const providerComponentId = parseComponentId("provider-service");
  const consumerComponentId = parseComponentId("consumer-service");
  const capability = parseCapabilityName("org.example.suspend");
  const providerDigest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
  const consumerDigest = parseArtifactDigest(`sha256:${"b".repeat(64)}`);
  const component = (target: ComponentInstance["componentId"]) => ({
    componentId: target,
    kind: "service" as const,
    entrypoint: `components/${target}.js`,
    executors: ["process" as const],
  });
  const providerManifest: PluginManifest = {
    ...manifest("1.0.0", providerDigest),
    pluginId: providerId,
    components: [component(providerComponentId)],
    capabilities: {
      provides: [capabilityProvision(capability, "1.0.0")],
      requires: [],
    },
  };
  const consumerManifest: PluginManifest = {
    ...manifest("1.0.0", consumerDigest),
    pluginId: consumerId,
    components: [component(consumerComponentId)],
    capabilities: {
      provides: [],
      requires: [
        { name: capability, protocolRange: "^1.0.0", lossPolicy: "suspend" },
        {
          name: parseCapabilityName("org.example.optional-recovery"),
          protocolRange: "^1.0.0",
          optional: true,
          lossPolicy: "suspend",
        },
      ],
    },
  };
  const provider = deployment("7", {
    pluginId: providerId,
    artifactDigest: providerDigest,
  });
  const consumer = deployment("7", {
    pluginId: consumerId,
    artifactDigest: consumerDigest,
    essential: true,
  });
  const installations: PluginInstallation[] = [
    {
      ...installation("1.0.0", providerDigest),
      pluginId: providerId,
      manifest: providerManifest,
    },
    {
      ...installation("1.0.0", consumerDigest),
      pluginId: consumerId,
      manifest: consumerManifest,
    },
  ];
  const artifacts = new Map(
    installations.map((installed) => [
      installed.digest,
      {
        digest: installed.digest,
        files: { schemaVersion: "1.0" as const, files: [] },
        manifest: installed.manifest,
      },
    ]),
  );
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  await state.transact({}, async (transaction) => {
    for (const desired of [provider, consumer]) {
      await transaction.put(
        {
          namespace: "tego",
          collection: "deployments",
          id: `${desired.applicationId}/${desired.pluginId}`,
        },
        desired,
        { expectedRevision: "absent" },
      );
    }
    for (const installed of installations) {
      await transaction.put(
        {
          namespace: "tego",
          collection: "installations",
          id: `${installed.pluginId}@${installed.version}@${installed.digest}`,
        },
        installed,
        { expectedRevision: "absent" },
      );
    }
    return null;
  });
  const effects = new GatedRecordingEffects();
  const reconciler = new Reconciler({
    artifactGate: {
      async validate(request) {
        const artifact = artifacts.get(request.digest);
        assert.ok(artifact);
        return artifact;
      },
    },
    clock,
    effects,
    state,
    loadInstallations: async () => installations,
  });
  await reconciler.start();
  const providerInstance = [...state.records.values()].find(
    (record) =>
      record.key.collection === "component-instances" &&
      (record.value as { readonly pluginId?: string }).pluginId === providerId,
  );
  const activationOne = [...state.records.values()].find(
    (record) =>
      record.key.collection === "component-instances" &&
      (record.value as { readonly pluginId?: string }).pluginId === consumerId,
  );
  assert.ok(providerInstance);
  assert.ok(activationOne);
  assert.equal((activationOne.value as { readonly activation?: string }).activation, "1");
  assert.equal(reconciler.applicationReady(), true);

  await state.transact({}, async (transaction) => {
    const current = await transaction.get(providerInstance.key);
    assert.ok(current);
    await transaction.put(
      providerInstance.key,
      { ...(current.value as object), lifecycle: "degraded" },
      { expectedRevision: current.revision },
    );
    return null;
  });
  const drainGate = effects.gateNext(consumerId, "drain");
  const suspendWake = reconciler.wake();
  assert.equal(
    await Promise.race([
      drainGate.entered.promise.then(() => "drain-entered" as const),
      suspendWake.then(() => "wake-finished" as const),
    ]),
    "drain-entered",
  );
  assert.equal(
    effects.calls.some((effect) => effect.pluginId === consumerId && effect.kind === "stop"),
    false,
  );
  drainGate.release.resolve();

  const stopGate = effects.gateNext(consumerId, "stop");
  assert.equal(
    await Promise.race([
      stopGate.entered.promise.then(() => "stop-entered" as const),
      suspendWake.then(() => "wake-finished" as const),
    ]),
    "stop-entered",
  );
  stopGate.release.resolve();
  await suspendWake;

  const stoppedOne = await state.read(activationOne.key);
  const stoppedOneValue = stoppedOne?.value as
    | { readonly deploymentGeneration?: string; readonly lifecycle?: string }
    | undefined;
  assert.equal(stoppedOneValue?.lifecycle, "stopped");
  assert.equal(stoppedOneValue?.deploymentGeneration, parseGeneration("7"));
  assert.equal(reconciler.applicationReady(), false);
  const suspendedObservation = await state.read({
    namespace: "tego",
    collection: "deployment-observations",
    id: `${applicationId}/${consumerId}`,
  });
  assert.equal(
    (suspendedObservation?.value as { readonly status?: string } | undefined)?.status,
    "suspended",
  );
  const callsAtHold = effects.calls.length;
  await reconciler.wake();
  assert.equal(effects.calls.length, callsAtHold);

  await state.transact({}, async (transaction) => {
    const current = await transaction.get(providerInstance.key);
    assert.ok(current);
    await transaction.put(
      providerInstance.key,
      { ...(current.value as object), lifecycle: "ready" },
      { expectedRevision: current.revision },
    );
    return null;
  });
  state.beforeProviderLossScan = {
    remaining: 2,
    run: async () => {
      await state.transact({}, async (transaction) => {
        const current = await transaction.get(providerInstance.key);
        assert.ok(current);
        await transaction.put(
          providerInstance.key,
          { ...(current.value as object), lifecycle: "degraded" },
          { expectedRevision: current.revision },
        );
        return null;
      });
    },
  };
  const callsBeforeRecoveryRace = effects.calls.length;
  await reconciler.wake();
  assert.equal(effects.calls.length, callsBeforeRecoveryRace);
  const retainedRecovery = await state.read({
    namespace: "tego",
    collection: "provider-loss",
    id: `${applicationId}/${consumerId}`,
  });
  assert.equal(
    (
      retainedRecovery?.value as
        | { readonly recoveryActivations?: Readonly<Record<string, string>> }
        | undefined
    )?.recoveryActivations?.[consumerComponentId],
    "2",
  );
  assert.equal(
    (
      (
        await state.read({
          namespace: "tego",
          collection: "deployment-observations",
          id: `${applicationId}/${consumerId}`,
        })
      )?.value as { readonly status?: string } | undefined
    )?.status,
    "suspended",
  );

  await state.transact({}, async (transaction) => {
    const current = await transaction.get(providerInstance.key);
    assert.ok(current);
    await transaction.put(
      providerInstance.key,
      { ...(current.value as object), lifecycle: "ready" },
      { expectedRevision: current.revision },
    );
    return null;
  });
  clock.advance(60_000);
  const prepareGate = effects.gateNext(consumerId, "prepare");
  const recoveryWake = reconciler.wake();
  assert.equal(
    await Promise.race([
      prepareGate.entered.promise.then(() => "prepare-entered" as const),
      recoveryWake.then(() => "wake-finished" as const),
    ]),
    "prepare-entered",
  );
  const activationTwoPrepare = (await prepareGate.entered.promise) as ReconcileEffect & {
    readonly activation?: string;
  };
  assert.equal(activationTwoPrepare?.activation, "2");
  assert.notEqual(activationTwoPrepare?.instanceId, activationOne.key.id);
  prepareGate.release.resolve();
  await recoveryWake;

  const activationTwo = await state.read({
    namespace: "tego",
    collection: "component-instances",
    id: activationTwoPrepare?.instanceId ?? "",
  });
  const activationTwoValue = activationTwo?.value as
    | {
        readonly activation?: string;
        readonly deploymentGeneration?: string;
        readonly lifecycle?: string;
      }
    | undefined;
  assert.equal(activationTwoValue?.lifecycle, "ready");
  assert.equal(activationTwoValue?.deploymentGeneration, parseGeneration("7"));
  assert.equal(
    (activationTwo?.value as { readonly activation?: string } | undefined)?.activation,
    "2",
  );
  assert.equal(
    ((await state.read(activationOne.key))?.value as { readonly lifecycle?: string } | undefined)
      ?.lifecycle,
    "stopped",
  );
  assert.equal(
    effects.calls.filter(
      (effect) =>
        effect.pluginId === consumerId &&
        effect.kind === "start" &&
        (effect as ReconcileEffect & { readonly activation?: string }).activation === "2",
    ).length,
    1,
  );
  assert.equal(reconciler.applicationReady(), true);
  await reconciler.stop();
});

test("Reconciler gates artifact, capabilities, permissions, placement, and executor before effects", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const calls: string[] = [];
  const artifactGate = {
    async validate() {
      calls.push("artifact");
      return gate().artifact;
    },
  };
  const blocked = deployment("1", {
    permissionGrants: [{ kind: "executor", executors: ["thread"] }],
  });
  const state = await createHarnessStore(clock);
  const reconciler = new Reconciler({
    artifactGate,
    authority: { resource: "runtime:app", epoch: parseFencingEpoch("7") },
    clock,
    effects,
    state,
    loadDeployments: async () => [blocked],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.deepEqual(calls, ["artifact"]);
  assert.deepEqual(effects.performed, []);
  assert.equal(reconciler.kernelRunning, true);
  assert.equal(reconciler.applicationReady(), true);
  assert.equal(reconciler.diagnostics()[0]?.code, "PERMISSION_GRANT_EXCEEDS_REQUEST");
  assert.equal(
    (
      [...state.records.values()].find(
        (entry) => entry.key.collection === "deployment-observations",
      )?.value as { readonly status?: string } | undefined
    )?.status,
    "blocked",
  );
  await reconciler.stop();
});

test("an unready capability consumer does not block its provider from bootstrapping", async () => {
  const providerId = parsePluginId("z-provider");
  const consumerId = parsePluginId("a-consumer");
  const capability = parseCapabilityName("org.example.echo");
  const providerDigest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
  const consumerDigest = parseArtifactDigest(`sha256:${"b".repeat(64)}`);
  const component = (id: string) => ({
    componentId: parseComponentId(id),
    kind: "service" as const,
    entrypoint: `components/${id}.js`,
    executors: ["process" as const],
  });
  const providerManifest: PluginManifest = {
    ...manifest("1.0.0", providerDigest),
    pluginId: providerId,
    components: [component("provider")],
    capabilities: {
      provides: [capabilityProvision(capability, "1.0.0")],
      requires: [],
    },
  };
  const consumerManifest: PluginManifest = {
    ...manifest("1.0.0", consumerDigest),
    pluginId: consumerId,
    components: [component("consumer")],
    capabilities: {
      provides: [],
      requires: [{ name: capability, protocolRange: "^1.0.0" }],
    },
  };
  const deployments = [
    deployment("1", { pluginId: providerId, artifactDigest: providerDigest }),
    deployment("1", { pluginId: consumerId, artifactDigest: consumerDigest }),
  ];
  const installations: PluginInstallation[] = [
    {
      ...installation("1.0.0", providerDigest),
      pluginId: providerId,
      manifest: providerManifest,
    },
    {
      ...installation("1.0.0", consumerDigest),
      pluginId: consumerId,
      manifest: consumerManifest,
    },
  ];
  const artifacts = new Map([
    [providerDigest, { ...gate().artifact, digest: providerDigest, manifest: providerManifest }],
    [consumerDigest, { ...gate().artifact, digest: consumerDigest, manifest: consumerManifest }],
  ]);
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const reconciler = new Reconciler({
    artifactGate: {
      async validate(request) {
        const artifact = artifacts.get(request.digest);
        assert.ok(artifact);
        return artifact;
      },
    },
    clock,
    effects,
    state,
    loadDeployments: async () => deployments,
    loadInstallations: async () => installations,
  });

  await reconciler.start();

  assert.deepEqual(
    effects.performed.map((effect) => [effect.pluginId, effect.kind]),
    [
      [providerId, "prepare"],
      [providerId, "start"],
      [consumerId, "prepare"],
      [consumerId, "start"],
    ],
  );
  assert.deepEqual(reconciler.diagnostics(), []);
  assert.equal(reconciler.applicationReady(), true);
  await reconciler.stop();
});

test("automatic capability binding is persisted without revision churn or provider substitution", async () => {
  const providerAId = parsePluginId("provider-a");
  const providerBId = parsePluginId("provider-b");
  const consumerId = parsePluginId("consumer");
  const capability = parseCapabilityName("org.example.durable");
  const providerADigest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
  const providerBDigest = parseArtifactDigest(`sha256:${"b".repeat(64)}`);
  const consumerDigest = parseArtifactDigest(`sha256:${"c".repeat(64)}`);
  const capabilityManifest = (
    targetPluginId: PluginInstallation["pluginId"],
    provides: PluginManifest["capabilities"]["provides"],
    requires: PluginManifest["capabilities"]["requires"],
  ): PluginManifest => ({
    ...manifest("1.0.0", digestOne),
    pluginId: targetPluginId,
    components: [],
    permissions: [],
    capabilities: { provides, requires },
  });
  const providerAManifest = capabilityManifest(
    providerAId,
    [capabilityProvision(capability, "1.0.0")],
    [],
  );
  const providerBManifest = capabilityManifest(
    providerBId,
    [capabilityProvision(capability, "1.1.0")],
    [],
  );
  const consumerManifest = capabilityManifest(
    consumerId,
    [],
    [{ name: capability, protocolRange: "^1.0.0" }],
  );
  const installations: PluginInstallation[] = [
    {
      ...installation("1.0.0", providerADigest),
      pluginId: providerAId,
      manifest: providerAManifest,
    },
    {
      ...installation("1.0.0", providerBDigest),
      pluginId: providerBId,
      manifest: providerBManifest,
    },
    {
      ...installation("1.0.0", consumerDigest),
      pluginId: consumerId,
      manifest: consumerManifest,
    },
  ];
  const artifacts = new Map(
    installations.map((installed) => [
      installed.digest,
      {
        digest: installed.digest,
        files: { schemaVersion: "1.0" as const, files: [] },
        manifest: installed.manifest,
      },
    ]),
  );
  const providerA = deployment("1", {
    pluginId: providerAId,
    artifactDigest: providerADigest,
    permissionGrants: [],
  });
  const providerB = deployment("1", {
    pluginId: providerBId,
    artifactDigest: providerBDigest,
    permissionGrants: [],
  });
  const consumer = deployment("1", {
    pluginId: consumerId,
    artifactDigest: consumerDigest,
    permissionGrants: [],
  });
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const deploymentStateKey = (desired: PluginDeployment): StateKey<PluginDeployment> => ({
    namespace: "tego",
    collection: "deployments",
    id: `${desired.applicationId}/${desired.pluginId}`,
  });
  await state.transact({}, async (transaction) => {
    await transaction.put(deploymentStateKey(providerA), providerA, {
      expectedRevision: "absent",
    });
    await transaction.put(deploymentStateKey(consumer), consumer, {
      expectedRevision: "absent",
    });
    return null;
  });
  const reconciler = new Reconciler({
    artifactGate: {
      async validate(request) {
        const artifact = artifacts.get(request.digest);
        assert.ok(artifact);
        return artifact;
      },
    },
    clock,
    effects,
    state,
    loadInstallations: async () => installations,
  });
  const bindingKey: StateKey<JsonValue> = {
    namespace: "tego",
    collection: "capability-bindings",
    id: `${applicationId}/${consumerId}/${capability}`,
  };

  await reconciler.start();

  const created = await state.read(bindingKey);
  assert.ok(created);
  assert.deepEqual(created.value, {
    consumer: { applicationId, pluginId: consumerId },
    capability,
    provider: { applicationId, pluginId: providerAId },
    source: "automatic",
    deploymentGeneration: parseGeneration("1"),
    updatedAt: clock.now().toISOString(),
  });
  assert.equal(
    [...state.records.values()].filter((record) => record.key.collection === "capability-bindings")
      .length,
    1,
  );
  assert.deepEqual(consumer.capabilityBindings, {});

  await reconciler.wake();
  assert.equal((await state.read(bindingKey))?.revision, created.revision);

  await state.transact({}, async (transaction) => {
    await transaction.put(deploymentStateKey(providerB), providerB, {
      expectedRevision: "absent",
    });
    return null;
  });
  await reconciler.wake();

  const afterProviderB = await state.read(bindingKey);
  assert.deepEqual(afterProviderB, created);
  assert.deepEqual(reconciler.diagnostics(), []);
  await reconciler.stop();
});

test("a losing automatic binding CAS aborts lifecycle work and replans from the winning binding", async () => {
  const providerAId = parsePluginId("provider-a");
  const providerBId = parsePluginId("provider-b");
  const consumerId = parsePluginId("consumer");
  const capability = parseCapabilityName("org.example.race");
  const providerADigest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
  const providerBDigest = parseArtifactDigest(`sha256:${"b".repeat(64)}`);
  const consumerDigest = parseArtifactDigest(`sha256:${"c".repeat(64)}`);
  const consumerComponentId = parseComponentId("consumer-service");
  const capabilityManifest = (
    targetPluginId: PluginInstallation["pluginId"],
    provides: PluginManifest["capabilities"]["provides"],
    requires: PluginManifest["capabilities"]["requires"],
    components: PluginManifest["components"] = [],
  ): PluginManifest => ({
    ...manifest("1.0.0", digestOne),
    pluginId: targetPluginId,
    components,
    permissions: components.length === 0 ? [] : [{ kind: "executor", executors: ["process"] }],
    capabilities: { provides, requires },
  });
  const providerAManifest = capabilityManifest(
    providerAId,
    [capabilityProvision(capability, "1.0.0")],
    [],
  );
  const providerBManifest = capabilityManifest(
    providerBId,
    [capabilityProvision(capability, "1.1.0")],
    [],
  );
  const consumerManifest = capabilityManifest(
    consumerId,
    [],
    [{ name: capability, protocolRange: "^1.0.0" }],
    [
      {
        componentId: consumerComponentId,
        kind: "service",
        entrypoint: "components/consumer.js",
        executors: ["process"],
      },
    ],
  );
  const installations: PluginInstallation[] = [
    {
      ...installation("1.0.0", providerADigest),
      pluginId: providerAId,
      manifest: providerAManifest,
    },
    {
      ...installation("1.0.0", providerBDigest),
      pluginId: providerBId,
      manifest: providerBManifest,
    },
    {
      ...installation("1.0.0", consumerDigest),
      pluginId: consumerId,
      manifest: consumerManifest,
    },
  ];
  const artifacts = new Map(
    installations.map((installed) => [
      installed.digest,
      {
        digest: installed.digest,
        files: { schemaVersion: "1.0" as const, files: [] },
        manifest: installed.manifest,
      },
    ]),
  );
  const providerA = deployment("1", {
    pluginId: providerAId,
    artifactDigest: providerADigest,
    permissionGrants: [],
  });
  const providerB = deployment("1", {
    pluginId: providerBId,
    artifactDigest: providerBDigest,
    permissionGrants: [],
  });
  const consumer = deployment("1", {
    pluginId: consumerId,
    artifactDigest: consumerDigest,
    permissionGrants: [{ kind: "executor", executors: ["process"] }],
  });
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const deploymentStateKey = (desired: PluginDeployment): StateKey<PluginDeployment> => ({
    namespace: "tego",
    collection: "deployments",
    id: `${desired.applicationId}/${desired.pluginId}`,
  });
  await state.transact({}, async (transaction) => {
    await transaction.put(deploymentStateKey(providerA), providerA, {
      expectedRevision: "absent",
    });
    await transaction.put(deploymentStateKey(consumer), consumer, {
      expectedRevision: "absent",
    });
    return null;
  });
  const bindingKey: StateKey<JsonValue> = {
    namespace: "tego",
    collection: "capability-bindings",
    id: `${applicationId}/${consumerId}/${capability}`,
  };
  const winningBinding = {
    consumer: { applicationId, pluginId: consumerId },
    capability,
    provider: { applicationId, pluginId: providerBId },
    source: "automatic",
    deploymentGeneration: parseGeneration("1"),
    updatedAt: clock.now().toISOString(),
  } as const;
  state.capabilityBindingRaceWinner = {
    key: bindingKey,
    beforeCommit: async () => {
      await state.transact({}, async (transaction) => {
        await transaction.put(deploymentStateKey(providerB), providerB, {
          expectedRevision: "absent",
        });
        return null;
      });
    },
    value: winningBinding,
  };
  const options = {
    artifactGate: {
      async validate(request: { readonly digest: ArtifactDigest }) {
        const artifact = artifacts.get(request.digest);
        assert.ok(artifact);
        return artifact;
      },
    },
    clock,
    effects,
    state,
    loadInstallations: async () => installations,
  };
  const loser = new Reconciler({ ...options, maxConvergencePasses: 1 });

  await assert.rejects(
    loser.start(),
    (error: unknown) =>
      error instanceof DiagnosticError &&
      error.diagnostic.code === "LIFECYCLE_RECONCILE_DID_NOT_CONVERGE",
  );

  assert.equal(state.outbox.size, 0);
  assert.deepEqual(effects.calls, []);
  assert.deepEqual((await state.read(bindingKey))?.value, winningBinding);
  await loser.stop();

  const replanned = new Reconciler(options);
  await replanned.start();

  assert.deepEqual((await state.read(bindingKey))?.value, winningBinding);
  assert.equal(
    effects.performed.some((effect) => effect.pluginId === consumerId && effect.kind === "start"),
    true,
  );
  assert.deepEqual(replanned.diagnostics(), []);
  await replanned.stop();
});

test("a generation-2 binding inserted after the deployment read is not deleted or replaced by generation 1", async () => {
  const providerAId = parsePluginId("provider-a");
  const providerBId = parsePluginId("provider-b");
  const consumerId = parsePluginId("consumer");
  const capability = parseCapabilityName("org.example.generation-race");
  const providerADigest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
  const providerBDigest = parseArtifactDigest(`sha256:${"b".repeat(64)}`);
  const consumerDigest = parseArtifactDigest(`sha256:${"c".repeat(64)}`);
  const capabilityManifest = (
    targetPluginId: PluginInstallation["pluginId"],
    provides: PluginManifest["capabilities"]["provides"],
    requires: PluginManifest["capabilities"]["requires"],
  ): PluginManifest => ({
    ...manifest("1.0.0", digestOne),
    pluginId: targetPluginId,
    components: [],
    permissions: [],
    capabilities: { provides, requires },
  });
  const providerAManifest = capabilityManifest(
    providerAId,
    [capabilityProvision(capability, "1.0.0")],
    [],
  );
  const providerBManifest = capabilityManifest(
    providerBId,
    [capabilityProvision(capability, "1.1.0")],
    [],
  );
  const consumerManifest = capabilityManifest(
    consumerId,
    [],
    [{ name: capability, protocolRange: "^1.0.0" }],
  );
  const installations: PluginInstallation[] = [
    {
      ...installation("1.0.0", providerADigest),
      pluginId: providerAId,
      manifest: providerAManifest,
    },
    {
      ...installation("1.0.0", providerBDigest),
      pluginId: providerBId,
      manifest: providerBManifest,
    },
    {
      ...installation("1.0.0", consumerDigest),
      pluginId: consumerId,
      manifest: consumerManifest,
    },
  ];
  const artifacts = new Map(
    installations.map((installed) => [
      installed.digest,
      {
        digest: installed.digest,
        files: { schemaVersion: "1.0" as const, files: [] },
        manifest: installed.manifest,
      },
    ]),
  );
  const providerA = deployment("1", {
    pluginId: providerAId,
    artifactDigest: providerADigest,
    permissionGrants: [],
  });
  const providerB = deployment("1", {
    pluginId: providerBId,
    artifactDigest: providerBDigest,
    permissionGrants: [],
  });
  const consumerGeneration1 = deployment("1", {
    pluginId: consumerId,
    artifactDigest: consumerDigest,
    permissionGrants: [],
  });
  const consumerGeneration2 = deployment("2", {
    pluginId: consumerId,
    artifactDigest: consumerDigest,
    permissionGrants: [],
  });
  const deploymentStateKey = (desired: PluginDeployment): StateKey<PluginDeployment> => ({
    namespace: "tego",
    collection: "deployments",
    id: `${desired.applicationId}/${desired.pluginId}`,
  });
  const bindingKey: StateKey<JsonValue> = {
    namespace: "tego",
    collection: "capability-bindings",
    id: `${applicationId}/${consumerId}/${capability}`,
  };
  const winningBinding = {
    consumer: { applicationId, pluginId: consumerId },
    capability,
    provider: { applicationId, pluginId: providerBId },
    source: "automatic",
    deploymentGeneration: parseGeneration("2"),
    updatedAt: "2026-07-23T00:00:01.000Z",
  } as const;
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  await state.transact({}, async (transaction) => {
    await transaction.put(deploymentStateKey(providerA), providerA, {
      expectedRevision: "absent",
    });
    await transaction.put(deploymentStateKey(consumerGeneration1), consumerGeneration1, {
      expectedRevision: "absent",
    });
    return null;
  });
  state.beforeNextCapabilityBindingScan = async () => {
    await state.transact({}, async (transaction) => {
      const current = await transaction.get(deploymentStateKey(consumerGeneration1));
      assert.ok(current);
      await transaction.put(deploymentStateKey(consumerGeneration2), consumerGeneration2, {
        expectedRevision: current.revision,
      });
      await transaction.put(deploymentStateKey(providerB), providerB, {
        expectedRevision: "absent",
      });
      await transaction.put(bindingKey, winningBinding, { expectedRevision: "absent" });
      return null;
    });
  };
  const reconciler = new Reconciler({
    artifactGate: {
      async validate(request) {
        const artifact = artifacts.get(request.digest);
        assert.ok(artifact);
        return artifact;
      },
    },
    clock,
    effects: new RecordingEffects(),
    state,
    loadInstallations: async () => installations,
  });

  await reconciler.start();

  assert.deepEqual((await state.read(bindingKey))?.value, winningBinding);
  await reconciler.stop();
});

test("a custom deployment loader does not destructively clean up persistent bindings", async () => {
  const consumerId = parsePluginId("consumer");
  const providerId = parsePluginId("provider");
  const capability = parseCapabilityName("org.example.custom-loader");
  const consumer = deployment("1", { pluginId: consumerId });
  const bindingKey: StateKey<JsonValue> = {
    namespace: "tego",
    collection: "capability-bindings",
    id: `${applicationId}/${consumerId}/${capability}`,
  };
  const binding = {
    consumer: { applicationId, pluginId: consumerId },
    capability,
    provider: { applicationId, pluginId: providerId },
    source: "automatic",
    deploymentGeneration: parseGeneration("2"),
    updatedAt: "2026-07-23T00:00:01.000Z",
  } as const;
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  await state.transact({}, async (transaction) => {
    await transaction.put(bindingKey, binding, { expectedRevision: "absent" });
    return null;
  });
  const persisted = await state.read(bindingKey);
  assert.ok(persisted);
  const reconciler = new Reconciler({
    artifactGate: {
      async validate() {
        assert.fail("missing installations must fail before artifact validation");
      },
    },
    clock,
    effects: new RecordingEffects(),
    state,
    loadDeployments: async () => [consumer],
    loadInstallations: async () => [],
  });

  await reconciler.start();

  assert.deepEqual(await state.read(bindingKey), persisted);
  await reconciler.stop();
});

test("degrade persists lexical provider loss evidence and recovers only the same providers", async () => {
  const providerZId = parsePluginId("z-provider");
  const providerAId = parsePluginId("a-provider");
  const alternateId = parsePluginId("alternate-provider");
  const consumerId = parsePluginId("essential-consumer");
  const capabilityZ = parseCapabilityName("org.example.zeta");
  const capabilityA = parseCapabilityName("org.example.alpha");
  const providerZDigest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
  const providerADigest = parseArtifactDigest(`sha256:${"b".repeat(64)}`);
  const alternateDigest = parseArtifactDigest(`sha256:${"c".repeat(64)}`);
  const consumerDigest = parseArtifactDigest(`sha256:${"d".repeat(64)}`);
  const consumerComponentId = parseComponentId("consumer-service");
  const capabilityManifest = (
    targetPluginId: PluginInstallation["pluginId"],
    provides: PluginManifest["capabilities"]["provides"],
    requires: PluginManifest["capabilities"]["requires"],
    components: PluginManifest["components"] = [],
  ): PluginManifest => ({
    ...manifest("1.0.0", digestOne),
    pluginId: targetPluginId,
    components,
    permissions: components.length === 0 ? [] : [{ kind: "executor", executors: ["process"] }],
    capabilities: { provides, requires },
  });
  const providerZManifest = capabilityManifest(
    providerZId,
    [capabilityProvision(capabilityZ, "1.0.0")],
    [],
    [
      {
        componentId: parseComponentId("z-provider-service"),
        kind: "service",
        entrypoint: "components/provider.js",
        executors: ["process"],
      },
    ],
  );
  const providerAManifest = capabilityManifest(
    providerAId,
    [capabilityProvision(capabilityA, "1.0.0")],
    [],
    [
      {
        componentId: parseComponentId("a-provider-service"),
        kind: "service",
        entrypoint: "components/provider.js",
        executors: ["process"],
      },
    ],
  );
  const alternateManifest = capabilityManifest(
    alternateId,
    [
      capabilityProvision(capabilityZ, "1.0.0"),
      capabilityProvision(capabilityA, "1.0.0"),
    ],
    [],
  );
  const consumerManifest = capabilityManifest(
    consumerId,
    [],
    [
      {
        name: capabilityZ,
        protocolRange: "^1.0.0",
        lossPolicy: "degrade",
      },
      {
        name: capabilityA,
        protocolRange: "^1.0.0",
        lossPolicy: "degrade",
      },
    ],
    [
      {
        componentId: consumerComponentId,
        kind: "service",
        entrypoint: "components/consumer.js",
        executors: ["process"],
      },
    ],
  );
  const installations: PluginInstallation[] = [
    {
      ...installation("1.0.0", providerZDigest),
      pluginId: providerZId,
      manifest: providerZManifest,
    },
    {
      ...installation("1.0.0", providerADigest),
      pluginId: providerAId,
      manifest: providerAManifest,
    },
    {
      ...installation("1.0.0", alternateDigest),
      pluginId: alternateId,
      manifest: alternateManifest,
    },
    {
      ...installation("1.0.0", consumerDigest),
      pluginId: consumerId,
      manifest: consumerManifest,
    },
  ];
  const artifacts = new Map(
    installations.map((installed) => [
      installed.digest,
      {
        digest: installed.digest,
        files: { schemaVersion: "1.0" as const, files: [] },
        manifest: installed.manifest,
      },
    ]),
  );
  const providerZ = deployment("1", {
    pluginId: providerZId,
    artifactDigest: providerZDigest,
    permissionGrants: [{ kind: "executor", executors: ["process"] }],
  });
  const providerA = deployment("1", {
    pluginId: providerAId,
    artifactDigest: providerADigest,
    permissionGrants: [{ kind: "executor", executors: ["process"] }],
  });
  const alternate = deployment("1", {
    pluginId: alternateId,
    artifactDigest: alternateDigest,
    permissionGrants: [],
  });
  const consumer = deployment("1", {
    pluginId: consumerId,
    artifactDigest: consumerDigest,
    essential: true,
    permissionGrants: [{ kind: "executor", executors: ["process"] }],
  });
  const deploymentRecordKey = (desired: PluginDeployment): StateKey<PluginDeployment> => ({
    namespace: "tego",
    collection: "deployments",
    id: `${desired.applicationId}/${desired.pluginId}`,
  });
  const lossKey: StateKey<JsonValue> = {
    namespace: "tego",
    collection: "provider-loss",
    id: `${applicationId}/${consumerId}`,
  };
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  await state.transact({}, async (transaction) => {
    for (const desired of [providerZ, providerA, consumer]) {
      await transaction.put(deploymentRecordKey(desired), desired, {
        expectedRevision: "absent",
      });
    }
    return null;
  });
  const options = {
    artifactGate: {
      async validate(request: { readonly digest: ArtifactDigest }) {
        const artifact = artifacts.get(request.digest);
        assert.ok(artifact);
        return artifact;
      },
    },
    clock,
    state,
    loadInstallations: async () => installations,
  };
  const firstEffects = new RecordingEffects();
  const first = new Reconciler({ ...options, effects: firstEffects });

  await first.start();

  assert.equal(first.applicationReady(), true);
  const providerAInstance = [...state.records.values()].find(
    (record) =>
      record.key.collection === "component-instances" &&
      (record.value as { readonly pluginId?: string }).pluginId === providerAId,
  );
  assert.ok(providerAInstance);
  const providerZInstance = [...state.records.values()].find(
    (record) =>
      record.key.collection === "component-instances" &&
      (record.value as { readonly pluginId?: string }).pluginId === providerZId,
  );
  assert.ok(providerZInstance);
  const readyInstance = [...state.records.values()].find(
    (record) =>
      record.key.collection === "component-instances" &&
      (record.value as { readonly pluginId?: string }).pluginId === consumerId,
  );
  assert.ok(readyInstance);
  const consumerEffectCount = (effects: RecordingEffects) =>
    effects.calls.filter((effect) => effect.pluginId === consumerId).length;
  const initialConsumerEffectCount = consumerEffectCount(firstEffects);
  await state.transact({}, async (transaction) => {
    const current = await transaction.get(providerAInstance.key);
    assert.ok(current);
    await transaction.put(
      providerAInstance.key,
      { ...(current.value as object), lifecycle: "degraded" },
      { expectedRevision: current.revision },
    );
    return null;
  });
  state.beforeNextProviderLossCommit = async () => {
    await state.transact({}, async (transaction) => {
      const current = await transaction.get(providerAInstance.key);
      assert.ok(current);
      await transaction.put(
        providerAInstance.key,
        { ...(current.value as object), lifecycle: "ready" },
        { expectedRevision: current.revision },
      );
      return null;
    });
  };

  await first.wake();

  assert.equal(await state.read(lossKey), undefined);
  const stillReadyAfterProviderRace = await state.read(readyInstance.key);
  assert.ok(stillReadyAfterProviderRace);
  assert.equal(
    (stillReadyAfterProviderRace.value as { readonly lifecycle?: string }).lifecycle,
    "ready",
  );
  await state.transact({}, async (transaction) => {
    for (const record of [providerZInstance, providerAInstance]) {
      const key = record.key;
      const current = await transaction.get(key);
      assert.ok(current);
      await transaction.put(
        key,
        { ...(current.value as object), lifecycle: "degraded" },
        { expectedRevision: current.revision },
      );
    }
    await transaction.put(deploymentRecordKey(alternate), alternate, {
      expectedRevision: "absent",
    });
    return null;
  });

  await first.wake();

  const degraded = await state.read(readyInstance.key);
  assert.ok(degraded);
  assert.equal((degraded.value as { readonly lifecycle?: string }).lifecycle, "degraded");
  assert.equal(first.applicationReady(), false);
  assert.equal(consumerEffectCount(firstEffects), initialConsumerEffectCount);
  const persistedLoss = await state.read(lossKey);
  assert.deepEqual(persistedLoss?.value, {
    consumer: { applicationId, pluginId: consumerId },
    deploymentGeneration: parseGeneration("1"),
    action: "degrade",
    capabilities: [capabilityA, capabilityZ],
    providers: [
      { applicationId, pluginId: providerAId },
      { applicationId, pluginId: providerZId },
    ],
    bindingPrerequisites: [
      {
        capability: capabilityA,
        provider: { applicationId, pluginId: providerAId },
      },
      {
        capability: capabilityZ,
        provider: { applicationId, pluginId: providerZId },
      },
    ],
    updatedAt: clock.now().toISOString(),
  });
  const observation = [...state.records.values()].find(
    (record) =>
      record.key.collection === "deployment-observations" &&
      record.key.id === `${applicationId}/${consumerId}`,
  );
  assert.equal(
    (observation?.value as { readonly status?: string } | undefined)?.status,
    "degraded",
  );

  await first.wake();

  assert.deepEqual(await state.read(lossKey), persistedLoss);
  assert.equal(consumerEffectCount(firstEffects), initialConsumerEffectCount);
  await first.stop();

  const recoveredEffects = new RecordingEffects();
  const recovered = new Reconciler({ ...options, effects: recoveredEffects });
  await recovered.start();
  assert.deepEqual(await state.read(lossKey), persistedLoss);
  assert.equal(recovered.applicationReady(), false);
  assert.equal(consumerEffectCount(recoveredEffects), 0);

  await state.transact({}, async (transaction) => {
    for (const record of [providerZInstance, providerAInstance]) {
      const key = record.key;
      const current = await transaction.get(key);
      assert.ok(current);
      await transaction.put(
        key,
        { ...(current.value as object), lifecycle: "ready" },
        { expectedRevision: current.revision },
      );
    }
    return null;
  });
  state.beforeNextProviderLossCommit = async () => {
    await state.transact({}, async (transaction) => {
      const currentProviderInstance = await transaction.get(providerAInstance.key);
      assert.ok(currentProviderInstance);
      await transaction.put(
        providerAInstance.key,
        { ...(currentProviderInstance.value as object), lifecycle: "degraded" },
        { expectedRevision: currentProviderInstance.revision },
      );
      return null;
    });
  };
  await recovered.wake();

  assert.ok(await state.read(lossKey));
  const stillDegraded = await state.read(readyInstance.key);
  assert.ok(stillDegraded);
  assert.equal((stillDegraded.value as { readonly lifecycle?: string }).lifecycle, "degraded");
  assert.equal(recovered.applicationReady(), false);
  assert.equal(consumerEffectCount(recoveredEffects), 0);
  await state.transact({}, async (transaction) => {
    const current = await transaction.get(providerAInstance.key);
    assert.ok(current);
    await transaction.put(
      providerAInstance.key,
      { ...(current.value as object), lifecycle: "ready" },
      { expectedRevision: current.revision },
    );
    return null;
  });
  await recovered.wake();

  const readyAgain = await state.read(readyInstance.key);
  assert.ok(readyAgain);
  assert.equal(
    (readyAgain.value as { readonly instanceId?: string }).instanceId,
    readyInstance.key.id,
  );
  assert.equal((readyAgain.value as { readonly lifecycle?: string }).lifecycle, "ready");
  assert.equal(await state.read(lossKey), undefined);
  assert.equal(recovered.applicationReady(), true);
  assert.equal(consumerEffectCount(recoveredEffects), 0);
  const recoveredObservation = [...state.records.values()].find(
    (record) =>
      record.key.collection === "deployment-observations" &&
      record.key.id === `${applicationId}/${consumerId}`,
  );
  assert.equal(
    (recoveredObservation?.value as { readonly status?: string } | undefined)?.status,
    "ready",
  );
  await recovered.stop();
});

test("provider loss load and parse failures preserve durable evidence", async (context) => {
  const consumerId = parsePluginId("consumer");
  const providerId = parsePluginId("provider");
  const capability = parseCapabilityName("org.example.durable-loss");
  const lossKey: StateKey<JsonValue> = {
    namespace: "tego",
    collection: "provider-loss",
    id: `${applicationId}/${consumerId}`,
  };
  const options = (state: TestStateStore, clock: Clock) => ({
    artifactGate: {
      async validate() {
        assert.fail("provider loss loading precedes artifact validation");
      },
    },
    clock,
    effects: new RecordingEffects(),
    state,
    loadInstallations: async () => [],
  });

  await context.test("transient load failure", async () => {
    const clock = new ManualClock();
    const state = await createHarnessStore(clock);
    const value = {
      consumer: { applicationId, pluginId: consumerId },
      deploymentGeneration: parseGeneration("1"),
      action: "degrade",
      capabilities: [capability],
      providers: [{ applicationId, pluginId: providerId }],
      updatedAt: clock.now().toISOString(),
    } as const;
    await state.transact({}, async (transaction) => {
      await transaction.put(lossKey, value, { expectedRevision: "absent" });
      return null;
    });
    const persisted = await state.read(lossKey);
    state.failNextProviderLossScan = true;
    const reconciler = new Reconciler(options(state, clock));

    await assert.rejects(reconciler.start(), /provider loss scan unavailable/);

    assert.deepEqual(await state.read(lossKey), persisted);
    await reconciler.stop();
  });

  await context.test("parse failure", async () => {
    const clock = new ManualClock();
    const state = await createHarnessStore(clock);
    await state.transact({}, async (transaction) => {
      await transaction.put(lossKey, { action: "degrade" }, { expectedRevision: "absent" });
      return null;
    });
    const persisted = await state.read(lossKey);
    const reconciler = new Reconciler(options(state, clock));

    await assert.rejects(reconciler.start(), /Persisted provider loss is invalid/);

    assert.deepEqual(await state.read(lossKey), persisted);
    await reconciler.stop();
  });
});

test("orphan provider loss cleanup is fenced and disabled for custom deployment loaders", async (context) => {
  const consumerId = parsePluginId("orphan-consumer");
  const providerId = parsePluginId("orphan-provider");
  const capability = parseCapabilityName("org.example.orphan");
  const consumer = deployment("1", { pluginId: consumerId });
  const lossKey: StateKey<JsonValue> = {
    namespace: "tego",
    collection: "provider-loss",
    id: `${applicationId}/${consumerId}`,
  };
  const deploymentKey: StateKey<PluginDeployment> = {
    namespace: "tego",
    collection: "deployments",
    id: `${applicationId}/${consumerId}`,
  };
  const persistedLoss = (clock: Clock) =>
    ({
      consumer: { applicationId, pluginId: consumerId },
      deploymentGeneration: consumer.generation,
      action: "degrade",
      capabilities: [capability],
      providers: [{ applicationId, pluginId: providerId }],
      updatedAt: clock.now().toISOString(),
    }) as const;
  const seed = async (state: TestStateStore, clock: Clock) => {
    await state.transact({}, async (transaction) => {
      await transaction.put(lossKey, persistedLoss(clock), { expectedRevision: "absent" });
      return null;
    });
  };
  const options = (state: TestStateStore, clock: Clock) => ({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects: new RecordingEffects(),
    state,
    loadInstallations: async () => [],
  });

  await context.test("removes a loss whose consumer remains absent", async () => {
    const clock = new ManualClock();
    const state = await createHarnessStore(clock);
    await seed(state, clock);
    const reconciler = new Reconciler(options(state, clock));

    await reconciler.start();

    assert.equal(await state.read(lossKey), undefined);
    await reconciler.stop();
  });

  await context.test(
    "preserves loss when the same generation is concurrently recreated",
    async () => {
      const clock = new ManualClock();
      const state = await createHarnessStore(clock);
      await seed(state, clock);
      state.beforeNextProviderLossCommit = async () => {
        await state.transact({}, async (transaction) => {
          await transaction.put(deploymentKey, consumer, { expectedRevision: "absent" });
          return null;
        });
      };
      const reconciler = new Reconciler(options(state, clock));

      await reconciler.start();

      assert.deepEqual((await state.read(deploymentKey))?.value, consumer);
      assert.deepEqual((await state.read(lossKey))?.value, persistedLoss(clock));
      await reconciler.stop();
    },
  );

  await context.test("custom deployment loaders remain non-destructive", async () => {
    const clock = new ManualClock();
    const state = await createHarnessStore(clock);
    await seed(state, clock);
    const persisted = await state.read(lossKey);
    const reconciler = new Reconciler({
      ...options(state, clock),
      loadDeployments: async () => [],
    });

    await reconciler.start();

    assert.deepEqual(await state.read(lossKey), persisted);
    await reconciler.stop();
  });
});

test("non-canonical provider instances cannot satisfy execution-time capabilities", async () => {
  const providerId = parsePluginId("z-provider");
  const consumerId = parsePluginId("a-consumer");
  const capability = parseCapabilityName("org.example.echo");
  const providerDigest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
  const consumerDigest = parseArtifactDigest(`sha256:${"b".repeat(64)}`);
  const providerComponentId = parseComponentId("provider");
  const consumerComponentId = parseComponentId("consumer");
  const component = (id: string) => ({
    componentId: parseComponentId(id),
    kind: "service" as const,
    entrypoint: `components/${id}.js`,
    executors: ["process" as const],
  });
  const providerManifest: PluginManifest = {
    ...manifest("1.0.0", providerDigest),
    pluginId: providerId,
    components: [component("provider")],
    capabilities: {
      provides: [capabilityProvision(capability, "1.0.0")],
      requires: [],
    },
  };
  const consumerManifest: PluginManifest = {
    ...manifest("1.0.0", consumerDigest),
    pluginId: consumerId,
    components: [component("consumer")],
    capabilities: {
      provides: [],
      requires: [{ name: capability, protocolRange: "^1.0.0" }],
    },
  };
  const providerDeployment = deployment("1", {
    pluginId: providerId,
    artifactDigest: providerDigest,
  });
  const consumerDeployment = deployment("1", {
    pluginId: consumerId,
    artifactDigest: consumerDigest,
  });
  const providerInstallation: PluginInstallation = {
    ...installation("1.0.0", providerDigest),
    pluginId: providerId,
    manifest: providerManifest,
  };
  const consumerInstallation: PluginInstallation = {
    ...installation("1.0.0", consumerDigest),
    pluginId: consumerId,
    manifest: consumerManifest,
  };
  const artifacts = new Map([
    [providerDigest, { ...gate().artifact, digest: providerDigest, manifest: providerManifest }],
    [consumerDigest, { ...gate().artifact, digest: consumerDigest, manifest: consumerManifest }],
  ]);
  const consumerArtifact = artifacts.get(consumerDigest);
  assert.ok(consumerArtifact);
  const effect = planReconcile({
    deployment: consumerDeployment,
    gate: {
      artifact: consumerArtifact,
      capabilityResolution: {
        ok: true,
        diagnostics: [],
        providerLossActions: [],
        bindings: [],
        order: [
          { applicationId, pluginId: providerId },
          { applicationId, pluginId: consumerId },
        ],
      },
      permissionDecision: {
        allowed: true,
        diagnostics: [],
        granted: consumerManifest.permissions,
        requested: consumerManifest.permissions,
      },
    },
    instances: [],
    now: "2026-07-23T00:00:00.000Z",
    supportedExecutors: ["process"],
  }).steps[0]?.effect;
  assert.ok(effect);
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const now = clock.now().toISOString();
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: "non-canonical-provider",
      },
      {
        applicationId,
        artifactDigest: providerDigest,
        componentId: providerComponentId,
        deploymentGeneration: parseGeneration("1"),
        executor: "process",
        instanceId: "non-canonical-provider",
        lifecycle: "ready",
        observedGeneration: parseGeneration("1"),
        pluginId: providerId,
      },
      { expectedRevision: "absent" },
    );
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: effect.instanceId,
      },
      {
        applicationId,
        artifactDigest: consumerDigest,
        componentId: consumerComponentId,
        deploymentGeneration: parseGeneration("1"),
        executor: effect.executor,
        instanceId: effect.instanceId,
        activation: effect.activation,
        lifecycle: "created",
        observedGeneration: parseGeneration("1"),
        pluginId: consumerId,
      },
      { expectedRevision: "absent" },
    );
    await transaction.enqueueOutbox({
      availableAt: now,
      createdAt: now,
      messageId: effect.messageId,
      operationId: effect.operationId,
      payload: effect,
      topic: "component.lifecycle",
    });
    return null;
  });
  const reconciler = new Reconciler({
    artifactGate: {
      async validate(request) {
        const artifact = artifacts.get(request.digest);
        assert.ok(artifact);
        return artifact;
      },
    },
    clock,
    effects,
    state,
    loadDeployments: async () => [providerDeployment, consumerDeployment],
    loadInstallations: async () => [providerInstallation, consumerInstallation],
  });

  await reconciler.start();

  assert.equal(
    effects.calls.some(
      (candidate) => candidate.pluginId === consumerId && candidate.kind === "prepare",
    ),
    false,
  );
  assert.equal(
    reconciler
      .diagnostics()
      .some((diagnostic) => diagnostic.code === "CAPABILITY_REQUIRED_UNAVAILABLE"),
    true,
  );
  await reconciler.stop();
});

test("optional capability edges still enqueue providers before lexical-first consumers", async () => {
  const providerId = parsePluginId("z-optional-provider");
  const consumerId = parsePluginId("a-optional-consumer");
  const capability = parseCapabilityName("org.example.optional");
  const providerDigest = parseArtifactDigest(`sha256:${"c".repeat(64)}`);
  const consumerDigest = parseArtifactDigest(`sha256:${"d".repeat(64)}`);
  const component = (id: string) => ({
    componentId: parseComponentId(id),
    kind: "service" as const,
    entrypoint: `components/${id}.js`,
    executors: ["process" as const],
  });
  const providerManifest: PluginManifest = {
    ...manifest("1.0.0", providerDigest),
    pluginId: providerId,
    components: [component("optional-provider")],
    capabilities: {
      provides: [capabilityProvision(capability, "1.0.0")],
      requires: [],
    },
  };
  const consumerManifest: PluginManifest = {
    ...manifest("1.0.0", consumerDigest),
    pluginId: consumerId,
    components: [component("optional-consumer")],
    capabilities: {
      provides: [],
      requires: [{ name: capability, protocolRange: "^1.0.0", optional: true }],
    },
  };
  const deployments = [
    deployment("1", { pluginId: consumerId, artifactDigest: consumerDigest }),
    deployment("1", { pluginId: providerId, artifactDigest: providerDigest }),
  ];
  const installations: PluginInstallation[] = [
    {
      ...installation("1.0.0", providerDigest),
      pluginId: providerId,
      manifest: providerManifest,
    },
    {
      ...installation("1.0.0", consumerDigest),
      pluginId: consumerId,
      manifest: consumerManifest,
    },
  ];
  const artifacts = new Map([
    [providerDigest, { ...gate().artifact, digest: providerDigest, manifest: providerManifest }],
    [consumerDigest, { ...gate().artifact, digest: consumerDigest, manifest: consumerManifest }],
  ]);
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  await state.transact({}, async (transaction) => {
    for (const generation of ["0", "1"] as const) {
      const instanceId = `app.z-optional-provider.optional-provider.g${generation}`;
      await transaction.put(
        {
          namespace: "tego",
          collection: "component-instances",
          id: instanceId,
        },
        {
          applicationId,
          artifactDigest: providerDigest,
          componentId: parseComponentId("optional-provider"),
          deploymentGeneration: parseGeneration(generation),
          executor: "process",
          instanceId,
          lifecycle: "ready",
          observedGeneration: parseGeneration(generation),
          pluginId: providerId,
        },
        { expectedRevision: "absent" },
      );
    }
    return null;
  });
  const reconciler = new Reconciler({
    artifactGate: {
      async validate(request) {
        const artifact = artifacts.get(request.digest);
        assert.ok(artifact);
        return artifact;
      },
    },
    clock,
    effects,
    state,
    loadDeployments: async () => deployments,
    loadInstallations: async () => installations,
  });

  await reconciler.start();

  assert.equal(effects.performed[0]?.pluginId, providerId);
  await reconciler.stop();
});

test("malformed lifecycle outbox payloads are diagnosed without invoking effects", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const now = clock.now().toISOString();
  await state.transact({}, async (transaction) => {
    await transaction.enqueueOutbox({
      availableAt: now,
      createdAt: now,
      messageId: parseMessageId("malformed-lifecycle-message"),
      operationId: parseOperationId("malformed-lifecycle-operation"),
      payload: { malformed: true },
      topic: "component.lifecycle",
    });
    return null;
  });
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [],
    loadInstallations: async () => [],
  });

  await reconciler.start();

  assert.deepEqual(effects.calls, []);
  assert.equal(reconciler.diagnostics()[0]?.code, "PROTOCOL_MESSAGE_INVALID");
  await reconciler.stop();
});

test("missing instances do not grant legacy provenance to lifecycle claims", async () => {
  const clock = new ManualClock();
  for (const [index, activation] of (["1", null, "01"] as const).entries()) {
    const effects = new RecordingEffects();
    const state = await createHarnessStore(clock);
    const now = clock.now().toISOString();
    const desired = deployment(String(index + 7));
    const legacy = legacyReconcileEffectIdentities(desired, componentId, "prepare");
    await state.transact({}, async (transaction) => {
      await transaction.enqueueOutbox({
        availableAt: now,
        createdAt: now,
        messageId: legacy.messageId,
        operationId: legacy.operationId,
        payload: {
          activation,
          applicationId,
          artifactDigest: digestOne,
          componentId,
          deploymentGeneration: desired.generation,
          executor: "process",
          instanceId: legacy.instanceId,
          kind: "prepare",
          messageId: legacy.messageId,
          operationId: legacy.operationId,
          pluginId,
        },
        topic: "component.lifecycle",
      });
      return null;
    });
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate().artifact },
      clock,
      effects,
      state,
      loadDeployments: async () => [],
      loadInstallations: async () => [],
    });

    await reconciler.start();

    assert.deepEqual(effects.calls, []);
    assert.equal(reconciler.diagnostics()[0]?.code, "PROTOCOL_MESSAGE_INVALID");
    assert.equal(state.outbox.get(legacy.messageId)?.acknowledgement?.outcome, "retry");
    await reconciler.stop();
  }
});

test("canonical lifecycle identities cannot be retargeted to another persisted instance", async () => {
  const source = (
    lifecycle: ComponentInstance["lifecycle"],
    generation = "1",
  ): ComponentInstance => ({
    activation: "1",
    applicationId,
    componentId,
    deploymentGeneration: parseGeneration(generation),
    executor: "process",
    instanceId: `source-${lifecycle}`,
    lifecycle,
    observedGeneration: parseGeneration(generation),
    pluginId,
    revision: parseRevision("1"),
  });
  const cases = [
    {
      desired: deployment(),
      effect: planReconcile(snapshot()).steps[0]?.effect,
      lifecycle: "created",
    },
    {
      desired: deployment(),
      effect: planReconcile(snapshot(deployment(), [source("preparing")])).steps[0]?.effect,
      lifecycle: "preparing",
    },
    {
      desired: deployment("2", { state: "disabled" }),
      effect: planReconcile(snapshot(deployment("2", { state: "disabled" }), [source("ready")]))
        .steps[0]?.effect,
      lifecycle: "ready",
    },
    {
      desired: deployment("2", { state: "disabled" }),
      effect: planReconcile(snapshot(deployment("2", { state: "disabled" }), [source("draining")]))
        .steps[0]?.effect,
      lifecycle: "draining",
    },
  ] as const;

  for (const item of cases) {
    const effect = item.effect;
    assert.ok(effect);
    const clock = new ManualClock();
    const effects = new RecordingEffects();
    const state = await createHarnessStore(clock);
    const retargeted = {
      ...effect,
      instanceId: `victim-${effect.kind}`,
    };
    const now = clock.now().toISOString();
    await state.transact({}, async (transaction) => {
      await transaction.put(
        {
          namespace: "tego",
          collection: "component-instances",
          id: retargeted.instanceId,
        },
        {
          applicationId,
          artifactDigest: effect.artifactDigest,
          componentId,
          deploymentGeneration: effect.deploymentGeneration,
          executor: effect.executor,
          instanceId: retargeted.instanceId,
          activation: retargeted.activation,
          lifecycle: item.lifecycle,
          observedGeneration: effect.deploymentGeneration,
          pluginId,
        },
        { expectedRevision: "absent" },
      );
      await transaction.enqueueOutbox({
        availableAt: now,
        createdAt: now,
        messageId: effect.messageId,
        operationId: effect.operationId,
        payload: retargeted,
        topic: "component.lifecycle",
      });
      return null;
    });
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate().artifact },
      clock,
      effects,
      state,
      loadDeployments: async () => [item.desired],
      loadInstallations: async () => [installation()],
    });

    await reconciler.start();
    await reconciler.wake();

    assert.deepEqual(effects.calls, [], effect.kind);
    assert.equal(reconciler.diagnostics()[0]?.code, "DEPLOYMENT_INSTANCE_INCONSISTENT");
    assert.equal(state.outbox.get(effect.messageId)?.acknowledgement?.outcome, "retry");
    await reconciler.stop();
  }
});

test("claimed effects revalidate current placement before journaling or performing", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  effects.supportedExecutors = ["thread"];
  const state = await createHarnessStore(clock);
  const value = installation();
  const currentManifest: PluginManifest = {
    ...value.manifest,
    components: [
      {
        componentId,
        kind: "service",
        entrypoint: "components/echo.js",
        executors: ["process", "thread"],
      },
    ],
    permissions: [{ kind: "executor", executors: ["process", "thread"] }],
  };
  const desired = deployment("1", {
    permissionGrants: [{ kind: "executor", executors: ["process", "thread"] }],
  });
  const effect = planReconcile(snapshot()).steps[0]?.effect;
  assert.ok(effect);
  const now = clock.now().toISOString();
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: effect.instanceId,
      },
      {
        applicationId,
        artifactDigest: effect.artifactDigest,
        componentId,
        deploymentGeneration: effect.deploymentGeneration,
        executor: effect.executor,
        instanceId: effect.instanceId,
        activation: effect.activation,
        lifecycle: "created",
        observedGeneration: effect.deploymentGeneration,
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    await transaction.enqueueOutbox({
      availableAt: now,
      createdAt: now,
      messageId: effect.messageId,
      operationId: effect.operationId,
      payload: effect,
      topic: "component.lifecycle",
    });
    return null;
  });
  const reconciler = new Reconciler({
    artifactGate: {
      validate: async () => ({ ...gate().artifact, manifest: currentManifest }),
    },
    clock,
    effects,
    state,
    loadDeployments: async () => [desired],
    loadInstallations: async () => [{ ...value, manifest: currentManifest }],
  });

  await reconciler.start();

  assert.deepEqual(
    effects.calls.map((candidate) => candidate.executor),
    ["thread", "thread"],
  );
  assert.equal(reconciler.replanCount, 1);
  assert.equal(
    effects.calls.some((candidate) => candidate.executor === effect.executor),
    false,
  );
  await reconciler.stop();
});

test("claimed remote effects require the current worker placement to match exactly", async () => {
  const resources = { cpuMillis: 1_000, memoryBytes: 1_000_000, storageBytes: 1_000_000 };
  const workerPermission = {
    kind: "worker" as const,
    labels: { zone: "edge" },
    resources,
  };
  const remoteManifest: PluginManifest = {
    ...manifest("1.0.0", digestOne),
    components: [
      {
        componentId,
        kind: "service",
        entrypoint: "components/echo.js",
        executors: ["remote", "process"],
      },
    ],
    permissions: [{ kind: "executor", executors: ["remote"] }, workerPermission],
  };
  const desired = deployment("1", {
    permissionGrants: [{ kind: "executor", executors: ["remote"] }, workerPermission],
  });
  const remoteGate: ArtifactDeploymentGate = {
    ...gate(),
    artifact: { ...gate().artifact, manifest: remoteManifest },
    permissionDecision: {
      allowed: true,
      diagnostics: [],
      granted: desired.permissionGrants,
      requested: remoteManifest.permissions,
    },
  };
  const planned = planReconcile({
    deployment: desired,
    gate: remoteGate,
    instances: [],
    now: "2026-07-23T00:00:00.000Z",
    supportedExecutors: ["remote"],
    workers: [
      {
        workerId: "worker-a",
        labels: { zone: "edge" },
        resources,
        executors: ["process"],
        preparedArtifacts: [digestOne],
      },
    ],
  }).steps[0]?.effect;
  assert.ok(planned);
  const plannedWorkerId = planned.workerId;
  assert.equal(plannedWorkerId, "worker-a");
  assert.ok(plannedWorkerId);

  const clock = new ManualClock();
  const effects = new RecordingEffects();
  effects.supportedExecutors = ["remote"];
  const state = await createHarnessStore(clock);
  const now = clock.now().toISOString();
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: planned.instanceId,
      },
      {
        applicationId,
        artifactDigest: planned.artifactDigest,
        componentId,
        deploymentGeneration: planned.deploymentGeneration,
        executor: planned.executor,
        instanceId: planned.instanceId,
        activation: planned.activation,
        lifecycle: "created",
        observedGeneration: planned.deploymentGeneration,
        pluginId,
        workerId: plannedWorkerId,
      },
      { expectedRevision: "absent" },
    );
    await transaction.enqueueOutbox({
      availableAt: now,
      createdAt: now,
      messageId: planned.messageId,
      operationId: planned.operationId,
      payload: planned,
      topic: "component.lifecycle",
    });
    return null;
  });
  const reconciler = new Reconciler({
    artifactGate: {
      validate: async () => ({ ...gate().artifact, manifest: remoteManifest }),
    },
    clock,
    effects,
    state,
    workers: [
      {
        workerId: "worker-b",
        labels: { zone: "edge" },
        resources,
        executors: ["process"],
        preparedArtifacts: [digestOne],
      },
    ],
    loadDeployments: async () => [desired],
    loadInstallations: async () => [
      {
        ...installation(),
        manifest: remoteManifest,
      },
    ],
  });

  await reconciler.start();

  assert.deepEqual(
    effects.calls.map((candidate) => [candidate.workerId, candidate.kind]),
    [
      ["worker-b", "prepare"],
      ["worker-b", "start"],
    ],
  );
  assert.equal(
    effects.calls.some((candidate) => candidate.workerId === plannedWorkerId),
    false,
  );
  assert.equal(reconciler.replanCount, 1);
  await reconciler.stop();
});

test("canonical effects with stale pre-lifecycle state never invoke the executor", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const preparing: ComponentInstance = {
    activation: "1",
    applicationId,
    componentId,
    deploymentGeneration: parseGeneration("1"),
    executor: "process",
    instanceId: "ignored-by-planner",
    lifecycle: "preparing",
    observedGeneration: parseGeneration("1"),
    pluginId,
    revision: parseRevision("1"),
  };
  const effect = planReconcile(snapshot(deployment(), [preparing])).steps[0]?.effect;
  assert.equal(effect?.kind, "start");
  assert.ok(effect);
  const now = clock.now().toISOString();
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: effect.instanceId,
      },
      {
        applicationId,
        artifactDigest: effect.artifactDigest,
        componentId,
        deploymentGeneration: effect.deploymentGeneration,
        executor: effect.executor,
        instanceId: effect.instanceId,
        activation: effect.activation,
        lifecycle: "ready",
        observedGeneration: effect.deploymentGeneration,
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    await transaction.enqueueOutbox({
      availableAt: now,
      createdAt: now,
      messageId: effect.messageId,
      operationId: effect.operationId,
      payload: effect,
      topic: "component.lifecycle",
    });
    return null;
  });
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.deepEqual(effects.calls, []);
  assert.equal(reconciler.replanCount, 1);
  assert.equal(
    [...state.operations.values()].some((operation) => operation.status === "executing"),
    false,
  );
  await reconciler.stop();
});

test("non-canonical persisted instance identities remain durably inconsistent across wakes", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: "non-canonical-instance",
      },
      {
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: parseGeneration("1"),
        executor: "process",
        instanceId: "non-canonical-instance",
        lifecycle: "ready",
        observedGeneration: parseGeneration("1"),
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();
  await reconciler.wake();

  const observation = [...state.records.values()].find(
    (record) => record.key.collection === "deployment-observations",
  );
  assert.equal((observation?.value as { readonly status?: string } | undefined)?.status, "blocked");
  assert.deepEqual(effects.calls, []);
  await reconciler.stop();
});

test("canonical instance values stored under non-canonical keys remain inconsistent", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const desired = deployment("1", { essential: true });
  const effect = planReconcile(snapshot(desired)).steps[0]?.effect;
  assert.ok(effect);
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: "non-canonical-storage-key",
      },
      {
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: parseGeneration("1"),
        executor: effect.executor,
        instanceId: effect.instanceId,
        activation: effect.activation,
        lifecycle: "ready",
        observedGeneration: parseGeneration("1"),
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [desired],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.equal(reconciler.applicationReady(), false);
  assert.equal(reconciler.diagnostics()[0]?.code, "DEPLOYMENT_INSTANCE_INCONSISTENT");
  assert.deepEqual(effects.calls, []);
  await reconciler.stop();
});

test("restores persisted ready local sessions before reconciliation and requires them to be live", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const desired = deployment("1", { essential: true });
  const planned = planReconcile(snapshot(desired)).steps[0]?.effect;
  assert.ok(planned);
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: planned.instanceId,
      },
      {
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: parseGeneration("1"),
        executor: planned.executor,
        instanceId: planned.instanceId,
        activation: planned.activation,
        lifecycle: "ready",
        observedGeneration: parseGeneration("1"),
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const instanceBefore = await state.read({
    namespace: "tego",
    collection: "component-instances",
    id: planned.instanceId,
  });
  const restored: ComponentInstance[] = [];
  const effects = new RecordingEffects() as RecordingEffects & {
    restore(instance: ComponentInstance): Promise<void>;
    isLive(instance: ComponentInstance): boolean;
  };
  effects.restore = async (instance) => {
    restored.push(instance);
  };
  effects.isLive = () => false;
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    authority: { resource: "runtime:app", epoch: parseFencingEpoch("9") },
    loadDeployments: async () => [desired],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.deepEqual(
    restored.map((instance) => instance.instanceId),
    [planned.instanceId],
  );
  assert.equal(reconciler.applicationReady(), false);
  assert.equal(state.operations.size, 1);
  const failed = await state.read({
    namespace: "tego",
    collection: "component-instances",
    id: planned.instanceId,
  });
  assert.notEqual(failed?.revision, instanceBefore?.revision);
  assert.equal(
    (
      failed?.value as
        | { readonly diagnostic?: { readonly code?: string }; readonly retryAt?: string }
        | undefined
    )?.diagnostic?.code,
    "LIFECYCLE_RESTORE_FAILED",
  );
  await reconciler.stop();
});

test("degraded persisted sessions restore only when needed and require post-restore liveness", async (context) => {
  const seedDegraded = async (state: TestStateStore) => {
    const desired = deployment("1", { essential: true });
    const planned = planReconcile(snapshot(desired)).steps[0]?.effect;
    assert.ok(planned);
    await state.transact({}, async (transaction) => {
      await transaction.put(
        {
          namespace: "tego",
          collection: "component-instances",
          id: planned.instanceId,
        },
        {
          applicationId,
          artifactDigest: digestOne,
          componentId,
          deploymentGeneration: parseGeneration("1"),
          executor: planned.executor,
          instanceId: planned.instanceId,
          activation: planned.activation,
          lifecycle: "degraded",
          observedGeneration: parseGeneration("1"),
          pluginId,
        },
        { expectedRevision: "absent" },
      );
      return null;
    });
    return { desired, planned };
  };

  await context.test("a live degraded session is not restored on repeated wakes", async () => {
    const clock = new ManualClock();
    const state = await createHarnessStore(clock);
    const { desired, planned } = await seedDegraded(state);
    const effects = new RecordingEffects();
    effects.live.add(planned.instanceId);
    let restores = 0;
    effects.restore = async () => {
      restores += 1;
    };
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate().artifact },
      clock,
      effects,
      state,
      loadDeployments: async () => [desired],
      loadInstallations: async () => [installation()],
    });

    await reconciler.start();
    await reconciler.wake();
    await reconciler.wake();

    assert.equal(restores, 0);
    await reconciler.stop();
  });

  await context.test("a restarted degraded session is restored exactly once", async () => {
    const clock = new ManualClock();
    const state = await createHarnessStore(clock);
    const { desired } = await seedDegraded(state);
    const effects = new RecordingEffects();
    let restores = 0;
    const restore = effects.restore.bind(effects);
    effects.restore = async (instance) => {
      restores += 1;
      await restore(instance);
    };
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate().artifact },
      clock,
      effects,
      state,
      loadDeployments: async () => [desired],
      loadInstallations: async () => [installation()],
    });

    await reconciler.start();
    await reconciler.wake();
    await reconciler.wake();

    assert.equal(restores, 1);
    await reconciler.stop();
  });

  await context.test("a degraded restore that stays non-live is recorded safely", async () => {
    const clock = new ManualClock();
    const state = await createHarnessStore(clock);
    const { desired, planned } = await seedDegraded(state);
    const effects = new RecordingEffects();
    let restores = 0;
    effects.restore = async () => {
      restores += 1;
    };
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate().artifact },
      clock,
      effects,
      state,
      loadDeployments: async () => [desired],
      loadInstallations: async () => [installation()],
    });

    await reconciler.start();

    const failed = await state.read({
      namespace: "tego",
      collection: "component-instances",
      id: planned.instanceId,
    });
    const value = failed?.value as
      | {
          readonly diagnostic?: { readonly code?: string };
          readonly lifecycle?: string;
          readonly retryAt?: string;
        }
      | undefined;
    assert.equal(restores, 1);
    assert.equal(value?.lifecycle, "degraded");
    assert.equal(typeof value?.retryAt, "string");
    assert.equal(value?.diagnostic?.code, "LIFECYCLE_RESTORE_FAILED");
    await reconciler.stop();
  });
});

test("remote restoration requires the persisted Worker to remain placement-eligible", async () => {
  const resources = { cpuMillis: 1_000, memoryBytes: 1_000_000, storageBytes: 1_000_000 };
  const workerPermission = {
    kind: "worker" as const,
    labels: { zone: "edge" },
    resources,
  };
  const remoteManifest: PluginManifest = {
    ...manifest("1.0.0", digestOne, ["remote", "thread"]),
    permissions: [{ kind: "executor", executors: ["remote"] }, workerPermission],
  };
  const remoteInstallation: PluginInstallation = {
    ...installation(),
    manifest: remoteManifest,
  };
  const desired = deployment("1", {
    permissionGrants: [{ kind: "executor", executors: ["remote"] }, workerPermission],
  });
  const planned = planReconcile({
    deployment: desired,
    gate: {
      ...gate(remoteInstallation),
      permissionDecision: {
        allowed: true,
        diagnostics: [],
        granted: desired.permissionGrants,
        requested: remoteManifest.permissions,
      },
    },
    instances: [],
    now: "2026-07-23T00:00:00.000Z",
    supportedExecutors: ["remote"],
    workers: [
      {
        workerId: "worker-restore",
        labels: { zone: "edge" },
        resources,
        executors: ["thread"],
        preparedArtifacts: [digestOne],
      },
    ],
  }).steps[0]?.effect;
  assert.ok(planned);

  for (const workers of [
    [
      {
        workerId: "worker-other",
        labels: { zone: "edge" },
        resources,
        executors: ["thread" as const],
        preparedArtifacts: [digestOne],
      },
    ],
    [
      {
        workerId: "worker-restore",
        labels: { zone: "edge" },
        resources,
        executors: ["thread" as const],
        preparedArtifacts: [digestTwo],
      },
    ],
    [
      {
        workerId: "worker-restore",
        labels: { zone: "edge" },
        resources,
        executors: ["process" as const],
        preparedArtifacts: [digestOne],
      },
    ],
  ]) {
    const clock = new ManualClock();
    const state = await createHarnessStore(clock);
    await state.transact({}, async (transaction) => {
      await transaction.put(
        {
          namespace: "tego",
          collection: "component-instances",
          id: planned.instanceId,
        },
        {
          applicationId,
          artifactDigest: digestOne,
          componentId,
          deploymentGeneration: parseGeneration("1"),
          executor: "remote",
          instanceId: planned.instanceId,
          activation: planned.activation,
          lifecycle: "ready",
          observedGeneration: parseGeneration("1"),
          pluginId,
          workerId: "worker-restore",
        },
        { expectedRevision: "absent" },
      );
      return null;
    });
    const effects = new RecordingEffects();
    effects.supportedExecutors = ["remote"];
    const restored: string[] = [];
    effects.restore = async (instance) => {
      restored.push(instance.instanceId);
    };
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate(remoteInstallation).artifact },
      clock,
      effects,
      state,
      workers,
      loadDeployments: async () => [desired],
      loadInstallations: async () => [remoteInstallation],
    });

    await reconciler.start();

    assert.deepEqual(restored, []);
    await reconciler.stop();
  }
});

test("persisted local restoration failures are isolated and durably retryable", async () => {
  for (const essential of [false, true]) {
    const clock = new ManualClock();
    const state = await createHarnessStore(clock);
    const desired = deployment("1", { essential });
    const planned = planReconcile(snapshot(desired)).steps[0]?.effect;
    assert.ok(planned);
    await state.transact({}, async (transaction) => {
      await transaction.put(
        {
          namespace: "tego",
          collection: "component-instances",
          id: planned.instanceId,
        },
        {
          applicationId,
          artifactDigest: digestOne,
          componentId,
          deploymentGeneration: parseGeneration("1"),
          executor: planned.executor,
          instanceId: planned.instanceId,
          activation: planned.activation,
          lifecycle: "ready",
          observedGeneration: parseGeneration("1"),
          pluginId,
        },
        { expectedRevision: "absent" },
      );
      return null;
    });
    const effects = new RecordingEffects();
    effects.restore = async () => {
      throw new Error("restore failed");
    };
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate().artifact },
      clock,
      effects,
      state,
      loadDeployments: async () => [desired],
      loadInstallations: async () => [installation()],
    });

    await reconciler.start();

    const failed = await state.read({
      namespace: "tego",
      collection: "component-instances",
      id: planned.instanceId,
    });
    const failedValue = failed?.value as
      | {
          readonly lifecycle?: string;
          readonly retryAt?: string;
          readonly diagnostic?: { readonly code?: string };
        }
      | undefined;
    assert.equal(failedValue?.lifecycle, "ready");
    assert.equal(typeof failedValue?.retryAt, "string");
    assert.equal(failedValue?.diagnostic?.code, "LIFECYCLE_RESTORE_FAILED");
    assert.equal(reconciler.kernelRunning, true);
    assert.equal(reconciler.applicationReady(), !essential);
    await reconciler.stop();
  }
});

test("persisted preparing local sessions are restored before their start effect resumes", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const desired = deployment("1", { essential: true });
  const planned = planReconcile(snapshot(desired)).steps[0]?.effect;
  assert.ok(planned);
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: planned.instanceId,
      },
      {
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: parseGeneration("1"),
        executor: planned.executor,
        instanceId: planned.instanceId,
        activation: planned.activation,
        lifecycle: "preparing",
        observedGeneration: parseGeneration("1"),
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const effects = new RecordingEffects();
  const restored: ComponentInstance[] = [];
  const restore = effects.restore.bind(effects);
  effects.restore = async (instance) => {
    restored.push(instance);
    await restore(instance);
  };
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [desired],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.deepEqual(
    restored.map((instance) => instance.lifecycle),
    ["preparing"],
  );
  assert.deepEqual(
    effects.calls.map((effect) => effect.kind),
    ["start"],
  );
  assert.equal(reconciler.applicationReady(), true);
  await reconciler.stop();
});

test("persisted local restoration retries automatically without reopening completed lifecycle messages", async () => {
  const clock = new ScheduledClock();
  const state = await createHarnessStore(clock);
  const desired = deployment("1", { essential: true });
  const planned = planReconcile(snapshot(desired)).steps[0]?.effect;
  assert.ok(planned);
  const startOperationId = parseOperationId(planned.operationId.replace(/prepare$/u, "start"));
  const restoreOperationId = parseOperationId(planned.operationId.replace(/prepare$/u, "restore"));
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: planned.instanceId,
      },
      {
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: parseGeneration("1"),
        executor: planned.executor,
        instanceId: planned.instanceId,
        activation: planned.activation,
        lifecycle: "ready",
        observedGeneration: parseGeneration("1"),
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    for (const operationId of [planned.operationId, startOperationId]) {
      await transaction.appendOperation({
        operationId,
        kind: "component.lifecycle",
        status: "completed",
        state: { instanceId: planned.instanceId },
        updatedAt: clock.now().toISOString(),
      });
    }
    return null;
  });
  const effects = new RecordingEffects();
  const restore = effects.restore.bind(effects);
  let restoreAttempts = 0;
  effects.restore = async (instance) => {
    restoreAttempts += 1;
    if (restoreAttempts <= 2) throw new Error("transient restore failure");
    await restore(instance);
  };
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [desired],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();
  assert.equal(reconciler.applicationReady(), false);
  const firstFailure = await state.read({
    namespace: "tego",
    collection: "component-instances",
    id: planned.instanceId,
  });
  const firstRetryAt = (firstFailure?.value as { readonly retryAt?: string } | undefined)?.retryAt;
  assert.equal(typeof firstRetryAt, "string");
  assert.equal(state.operations.get(planned.operationId)?.status, "completed");
  assert.equal(state.operations.get(startOperationId)?.status, "completed");
  assert.equal(state.operations.get(restoreOperationId)?.status, "failed");

  clock.advance(Date.parse(firstRetryAt as string) - clock.now().getTime());
  for (let turn = 0; turn < 20 && restoreAttempts < 2; turn += 1) {
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  const secondFailure = await state.read({
    namespace: "tego",
    collection: "component-instances",
    id: planned.instanceId,
  });
  const secondRetryAt = (secondFailure?.value as { readonly retryAt?: string } | undefined)
    ?.retryAt;
  assert.equal(typeof secondRetryAt, "string");
  assert.equal(Date.parse(secondRetryAt as string) > Date.parse(firstRetryAt as string), true);

  clock.advance(Date.parse(secondRetryAt as string) - clock.now().getTime());
  for (let turn = 0; turn < 20 && !reconciler.applicationReady(); turn += 1) {
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }

  assert.equal(restoreAttempts, 3);
  assert.equal(reconciler.applicationReady(), true);
  const recovered = await state.read({
    namespace: "tego",
    collection: "component-instances",
    id: planned.instanceId,
  });
  assert.equal(
    (recovered?.value as { readonly diagnostic?: unknown } | undefined)?.diagnostic,
    undefined,
  );
  assert.equal(
    (recovered?.value as { readonly attempt?: unknown } | undefined)?.attempt,
    undefined,
  );
  assert.equal(
    (recovered?.value as { readonly retryAt?: unknown } | undefined)?.retryAt,
    undefined,
  );
  assert.equal(state.operations.get(planned.operationId)?.status, "completed");
  assert.equal(state.operations.get(startOperationId)?.status, "completed");
  assert.equal(state.operations.get(restoreOperationId)?.status, "completed");
  await reconciler.stop();
});

test("persisted ready state is not live when the executor has no lifecycle capability", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const desired = deployment("1", { essential: true });
  const planned = planReconcile(snapshot(desired)).steps[0]?.effect;
  assert.ok(planned);
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: planned.instanceId,
      },
      {
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: parseGeneration("1"),
        executor: planned.executor,
        instanceId: planned.instanceId,
        activation: planned.activation,
        lifecycle: "ready",
        observedGeneration: parseGeneration("1"),
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const effects: ComponentEffectExecutor = {
    supportedExecutors: ["process"],
    perform: async () => {},
  };
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [desired],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.equal(reconciler.applicationReady(), false);
  await reconciler.stop();
});

test("component lifecycle methods are accepted only as one complete capability", async () => {
  const lifecycleMethods = {
    restore: async (_instance: ComponentInstance) => {},
    isLive: (_instance: ComponentInstance) => false,
    close: async () => {},
  };
  for (let mask = 1; mask < 7; mask += 1) {
    const effects = {
      supportedExecutors: ["process"] as const,
      perform: async (_effect: ReconcileEffect) => {},
      ...(mask & 1 ? { restore: lifecycleMethods.restore } : {}),
      ...(mask & 2 ? { isLive: lifecycleMethods.isLive } : {}),
      ...(mask & 4 ? { close: lifecycleMethods.close } : {}),
    };
    assert.throws(
      () =>
        new Reconciler({
          artifactGate: { validate: async () => gate().artifact },
          clock: new ManualClock(),
          effects,
          state: new TestStateStore(new ManualClock()),
        }),
      /restore|isLive|close|lifecycle|capability/iu,
      `partial lifecycle mask ${mask} must be rejected`,
    );
  }
});

test("restoration skips ready instances whose observed generation is stale", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const desired = deployment("1", { essential: true });
  const planned = planReconcile(snapshot(desired)).steps[0]?.effect;
  assert.ok(planned);
  await state.transact({}, async (transaction) => {
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: planned.instanceId,
      },
      {
        applicationId,
        artifactDigest: digestOne,
        componentId,
        deploymentGeneration: parseGeneration("1"),
        executor: planned.executor,
        instanceId: planned.instanceId,
        activation: planned.activation,
        lifecycle: "ready",
        observedGeneration: parseGeneration("2"),
        pluginId,
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const effects = new RecordingEffects();
  const restored: string[] = [];
  effects.restore = async (instance) => {
    restored.push(instance.instanceId);
  };
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [desired],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.deepEqual(restored, []);
  assert.equal(reconciler.applicationReady(), false);
  await reconciler.stop();
});

test("recovery restoration invalidates its activation when durable providers change", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const providerAId = parsePluginId("full-set-provider-a");
  const providerBId = parsePluginId("full-set-provider-b");
  const consumerId = parsePluginId("full-set-consumer");
  const providerAComponentId = parseComponentId("full-set-provider-a-service");
  const providerBComponentId = parseComponentId("full-set-provider-b-service");
  const consumerComponentId = parseComponentId("full-set-consumer-service");
  const lostCapability = parseCapabilityName("org.example.full-set-lost");
  const otherCapability = parseCapabilityName("org.example.full-set-other");
  const providerADigest = parseArtifactDigest(`sha256:${"3".repeat(64)}`);
  const providerBDigest = parseArtifactDigest(`sha256:${"4".repeat(64)}`);
  const consumerDigest = parseArtifactDigest(`sha256:${"5".repeat(64)}`);
  const component = (target: ComponentInstance["componentId"]) => ({
    componentId: target,
    kind: "service" as const,
    entrypoint: `components/${target}.js`,
    executors: ["process" as const],
  });
  const providerManifest = (
    targetPluginId: PluginManifest["pluginId"],
    targetComponentId: ComponentInstance["componentId"],
    capability: typeof lostCapability,
  ): PluginManifest => ({
    ...manifest("1.0.0", providerADigest),
    pluginId: targetPluginId,
    components: [component(targetComponentId)],
    capabilities: {
      provides: [capabilityProvision(capability, "1.0.0")],
      requires: [],
    },
  });
  const providerAManifest = providerManifest(providerAId, providerAComponentId, lostCapability);
  const providerBManifest = providerManifest(providerBId, providerBComponentId, otherCapability);
  const consumerManifest: PluginManifest = {
    ...manifest("1.0.0", consumerDigest),
    pluginId: consumerId,
    components: [component(consumerComponentId)],
    capabilities: {
      provides: [],
      requires: [
        { name: lostCapability, protocolRange: "^1.0.0", lossPolicy: "suspend" },
        { name: otherCapability, protocolRange: "^1.0.0", lossPolicy: "suspend" },
      ],
    },
  };
  const providerA = deployment("1", {
    pluginId: providerAId,
    artifactDigest: providerADigest,
  });
  const providerB = deployment("1", {
    pluginId: providerBId,
    artifactDigest: providerBDigest,
  });
  const consumer = deployment("1", {
    pluginId: consumerId,
    artifactDigest: consumerDigest,
    essential: true,
  });
  const installations: PluginInstallation[] = [
    {
      ...installation("1.0.0", providerADigest),
      pluginId: providerAId,
      manifest: providerAManifest,
    },
    {
      ...installation("1.0.0", providerBDigest),
      pluginId: providerBId,
      manifest: providerBManifest,
    },
    {
      ...installation("1.0.0", consumerDigest),
      pluginId: consumerId,
      manifest: consumerManifest,
    },
  ];
  const artifacts = new Map(
    installations.map((installed) => [
      installed.digest,
      {
        digest: installed.digest,
        files: { schemaVersion: "1.0" as const, files: [] },
        manifest: installed.manifest,
      },
    ]),
  );
  const planned = (desired: PluginDeployment, installed: PluginInstallation, activation = "1") => {
    const artifact = artifacts.get(installed.digest);
    const installedComponent = installed.manifest.components[0];
    assert.ok(artifact);
    assert.ok(installedComponent);
    const step = planReconcile({
      deployment: desired,
      gate: { ...gate(installed), artifact },
      instances: [],
      now: clock.now().toISOString(),
      supportedExecutors: ["process"],
      activations: { [installedComponent.componentId]: activation },
    }).steps[0];
    assert.ok(step);
    return step.effect;
  };
  const [providerAInstallation, providerBInstallation, consumerInstallation] = installations;
  assert.ok(providerAInstallation);
  assert.ok(providerBInstallation);
  assert.ok(consumerInstallation);
  const providerAInstance = planned(providerA, providerAInstallation);
  const providerBInstance = planned(providerB, providerBInstallation);
  const recoveryInstance = planned(consumer, consumerInstallation, "2");
  await state.transact({}, async (transaction) => {
    for (const effect of [providerAInstance, providerBInstance, recoveryInstance]) {
      await transaction.put(
        {
          namespace: "tego",
          collection: "component-instances",
          id: effect.instanceId,
        },
        {
          activation: effect.activation,
          applicationId: effect.applicationId,
          artifactDigest: effect.artifactDigest,
          componentId: effect.componentId,
          deploymentGeneration: effect.deploymentGeneration,
          executor: effect.executor,
          instanceId: effect.instanceId,
          lifecycle: effect === recoveryInstance ? "preparing" : "ready",
          observedGeneration: effect.deploymentGeneration,
          pluginId: effect.pluginId,
        },
        { expectedRevision: "absent" },
      );
    }
    await transaction.put(
      {
        namespace: "tego",
        collection: "provider-loss",
        id: `${applicationId}/${consumerId}`,
      },
      {
        consumer: { applicationId, pluginId: consumerId },
        deploymentGeneration: consumer.generation,
        action: "suspend",
        capabilities: [lostCapability],
        providers: [{ applicationId, pluginId: providerAId }],
        bindingPrerequisites: [
          {
            capability: lostCapability,
            provider: { applicationId, pluginId: providerAId },
            providerGeneration: providerA.generation,
          },
          {
            capability: otherCapability,
            provider: { applicationId, pluginId: providerBId },
            providerGeneration: providerB.generation,
          },
        ],
        recoveryActivations: { [consumerComponentId]: "2" },
        updatedAt: clock.now().toISOString(),
      },
      { expectedRevision: "absent" },
    );
    await transaction.put(
      {
        namespace: "tego",
        collection: "capability-bindings",
        id: `${applicationId}/${consumerId}/${lostCapability}`,
      },
      {
        consumer: { applicationId, pluginId: consumerId },
        capability: lostCapability,
        provider: { applicationId, pluginId: providerAId },
        source: "automatic",
        deploymentGeneration: consumer.generation,
        updatedAt: clock.now().toISOString(),
      },
      { expectedRevision: "absent" },
    );
    await transaction.put(
      {
        namespace: "tego",
        collection: "capability-bindings",
        id: `${applicationId}/${consumerId}/${otherCapability}`,
      },
      {
        consumer: { applicationId, pluginId: consumerId },
        capability: otherCapability,
        provider: { applicationId, pluginId: providerBId },
        source: "automatic",
        deploymentGeneration: consumer.generation,
        updatedAt: clock.now().toISOString(),
      },
      { expectedRevision: "absent" },
    );
    return null;
  });
  const effects = new RecordingEffects();
  effects.live.add(providerAInstance.instanceId);
  effects.live.add(providerBInstance.instanceId);
  const isLive = effects.isLive.bind(effects);
  let droppedAfterSnapshot = false;
  effects.isLive = (instance) => {
    const live = isLive(instance);
    if (instance.instanceId === providerBInstance.instanceId && !droppedAfterSnapshot) {
      droppedAfterSnapshot = true;
      const key = stateIdentifier({
        namespace: "tego",
        collection: "component-instances",
        id: providerBInstance.instanceId,
      });
      const current = state.records.get(key);
      assert.ok(current);
      state.records.set(key, {
        ...current,
        value: {
          ...(current.value as Record<string, JsonValue>),
          lifecycle: "degraded",
        },
      });
    }
    return live;
  };
  const reconciler = new Reconciler({
    artifactGate: {
      validate: async (request) => {
        const artifact = artifacts.get(request.digest);
        assert.ok(artifact);
        return artifact;
      },
    },
    clock,
    effects,
    state,
    loadDeployments: async () => [providerA, providerB, consumer],
    loadInstallations: async () => installations,
  });

  await reconciler.start();

  assert.deepEqual(effects.restored, []);
  assert.equal(
    effects.calls.some(
      (effect) => effect.instanceId === recoveryInstance.instanceId && effect.kind === "start",
    ),
    false,
  );
  assert.equal(
    (
      (
        await state.read({
          namespace: "tego",
          collection: "component-instances",
          id: recoveryInstance.instanceId,
        })
      )?.value as { readonly lifecycle?: string } | undefined
    )?.lifecycle,
    "stopped",
  );
  assert.equal(
    (
      (
        await state.read({
          namespace: "tego",
          collection: "provider-loss",
          id: `${applicationId}/${consumerId}`,
        })
      )?.value as { readonly recoveryActivations?: Readonly<Record<string, string>> } | undefined
    )?.recoveryActivations,
    undefined,
  );
  await reconciler.stop();
});

test("journaled execution persists before effect, commits with expected revision and authority, and rereads conflicts", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  state.failNextObservedCommit = true;
  const authority = {
    resource: "runtime:app",
    epoch: parseFencingEpoch("8"),
  };
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    authority,
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();
  await reconciler.wake();

  assert.equal(effects.performed.length >= 1, true);
  assert.equal(effects.uniqueOperations.size, effects.performed.length);
  assert.equal(
    [...state.operations.values()].some((entry) => entry.status === "completed"),
    true,
  );
  assert.equal(
    [...state.records.values()].some(
      (entry) => (entry.value as { readonly lifecycle?: string }).lifecycle === "ready",
    ),
    true,
  );
  assert.equal(reconciler.lastCommitAuthority?.epoch, authority.epoch);
  assert.equal(reconciler.replanCount >= 1, true);
  await reconciler.stop();
});

test("retry pre-state revision conflicts replan before external execution", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const instance: ComponentInstance = {
    activation: "1",
    applicationId,
    artifactDigest: digestOne,
    componentId,
    deploymentGeneration: parseGeneration("1"),
    executor: "process",
    instanceId: "app.org_dexample_decho.echo-service.g1.a1",
    lifecycle: "failed",
    observedGeneration: parseGeneration("1"),
    pluginId,
    retryAt: clock.now().toISOString(),
    retryEffect: "start",
    revision: parseRevision("1"),
  };
  const effect = planReconcile(snapshot(deployment(), [instance])).steps[0]?.effect;
  assert.ok(effect);
  const now = clock.now().toISOString();
  await state.transact({}, async (transaction) => {
    const { revision: _revision, ...persisted } = instance;
    void _revision;
    await transaction.put(
      {
        namespace: "tego",
        collection: "component-instances",
        id: instance.instanceId,
      },
      persisted,
      { expectedRevision: "absent" },
    );
    await transaction.enqueueOutbox({
      availableAt: now,
      createdAt: now,
      messageId: effect.messageId,
      operationId: effect.operationId,
      payload: effect,
      topic: "component.lifecycle",
    });
    return null;
  });
  state.failNextExecutionPreStateCommit = true;
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    authority: {
      resource: "runtime:app",
      epoch: parseFencingEpoch("8"),
    },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.deepEqual(
    effects.calls.map((candidate) => candidate.kind),
    ["start"],
  );
  assert.equal(reconciler.replanCount >= 1, true);
  const ready = await state.read({
    namespace: "tego",
    collection: "component-instances",
    id: instance.instanceId,
  });
  assert.equal((ready?.value as { readonly lifecycle?: string } | undefined)?.lifecycle, "ready");
  await reconciler.stop();
});

test("restart before acknowledgement reuses stable identity and leaves one live instance", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const effects = new RecordingEffects();
  const options = {
    artifactGate: { validate: async () => gate().artifact },
    authority: {
      resource: "runtime:app",
      epoch: parseFencingEpoch("9") as FencingEpoch,
    },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  };
  const first = new Reconciler({ ...options, interruptAfterEffect: true });
  await first.start();
  await first.stop();

  clock.advance(31_000);
  const second = new Reconciler(options);
  await second.start();
  await second.wake();

  const live = [...state.records.values()].filter(
    (entry) =>
      entry.key.collection === "component-instances" &&
      (entry.value as { readonly lifecycle?: string }).lifecycle !== "stopped" &&
      (entry.value as { readonly lifecycle?: string }).lifecycle !== "failed",
  );
  assert.equal(live.length, 1);
  assert.equal(effects.uniqueOperations.size, 2);
  assert.equal(
    effects.performed.every(
      (effect) =>
        effect.messageId ===
        parseMessageId(`reconcile.app.org_dexample_decho.echo-service.g1.a1.${effect.kind}`),
    ),
    true,
  );
  await second.stop();
});

test("restart after observed commit but before acknowledgement does not repeat the external effect", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const effects = new RecordingEffects();
  const options = {
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  };
  state.failNextAcknowledgement = true;
  const first = new Reconciler(options);
  await assert.rejects(first.start(), /acknowledgement unavailable/u);
  await first.stop();

  clock.advance(31_000);
  const second = new Reconciler(options);
  await second.start();

  assert.equal(effects.calls.filter((effect) => effect.kind === "prepare").length, 1);
  assert.equal(effects.calls.filter((effect) => effect.kind === "start").length, 1);
  assert.equal(
    [...state.operations.values()].filter((entry) => entry.status === "completed").length,
    2,
  );
  await second.stop();
});

test("completed-operation history prevents an old prepare replay after start completes", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const effects = new RecordingEffects();
  const options = {
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  };
  state.failNextAcknowledgement = true;
  const first = new Reconciler(options);
  await assert.rejects(first.start(), /acknowledgement unavailable/u);
  await first.stop();

  const second = new Reconciler(options);
  await second.start();
  clock.advance(31_000);
  await second.wake();

  assert.equal(effects.calls.filter((effect) => effect.kind === "prepare").length, 1);
  assert.equal(effects.calls.filter((effect) => effect.kind === "start").length, 1);
  await second.stop();
});

test("a queued startup effect is discarded when desired state becomes disabled", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const effects = new RecordingEffects();
  let desired = deployment();
  const options = {
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [desired],
    loadInstallations: async () => [installation()],
  };
  const first = new Reconciler({ ...options, interruptAfterEffect: true });
  await first.start();
  await first.stop();

  desired = deployment("2", { state: "disabled" });
  clock.advance(31_000);
  const second = new Reconciler(options);
  await second.start();
  await second.wake();

  assert.equal(effects.calls.filter((effect) => effect.kind === "prepare").length, 1);
  assert.deepEqual(
    effects.calls.slice(-2).map((effect) => effect.kind),
    ["drain", "stop"],
  );
  assert.equal(second.replanCount, 1);
  await second.stop();
});

test("disabled deployments can drain persisted instances after installation removal", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const effects = new RecordingEffects();
  const active = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });
  await active.start();
  await active.stop();

  const disabled = new Reconciler({
    artifactGate: {
      validate: async () => {
        throw new Error("disabled deployment must not validate an artifact");
      },
    },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment("2", { state: "disabled" })],
    loadInstallations: async () => [],
  });
  await disabled.start();

  assert.deepEqual(
    effects.performed.slice(-2).map((effect) => effect.kind),
    ["drain", "stop"],
  );
  await disabled.stop();
});

test("active upgrades retain failed teardown diagnostics from obsolete generations", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const effects = new RecordingEffects();
  let desired = deployment();
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [desired],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();
  desired = deployment("2");
  effects.failStop = true;
  await reconciler.wake();

  assert.equal(
    reconciler.diagnostics().some((diagnostic) => diagnostic.code === "LIFECYCLE_STOP_FAILED"),
    true,
  );
  assert.equal(
    (
      [...state.records.values()].find(
        (entry) => entry.key.collection === "deployment-observations",
      )?.value as { readonly status?: string } | undefined
    )?.status,
    "failed",
  );
  await reconciler.stop();
});

test("stale desired state invalidates a planned effect before it is journaled", async () => {
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  const effects = new RecordingEffects();
  let loads = 0;
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => {
      loads += 1;
      return [deployment(loads === 1 ? "1" : "2")];
    },
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.deepEqual(
    effects.calls.map((effect) => [effect.deploymentGeneration, effect.kind]),
    [
      ["2", "prepare"],
      ["2", "start"],
    ],
  );
  assert.equal(reconciler.replanCount, 1);
  await reconciler.stop();
});

test("component start failure records failure and only essential deployment readiness changes", async () => {
  for (const essential of [false, true]) {
    const clock = new ManualClock();
    const effects = new RecordingEffects();
    effects.failStart = true;
    const state = await createHarnessStore(clock);
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate().artifact },
      clock,
      effects,
      state,
      loadDeployments: async () => [deployment("1", { essential })],
      loadInstallations: async () => [installation()],
    });

    await reconciler.start();
    await reconciler.wake();

    assert.equal(reconciler.kernelRunning, true);
    assert.equal(reconciler.applicationReady(), !essential);
    const observation = [...state.records.values()].find(
      (entry) => entry.key.collection === "deployment-observations",
    );
    assert.equal(
      (observation?.value as { readonly status?: string } | undefined)?.status,
      "failed",
    );
    assert.equal(
      reconciler
        .diagnostics()
        .some((item: { readonly code: string }) => item.code === "LIFECYCLE_START_FAILED"),
      true,
    );
    await reconciler.wake();
    assert.equal(
      reconciler
        .diagnostics()
        .some((item: { readonly code: string }) => item.code === "LIFECYCLE_START_FAILED"),
      true,
    );
    await reconciler.stop();
  }
});

test("deployment observations are ready when wake convergence completes", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();
  const observation = () =>
    [...state.records.values()].find((entry) => entry.key.collection === "deployment-observations");
  assert.equal((observation()?.value as { readonly status?: string } | undefined)?.status, "ready");
  const settledRevision = observation()?.revision;
  const settledUpdatedAt = (observation()?.value as { readonly updatedAt?: string } | undefined)
    ?.updatedAt;

  clock.advance(1_000);
  await reconciler.wake();
  assert.equal((observation()?.value as { readonly status?: string } | undefined)?.status, "ready");
  assert.equal(observation()?.revision, settledRevision);
  assert.equal(
    (observation()?.value as { readonly updatedAt?: string } | undefined)?.updatedAt,
    settledUpdatedAt,
  );
  await reconciler.stop();
});

test("stable blocked deployment observations do not churn only because observedAt advances", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [
      deployment("1", {
        permissionGrants: [{ kind: "executor", executors: ["thread"] }],
      }),
    ],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();
  const observation = () =>
    [...state.records.values()].find((entry) => entry.key.collection === "deployment-observations");
  const settledRevision = observation()?.revision;
  const settledUpdatedAt = (observation()?.value as { readonly updatedAt?: string } | undefined)
    ?.updatedAt;

  clock.advance(1_000);
  await reconciler.wake();

  assert.equal(observation()?.revision, settledRevision);
  assert.equal(
    (observation()?.value as { readonly updatedAt?: string } | undefined)?.updatedAt,
    settledUpdatedAt,
  );
  await reconciler.stop();
});

test("one wake converges immediately available lifecycle effects to quiescence", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.deepEqual(
    effects.performed.map((effect) => effect.kind),
    ["prepare", "start"],
  );
  assert.equal(reconciler.applicationReady(), true);
  await reconciler.stop();
});

test("wake fails closed when immediate lifecycle work exceeds its pass budget", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    maxConvergencePasses: 1,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  await assert.rejects(reconciler.start(), /did not converge within 1 pass/u);
  assert.equal(reconciler.kernelRunning, false);
  assert.equal(effects.live.size, 0);
});

test("a later wake budget failure stops an already-started reconciler", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  let deployments: readonly PluginDeployment[] = [];
  const backgroundErrors: unknown[] = [];
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    maxConvergencePasses: 1,
    state,
    loadDeployments: async () => deployments,
    loadInstallations: async () => [installation()],
    onBackgroundError: (error) => {
      backgroundErrors.push(error);
    },
  });

  await reconciler.start();
  assert.equal(reconciler.kernelRunning, true);

  deployments = [deployment()];
  await assert.rejects(reconciler.wake(), /did not converge within 1 pass/u);

  assert.equal(reconciler.kernelRunning, false);
  assert.equal(effects.live.size, 0);
  assert.equal(backgroundErrors.length, 1);
});

test("the convergence pass budget counts lifecycle work without an extra idle proof pass", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    maxConvergencePasses: 2,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.deepEqual(
    effects.performed.map((effect) => effect.kind),
    ["prepare", "start"],
  );
  assert.equal(reconciler.applicationReady(), true);
  await reconciler.stop();
});

test("a recovered final commit conflict does not consume another convergence pass", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  state.failNextObservedCommit = true;
  state.failNextObservedCommitKind = "start";
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    maxConvergencePasses: 2,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();

  assert.deepEqual(
    effects.performed.map((effect) => effect.kind),
    ["prepare", "start"],
  );
  assert.equal(reconciler.applicationReady(), true);
  await reconciler.stop();
});

test("interruptAfterEffect terminates the whole convergence loop after one external effect", async () => {
  const secondComponentId = parseComponentId("second-service");
  const value = installation();
  const twoComponentManifest: PluginManifest = {
    ...value.manifest,
    components: [
      ...value.manifest.components,
      {
        componentId: secondComponentId,
        kind: "service",
        entrypoint: "components/second.js",
        executors: ["process"],
      },
    ],
  };
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const reconciler = new Reconciler({
    artifactGate: {
      validate: async () => ({ ...gate().artifact, manifest: twoComponentManifest }),
    },
    clock,
    effects,
    interruptAfterEffect: true,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [{ ...value, manifest: twoComponentManifest }],
  });

  await reconciler.start();

  assert.equal(effects.calls.length, 1);
  await reconciler.stop();
});

test("stop prevents a gated reconciliation pass from starting a new external effect", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<ReturnType<typeof gate>["artifact"]>();
  const reconciler = new Reconciler({
    artifactGate: {
      validate: async () => {
        entered.resolve();
        return release.promise;
      },
    },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  const starting = reconciler.start();
  await entered.promise;
  const stopping = reconciler.stop();
  release.resolve(gate().artifact);
  await Promise.all([starting, stopping]);

  assert.deepEqual(effects.calls, []);
  assert.equal(reconciler.kernelRunning, false);
});

test("failed lifecycle effects wake automatically when retryAt becomes due", async () => {
  const clock = new ScheduledClock();
  const effects = new RecordingEffects();
  effects.failStart = true;
  const state = await createHarnessStore(clock);
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();
  assert.deepEqual(
    effects.calls.map((effect) => effect.kind),
    ["prepare", "start"],
  );
  effects.failStart = false;

  clock.advance(60_000);
  for (let turn = 0; turn < 20 && effects.calls.length < 3; turn += 1) {
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }

  assert.deepEqual(
    effects.calls.map((effect) => effect.kind),
    ["prepare", "start", "start"],
  );
  assert.equal(reconciler.applicationReady(), true);
  await reconciler.stop();
});

test("deferred scheduler failure is observable and fails the reconciler closed", async () => {
  const clock = new RejectingSleepClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const backgroundErrors: unknown[] = [];
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [],
    loadInstallations: async () => [],
    onBackgroundError: (error) => {
      backgroundErrors.push(error);
    },
  });

  await assert.rejects(reconciler.start(), /scheduler unavailable/u);

  assert.equal(reconciler.kernelRunning, false);
  assert.equal(backgroundErrors.length, 0);
  assert.equal(
    reconciler
      .diagnostics()
      .some((diagnostic) => diagnostic.code === "LIFECYCLE_RECONCILE_BACKGROUND_FAILED"),
    true,
  );
});

test("an abandoned lifecycle claim is recovered automatically after its lease expires", async () => {
  const clock = new ScheduledClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  const options = {
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  };
  const abandoned = new Reconciler({
    ...options,
    interruptAfterEffect: true,
    owner: "abandoned-runtime",
  });

  await abandoned.start();
  assert.deepEqual(
    effects.calls.map((effect) => effect.kind),
    ["prepare"],
  );
  await abandoned.stop();

  const recovered = new Reconciler({ ...options, owner: "replacement-runtime" });
  await recovered.start();
  assert.deepEqual(
    effects.calls.map((effect) => effect.kind),
    ["prepare"],
  );

  await recovered.wake();
  clock.advance(30_001);
  for (let turn = 0; turn < 20 && effects.calls.length < 3; turn += 1) {
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }

  assert.deepEqual(
    effects.calls.map((effect) => effect.kind),
    ["prepare", "prepare", "start"],
  );
  assert.equal(recovered.applicationReady(), true);
  await recovered.stop();
});

test("an exhausted lifecycle commit conflict is recovered automatically after its lease expires", async () => {
  const clock = new ScheduledClock();
  const effects = new RecordingEffects();
  const state = await createHarnessStore(clock);
  let deployments: readonly PluginDeployment[] = [];
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => deployments,
    loadInstallations: async () => [installation()],
  });

  await reconciler.start();
  clock.advance(30_001);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

  deployments = [deployment()];
  state.observedCommitConflicts = 3;
  await reconciler.wake();
  assert.deepEqual(
    effects.calls.map((effect) => effect.kind),
    ["prepare"],
  );

  clock.advance(30_001);
  for (let turn = 0; turn < 20 && effects.calls.length < 3; turn += 1) {
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }

  assert.deepEqual(
    effects.calls.map((effect) => effect.kind),
    ["prepare", "prepare", "start"],
  );
  assert.equal(reconciler.applicationReady(), true);
  await reconciler.stop();
});

test("deployment observations expose blocked and degraded public states", async () => {
  for (const [expected, instances, installations] of [
    ["blocked", [], []],
    [
      "blocked",
      [
        {
          key: "duplicate-a",
          instanceId: "app.org_dexample_decho.echo-service.g1",
          lifecycle: "ready",
        },
        {
          key: "duplicate-b",
          instanceId: "app.org_dexample_decho.echo-service.g1",
          lifecycle: "ready",
        },
      ],
      [installation()],
    ],
    [
      "degraded",
      [
        {
          key: "app.org_dexample_decho.echo-service.g1",
          instanceId: "app.org_dexample_decho.echo-service.g1",
          lifecycle: "degraded",
        },
      ],
      [installation()],
    ],
  ] as const) {
    const clock = new ManualClock();
    const effects = new RecordingEffects();
    const state = await createHarnessStore(clock);
    for (const value of instances) {
      await state.transact({}, async (transaction) => {
        await transaction.put(
          {
            namespace: "tego",
            collection: "component-instances",
            id: value.key,
          },
          {
            applicationId,
            artifactDigest: digestOne,
            componentId,
            deploymentGeneration: parseGeneration("1"),
            executor: "process",
            instanceId: value.instanceId,
            lifecycle: value.lifecycle,
            observedGeneration: parseGeneration("1"),
            pluginId,
          },
          { expectedRevision: "absent" },
        );
        return null;
      });
    }
    const reconciler = new Reconciler({
      artifactGate: { validate: async () => gate().artifact },
      clock,
      effects,
      state,
      loadDeployments: async () => [deployment()],
      loadInstallations: async () => installations,
    });

    await reconciler.start();

    const observation = [...state.records.values()].find(
      (entry) => entry.key.collection === "deployment-observations",
    );
    assert.equal(
      (observation?.value as { readonly status?: string } | undefined)?.status,
      expected,
    );
    await reconciler.stop();
  }
});

test("failed effect conditional commits reread after a revision conflict", async () => {
  const clock = new ManualClock();
  const effects = new RecordingEffects();
  effects.failStart = true;
  const state = await createHarnessStore(clock);
  const reconciler = new Reconciler({
    artifactGate: { validate: async () => gate().artifact },
    clock,
    effects,
    state,
    loadDeployments: async () => [deployment()],
    loadInstallations: async () => [installation()],
  });

  state.failNextFailureCommit = true;
  await reconciler.start();

  assert.equal(reconciler.replanCount, 1);
  assert.equal(
    [...state.operations.values()].some((operation) => operation.status === "failed"),
    true,
  );
  assert.equal(reconciler.kernelRunning, true);
  await reconciler.stop();
});

async function createProviderLossTestFixture(
  suffix: string,
  policies: readonly ("degrade" | "fail" | "suspend")[],
  essential = true,
) {
  const providerId = parsePluginId(`loss-provider-${suffix}`);
  const consumerId = parsePluginId(`loss-consumer-${suffix}`);
  const providerComponentId = parseComponentId(`loss-provider-${suffix}-service`);
  const consumerComponentId = parseComponentId(`loss-consumer-${suffix}-service`);
  const capabilities = policies.map((_, index) =>
    parseCapabilityName(`org.example.loss-${suffix}-${index}`),
  );
  const providerDigest = parseArtifactDigest(`sha256:${"e".repeat(64)}`);
  const consumerDigest = parseArtifactDigest(`sha256:${"f".repeat(64)}`);
  const component = (targetComponentId: ReturnType<typeof parseComponentId>) => ({
    componentId: targetComponentId,
    kind: "service" as const,
    entrypoint: `components/${targetComponentId}.js`,
    executors: ["process" as const],
  });
  const providerManifest: PluginManifest = {
    ...manifest("1.0.0", providerDigest),
    pluginId: providerId,
    components: [component(providerComponentId)],
    capabilities: {
      provides: capabilities.map((name) => capabilityProvision(name, "1.0.0")),
      requires: [],
    },
  };
  const consumerManifest: PluginManifest = {
    ...manifest("1.0.0", consumerDigest),
    pluginId: consumerId,
    components: [component(consumerComponentId)],
    capabilities: {
      provides: [],
      requires: policies.map((lossPolicy, index) => ({
        name: parseCapabilityName(`org.example.loss-${suffix}-${index}`),
        protocolRange: "^1.0.0",
        lossPolicy,
      })),
    },
  };
  const installations: PluginInstallation[] = [
    {
      ...installation("1.0.0", providerDigest),
      pluginId: providerId,
      manifest: providerManifest,
    },
    {
      ...installation("1.0.0", consumerDigest),
      pluginId: consumerId,
      manifest: consumerManifest,
    },
  ];
  const artifacts = new Map(
    installations.map((installed) => [
      installed.digest,
      {
        digest: installed.digest,
        files: { schemaVersion: "1.0" as const, files: [] },
        manifest: installed.manifest,
      },
    ]),
  );
  const provider = deployment("1", { pluginId: providerId, artifactDigest: providerDigest });
  const consumer = deployment("1", {
    pluginId: consumerId,
    artifactDigest: consumerDigest,
    essential,
  });
  const deploymentKey = (desired: PluginDeployment): StateKey<PluginDeployment> => ({
    namespace: "tego",
    collection: "deployments",
    id: `${desired.applicationId}/${desired.pluginId}`,
  });
  const lossKey: StateKey<JsonValue> = {
    namespace: "tego",
    collection: "provider-loss",
    id: `${applicationId}/${consumerId}`,
  };
  const observationKey: StateKey<JsonValue> = {
    namespace: "tego",
    collection: "deployment-observations",
    id: `${applicationId}/${consumerId}`,
  };
  const clock = new ManualClock();
  const state = await createHarnessStore(clock);
  await state.transact({}, async (transaction) => {
    for (const desired of [provider, consumer]) {
      await transaction.put(deploymentKey(desired), desired, { expectedRevision: "absent" });
    }
    for (const installed of installations) {
      await transaction.put(
        {
          namespace: "tego",
          collection: "installations",
          id: `${installed.pluginId}@${installed.version}@${installed.digest}`,
        },
        installed,
        { expectedRevision: "absent" },
      );
    }
    return null;
  });
  const options = (effects: RecordingEffects) => ({
    artifactGate: {
      async validate(request: { readonly digest: ArtifactDigest }) {
        const artifact = artifacts.get(request.digest);
        assert.ok(artifact);
        return artifact;
      },
    },
    clock,
    effects,
    state,
    loadInstallations: async () => installations,
  });
  const failProvider = async (providerStart: ReconcileEffect) => {
    const key = {
      namespace: "tego",
      collection: "component-instances",
      id: providerStart.instanceId,
    };
    await state.transact({}, async (transaction) => {
      const current = await transaction.get(key);
      assert.ok(current);
      await transaction.put(
        key,
        { ...(current.value as Record<string, JsonValue>), lifecycle: "degraded" },
        { expectedRevision: current.revision },
      );
      return null;
    });
  };
  const recoverProvider = async (providerStart: ReconcileEffect) => {
    const key = {
      namespace: "tego",
      collection: "component-instances",
      id: providerStart.instanceId,
    };
    await state.transact({}, async (transaction) => {
      const current = await transaction.get(key);
      assert.ok(current);
      await transaction.put(
        key,
        { ...(current.value as Record<string, JsonValue>), lifecycle: "ready" },
        { expectedRevision: current.revision },
      );
      return null;
    });
  };
  return {
    consumer,
    consumerComponentId,
    consumerId,
    deploymentKey,
    failProvider,
    lossKey,
    observationKey,
    options,
    provider,
    providerId,
    recoverProvider,
    state,
  };
}

test("sequential provider loss upgrades one durable record after restart", async () => {
  for (const initialAction of ["degrade", "suspend"] as const) {
    const fixture = await createProviderLossTestFixture(`sequential-${initialAction}`, ["fail"]);
    const firstEffects = new RecordingEffects();
    const first = new Reconciler(fixture.options(firstEffects));
    await first.start();
    const providerStart = firstEffects.calls.find(
      (effect) => effect.pluginId === fixture.providerId && effect.kind === "start",
    );
    const consumerStart = firstEffects.calls.find(
      (effect) => effect.pluginId === fixture.consumerId && effect.kind === "start",
    );
    assert.ok(providerStart);
    assert.ok(consumerStart);
    await first.stop();

    await fixture.state.transact({}, async (transaction) => {
      const consumerKey = {
        namespace: "tego",
        collection: "component-instances",
        id: consumerStart.instanceId,
      };
      const currentConsumer = await transaction.get(consumerKey);
      assert.ok(currentConsumer);
      await transaction.put(
        consumerKey,
        {
          ...(currentConsumer.value as Record<string, JsonValue>),
          lifecycle: initialAction === "degrade" ? "degraded" : "stopped",
        },
        { expectedRevision: currentConsumer.revision },
      );
      await transaction.put(
        fixture.lossKey,
        {
          consumer: { applicationId, pluginId: fixture.consumerId },
          deploymentGeneration: fixture.consumer.generation,
          action: initialAction,
          capabilities: [parseCapabilityName(`org.example.loss-prior-${initialAction}`)],
          providers: [{ applicationId, pluginId: fixture.providerId }],
          recoveryActivations: { [fixture.consumerComponentId]: "2" },
          updatedAt: new ManualClock().now().toISOString(),
        },
        { expectedRevision: "absent" },
      );
      return null;
    });
    await fixture.failProvider(providerStart);

    const restartedEffects = new RecordingEffects();
    const restarted = new Reconciler(fixture.options(restartedEffects));
    await restarted.start();

    const loss = await fixture.state.read(fixture.lossKey);
    assert.equal((loss?.value as { readonly action?: string } | undefined)?.action, "fail");
    assert.deepEqual(
      (
        loss?.value as
          | { readonly capabilities?: readonly string[]; readonly recoveryActivations?: object }
          | undefined
      )?.capabilities,
      [
        parseCapabilityName(`org.example.loss-prior-${initialAction}`),
        parseCapabilityName(`org.example.loss-sequential-${initialAction}-0`),
      ],
    );
    assert.equal(
      (
        loss?.value as
          | { readonly recoveryActivations?: Readonly<Record<string, string>> }
          | undefined
      )?.recoveryActivations,
      undefined,
    );
    assert.equal(
      [...fixture.state.records.values()].filter(
        (record) =>
          record.key.collection === "provider-loss" && record.key.id === fixture.lossKey.id,
      ).length,
      1,
    );
    assert.equal(
      (
        (await fixture.state.read(fixture.observationKey))?.value as
          | { readonly status?: string }
          | undefined
      )?.status,
      "failed",
    );
    await restarted.stop();
  }
});

test("legacy provider loss infers started only from unambiguous ready lifecycles", async () => {
  for (const lifecycle of [
    "created",
    "preparing",
    "starting",
    "ready",
    "degraded",
    "draining",
    "stopping",
    "stopped",
    "failed",
  ] as const) {
    const expectedStarted = lifecycle === "ready" || lifecycle === "degraded";
    assert.equal(inferComponentHasStarted({ lifecycle }), expectedStarted, lifecycle);
  }
});

test("explicit hasStarted survives every lifecycle checkpoint", async () => {
  for (const lifecycle of [
    "created",
    "preparing",
    "starting",
    "ready",
    "degraded",
    "draining",
    "stopping",
    "stopped",
    "failed",
  ] as const) {
    assert.equal(inferComponentHasStarted({ hasStarted: true, lifecycle }), true, lifecycle);
  }
});

test("recovery start is reauthorized after its executing journal commit", async () => {
  const fixture = await createProviderLossTestFixture("recovery-execution-fence", ["suspend"]);
  const effects = new RecordingEffects();
  const reconciler = new Reconciler(fixture.options(effects));
  await reconciler.start();
  const providerStart = effects.calls.find(
    (effect) => effect.pluginId === fixture.providerId && effect.kind === "start",
  );
  assert.ok(providerStart);

  await fixture.failProvider(providerStart);
  await reconciler.wake();
  await fixture.recoverProvider(providerStart);
  fixture.state.afterNextExecutingCommit = async (effect) => {
    assert.equal(effect.pluginId, fixture.consumerId);
    assert.equal(effect.kind, "prepare");
    await fixture.failProvider(providerStart);
  };
  await reconciler.wake();

  assert.deepEqual(
    effects.calls.filter(
      (effect) =>
        effect.pluginId === fixture.consumerId &&
        effect.activation === "2" &&
        effect.kind === "prepare",
    ),
    [],
  );
  const loss = await fixture.state.read(fixture.lossKey);
  assert.equal((loss?.value as { readonly action?: string } | undefined)?.action, "suspend");
  await reconciler.stop();
});

test("recovery effect is fenced by the current consumer instance revision", async () => {
  const fixture = await createProviderLossTestFixture("recovery-instance-fence", ["suspend"]);
  const effects = new RecordingEffects();
  const reconciler = new Reconciler(fixture.options(effects));
  await reconciler.start();
  const providerStart = effects.calls.find(
    (effect) => effect.pluginId === fixture.providerId && effect.kind === "start",
  );
  assert.ok(providerStart);

  await fixture.failProvider(providerStart);
  await reconciler.wake();
  await fixture.recoverProvider(providerStart);
  fixture.state.afterNextExecutingCommit = async (effect) => {
    assert.equal(effect.pluginId, fixture.consumerId);
    const key = {
      namespace: "tego",
      collection: "component-instances",
      id: effect.instanceId,
    };
    await fixture.state.transact({}, async (transaction) => {
      const current = await transaction.get(key);
      assert.ok(current);
      await transaction.put(
        key,
        {
          ...(current.value as Record<string, JsonValue>),
          artifactDigest: digestOne,
        },
        { expectedRevision: current.revision },
      );
      return null;
    });
  };
  await reconciler.wake();

  assert.deepEqual(
    effects.calls.filter(
      (effect) =>
        effect.pluginId === fixture.consumerId &&
        effect.activation === "2" &&
        effect.kind === "prepare",
    ),
    [],
  );
  await reconciler.stop();
});

test("recovery claim replans when its exact instance receives a legal revision", async () => {
  const fixture = await createProviderLossTestFixture("recovery-instance-retry", ["suspend"]);
  const effects = new RecordingEffects();
  const reconciler = new Reconciler(fixture.options(effects));
  await reconciler.start();
  const providerStart = effects.calls.find(
    (effect) => effect.pluginId === fixture.providerId && effect.kind === "start",
  );
  assert.ok(providerStart);

  await fixture.failProvider(providerStart);
  await reconciler.wake();
  await fixture.recoverProvider(providerStart);
  fixture.state.afterNextExecutingCommit = async (effect) => {
    assert.equal(effect.pluginId, fixture.consumerId);
    assert.equal(effect.kind, "prepare");
    const key = {
      namespace: "tego",
      collection: "component-instances",
      id: effect.instanceId,
    };
    await fixture.state.transact({}, async (transaction) => {
      const current = await transaction.get(key);
      assert.ok(current);
      await transaction.put(
        key,
        {
          ...(current.value as Record<string, JsonValue>),
          hasStarted: false,
        },
        { expectedRevision: current.revision },
      );
      return null;
    });
  };
  await reconciler.wake();

  assert.equal(
    effects.calls.filter(
      (effect) =>
        effect.pluginId === fixture.consumerId &&
        effect.activation === "2" &&
        effect.kind === "prepare",
    ).length,
    1,
  );
  await reconciler.wake();
  assert.equal(
    effects.calls.filter(
      (effect) =>
        effect.pluginId === fixture.consumerId &&
        effect.activation === "2" &&
        effect.kind === "prepare",
    ).length,
    1,
  );
  await reconciler.stop();
});

test("recovery execution fails closed when durable authorization records disappear", async () => {
  for (const deletedCollection of [
    "deployments",
    "installations",
    "capability-bindings",
    "component-instances",
    "provider-loss",
  ] as const) {
    const fixture = await createProviderLossTestFixture(`recovery-delete-${deletedCollection}`, [
      "suspend",
    ]);
    const effects = new RecordingEffects();
    const reconciler = new Reconciler(fixture.options(effects));
    await reconciler.start();
    const providerStart = effects.calls.find(
      (effect) => effect.pluginId === fixture.providerId && effect.kind === "start",
    );
    assert.ok(providerStart);

    await fixture.failProvider(providerStart);
    await reconciler.wake();
    await fixture.recoverProvider(providerStart);
    fixture.state.afterNextExecutingCommit = async (effect) => {
      assert.equal(effect.pluginId, fixture.consumerId);
      assert.equal(effect.kind, "prepare");
      await fixture.state.transact({}, async (transaction) => {
        const records = [];
        for await (const record of transaction.scan({
          namespace: "tego",
          collection: deletedCollection,
        })) {
          records.push(record);
        }
        const targets =
          deletedCollection === "component-instances"
            ? records.filter((record) => record.key.id === providerStart.instanceId)
            : records;
        for (const record of targets) {
          await transaction.delete(record.key, { expectedRevision: record.revision });
        }
        return null;
      });
    };
    await reconciler.wake();

    assert.deepEqual(
      effects.calls.filter(
        (effect) =>
          effect.pluginId === fixture.consumerId &&
          effect.activation === "2" &&
          effect.kind === "prepare",
      ),
      [],
      deletedCollection,
    );
    await reconciler.stop();
  }
});

test("provider generation upgrade recovers the same logical provider identity", async () => {
  for (const policy of ["degrade", "suspend"] as const) {
    const fixture = await createProviderLossTestFixture(`generation-upgrade-${policy}`, [policy]);
    const effects = new RecordingEffects();
    const reconciler = new Reconciler(fixture.options(effects));
    await reconciler.start();
    const providerStart = effects.calls.find(
      (effect) => effect.pluginId === fixture.providerId && effect.kind === "start",
    );
    assert.ok(providerStart);
    await fixture.failProvider(providerStart);
    await reconciler.wake();
    assert.ok(await fixture.state.read(fixture.lossKey));

    await fixture.state.transact({}, async (transaction) => {
      const key = fixture.deploymentKey(fixture.provider);
      const current = await transaction.get(key);
      assert.ok(current);
      await transaction.put(
        key,
        { ...fixture.provider, generation: parseGeneration("2") },
        { expectedRevision: current.revision },
      );
      return null;
    });
    await reconciler.wake();

    assert.equal(await fixture.state.read(fixture.lossKey), undefined);
    const generationTwoProvider = effects.calls.find(
      (effect) =>
        effect.pluginId === fixture.providerId &&
        effect.kind === "start" &&
        effect.deploymentGeneration === parseGeneration("2"),
    );
    assert.ok(generationTwoProvider);
    assert.equal(
      (
        (await fixture.state.read(fixture.observationKey))?.value as
          | { readonly status?: string }
          | undefined
      )?.status,
      "ready",
    );
    await fixture.failProvider(generationTwoProvider);
    await reconciler.wake();
    assert.equal(
      (
        (await fixture.state.read(fixture.lossKey))?.value as
          | { readonly action?: string }
          | undefined
      )?.action,
      policy,
    );
    await reconciler.stop();
  }
});

test("failed provider loss drains and stops until a new desired generation", async () => {
  const fixture = await createProviderLossTestFixture("generation", ["fail"]);
  const effects = new RecordingEffects();
  const first = new Reconciler(fixture.options(effects));
  await first.start();
  const providerStart = effects.calls.find(
    (effect) => effect.pluginId === fixture.providerId && effect.kind === "start",
  );
  const consumerStart = effects.calls.find(
    (effect) => effect.pluginId === fixture.consumerId && effect.kind === "start",
  );
  assert.ok(providerStart);
  assert.ok(consumerStart);
  await fixture.failProvider(providerStart);

  await first.wake();

  assert.deepEqual(
    effects.calls
      .filter(
        (effect) =>
          effect.pluginId === fixture.consumerId &&
          (effect.kind === "drain" || effect.kind === "stop"),
      )
      .map((effect) => effect.kind),
    ["drain", "stop"],
  );
  assert.equal(
    (
      (
        await fixture.state.read({
          namespace: "tego",
          collection: "component-instances",
          id: consumerStart.instanceId,
        })
      )?.value as { readonly lifecycle?: string } | undefined
    )?.lifecycle,
    "stopped",
  );
  const observation = await fixture.state.read(fixture.observationKey);
  assert.equal((observation?.value as { readonly status?: string } | undefined)?.status, "failed");
  assert.equal(
    (
      observation?.value as
        | { readonly diagnostics?: readonly { readonly code?: string }[] }
        | undefined
    )?.diagnostics?.[0]?.code,
    "CAPABILITY_PROVIDER_LOST",
  );
  assert.equal(first.applicationReady(), false);
  const heldLoss = await fixture.state.read(fixture.lossKey);
  await fixture.recoverProvider(providerStart);
  const sameGenerationCallCount = effects.calls.length;
  await first.wake();
  assert.equal(effects.calls.length, sameGenerationCallCount);
  assert.deepEqual(await fixture.state.read(fixture.lossKey), heldLoss);
  await first.stop();

  const restartedEffects = new RecordingEffects();
  const restarted = new Reconciler(fixture.options(restartedEffects));
  await restarted.start();
  assert.equal(
    restartedEffects.calls.some(
      (effect) =>
        effect.pluginId === fixture.consumerId &&
        (effect.kind === "prepare" || effect.kind === "start"),
    ),
    false,
  );
  assert.equal(
    (
      (await fixture.state.read(fixture.observationKey))?.value as
        | { readonly status?: string }
        | undefined
    )?.status,
    "failed",
  );
  await fixture.state.transact({}, async (transaction) => {
    const current = await transaction.get(fixture.deploymentKey(fixture.consumer));
    assert.ok(current);
    await transaction.put(
      fixture.deploymentKey(fixture.consumer),
      { ...fixture.consumer, generation: parseGeneration("2") },
      { expectedRevision: current.revision },
    );
    return null;
  });
  await restarted.wake();

  const generationTwoStart = restartedEffects.calls.find(
    (effect) =>
      effect.pluginId === fixture.consumerId &&
      effect.kind === "start" &&
      effect.deploymentGeneration === parseGeneration("2"),
  );
  assert.ok(generationTwoStart);
  assert.equal(generationTwoStart.activation, "1");
  assert.equal(await fixture.state.read(fixture.lossKey), undefined);
  assert.equal(restarted.applicationReady(), true);
  await restarted.stop();
});

test("mixed provider loss orders execute only fail and remain fail-held after restart", async () => {
  for (const [suffix, policies] of [
    ["forward", ["degrade", "suspend", "fail"]],
    ["reverse", ["fail", "degrade", "suspend"]],
  ] as const) {
    const fixture = await createProviderLossTestFixture(suffix, policies);
    const effects = new RecordingEffects();
    const first = new Reconciler(fixture.options(effects));
    await first.start();
    const providerStart = effects.calls.find(
      (effect) => effect.pluginId === fixture.providerId && effect.kind === "start",
    );
    const consumerStart = effects.calls.find(
      (effect) => effect.pluginId === fixture.consumerId && effect.kind === "start",
    );
    assert.ok(providerStart);
    assert.ok(consumerStart);
    fixture.state.observationStatuses.length = 0;
    await fixture.failProvider(providerStart);
    await first.wake();

    assert.equal(
      (
        (await fixture.state.read(fixture.lossKey))?.value as
          | { readonly action?: string }
          | undefined
      )?.action,
      "fail",
    );
    assert.deepEqual(
      effects.calls
        .filter(
          (effect) =>
            effect.pluginId === fixture.consumerId &&
            (effect.kind === "drain" || effect.kind === "stop"),
        )
        .map((effect) => effect.kind),
      ["drain", "stop"],
    );
    assert.equal(
      (
        (await fixture.state.read(fixture.observationKey))?.value as
          | { readonly status?: string }
          | undefined
      )?.status,
      "failed",
    );
    const consumerStatuses = fixture.state.observationStatuses
      .filter(({ id }) => id === fixture.observationKey.id)
      .map(({ status }) => status);
    assert.equal(consumerStatuses.includes("degraded"), false);
    assert.equal(consumerStatuses.includes("suspended"), false);
    await first.stop();

    const restartedEffects = new RecordingEffects();
    const restarted = new Reconciler(fixture.options(restartedEffects));
    await restarted.start();
    assert.equal(
      restartedEffects.calls.some(
        (effect) =>
          effect.pluginId === fixture.consumerId &&
          (effect.kind === "prepare" || effect.kind === "start"),
      ),
      false,
    );
    assert.equal(
      (
        (await fixture.state.read(fixture.observationKey))?.value as
          | { readonly status?: string }
          | undefined
      )?.status,
      "failed",
    );
    await restarted.stop();
  }
});
