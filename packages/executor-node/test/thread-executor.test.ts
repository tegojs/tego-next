import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Worker, type Transferable } from "node:worker_threads";
import {
  diagnosticCode,
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseComponentId,
  parsePluginId,
  parsePluginManifest,
  parseTaskId,
  type ExecutionRequest,
  type JsonValue,
} from "@tegojs/contracts";
import {
  eventually,
  executorConformance,
  FakeClock,
  type ExecutorConformanceFixture,
} from "@tegojs/testkit";
import {
  THREAD_EXECUTOR_MAX_MESSAGE_BYTES,
  ThreadExecutor,
  threadExecutionRequest,
  type ThreadExecutorOptions,
  type ThreadWorker,
  type ThreadWorkerFactory,
} from "../src/index.js";

const digest = parseArtifactDigest(`sha256:${"b".repeat(64)}`);
const clock = new FakeClock(new Date(0));
const directories: string[] = [];

class TrackingWorker implements ThreadWorker {
  readonly #worker: Worker;
  readonly #onExit: () => void;
  #exited = false;

  constructor(worker: Worker, onExit: () => void) {
    this.#worker = worker;
    this.#onExit = onExit;
    worker.once("exit", () => {
      this.#exited = true;
      onExit();
    });
  }

  postMessage(value: unknown, transferList?: readonly Transferable[]): void {
    this.#worker.postMessage(value, transferList);
  }

  on(
    event: "error" | "exit" | "message" | "messageerror" | "online",
    listener: (...arguments_: readonly unknown[]) => void,
  ): this {
    this.#worker.on(event, listener);
    return this;
  }

  once(
    event: "error" | "exit" | "message" | "messageerror" | "online",
    listener: (...arguments_: readonly unknown[]) => void,
  ): this {
    this.#worker.once(event, listener);
    return this;
  }

  async terminate(): Promise<number> {
    const exitCode = await this.#worker.terminate();
    if (!this.#exited) {
      this.#exited = true;
      this.#onExit();
    }
    return exitCode;
  }
}

class TrackingWorkerFactory implements ThreadWorkerFactory {
  active = 0;
  peak = 0;
  created = 0;

  create(entrypoint: string): ThreadWorker {
    this.active += 1;
    this.created += 1;
    this.peak = Math.max(this.peak, this.active);
    return new TrackingWorker(new Worker(entrypoint), () => {
      this.active -= 1;
    });
  }
}

after(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const componentSource = `
export default {
  protocol: "tego.component/1.0",
  kind: "task",
  async run(context, input) {
    if (input.mode === "wait") {
      await context.events.emit("run.started", { mode: input.mode });
      if (context.cancellation.aborted) return { cancelled: true };
      return new Promise((resolve) => {
        context.cancellation.addEventListener(
          "abort",
          () => resolve({ cancelled: true }),
          { once: true }
        );
      });
    }
    if (input.mode === "ignore-cancel") {
      await context.events.emit("run.started", { mode: input.mode });
      return new Promise(() => {});
    }
    if (input.mode === "crash") process.exit(42);
    if (input.mode === "large-output") return "x".repeat(${1024 * 1024 + 64});
    return input.value;
  }
};
`;

async function artifact() {
  const root = await mkdtemp(join(tmpdir(), "tego-thread-executor-"));
  directories.push(root);
  await mkdir(join(root, "components"), { recursive: true });
  await writeFile(join(root, "components", "echo.js"), componentSource);
  const artifactRoot = await realpath(root);
  const manifest = parsePluginManifest({
    schemaVersion: "1.0",
    pluginId: "org.example.thread",
    version: "1.0.0",
    contractRange: "^1.0.0",
    nodeRange: ">=24.0.0 <27",
    moduleFormat: "esm",
    components: [
      {
        componentId: "echo",
        kind: "task",
        entrypoint: "components/echo.js",
        executors: ["process", "thread"],
      },
    ],
    permissions: [{ kind: "executor", executors: ["process", "thread"] }],
    capabilities: { provides: [], requires: [] },
  });
  return { artifactRoot, manifest };
}

function request(input: JsonValue, suffix: string): ExecutionRequest {
  return {
    taskId: parseTaskId(`thread-task-${suffix}`),
    attemptId: parseAttemptId(`thread-attempt-${suffix}`),
    applicationId: parseApplicationId("app"),
    pluginId: parsePluginId("org.example.thread"),
    componentId: parseComponentId("echo"),
    input,
    deadline: new Date(clock.now().getTime() + 60_000).toISOString(),
    orphanPolicy: "cancel",
  };
}

async function options(
  factory: ThreadWorkerFactory,
  overrides: Partial<ThreadExecutorOptions> = {},
): Promise<ThreadExecutorOptions> {
  const fixture = await artifact();
  return {
    id: "thread-local",
    clock,
    workerFactory: factory,
    maxConcurrency: 2,
    cancellationGraceMs: 100,
    resolveComponent: async () => ({
      artifactDigest: digest,
      artifactRoot: fixture.artifactRoot,
      manifest: fixture.manifest,
      runtimeId: "runtime",
      instanceId: "instance",
      configuration: {},
      permissionGrants: fixture.manifest.permissions,
      capabilityDefinitions: [],
    }),
    ...overrides,
  };
}

let conformanceFactory: TrackingWorkerFactory | undefined;

const conformanceFixture: ExecutorConformanceFixture = {
  request,
  echoInput: { mode: "echo", value: { echoed: true } },
  echoOutput: { echoed: true },
  waitingInput: { mode: "wait", generation: 0 },
  crashInput: { mode: "crash" },
  replacementInput: { mode: "echo", value: "replacement" },
  replacementOutput: "replacement",
  oversizedInput: { value: "x".repeat(THREAD_EXECUTOR_MAX_MESSAGE_BYTES) },
  oversizedOutputInput: { mode: "large-output" },
  activeResourceCount: () => conformanceFactory?.active ?? 0,
  async spawnFailureFactory() {
    conformanceFactory = new TrackingWorkerFactory();
    return new ThreadExecutor(
      await options(conformanceFactory, {
        workerEntrypoint: join(process.cwd(), "missing-thread-entry.js"),
      }),
    );
  },
  async shutdownHostTwice() {
    const factory = new TrackingWorkerFactory();
    const executor = new ThreadExecutor(await options(factory));
    await Promise.all([executor.close(), executor.close()]);
    assert.equal(factory.active, 0);
  },
  async advanceClock(milliseconds) {
    clock.advanceBy(milliseconds);
    await Promise.resolve();
    await Promise.resolve();
  },
};

executorConformance(async () => {
  conformanceFactory = new TrackingWorkerFactory();
  return new ThreadExecutor(await options(conformanceFactory));
}, conformanceFixture);

test("thread probe documents shared-process isolation semantics", async () => {
  const factory = new TrackingWorkerFactory();
  const executor = new ThreadExecutor(await options(factory));
  try {
    assert.deepEqual(await executor.probe(), {
      id: "thread-local",
      type: "thread",
      available: true,
      maxConcurrency: 2,
      availableCapacity: 2,
      securityIsolation: false,
    });
  } finally {
    await executor.drain({});
  }
});

test("thread transfer ownership detaches only explicitly transferable buffers", async () => {
  const factory = new TrackingWorkerFactory();
  const executor = new ThreadExecutor(await options(factory));
  const cloned = new Uint8Array([1, 2, 3, 4]).buffer;
  const transferred = new Uint8Array([5, 6, 7, 8]).buffer;
  try {
    const clonedHandle = await executor.submit(
      threadExecutionRequest(request({ mode: "echo", value: "clone" }, "clone-buffer"), {
        buffers: [cloned],
        ownership: "clone",
      }),
    );
    assert.equal(cloned.byteLength, 4);
    assert.equal((await clonedHandle.result).status, "succeeded");
    assert.equal(cloned.byteLength, 4);

    const transferredHandle = await executor.submit(
      threadExecutionRequest(request({ mode: "echo", value: "transfer" }, "transfer-buffer"), {
        buffers: [transferred],
        ownership: "transfer",
      }),
    );
    assert.equal(transferred.byteLength, 0);
    assert.equal((await transferredHandle.result).status, "succeeded");
  } finally {
    await executor.drain({});
  }
});

test("thread transfer request rejects detached and duplicate buffers before worker startup", async () => {
  const factory = new TrackingWorkerFactory();
  const executor = new ThreadExecutor(await options(factory));
  const buffer = new ArrayBuffer(8);
  structuredClone(buffer, { transfer: [buffer] });
  try {
    await assert.rejects(
      executor.submit(
        threadExecutionRequest(request({ mode: "echo", value: "detached" }, "detached"), {
          buffers: [buffer],
          ownership: "transfer",
        }),
      ),
      (error: unknown) =>
        diagnosticCode(error) === "EXECUTOR_THREAD_TRANSFER_INVALID" ||
        (error instanceof Error && /detach|transfer/iu.test(error.message)),
    );
    assert.equal(factory.created, 0);

    const duplicate = new ArrayBuffer(8);
    await assert.rejects(
      executor.submit(
        threadExecutionRequest(request({ mode: "echo", value: "duplicate" }, "duplicate-buffer"), {
          buffers: [duplicate, duplicate],
          ownership: "transfer",
        }),
      ),
      /duplicate|transfer/iu,
    );
    assert.equal(duplicate.byteLength, 8);
    assert.equal(factory.created, 0);
  } finally {
    await executor.drain({});
  }
});

test("thread worker exit settles before replacement capacity is advertised", async () => {
  const factory = new TrackingWorkerFactory();
  const executor = new ThreadExecutor(await options(factory, { maxConcurrency: 1 }));
  try {
    const crashed = await executor.submit(request({ mode: "crash" }, "crash-order"));
    assert.equal((await crashed.result).status, "failed");
    await eventually(() => assert.equal(factory.active, 0));
    assert.equal((await executor.probe()).availableCapacity, 1);

    const replacement = await executor.submit(
      request({ mode: "echo", value: "replacement" }, "replacement-order"),
    );
    assert.equal((await replacement.result).output, "replacement");
    assert.equal(factory.created, 2);
  } finally {
    await executor.drain({});
  }
});
