import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseApplicationId,
  parseArtifactDigest,
  parseComponentId,
  parseFencingEpoch,
  parseGeneration,
  parseMessageId,
  parseOperationId,
  parsePluginId,
  parseRevision,
  type ArtifactDigest,
  type Clock,
  type DriverHealth,
  type ExecutorKind,
  type FencingEpoch,
  type JsonObject,
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
  deterministicRetryDelay,
  planReconcile,
  Reconciler,
  type ArtifactDeploymentGate,
  type ComponentEffectExecutor,
  type ComponentInstance,
  type ReconcileEffect,
  type ReconcilePlanStep,
  type ReconcileSnapshot,
} from "../src/index.js";

const applicationId = parseApplicationId("app");
const pluginId = parsePluginId("org.example.echo");
const componentId = parseComponentId("echo-service");
const digestOne = parseArtifactDigest(`sha256:${"1".repeat(64)}`);
const digestTwo = parseArtifactDigest(`sha256:${"2".repeat(64)}`);

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

function installation(
  version = "1.0.0",
  digest: ArtifactDigest = digestOne,
): PluginInstallation {
  return {
    pluginId,
    version,
    digest,
    manifest: manifest(version, digest),
    installedAt: "2026-07-23T00:00:00.000Z",
  };
}

function deployment(
  generation = "1",
  options: Partial<PluginDeployment> = {},
): PluginDeployment {
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
        instanceId: "app.org.example.echo.echo-service.g1",
        messageId: "reconcile.app.org.example.echo.echo-service.g1.prepare",
        operationId: "reconcile.app.org.example.echo.echo-service.g1.prepare",
      },
    ],
  );
  assert.equal(
    first.steps.every((step: ReconcilePlanStep) => Object.keys(step.effect).length > 0),
    true,
  );

  const ready: ComponentInstance = {
    componentId,
    deploymentGeneration: parseGeneration("1"),
    executor: "process",
    instanceId: "app.org.example.echo.echo-service.g1",
    lifecycle: "ready",
    observedGeneration: parseGeneration("1"),
    pluginId,
    revision: "1",
  };
  assert.deepEqual(planReconcile(snapshot(deployment(), [ready])).steps, []);
});

test("plans enable, disable, upgrade, drain, and rollback without combining external effects", () => {
  const oldReady: ComponentInstance = {
    componentId,
    deploymentGeneration: parseGeneration("1"),
    executor: "process",
    instanceId: "app.org.example.echo.echo-service.g1",
    lifecycle: "ready",
    observedGeneration: parseGeneration("1"),
    pluginId,
    revision: "2",
  };
  const disabled = planReconcile(
    snapshot(deployment("2", { state: "disabled" }), [oldReady]),
  );
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
  assert.equal(
    new Set(upgraded.steps.map((step: ReconcilePlanStep) => step.operationId)).size,
    2,
  );

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
  assert.equal(delays[0] >= 100 && delays[0] < 125, true);
  assert.equal(delays[1] >= 200 && delays[1] < 250, true);
  assert.equal(delays[2] >= 400 && delays[2] < 500, true);
  assert.equal(delays[3], 1_000);
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
          expectedRevision: writeOptions.expectedRevision,
        });
      },
      delete: async () => {},
      appendOperation: async (entry) => {
        operations.push(structuredClone(entry));
      },
      enqueueOutbox: async (message) => {
        messages.push(structuredClone(message));
      },
    };
    const result = await work(transaction);
    if (
      this.failNextObservedCommit &&
      puts.some((put) => put.key.collection === "component-instances")
    ) {
      this.failNextObservedCommit = false;
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
    if (puts.length > 0 || operations.length > 0 || messages.length > 0) {
      this.revision += 1n;
    }
    const revision = parseRevision(this.revision.toString());
    for (const put of puts) {
      this.records.set(stateIdentifier(put.key), {
        key: structuredClone(put.key),
        value: structuredClone(put.value),
        revision,
      });
    }
    for (const operation of operations) {
      this.operations.set(operation.operationId, { ...operation, revision });
    }
    for (const message of messages) {
      if (!this.outbox.has(message.messageId)) {
        this.outbox.set(message.messageId, { attempt: 0, message });
      }
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

  async claimOutbox(request: OutboxClaimRequest): Promise<readonly OutboxClaim[]> {
    const claimedAt = this.#clock.now().toISOString();
    const now = this.#clock.now().getTime();
    const claimed: OutboxClaim[] = [];
    for (const record of [...this.outbox.values()].sort((left, right) =>
      left.message.messageId < right.message.messageId ? -1 : 1,
    )) {
      if (
        record.acknowledgement?.outcome === "completed" ||
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
      record.acknowledgement = undefined;
      claimed.push(structuredClone(claim));
      if (claimed.length === (request.limit ?? 1)) break;
    }
    return claimed;
  }

  async acknowledgeOutbox(
    request: OutboxAcknowledgementRequest,
  ): Promise<OutboxAcknowledgement> {
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
      record.claim = undefined;
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
  readonly supportedExecutors = ["process"] as const;
  readonly performed: ReconcileEffect[] = [];
  readonly uniqueOperations = new Set<string>();
  readonly calls: ReconcileEffect[] = [];
  failStart = false;

  async perform(effect: ReconcileEffect): Promise<void> {
    this.calls.push(effect);
    if (this.uniqueOperations.has(effect.operationId)) return;
    this.uniqueOperations.add(effect.operationId);
    this.performed.push(effect);
    if (effect.kind === "start" && this.failStart) {
      throw new Error("component start failed");
    }
  }
}

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
    [...state.records.values()].some((entry) => entry.lifecycle === "ready"),
    true,
  );
  assert.equal(reconciler.lastCommitAuthority?.epoch, authority.epoch);
  assert.equal(reconciler.replanCount >= 1, true);
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
    (entry) => entry.lifecycle !== "stopped" && entry.lifecycle !== "failed",
  );
  assert.equal(live.length, 1);
  assert.equal(effects.uniqueOperations.size, 2);
  assert.equal(
    effects.performed.every(
      (effect) =>
        effect.messageId ===
        parseMessageId(`reconcile.app.org.example.echo.echo-service.g1.${effect.kind}`),
    ),
    true,
  );
  await second.stop();
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
    assert.equal(
      reconciler
        .diagnostics()
        .some((item: { readonly code: string }) => item.code === "LIFECYCLE_START_FAILED"),
      true,
    );
    await reconciler.stop();
  }
});
