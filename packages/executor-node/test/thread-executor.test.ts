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

class GatedTerminationFactory extends TrackingWorkerFactory {
  readonly gate = Promise.withResolvers<void>();
  terminationStarted = Promise.withResolvers<void>();

  override create(entrypoint: string): ThreadWorker {
    const worker = super.create(entrypoint);
    return {
      ...(worker.threadId === undefined ? {} : { threadId: worker.threadId }),
      postMessage: (value, transferList) => worker.postMessage(value, transferList),
      on(event, listener) {
        worker.on(event, listener);
        return this;
      },
      once(event, listener) {
        worker.once(event, listener);
        return this;
      },
      terminate: async () => {
        this.terminationStarted.resolve();
        await this.gate.promise;
        return worker.terminate();
      },
    };
  }
}

class ExitFirstTerminationFactory extends TrackingWorkerFactory {
  readonly lateTermination = Promise.withResolvers<number>();
  readonly exited = Promise.withResolvers<void>();

  override create(entrypoint: string): ThreadWorker {
    const worker = super.create(entrypoint);
    return {
      ...(worker.threadId === undefined ? {} : { threadId: worker.threadId }),
      postMessage: (value, transferList) => worker.postMessage(value, transferList),
      on(event, listener) {
        worker.on(event, listener);
        return this;
      },
      once(event, listener) {
        worker.once(event, listener);
        return this;
      },
      terminate: () => {
        void worker.terminate().then(() => this.exited.resolve());
        return this.lateTermination.promise;
      },
    };
  }
}

class RejectingTerminationFactory extends TrackingWorkerFactory {
  readonly terminationStarted = Promise.withResolvers<void>();
  #worker: ThreadWorker | undefined;

  override create(entrypoint: string): ThreadWorker {
    const worker = super.create(entrypoint);
    this.#worker = worker;
    return {
      ...(worker.threadId === undefined ? {} : { threadId: worker.threadId }),
      postMessage: (value, transferList) => worker.postMessage(value, transferList),
      on(event, listener) {
        worker.on(event, listener);
        return this;
      },
      once(event, listener) {
        worker.once(event, listener);
        return this;
      },
      terminate: () => {
        this.terminationStarted.resolve();
        return Promise.reject(new Error("thread termination rejected"));
      },
    };
  }

  forceExit(): Promise<number> {
    if (this.#worker === undefined) throw new Error("Worker has not started");
    return this.#worker.terminate();
  }
}

class HangingTerminationFactory extends TrackingWorkerFactory {
  readonly terminationStarted = Promise.withResolvers<void>();
  readonly termination = Promise.withResolvers<number>();
  #worker: ThreadWorker | undefined;

  override create(entrypoint: string): ThreadWorker {
    const worker = super.create(entrypoint);
    this.#worker = worker;
    return {
      ...(worker.threadId === undefined ? {} : { threadId: worker.threadId }),
      postMessage: (value, transferList) => worker.postMessage(value, transferList),
      on(event, listener) {
        worker.on(event, listener);
        return this;
      },
      once(event, listener) {
        worker.once(event, listener);
        return this;
      },
      terminate: () => {
        this.terminationStarted.resolve();
        return this.termination.promise;
      },
    };
  }

  forceExit(): Promise<number> {
    if (this.#worker === undefined) throw new Error("Worker has not started");
    return this.#worker.terminate();
  }
}

class ConnectFailureFactory extends TrackingWorkerFactory {
  override create(entrypoint: string): ThreadWorker {
    const worker = super.create(entrypoint);
    let connected = false;
    return {
      ...(worker.threadId === undefined ? {} : { threadId: worker.threadId }),
      postMessage(value, transferList) {
        if (!connected) {
          connected = true;
          throw new Error("connect transfer failed");
        }
        worker.postMessage(value, transferList);
      },
      on(event, listener) {
        worker.on(event, listener);
        return this;
      },
      once(event, listener) {
        worker.once(event, listener);
        return this;
      },
      terminate: () => worker.terminate(),
    };
  }
}

after(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const componentSource = `
import { MessagePort } from "node:worker_threads";

let capturedBroker;
const nativePostMessage = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function (...arguments_) {
  capturedBroker ??= this;
  return Reflect.apply(nativePostMessage, this, arguments_);
};

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
    if (input.mode === "secret") return context.secrets.get("api");
    if (input.mode === "forge-rpc") {
      const { parentPort } = await import("node:worker_threads");
      parentPort.postMessage({
        kind: "rpc-request",
        id: "forged",
        type: "secret",
        payload: { name: "api" }
      });
      return "safe";
    }
    if (input.mode === "forge-private-port") {
      if (capturedBroker !== undefined) {
        Reflect.apply(nativePostMessage, capturedBroker, [{
          kind: "rpc-request",
          id: "forged-private",
          type: "secret",
          payload: { name: "api" }
        }]);
      }
      return capturedBroker === undefined ? "safe" : "captured";
    }
    if (input.mode === "flood-events") {
      for (let index = 0; index < 1000; index += 1) {
        void context.events.emit("flood", { index });
      }
      return "flooded";
    }
    if (input.mode === "attachments") {
      return Array.from({ length: context.attachments.length }, (_, index) => {
        const attachment = context.attachments.get(index);
        const bytes = attachment.bytes();
        return {
          byteLength: attachment.byteLength,
          bytes: Array.from(bytes),
          checksum: bytes.reduce((sum, value) => (sum + value) % 65536, 0)
        };
      });
    }
    if (input.mode === "finish-gate") {
      await context.events.emit("run.finished", { mode: input.mode });
      return input.value;
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
    permissions: [
      { kind: "executor", executors: ["process", "thread"] },
      { kind: "secret", names: ["api"] },
    ],
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

test("clone and transfer attachments reach the real plugin in order as read-only bytes", async () => {
  const factory = new TrackingWorkerFactory();
  const executor = new ThreadExecutor(await options(factory));
  const cloneFirst = new Uint8Array([1, 2, 3]).buffer;
  const cloneSecond = new Uint8Array([10, 20]).buffer;
  const transferFirst = new Uint8Array([5, 4, 3, 2, 1]).buffer;
  const transferSecond = new Uint8Array([255]).buffer;
  try {
    const cloned = await (
      await executor.submit(
        threadExecutionRequest(request({ mode: "attachments" }, "attachments-clone"), {
          buffers: [cloneFirst, cloneSecond],
          ownership: "clone",
        }),
      )
    ).result;
    assert.equal(cloned.status, "succeeded");
    assert.deepEqual(cloned.output, [
      { byteLength: 3, bytes: [1, 2, 3], checksum: 6 },
      { byteLength: 2, bytes: [10, 20], checksum: 30 },
    ]);
    assert.equal(cloneFirst.byteLength, 3);
    assert.equal(cloneSecond.byteLength, 2);

    const transferred = await (
      await executor.submit(
        threadExecutionRequest(request({ mode: "attachments" }, "attachments-transfer"), {
          buffers: [transferFirst, transferSecond],
          ownership: "transfer",
        }),
      )
    ).result;
    assert.equal(transferred.status, "succeeded");
    assert.deepEqual(transferred.output, [
      { byteLength: 5, bytes: [5, 4, 3, 2, 1], checksum: 15 },
      { byteLength: 1, bytes: [255], checksum: 255 },
    ]);
    assert.equal(transferFirst.byteLength, 0);
    assert.equal(transferSecond.byteLength, 0);
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

    const invalidOwnership = new ArrayBuffer(8);
    await assert.rejects(
      executor.submit(
        threadExecutionRequest(request({ mode: "echo", value: "ownership" }, "invalid-ownership"), {
          buffers: [invalidOwnership],
          ownership: "borrow" as "transfer",
        }),
      ),
      /ownership|transfer/iu,
    );
    assert.equal(invalidOwnership.byteLength, 8);
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

test("thread secret RPC remains parent-gated over the private broker port", {
  timeout: 2_000,
}, async () => {
  const factory = new TrackingWorkerFactory();
  let secretCalls = 0;
  const executor = new ThreadExecutor(
    await options(factory, {
      secretProvider: {
        developmentOnly: false,
        open: async () => {},
        close: async () => {},
        health: async () => ({
          status: "healthy",
          checkedAt: clock.now().toISOString(),
        }),
        async get(name) {
          secretCalls += 1;
          return name === "api" ? "parent-secret" : undefined;
        },
      },
    }),
  );
  try {
    const result = await (await executor.submit(request({ mode: "secret" }, "secret-rpc"))).result;
    assert.equal(result.status, "succeeded");
    assert.equal(result.output, "[REDACTED]");
    assert.equal(secretCalls, 1);
  } finally {
    await executor.drain({});
  }
});

test("plugin parentPort messages cannot forge privileged broker RPC", async () => {
  const factory = new TrackingWorkerFactory();
  let secretCalls = 0;
  const executor = new ThreadExecutor(
    await options(factory, {
      secretProvider: {
        developmentOnly: false,
        open: async () => {},
        close: async () => {},
        health: async () => ({ status: "healthy", checkedAt: clock.now().toISOString() }),
        async get() {
          secretCalls += 1;
          return "must-not-return";
        },
      },
    }),
  );
  try {
    const result = await (await executor.submit(request({ mode: "forge-rpc" }, "forge-rpc")))
      .result;
    assert.equal(result.status, "succeeded");
    assert.equal(result.output, "safe");
    assert.equal(secretCalls, 0);
  } finally {
    await executor.drain({});
  }
});

test("plugin cannot capture the private broker by patching MessagePort.prototype", async () => {
  const factory = new TrackingWorkerFactory();
  let secretCalls = 0;
  const executor = new ThreadExecutor(
    await options(factory, {
      secretProvider: {
        developmentOnly: false,
        open: async () => {},
        close: async () => {},
        health: async () => ({ status: "healthy", checkedAt: clock.now().toISOString() }),
        async get() {
          secretCalls += 1;
          return "must-not-return";
        },
      },
    }),
  );
  try {
    const result = await (
      await executor.submit(request({ mode: "forge-private-port" }, "forge-private-port"))
    ).result;
    assert.equal(result.status, "succeeded");
    assert.equal(result.output, "safe");
    assert.equal(secretCalls, 0);
  } finally {
    await executor.drain({});
  }
});

test("unawaited event floods are backpressured and cannot exhaust the parent", async () => {
  const factory = new TrackingWorkerFactory();
  const eventGate = Promise.withResolvers<void>();
  let eventCalls = 0;
  const executor = new ThreadExecutor(
    await options(factory, {
      events: {
        async emit() {
          eventCalls += 1;
          await eventGate.promise;
        },
      },
    }),
  );
  try {
    const result = await (await executor.submit(request({ mode: "flood-events" }, "flood-events")))
      .result;
    assert.equal(result.status, "failed");
    assert.ok(eventCalls <= 64, `event sink received ${eventCalls} unbounded calls`);
    assert.equal(factory.active, 0);
  } finally {
    eventGate.resolve();
    await executor.drain({});
  }
});

test("event backpressure budget is shared across attempts until sinks settle", async () => {
  const factory = new TrackingWorkerFactory();
  const eventGate = Promise.withResolvers<void>();
  let eventCalls = 0;
  const executor = new ThreadExecutor(
    await options(factory, {
      events: {
        async emit() {
          eventCalls += 1;
          await eventGate.promise;
        },
      },
    }),
  );
  try {
    const first = await (
      await executor.submit(request({ mode: "flood-events" }, "flood-events-first"))
    ).result;
    assert.equal(first.status, "failed");
    assert.ok(eventCalls <= 64);

    const second = await (
      await executor.submit(request({ mode: "flood-events" }, "flood-events-second"))
    ).result;
    assert.equal(second.status, "failed");
    assert.ok(eventCalls <= 64, `shared sink budget grew to ${eventCalls}`);
  } finally {
    eventGate.resolve();
    await executor.drain({});
  }
});

test("transferable duplicate submission replays the existing handle after ownership moves", async () => {
  const factory = new TrackingWorkerFactory();
  const executor = new ThreadExecutor(await options(factory));
  const buffer = new Uint8Array([1, 2, 3]).buffer;
  const execution = threadExecutionRequest(
    request({ mode: "echo", value: "deduplicated" }, "transfer-deduplicate"),
    { buffers: [buffer], ownership: "transfer" },
  );
  try {
    const first = await executor.submit(execution);
    assert.equal(buffer.byteLength, 0);
    const duplicate = await executor.submit(execution);
    assert.strictEqual(duplicate, first);
    assert.equal((await duplicate.result).output, "deduplicated");
    assert.equal(factory.created, 1);
  } finally {
    await executor.drain({});
  }
});

test("oversized transferable payload is rejected before ownership or worker startup", async () => {
  const factory = new TrackingWorkerFactory();
  const executor = new ThreadExecutor(await options(factory));
  const first = new ArrayBuffer(Math.floor(THREAD_EXECUTOR_MAX_MESSAGE_BYTES / 2) + 1);
  const second = new ArrayBuffer(Math.floor(THREAD_EXECUTOR_MAX_MESSAGE_BYTES / 2) + 1);
  try {
    await assert.rejects(
      executor.submit(
        threadExecutionRequest(request({ mode: "echo", value: "too-large" }, "transfer-limit"), {
          buffers: [first, second],
          ownership: "transfer",
        }),
      ),
      (error: unknown) => diagnosticCode(error) === "EXECUTOR_INPUT_LIMIT_EXCEEDED",
    );
    assert.equal(first.byteLength > 0, true);
    assert.equal(second.byteLength > 0, true);
    assert.equal(factory.created, 0);
  } finally {
    await executor.drain({});
  }
});

test("the exact run envelope is bounded before transferable ownership moves", async () => {
  const factory = new TrackingWorkerFactory();
  const executor = new ThreadExecutor(await options(factory));
  const buffer = new ArrayBuffer(700_000);
  try {
    await assert.rejects(
      executor.submit(
        threadExecutionRequest(
          request({ mode: "echo", value: "x".repeat(700_000) }, "combined-transfer-limit"),
          { buffers: [buffer], ownership: "transfer" },
        ),
      ),
      (error: unknown) => diagnosticCode(error) === "EXECUTOR_INPUT_LIMIT_EXCEEDED",
    );
    assert.equal(buffer.byteLength, 700_000);
    assert.equal(factory.created, 0);
  } finally {
    await executor.drain({});
  }
});

test("clone fingerprints are recomputed after caller buffer mutation", async () => {
  const factory = new TrackingWorkerFactory();
  const executor = new ThreadExecutor(await options(factory));
  const buffer = new Uint8Array([1, 2, 3]).buffer;
  const execution = threadExecutionRequest(
    request({ mode: "echo", value: "clone-mutation" }, "clone-mutation"),
    { buffers: [buffer], ownership: "clone" },
  );
  try {
    await executor.submit(execution);
    new Uint8Array(buffer)[0] = 9;
    await assert.rejects(
      executor.submit(execution),
      (error: unknown) => diagnosticCode(error) === "PROTOCOL_IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await executor.drain({});
  }
});

test("transfer fingerprints frame attachment count and individual lengths", async () => {
  const factory = new TrackingWorkerFactory();
  const executor = new ThreadExecutor(await options(factory));
  const execution = request({ mode: "echo", value: "fingerprint-framing" }, "fingerprint-framing");
  try {
    await executor.submit(
      threadExecutionRequest(execution, {
        buffers: [Uint8Array.of(1).buffer, Uint8Array.of(2).buffer],
        ownership: "clone",
      }),
    );
    await assert.rejects(
      executor.submit(
        threadExecutionRequest(execution, {
          buffers: [Uint8Array.of(1, 2).buffer],
          ownership: "clone",
        }),
      ),
      (error: unknown) => diagnosticCode(error) === "PROTOCOL_IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await executor.drain({});
  }
});

test("active cancellation waits for worker termination before releasing capacity", async () => {
  const factory = new TrackingWorkerFactory();
  const started = Promise.withResolvers<void>();
  const executor = new ThreadExecutor(
    await options(factory, {
      maxConcurrency: 1,
      events: {
        async emit(type) {
          if (type === "run.started") started.resolve();
        },
      },
    }),
  );
  const execution = request({ mode: "ignore-cancel" }, "forced-cancel");
  const handle = await executor.submit(execution);
  try {
    await started.promise;
    await executor.cancel(execution.taskId, execution.attemptId);
    assert.equal(factory.active, 1);
    assert.equal((await executor.probe()).availableCapacity, 0);
    clock.advanceBy(100);
    assert.equal((await handle.result).status, "cancelled");
    assert.equal(factory.active, 0);
    assert.equal((await executor.probe()).availableCapacity, 1);
  } finally {
    await executor.drain({});
  }
});

test("resolver cancellation does not release result, drain, or capacity before admission settles", async () => {
  const factory = new TrackingWorkerFactory();
  const resolverStarted = Promise.withResolvers<void>();
  const resolverGate = Promise.withResolvers<void>();
  const base = await options(factory);
  const executor = new ThreadExecutor({
    ...base,
    maxConcurrency: 1,
    async resolveComponent(execution) {
      resolverStarted.resolve();
      await resolverGate.promise;
      return base.resolveComponent(execution);
    },
  });
  const execution = request({ mode: "echo", value: "late" }, "resolver-cancel");
  const handle = await executor.submit(execution);
  await resolverStarted.promise;
  await executor.cancel(execution.taskId, execution.attemptId);
  let resultSettled = false;
  let drainSettled = false;
  void handle.result.then(() => {
    resultSettled = true;
  });
  const draining = executor.drain({}).then(() => {
    drainSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resultSettled, false);
  assert.equal(drainSettled, false);
  assert.equal((await executor.probe()).availableCapacity, 0);

  resolverGate.resolve();
  await draining;
  assert.equal((await handle.result).status, "cancelled");
  assert.equal(resultSettled, true);
  assert.equal(drainSettled, true);
  assert.equal(factory.created, 0);
});

test("successful component output remains non-terminal until worker cleanup settles", async () => {
  const factory = new GatedTerminationFactory();
  const componentFinished = Promise.withResolvers<void>();
  const executor = new ThreadExecutor(
    await options(factory, {
      maxConcurrency: 1,
      events: {
        async emit(type) {
          if (type === "run.finished") componentFinished.resolve();
        },
      },
    }),
  );
  const execution = request({ mode: "finish-gate", value: "complete" }, "cleanup-gate");
  const handle = await executor.submit(execution);
  await componentFinished.promise;
  await factory.terminationStarted.promise;
  let resultSettled = false;
  let drainSettled = false;
  void handle.result.then(() => {
    resultSettled = true;
  });
  const draining = executor.drain({}).then(() => {
    drainSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await executor.observe(execution.taskId, execution.attemptId), {
    state: "running",
  });
  assert.equal(resultSettled, false);
  assert.equal(drainSettled, false);
  assert.equal((await executor.probe()).availableCapacity, 0);

  factory.gate.resolve();
  await draining;
  assert.equal((await handle.result).status, "succeeded");
  assert.equal(resultSettled, true);
  assert.equal(drainSettled, true);
  assert.equal((await executor.health()).active, 0);
});

test("failed component output remains non-terminal until worker cleanup settles", async () => {
  const factory = new GatedTerminationFactory();
  const executor = new ThreadExecutor(await options(factory, { maxConcurrency: 1 }));
  const execution = request({ mode: "large-output" }, "failed-cleanup-gate");
  const handle = await executor.submit(execution);
  await factory.terminationStarted.promise;
  let resultSettled = false;
  try {
    void handle.result.then(() => {
      resultSettled = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(await executor.observe(execution.taskId, execution.attemptId), {
        state: "running",
      });
      assert.equal(resultSettled, false);
      assert.equal(factory.active, 1);
      assert.equal((await executor.probe()).availableCapacity, 0);
    } finally {
      factory.gate.resolve();
    }
    assert.equal((await handle.result).status, "failed");
    assert.equal(resultSettled, true);
    assert.equal(factory.active, 0);
  } finally {
    factory.gate.resolve();
    await executor.drain({});
  }
});

test("worker exit releases cleanup even when terminate remains pending and later rejects", async () => {
  const factory = new ExitFirstTerminationFactory();
  const executor = new ThreadExecutor(await options(factory, { maxConcurrency: 1 }));
  const handle = await executor.submit(
    request({ mode: "echo", value: "exit-authoritative" }, "exit-authoritative"),
  );
  await factory.exited.promise;
  let result: Awaited<typeof handle.result> | undefined;
  void handle.result.then((value) => {
    result = value;
  });
  await eventually(() => assert.notEqual(result, undefined), {
    attempts: 20,
    advance: () => new Promise((resolve) => setImmediate(resolve)),
  });
  factory.lateTermination.reject(new Error("late terminate rejection"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result?.status, "succeeded");
  assert.equal((await executor.health()).status, "healthy");
  assert.equal((await executor.probe()).availableCapacity, 1);
  await executor.drain({});
});

test("terminate rejection transfers custody to quarantine without double-counting active", async () => {
  const factory = new RejectingTerminationFactory();
  const executor = new ThreadExecutor(await options(factory, { maxConcurrency: 1 }));
  const handle = await executor.submit(
    request({ mode: "echo", value: "termination-reject" }, "termination-reject"),
  );
  await factory.terminationStarted.promise;
  let drained = false;
  const draining = executor.drain({}).then(() => {
    drained = true;
  });
  let result: Awaited<typeof handle.result> | undefined;
  void handle.result.then((value) => {
    result = value;
  });
  try {
    await eventually(() => assert.notEqual(result, undefined), {
      attempts: 20,
      advance: () => new Promise((resolve) => setImmediate(resolve)),
    });
    if (result === undefined) throw new Error("Termination rejection result is missing");
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostic?.code, "EXECUTOR_THREAD_TERMINATION_FAILED");
    assert.equal((await executor.health()).active, 1);
    assert.equal((await executor.health()).status, "unhealthy");
    assert.equal((await executor.probe()).availableCapacity, 0);
    assert.equal(drained, false);

    await factory.forceExit();
    await draining;
    assert.equal((await executor.health()).active, 0);
  } finally {
    await factory.forceExit().catch(() => undefined);
  }
});

test("terminate and exit timeout enters bounded quarantine until authoritative exit", async () => {
  const factory = new HangingTerminationFactory();
  const executor = new ThreadExecutor(
    await options(factory, { cleanupGraceMs: 100, maxConcurrency: 1 }),
  );
  const handle = await executor.submit(
    request({ mode: "echo", value: "termination-timeout" }, "termination-timeout"),
  );
  await factory.terminationStarted.promise;
  clock.advanceBy(100);
  let drained = false;
  const draining = executor.drain({}).then(() => {
    drained = true;
  });
  let result: Awaited<typeof handle.result> | undefined;
  void handle.result.then((value) => {
    result = value;
  });
  try {
    await eventually(() => assert.notEqual(result, undefined), {
      attempts: 20,
      advance: () => new Promise((resolve) => setImmediate(resolve)),
    });
    if (result === undefined) throw new Error("Termination timeout result is missing");
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostic?.code, "EXECUTOR_THREAD_TERMINATION_FAILED");
    assert.equal((await executor.health()).active, 1);
    assert.equal((await executor.health()).status, "unhealthy");
    assert.equal((await executor.probe()).availableCapacity, 0);
    assert.equal(drained, false);

    await factory.forceExit();
    await draining;
    assert.equal((await executor.health()).active, 0);
  } finally {
    factory.termination.resolve(0);
    await factory.forceExit().catch(() => undefined);
  }
});

test("cancellation during worker cleanup wins the single terminal decision", async () => {
  const factory = new GatedTerminationFactory();
  const componentFinished = Promise.withResolvers<void>();
  const executor = new ThreadExecutor(
    await options(factory, {
      maxConcurrency: 1,
      events: {
        async emit(type) {
          if (type === "run.finished") componentFinished.resolve();
        },
      },
    }),
  );
  const execution = request({ mode: "finish-gate", value: "too-late" }, "cleanup-cancel");
  const handle = await executor.submit(execution);
  await componentFinished.promise;
  await factory.terminationStarted.promise;
  await executor.cancel(execution.taskId, execution.attemptId);
  factory.gate.resolve();
  try {
    assert.equal((await handle.result).status, "cancelled");
  } finally {
    await executor.drain({});
  }
});

test("deadline during worker cleanup wins the single terminal decision", async () => {
  const factory = new GatedTerminationFactory();
  const componentFinished = Promise.withResolvers<void>();
  const executor = new ThreadExecutor(
    await options(factory, {
      maxConcurrency: 1,
      events: {
        async emit(type) {
          if (type === "run.finished") componentFinished.resolve();
        },
      },
    }),
  );
  const execution = {
    ...request({ mode: "finish-gate", value: "too-late" }, "cleanup-deadline"),
    deadline: new Date(clock.now().getTime() + 100).toISOString(),
  };
  const handle = await executor.submit(execution);
  await componentFinished.promise;
  await factory.terminationStarted.promise;
  clock.advanceBy(100);
  await Promise.resolve();
  factory.gate.resolve();
  try {
    assert.equal((await handle.result).status, "timed-out");
  } finally {
    await executor.drain({});
  }
});

test("connect transfer failure closes both private ports and the worker", async () => {
  const factory = new ConnectFailureFactory();
  const before = process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "MessagePort").length;
  const executor = new ThreadExecutor(await options(factory));
  try {
    const result = await (
      await executor.submit(request({ mode: "echo", value: "never" }, "connect-failure"))
    ).result;
    assert.equal(result.status, "failed");
    assert.equal(factory.active, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const after = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "MessagePort").length;
    assert.equal(after, before);
  } finally {
    await executor.drain({});
  }
});
