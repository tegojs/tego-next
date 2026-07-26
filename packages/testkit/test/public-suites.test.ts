import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coordinationConformance,
  executorConformance,
  lifecycleConformance,
  manifestConformance,
  stateStoreConformance,
  workerConformance,
  type CoordinationFactory,
  type ExecutorConformanceFixture,
  type ExecutorFactory,
  type LifecycleConformanceFactory,
  type ManifestConformanceFactory,
  type StateStoreFactory,
  type WorkerConformanceFactory,
} from "@tegojs/testkit";
import {
  parseApplicationId,
  parseArtifactDigest,
  parseFencingEpoch,
  parseNodeId,
  parsePluginManifest,
  parseRuntimeId,
  parseWorkerId,
  type ArtifactDigest,
  type ExecutorKind,
  type FencingEpoch,
  type JsonValue,
  type Runtime,
  type RuntimeLifecycleState,
  type RuntimeStatus,
  type WorkerId,
} from "@tegojs/contracts";

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
  coordination: (factory: CoordinationFactory) => coordinationConformance(factory),
  executor: (factory: ExecutorFactory, fixture: ExecutorConformanceFixture) =>
    executorConformance(factory, fixture),
  lifecycle: (factory: LifecycleConformanceFactory) => lifecycleConformance(factory),
  manifest: (factory: ManifestConformanceFactory) => manifestConformance(factory),
  stateStore: (factory: StateStoreFactory) => stateStoreConformance(factory),
  worker: (factory: WorkerConformanceFactory) => workerConformance(factory),
};

test("all six conformance suites are consumable from the public package entry", () => {
  assert.deepEqual(Object.keys(publicSuiteConsumers).sort(), [
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
