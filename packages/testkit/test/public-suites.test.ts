import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  type ArtifactDigest,
  type ArtifactStore,
  type ArtifactStoreOptions,
  DiagnosticError,
  type DriverHealth,
  type ExecutorKind,
  type FencingEpoch,
  type JsonValue,
  parseApplicationId,
  parseArtifactDigest,
  parseFencingEpoch,
  parseNodeId,
  parsePluginManifest,
  parseRuntimeId,
  parseWorkerId,
  type Runtime,
  type RuntimeLifecycleState,
  type RuntimeStatus,
  type WorkerId,
} from "@tego/contracts";
import {
  type ArtifactStoreSuiteFactory,
  type CoordinationFactory,
  coordinationConformance,
  defineArtifactStoreSuite,
  type ExecutorConformanceFixture,
  type ExecutorFactory,
  executorConformance,
  type LifecycleConformanceFactory,
  lifecycleConformance,
  type ManifestConformanceFactory,
  manifestConformance,
  type StateStoreFactory,
  stateStoreConformance,
  type WorkerConformanceFactory,
  workerConformance,
} from "@tego/testkit";

class PublicQuotaFixtureStore implements ArtifactStore {
  readonly scope = "local" as const;
  readonly #limits: Required<ArtifactStoreOptions>["limits"];
  readonly #artifacts = new Map<ArtifactDigest, Uint8Array>();
  #reservedBytes = 0;

  constructor(options: ArtifactStoreOptions) {
    this.#limits = options.limits ?? {};
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async health(): Promise<DriverHealth> {
    return { status: "healthy", checkedAt: "2026-08-13T00:00:00.000Z" };
  }

  async put(digest: ArtifactDigest, source: AsyncIterable<Uint8Array>): Promise<void> {
    if (this.#artifacts.has(digest)) return;
    const bytes: Uint8Array[] = [];
    let reservedForWrite = 0;
    try {
      for await (const chunk of source) {
        const nextSize = reservedForWrite + chunk.byteLength;
        if (nextSize > (this.#limits.maxArtifactBytes ?? Number.MAX_SAFE_INTEGER)) {
          throw this.#error("ARTIFACT_SIZE_LIMIT_EXCEEDED");
        }
        const storedBytes = [...this.#artifacts.values()].reduce(
          (total, artifact) => total + artifact.byteLength,
          0,
        );
        if (
          storedBytes + this.#reservedBytes + chunk.byteLength >
          (this.#limits.maxNamespaceBytes ?? Number.MAX_SAFE_INTEGER)
        ) {
          throw this.#error("ARTIFACT_NAMESPACE_QUOTA_EXCEEDED");
        }
        const copy = Uint8Array.from(chunk);
        bytes.push(copy);
        reservedForWrite += copy.byteLength;
        this.#reservedBytes += copy.byteLength;
      }
      const content = Buffer.concat(bytes);
      const actual = parseArtifactDigest(
        `sha256:${createHash("sha256").update(content).digest("hex")}`,
      );
      if (actual !== digest) throw this.#error("ARTIFACT_DIGEST_MISMATCH");
      this.#artifacts.set(digest, content);
    } finally {
      this.#reservedBytes -= reservedForWrite;
    }
  }

  async *read(digest: ArtifactDigest): AsyncIterable<Uint8Array> {
    const content = this.#artifacts.get(digest);
    if (content === undefined) throw this.#error("ARTIFACT_NOT_FOUND");
    yield content;
  }

  #error(code: `ARTIFACT_${string}`): DiagnosticError {
    return new DiagnosticError({
      code,
      message: code,
      source: { kind: "artifact", id: "public-quota-fixture" },
      severity: "error",
      retryable: false,
      observedAt: "2026-08-13T00:00:00.000Z",
    });
  }
}

const artifactStoreSuiteFactory: ArtifactStoreSuiteFactory = async (options) => ({
  store: new PublicQuotaFixtureStore(options),
  dispose: async () => {},
});

defineArtifactStoreSuite(artifactStoreSuiteFactory);

manifestConformance(() => ({
  parse: parsePluginManifest,
}));

class PublicRuntimeFixture implements Runtime {
  readonly operations = {} as Runtime["operations"];
  readonly events: AsyncIterable<never> = {
    async *[Symbol.asyncIterator]() {},
  };
  #state: RuntimeLifecycleState = "created";

  async start(): Promise<void> {
    this.#state = "running";
  }

  async status(): Promise<RuntimeStatus> {
    const running = this.#state === "running";
    return {
      identity: {
        runtimeId: parseRuntimeId("public-runtime"),
        applicationId: parseApplicationId("public-application"),
        nodeId: parseNodeId("public-node"),
      },
      mode: "single-main",
      lifecycle: this.#state,
      liveness: running,
      readiness: running,
      acceptingOperations: running,
      drivers: [],
      counts: {
        deployments: 0,
        installations: 0,
        recoverableOperations: 0,
        tasks: 0,
        workers: 0,
      },
    };
  }

  async stop(): Promise<void> {
    this.#state = "stopped";
  }
}

lifecycleConformance(() => new PublicRuntimeFixture());

const publicWorkerId = parseWorkerId("conformance-worker");
const publicDigest = parseArtifactDigest(`sha256:${"0".repeat(64)}`);

class PublicWorkerFixture {
  registration(): {
    readonly workerId: WorkerId;
    readonly executors: readonly ExecutorKind[];
    readonly preparedArtifacts: readonly ArtifactDigest[];
  } {
    return {
      workerId: publicWorkerId,
      executors: ["process", "thread", "remote"],
      preparedArtifacts: [publicDigest],
    };
  }

  heartbeat(): { readonly beforeExpiry: boolean; readonly afterExpiry: boolean } {
    return { beforeExpiry: true, afterExpiry: false };
  }

  reconnect(): {
    readonly previousEpoch: FencingEpoch;
    readonly currentEpoch: FencingEpoch;
    readonly authoritativeEpoch: FencingEpoch;
  } {
    return {
      previousEpoch: parseFencingEpoch("1"),
      currentEpoch: parseFencingEpoch("2"),
      authoritativeEpoch: parseFencingEpoch("2"),
    };
  }

  deduplicate(payload: JsonValue): readonly JsonValue[] {
    return [structuredClone(payload)];
  }

  close(): void {}
}

workerConformance(() => new PublicWorkerFixture());

const publicSuiteConsumers = {
  artifactStore: (factory: ArtifactStoreSuiteFactory) => defineArtifactStoreSuite(factory),
  coordination: (factory: CoordinationFactory) => coordinationConformance(factory),
  executor: (factory: ExecutorFactory, fixture: ExecutorConformanceFixture) =>
    executorConformance(factory, fixture),
  lifecycle: (factory: LifecycleConformanceFactory) => lifecycleConformance(factory),
  manifest: (factory: ManifestConformanceFactory) => manifestConformance(factory),
  stateStore: (factory: StateStoreFactory) => stateStoreConformance(factory),
  worker: (factory: WorkerConformanceFactory) => workerConformance(factory),
};

test("all seven conformance suites are consumable from the public package entry", () => {
  assert.deepEqual(Object.keys(publicSuiteConsumers).sort(), [
    "artifactStore",
    "coordination",
    "executor",
    "lifecycle",
    "manifest",
    "stateStore",
    "worker",
  ]);
  for (const consume of Object.values(publicSuiteConsumers)) {
    assert.equal(typeof consume, "function");
  }
});
