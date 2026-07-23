import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
  type ArtifactDigest,
  type Clock,
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
        instanceId: "app.org_dexample_decho.echo-service.g1",
        messageId: "reconcile.app.org_dexample_decho.echo-service.g1.prepare",
        operationId: "reconcile.app.org_dexample_decho.echo-service.g1.prepare",
      },
    ],
  );
  assert.equal(
    first.steps.every((step: ReconcilePlanStep) => Object.keys(step.effect).length > 0),
    true,
  );

  const ready: ComponentInstance = {
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

test("plans enable, disable, upgrade, drain, and rollback without combining external effects", () => {
  const oldReady: ComponentInstance = {
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
  failNextFailureCommit = false;
  failNextAcknowledgement = false;
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
          ...(writeOptions.expectedRevision === undefined
            ? {}
            : { expectedRevision: writeOptions.expectedRevision }),
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
      puts.some((put) => put.key.collection === "component-instances") &&
      operations.some((operation) => operation.status === "completed")
    ) {
      this.failNextObservedCommit = false;
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
  const providerId = parsePluginId("a-provider");
  const consumerId = parsePluginId("z-consumer");
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
      provides: [{ name: capability, protocolVersion: "1.0.0" }],
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
    effects.performed.map((effect) => effect.pluginId),
    [providerId],
  );
  assert.equal(reconciler.diagnostics()[0]?.code, "CAPABILITY_REQUIRED_UNAVAILABLE");
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

test("canonical lifecycle identities cannot be retargeted to another persisted instance", async () => {
  const source = (
    lifecycle: ComponentInstance["lifecycle"],
    generation = "1",
  ): ComponentInstance => ({
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

    assert.deepEqual(effects.calls, [], effect.kind);
    assert.equal(reconciler.diagnostics()[0]?.code, "PROTOCOL_MESSAGE_INVALID");
    await reconciler.stop();
  }
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
        parseMessageId(`reconcile.app.org_dexample_decho.echo-service.g1.${effect.kind}`),
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

  assert.equal(effects.calls.length, 1);
  assert.equal(
    [...state.operations.values()].filter((entry) => entry.status === "completed").length,
    1,
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
  assert.equal(effects.calls.at(-1)?.kind, "drain");
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

  assert.equal(effects.performed.at(-1)?.kind, "drain");
  await disabled.stop();
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

  assert.deepEqual(effects.calls, []);
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

test("deployment observations progress from converging to ready", async () => {
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
  const status = () =>
    (
      [...state.records.values()].find(
        (entry) => entry.key.collection === "deployment-observations",
      )?.value as { readonly status?: string } | undefined
    )?.status;
  assert.equal(status(), "converging");

  await reconciler.wake();
  assert.equal(status(), "ready");
  await reconciler.stop();
});

test("deployment observations distinguish unavailable, inconsistent, and degraded states", async () => {
  for (const [expected, instances, installations] of [
    ["unavailable", [], []],
    [
      "inconsistent",
      [
        { instanceId: "duplicate-a", lifecycle: "ready" },
        { instanceId: "duplicate-b", lifecycle: "ready" },
      ],
      [installation()],
    ],
    ["degraded", [{ instanceId: "degraded", lifecycle: "degraded" }], [installation()]],
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
            id: value.instanceId,
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

  await reconciler.start();
  state.failNextFailureCommit = true;
  await reconciler.wake();

  assert.equal(reconciler.replanCount, 1);
  assert.equal(
    [...state.operations.values()].some((operation) => operation.status === "failed"),
    true,
  );
  assert.equal(reconciler.kernelRunning, true);
  await reconciler.stop();
});
