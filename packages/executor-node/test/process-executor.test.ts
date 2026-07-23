import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  diagnosticCode,
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseComponentId,
  parsePluginId,
  parsePluginManifest,
  parseTaskId,
  type Clock,
  type DriverHealth,
  type ExecutionRequest,
  type HostedProcess,
  type HostedProcessExit,
  type JsonValue,
  type ProcessHost,
  type ProcessSpawnRequest,
} from "@tegojs/contracts";
import {
  eventually,
  executorConformance,
  FakeClock,
  type ExecutorConformanceFixture,
} from "@tegojs/testkit";
import {
  PROCESS_EXECUTOR_MAX_FRAME_BYTES,
  ProcessFrameDecoder,
  ProcessExecutor,
  encodeProcessFrame,
  selectExecutor,
  type ProcessExecutorOptions,
} from "../src/index.js";

const digest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
const clock = new FakeClock(new Date(0));
const directories: string[] = [];

class TestHostedProcess implements HostedProcess {
  readonly pid: number | undefined;
  readonly stdin: HostedProcess["stdin"];
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exit: Promise<HostedProcessExit>;

  constructor(child: ChildProcessWithoutNullStreams, exited: () => void) {
    this.#child = child;
    this.pid = child.pid;
    this.stdout = child.stdout as AsyncIterable<Uint8Array>;
    this.stderr = child.stderr as AsyncIterable<Uint8Array>;
    this.#exit = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        exited();
        resolve({
          ...(code === null ? {} : { code }),
          ...(signal === null ? {} : { signal }),
        });
      });
    });
    this.stdin = {
      write: (bytes) =>
        new Promise<void>((resolve, reject) => {
          child.stdin.write(Buffer.from(bytes), (error) =>
            error === null || error === undefined ? resolve() : reject(error),
          );
        }),
      close: () =>
        new Promise<void>((resolve) => {
          if (child.stdin.destroyed || child.stdin.writableEnded) resolve();
          else child.stdin.end(resolve);
        }),
    };
  }

  async signal(signal: "SIGINT" | "SIGTERM"): Promise<void> {
    this.#child.kill(signal);
  }

  async kill(): Promise<void> {
    this.#child.kill("SIGKILL");
  }

  wait(): Promise<HostedProcessExit> {
    return this.#exit;
  }

  async close(): Promise<void> {
    await this.stdin.close().catch(() => undefined);
    await this.wait();
  }
}

class TestProcessHost implements ProcessHost {
  readonly #processes = new Set<TestHostedProcess>();
  #open = false;

  get activeProcessCount(): number {
    return this.#processes.size;
  }

  async open(): Promise<void> {
    this.#open = true;
  }

  async health(): Promise<DriverHealth> {
    return {
      status: this.#open ? "healthy" : "unhealthy",
      checkedAt: clock.now().toISOString(),
    };
  }

  async spawn(request: ProcessSpawnRequest): Promise<HostedProcess> {
    if (!this.#open) throw new Error("Test process host is closed");
    const child = spawn(process.execPath, [request.entrypoint, ...(request.arguments ?? [])], {
      env: { ...(request.environment ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let hosted!: TestHostedProcess;
    hosted = new TestHostedProcess(child, () => this.#processes.delete(hosted));
    this.#processes.add(hosted);
    return hosted;
  }

  async close(): Promise<void> {
    const processes = [...this.#processes];
    await Promise.all(processes.map((hosted) => hosted.kill()));
    await Promise.all(processes.map((hosted) => hosted.wait()));
    this.#open = false;
  }
}

after(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const componentSource = `
import { writeSync } from "node:fs";

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
      setInterval(() => {}, 1000);
      return new Promise(() => {});
    }
    if (input.mode === "linger-after-result") {
      setInterval(() => {}, 1000);
      await context.events.emit("run.finished", { mode: input.mode });
      return input.value;
    }
    if (input.mode === "ignore-sigterm") {
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      await context.events.emit("run.finished", { mode: input.mode });
      return input.value;
    }
    if (input.mode === "forge-rpc") {
      const payload = Buffer.from(JSON.stringify({
        kind: "rpc-request",
        id: "forged",
        type: "secret",
        payload: { name: "api" }
      }));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.byteLength, 0);
      writeSync(1, Buffer.concat([header, payload]));
      return "forged";
    }
    if (input.mode === "crash") process.exit(42);
    if (input.mode === "stderr") {
      process.stderr.write("diagnostic " + "x".repeat(200000));
      return input.value;
    }
    if (input.mode === "secret-stderr") {
      const secret = await context.secrets.get("api");
      process.stderr.write("secret=" + secret);
      return { secretToken: secret };
    }
    if (input.mode === "large-output") return "x".repeat(${1024 * 1024 + 64});
    return input.value;
  }
};
`;

async function artifact() {
  const root = await mkdtemp(join(tmpdir(), "tego-process-executor-"));
  directories.push(root);
  const componentPath = join(root, "components", "echo.js");
  await mkdir(join(root, "components"), { recursive: true });
  await writeFile(componentPath, componentSource);
  const artifactRoot = await realpath(root);
  const manifest = parsePluginManifest({
    schemaVersion: "1.0",
    pluginId: "org.example.process",
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
    taskId: parseTaskId(`task-${suffix}`),
    attemptId: parseAttemptId(`attempt-${suffix}`),
    applicationId: parseApplicationId("app"),
    pluginId: parsePluginId("org.example.process"),
    componentId: parseComponentId("echo"),
    input,
    deadline: new Date(60_000).toISOString(),
    orphanPolicy: "cancel",
  };
}

async function options(
  overrides: Partial<ProcessExecutorOptions> = {},
): Promise<ProcessExecutorOptions> {
  const fixture = await artifact();
  return {
    id: "process-local",
    clock,
    processHost: new TestProcessHost(),
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

const conformanceFixture: ExecutorConformanceFixture = {
  request,
  echoInput: { mode: "echo", value: { echoed: true } },
  echoOutput: { echoed: true },
  waitingInput: { mode: "wait", generation: 0 },
  async advanceClock(milliseconds) {
    clock.advanceBy(milliseconds);
    await Promise.resolve();
    await Promise.resolve();
  },
};

executorConformance(async () => new ProcessExecutor(await options()), conformanceFixture);

test("process framing handles partial, coalesced, truncated, and invalid frames", () => {
  const first = encodeProcessFrame({ sequence: 1 });
  const second = encodeProcessFrame({ sequence: 2 });
  const decoder = new ProcessFrameDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(first.subarray(2)), [{ sequence: 1 }]);
  assert.deepEqual(decoder.push(Buffer.concat([Buffer.from(first), Buffer.from(second)])), [
    { sequence: 1 },
    { sequence: 2 },
  ]);
  decoder.finish();

  const truncated = new ProcessFrameDecoder();
  truncated.push(first.subarray(0, first.byteLength - 1));
  assert.throws(
    () => truncated.finish(),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_PROCESS_FRAME_TRUNCATED",
  );

  const invalidJson = Buffer.alloc(5);
  invalidJson.writeUInt32BE(1, 0);
  invalidJson[4] = "{".charCodeAt(0);
  assert.throws(
    () => new ProcessFrameDecoder().push(invalidJson),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_PROCESS_FRAME_INVALID",
  );
});

test("process framing rejects an oversized declared length before buffering its payload", () => {
  const malicious = Buffer.alloc(PROCESS_EXECUTOR_MAX_FRAME_BYTES + 5);
  malicious.writeUInt32BE(PROCESS_EXECUTOR_MAX_FRAME_BYTES + 1, 0);
  let parseCalls = 0;
  const originalParse = JSON.parse;
  JSON.parse = ((...arguments_: Parameters<typeof JSON.parse>) => {
    parseCalls += 1;
    return originalParse(...arguments_);
  }) as typeof JSON.parse;
  try {
    assert.throws(
      () => new ProcessFrameDecoder().push(malicious),
      (error: unknown) => diagnosticCode(error) === "PROTOCOL_PROCESS_FRAME_LENGTH_INVALID",
    );
    assert.equal(parseCalls, 0);
  } finally {
    JSON.parse = originalParse;
  }
});

test("process framing rejects excessive wire complexity", () => {
  let nested: JsonValue = null;
  for (let depth = 0; depth < 65; depth += 1) nested = [nested];
  const frame = encodeProcessFrame(nested);
  assert.throws(
    () => new ProcessFrameDecoder().push(frame),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_PROCESS_FRAME_COMPLEXITY_EXCEEDED",
  );
});

test("@spec:executor-runtime/executor-failure-containment/crash-replacement", async () => {
  const executor = new ProcessExecutor(await options({ maxConcurrency: 1 }));
  try {
    const crashed = await executor.submit(request({ mode: "crash" }, "crash"));
    const failure = await crashed.result;
    assert.equal(failure.status, "failed");
    assert.equal(failure.diagnostic?.code, "EXECUTOR_PROCESS_EXIT");

    const replacement = await executor.submit(
      request({ mode: "echo", value: "replacement" }, "replacement"),
    );
    assert.equal((await replacement.result).output, "replacement");
  } finally {
    await executor.drain({});
  }
});

test("active cancellation is cooperative before fake-clock grace forces process termination", async () => {
  const started = Promise.withResolvers<void>();
  const processHost = new TestProcessHost();
  const executor = new ProcessExecutor(
    await options({
      processHost,
      maxConcurrency: 1,
      events: {
        async emit(type) {
          if (type === "run.started") started.resolve();
        },
      },
    }),
  );
  const execution = request({ mode: "ignore-cancel" }, "force-cancel");
  const handle = await executor.submit(execution);
  await started.promise;
  await executor.cancel(execution.taskId, execution.attemptId);
  assert.equal(processHost.activeProcessCount, 1);
  clock.advanceBy(100);
  assert.equal((await handle.result).status, "cancelled");
  assert.equal(processHost.activeProcessCount, 0);
  await executor.drain({});
});

test("duplicate cancellation shares one escalation timer", async () => {
  const started = Promise.withResolvers<void>();
  let graceSleeps = 0;
  const countingClock: Clock = {
    now: () => clock.now(),
    sleep(delay, signal) {
      if (delay === 100) graceSleeps += 1;
      return clock.sleep(delay, signal);
    },
  };
  const executor = new ProcessExecutor(
    await options({
      clock: countingClock,
      events: {
        async emit(type) {
          if (type === "run.started") started.resolve();
        },
      },
    }),
  );
  const execution = request({ mode: "ignore-cancel" }, "duplicate-cancel");
  const handle = await executor.submit(execution);
  await started.promise;
  await Promise.all(
    Array.from({ length: 20 }, () => executor.cancel(execution.taskId, execution.attemptId)),
  );
  assert.equal(graceSleeps, 1);
  clock.advanceBy(100);
  await handle.result;
  await executor.drain({});
});

test("an active deadline uses the shared clock and cannot be overwritten by a late exit", async () => {
  const started = Promise.withResolvers<void>();
  const processHost = new TestProcessHost();
  const executor = new ProcessExecutor(
    await options({
      processHost,
      maxConcurrency: 1,
      events: {
        async emit(type) {
          if (type === "run.started") started.resolve();
        },
      },
    }),
  );
  const execution = {
    ...request({ mode: "ignore-cancel" }, "active-deadline"),
    deadline: new Date(clock.now().getTime() + 50).toISOString(),
  };
  const handle = await executor.submit(execution);
  await started.promise;
  clock.advanceBy(50);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  clock.advanceBy(100);
  const first = await handle.result;
  assert.equal(first.status, "timed-out");
  assert.deepEqual(await executor.observe(execution.taskId, execution.attemptId), {
    state: "terminal",
    result: first,
  });
  await executor.cancel(execution.taskId, execution.attemptId);
  const afterDuplicateCancel = await executor.observe(execution.taskId, execution.attemptId);
  assert.equal(afterDuplicateCancel?.state, "terminal");
  if (afterDuplicateCancel?.state === "terminal") {
    assert.deepEqual(afterDuplicateCancel.result, first);
  }
  await executor.drain({});
});

test("active and queued attempts are hard bounded before asynchronous spawn begins", async () => {
  const executor = new ProcessExecutor(await options({ maxConcurrency: 1, maxQueue: 0 }));
  const firstRequest = request({ mode: "wait" }, "bounded-first");
  const first = await executor.submit(firstRequest);
  await assert.rejects(
    executor.submit(request({ mode: "echo", value: "overflow" }, "bounded-second")),
    (error: unknown) => diagnosticCode(error) === "EXECUTOR_QUEUE_CAPACITY_EXCEEDED",
  );
  await executor.cancel(firstRequest.taskId, firstRequest.attemptId);
  clock.advanceBy(100);
  await first.result;
  await executor.drain({});
});

test("input and output wire sizes are bounded", async () => {
  const executor = new ProcessExecutor(await options());
  try {
    await assert.rejects(
      executor.submit(request({ value: "x".repeat(PROCESS_EXECUTOR_MAX_FRAME_BYTES) }, "large-in")),
      (error: unknown) => diagnosticCode(error) === "EXECUTOR_INPUT_LIMIT_EXCEEDED",
    );
    const result = await (await executor.submit(request({ mode: "large-output" }, "large-out")))
      .result;
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostic?.code, "EXECUTOR_OUTPUT_LIMIT_EXCEEDED");
  } finally {
    await executor.drain({});
  }
});

test("spawn failure leaks neither capacity nor hosted process handles", async () => {
  const processHost = new TestProcessHost();
  const executor = new ProcessExecutor(
    await options({
      processHost,
      processEntrypoint: join(process.cwd(), "missing-process-entry.js"),
      maxConcurrency: 1,
    }),
  );
  const result = await (await executor.submit(request({ mode: "echo" }, "spawn-fail"))).result;
  assert.equal(result.status, "failed");
  assert.equal((await executor.health()).active, 0);
  assert.equal(processHost.activeProcessCount, 0);
  await executor.drain({});
  assert.equal(processHost.activeProcessCount, 0);
});

test("process host open, health, and shutdown are idempotent", async () => {
  const host = new TestProcessHost();
  await Promise.all([host.open(), host.open()]);
  assert.equal((await host.health()).status, "healthy");
  await Promise.all([host.close(), host.close()]);
  assert.equal(host.activeProcessCount, 0);
});

test("drain and close leave no active child process", async () => {
  const processHost = new TestProcessHost();
  const executor = new ProcessExecutor(await options({ processHost }));
  const handled = await executor.submit(request({ mode: "echo", value: "done" }, "close"));
  assert.equal((await handled.result).status, "succeeded");
  await Promise.all([executor.drain({}), executor.drain({})]);
  await Promise.all([executor.close(), executor.close()]);
  assert.equal(processHost.activeProcessCount, 0);
  assert.equal((await executor.health()).active, 0);
});

test("a task that leaves handles behind cannot retain its child slot after returning", async () => {
  const finished = Promise.withResolvers<void>();
  const processHost = new TestProcessHost();
  const executor = new ProcessExecutor(
    await options({
      processHost,
      events: {
        async emit(type) {
          if (type === "run.finished") finished.resolve();
        },
      },
    }),
  );
  const handle = await executor.submit(
    request({ mode: "linger-after-result", value: "complete" }, "linger"),
  );
  try {
    await finished.promise;
    let settled = false;
    void handle.result.then(() => {
      settled = true;
    });
    await eventually(() => assert.equal(settled, true), {
      attempts: 1_000,
      advance: () => new Promise((resolve) => setImmediate(resolve)),
    });
    assert.equal(processHost.activeProcessCount, 0);
  } finally {
    await processHost.close();
    await executor.drain({});
  }
});

test("graceful cleanup is bounded when a returned component ignores SIGTERM", async () => {
  const finished = Promise.withResolvers<void>();
  const processHost = new TestProcessHost();
  const executor = new ProcessExecutor(
    await options({
      processHost,
      events: {
        async emit(type) {
          if (type === "run.finished") finished.resolve();
        },
      },
    }),
  );
  const handle = await executor.submit(
    request({ mode: "ignore-sigterm", value: "complete" }, "ignore-sigterm"),
  );
  try {
    await finished.promise;
    clock.advanceBy(100);
    let settled = false;
    void handle.result.then(() => {
      settled = true;
    });
    await eventually(() => assert.equal(settled, true), {
      attempts: 1_000,
      advance: () => new Promise((resolve) => setImmediate(resolve)),
    });
    assert.equal(processHost.activeProcessCount, 0);
  } finally {
    await processHost.close();
    await executor.drain({});
  }
});

test("drain deadline cancels accepted work and bounds shutdown", async () => {
  const started = Promise.withResolvers<void>();
  const processHost = new TestProcessHost();
  const executor = new ProcessExecutor(
    await options({
      processHost,
      events: {
        async emit(type) {
          if (type === "run.started") started.resolve();
        },
      },
    }),
  );
  const execution = request({ mode: "ignore-cancel" }, "drain-deadline");
  const handle = await executor.submit(execution);
  try {
    await started.promise;
    let drained = false;
    const draining = executor
      .drain({
        deadline: new Date(clock.now().getTime() + 50).toISOString(),
      })
      .then(() => {
        drained = true;
      });
    clock.advanceBy(50);
    await Promise.resolve();
    await Promise.resolve();
    clock.advanceBy(100);
    await eventually(() => assert.equal(drained, true), {
      attempts: 1_000,
      advance: () => new Promise((resolve) => setImmediate(resolve)),
    });
    assert.equal((await handle.result).status, "cancelled");
    await draining;
  } finally {
    await processHost.close();
  }
});

test("stderr diagnostics are bounded and sensitive fields are redacted", async () => {
  const executor = new ProcessExecutor(await options());
  try {
    const result = await (
      await executor.submit(
        request({ mode: "stderr", value: { secretToken: "do-not-return" } }, "stderr"),
      )
    ).result;
    assert.equal(result.status, "succeeded");
    const metadata = result.executor.metadata;
    assert.ok(JSON.stringify(metadata).length < 70_000);
    assert.doesNotMatch(JSON.stringify(metadata), /do-not-return/u);
  } finally {
    await executor.drain({});
  }
});

test("secret RPC stays parent-gated and redacts direct child stderr", async () => {
  const executor = new ProcessExecutor(
    await options({
      secretProvider: {
        developmentOnly: false,
        open: async () => {},
        health: async () => ({
          status: "healthy",
          checkedAt: clock.now().toISOString(),
        }),
        close: async () => {},
        get: async (name) => (name === "api" ? "parent-only-secret" : undefined),
      },
    }),
  );
  try {
    const result = await (
      await executor.submit(request({ mode: "secret-stderr" }, "secret-stderr"))
    ).result;
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.output, { secretToken: "[REDACTED]" });
    assert.doesNotMatch(JSON.stringify(result.executor.metadata), /parent-only-secret/u);
    assert.match(JSON.stringify(result.executor.metadata), /\[REDACTED\]/u);
  } finally {
    await executor.drain({});
  }
});

test("raw plugin stdout cannot forge a parent RPC request", async () => {
  let secretCalls = 0;
  const executor = new ProcessExecutor(
    await options({
      secretProvider: {
        developmentOnly: false,
        open: async () => {},
        health: async () => ({
          status: "healthy",
          checkedAt: clock.now().toISOString(),
        }),
        close: async () => {},
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
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostic?.code, "PROTOCOL_PROCESS_FRAME_AUTHENTICATION_FAILED");
    assert.equal(secretCalls, 0);
  } finally {
    await executor.drain({});
  }
});

test("selection filters support, grant, resources, and health before preference", () => {
  const selected = selectExecutor({
    supported: ["process", "remote", "thread"],
    granted: ["process", "remote", "thread"],
    resources: { cpuMillis: 500, memoryBytes: 1024, storageBytes: 0 },
    preference: ["process", "remote", "thread"],
    candidates: [
      {
        id: "process",
        type: "process",
        available: false,
        healthy: true,
        resources: { cpuMillis: 1000, memoryBytes: 2048, storageBytes: 0 },
      },
      {
        id: "remote",
        type: "remote",
        available: true,
        healthy: true,
        resources: { cpuMillis: 1000, memoryBytes: 2048, storageBytes: 0 },
      },
      {
        id: "thread",
        type: "thread",
        available: true,
        healthy: true,
        resources: { cpuMillis: 100, memoryBytes: 2048, storageBytes: 0 },
      },
    ],
  });
  assert.equal(selected.id, "remote");

  assert.throws(
    () =>
      selectExecutor({
        supported: ["process"],
        granted: ["process"],
        resources: { cpuMillis: 1, memoryBytes: 1, storageBytes: 1 },
        candidates: [],
      }),
    (error: unknown) => diagnosticCode(error) === "EXECUTOR_SELECTION_UNAVAILABLE",
  );
});
