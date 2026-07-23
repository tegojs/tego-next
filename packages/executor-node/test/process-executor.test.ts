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
  type Permission,
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
  readonly #signalled: () => void;

  constructor(child: ChildProcessWithoutNullStreams, exited: () => void, signalled: () => void) {
    this.#child = child;
    this.#signalled = signalled;
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
    this.#signalled();
    this.#child.kill(signal);
  }

  async kill(): Promise<HostedProcessExit> {
    this.#child.kill("SIGKILL");
    return this.#exit;
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
  #peakActiveProcessCount = 0;
  #signalCount = 0;

  get activeProcessCount(): number {
    return this.#processes.size;
  }

  get signalCount(): number {
    return this.#signalCount;
  }

  get peakActiveProcessCount(): number {
    return this.#peakActiveProcessCount;
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
    hosted = new TestHostedProcess(
      child,
      () => this.#processes.delete(hosted),
      () => {
        this.#signalCount += 1;
      },
    );
    this.#processes.add(hosted);
    this.#peakActiveProcessCount = Math.max(this.#peakActiveProcessCount, this.#processes.size);
    return hosted;
  }

  async close(): Promise<void> {
    const processes = [...this.#processes];
    await Promise.all(processes.map((hosted) => hosted.kill()));
    await Promise.all(processes.map((hosted) => hosted.wait()));
    this.#open = false;
  }
}

class NonSettlingWaitProcessHost extends TestProcessHost {
  override async spawn(request: ProcessSpawnRequest): Promise<HostedProcess> {
    const hosted = await super.spawn(request);
    return {
      pid: hosted.pid,
      stdin: hosted.stdin,
      stdout: hosted.stdout,
      stderr: hosted.stderr,
      signal: (signal) => hosted.signal(signal),
      kill: () => hosted.kill(),
      wait: () => new Promise<HostedProcessExit>(() => {}),
      close: () => new Promise<void>(() => {}),
    };
  }
}

class RejectingKillProcessHost extends TestProcessHost {
  spawnCount = 0;

  override async spawn(request: ProcessSpawnRequest): Promise<HostedProcess> {
    this.spawnCount += 1;
    const hosted = await super.spawn(request);
    return {
      pid: hosted.pid,
      stdin: hosted.stdin,
      stdout: hosted.stdout,
      stderr: hosted.stderr,
      signal: (signal) => hosted.signal(signal),
      kill: () => Promise.reject(new Error("SIGKILL delivery failed")),
      wait: () => new Promise<HostedProcessExit>(() => {}),
      close: () => new Promise<void>(() => {}),
    };
  }
}

class DelayedSpawnProcessHost extends TestProcessHost {
  readonly started = Promise.withResolvers<void>();
  readonly gate = Promise.withResolvers<void>();
  readonly returned = Promise.withResolvers<void>();
  spawnCount = 0;

  override async spawn(request: ProcessSpawnRequest): Promise<HostedProcess> {
    this.spawnCount += 1;
    this.started.resolve();
    await this.gate.promise;
    const hosted = await super.spawn(request);
    this.returned.resolve();
    return hosted;
  }
}

class StalledCloseDelayedSpawnProcessHost extends DelayedSpawnProcessHost {
  override async spawn(request: ProcessSpawnRequest): Promise<HostedProcess> {
    const hosted = await super.spawn(request);
    return {
      pid: hosted.pid,
      stdin: {
        write: (bytes) => hosted.stdin.write(bytes),
        close: () => new Promise<void>(() => {}),
      },
      stdout: hosted.stdout,
      stderr: hosted.stderr,
      signal: (signal) => hosted.signal(signal),
      kill: () => hosted.kill(),
      wait: () => hosted.wait(),
      close: () => hosted.close(),
    };
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
    if (input.mode === "replay-rpc") {
      const originalWrite = process.stdout.write.bind(process.stdout);
      let captured;
      process.stdout.write = (chunk, ...arguments_) => {
        captured ??= Buffer.from(chunk);
        return originalWrite(chunk, ...arguments_);
      };
      await context.secrets.get("api");
      process.stdout.write = originalWrite;
      writeSync(1, captured);
      return "replayed";
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
  crashInput: { mode: "crash" },
  replacementInput: { mode: "echo", value: "replacement" },
  replacementOutput: "replacement",
  oversizedInput: { value: "x".repeat(PROCESS_EXECUTOR_MAX_FRAME_BYTES) },
  oversizedOutputInput: { mode: "large-output" },
  activeResourceCount: () => conformanceProcessHost?.activeProcessCount ?? 0,
  async spawnFailureFactory() {
    conformanceProcessHost = new TestProcessHost();
    return new ProcessExecutor(
      await options({
        processHost: conformanceProcessHost,
        processEntrypoint: join(process.cwd(), "missing-process-entry.js"),
      }),
    );
  },
  async shutdownHostTwice() {
    conformanceProcessHost = new TestProcessHost();
    await Promise.all([conformanceProcessHost.open(), conformanceProcessHost.open()]);
    await Promise.all([conformanceProcessHost.close(), conformanceProcessHost.close()]);
  },
  async advanceClock(milliseconds) {
    clock.advanceBy(milliseconds);
    await Promise.resolve();
    await Promise.resolve();
  },
};

let conformanceProcessHost: TestProcessHost | undefined;

executorConformance(async () => {
  conformanceProcessHost = new TestProcessHost();
  return new ProcessExecutor(await options({ processHost: conformanceProcessHost }));
}, conformanceFixture);

test("attempt fingerprints canonicalize nested object key order", async () => {
  const executor = new ProcessExecutor(await options());
  const original = request(
    { mode: "echo", value: { first: 1, nested: { left: true, right: false } } },
    "canonical-fingerprint",
  );
  try {
    const first = await executor.submit(original);
    const duplicate = await executor.submit({
      ...original,
      input: {
        value: { nested: { right: false, left: true }, first: 1 },
        mode: "echo",
      },
    });
    assert.strictEqual(duplicate, first);
    assert.equal((await first.result).status, "succeeded");
  } finally {
    await executor.drain({});
  }
});

test("submit snapshots mutable request data at admission", async () => {
  const gate = Promise.withResolvers<void>();
  const base = await options();
  const executor = new ProcessExecutor({
    ...base,
    async resolveComponent(execution) {
      await gate.promise;
      return base.resolveComponent(execution);
    },
  });
  const mutable = { nested: { value: "original" } };
  const execution = request({ mode: "echo", value: mutable }, "request-snapshot");
  const handle = await executor.submit(execution);
  mutable.nested.value = "mutated";
  gate.resolve();
  try {
    assert.deepEqual((await handle.result).output, { nested: { value: "original" } });
  } finally {
    await executor.drain({});
  }
});

test("terminal results are deeply immutable cached snapshots", async () => {
  const executor = new ProcessExecutor(await options());
  const execution = request(
    { mode: "echo", value: { nested: { value: "original" } } },
    "result-snapshot",
  );
  try {
    const result = await (await executor.submit(execution)).result;
    assert.throws(() => {
      (result.output as { nested: { value: string } }).nested.value = "mutated";
    }, TypeError);
    const observed = await executor.observe(execution.taskId, execution.attemptId);
    assert.equal(observed?.state, "terminal");
    if (observed?.state === "terminal") {
      assert.deepEqual(observed.result.output, { nested: { value: "original" } });
    }
  } finally {
    await executor.drain({});
  }
});

test("child permission validation accepts canonical narrowed grants for every permission category", async () => {
  const requested = [
    {
      kind: "capability",
      capabilities: [{ name: "org.example.echo", methods: ["read", "write"] }],
    },
    { kind: "executor", executors: ["process", "thread"] },
    { kind: "secret", names: ["api", "signing"] },
    {
      kind: "network",
      hosts: ["EXAMPLE.com.", "api.example.com"],
      ports: [80, 443],
      methods: ["GET", "POST"],
    },
    {
      kind: "filesystem",
      roots: [{ path: "/data", access: ["read", "write"] }],
    },
    {
      kind: "worker",
      labels: { zone: "edge-a" },
      resources: { cpuMillis: 2_000, memoryBytes: 2_000, storageBytes: 2_000 },
    },
  ] satisfies readonly Permission[];
  const granted = [
    {
      kind: "capability",
      capabilities: [{ name: "org.example.echo", methods: ["read"] }],
    },
    { kind: "executor", executors: ["process"] },
    { kind: "secret", names: ["api"] },
    {
      kind: "network",
      hosts: ["example.com"],
      ports: [443],
      methods: ["GET"],
    },
    {
      kind: "filesystem",
      roots: [{ path: "/data/reports", access: ["read"] }],
    },
    {
      kind: "worker",
      labels: { zone: "edge-a", accelerator: "gpu" },
      resources: { cpuMillis: 1_000, memoryBytes: 1_000, storageBytes: 1_000 },
    },
  ] satisfies readonly Permission[];
  const fixture = await artifact();
  const manifest = parsePluginManifest({ ...fixture.manifest, permissions: requested });
  const executor = new ProcessExecutor(
    await options({
      resolveComponent: async () => ({
        artifactDigest: digest,
        artifactRoot: fixture.artifactRoot,
        manifest,
        runtimeId: "runtime",
        instanceId: "instance",
        configuration: {},
        permissionGrants: granted,
        capabilityDefinitions: [],
      }),
    }),
  );
  try {
    const result = await (
      await executor.submit(request({ mode: "echo", value: "narrowed" }, "narrowed-permissions"))
    ).result;
    assert.equal(result.status, "succeeded");
    assert.equal(result.output, "narrowed");
  } finally {
    await executor.drain({});
  }
});

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

test("process framing keeps copy work linear under one-byte fragmentation", () => {
  const value = { payload: "x".repeat(4 * 1024) };
  const frame = encodeProcessFrame(value);
  const decoder = new ProcessFrameDecoder();
  const originalConcat = Buffer.concat;
  let copiedBytes = 0;
  Buffer.concat = ((...arguments_: Parameters<typeof Buffer.concat>) => {
    const result = originalConcat(...arguments_);
    copiedBytes += result.byteLength;
    return result;
  }) as typeof Buffer.concat;
  try {
    const decoded: unknown[] = [];
    for (const byte of frame) decoded.push(...decoder.push(Uint8Array.of(byte)));
    decoder.finish();
    assert.deepEqual(decoded, [value]);
    assert.ok(
      copiedBytes <= frame.byteLength * 2,
      `fragmented frame copied ${copiedBytes} bytes for ${frame.byteLength} wire bytes`,
    );
  } finally {
    Buffer.concat = originalConcat;
  }
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

test("cancellation races a delayed resolver so result and drain converge", async () => {
  const resolverStarted = Promise.withResolvers<void>();
  const resolverGate = Promise.withResolvers<void>();
  const processHost = new TestProcessHost();
  const base = await options({ processHost });
  const executor = new ProcessExecutor({
    ...base,
    async resolveComponent(execution) {
      resolverStarted.resolve();
      await resolverGate.promise;
      return base.resolveComponent(execution);
    },
  });
  const execution = request({ mode: "echo", value: "late-resolver" }, "cancel-resolver");
  const handle = await executor.submit(execution);
  await resolverStarted.promise;
  try {
    await executor.cancel(execution.taskId, execution.attemptId);
    let result: Awaited<typeof handle.result> | undefined;
    let drained = false;
    void handle.result.then((value) => {
      result = value;
    });
    void executor.drain({}).then(() => {
      drained = true;
    });
    await eventually(
      () => {
        assert.equal(result?.status, "cancelled");
        assert.equal(drained, true);
      },
      {
        attempts: 100,
        advance: () => new Promise((resolve) => setImmediate(resolve)),
      },
    );
    assert.equal(processHost.activeProcessCount, 0);
  } finally {
    resolverGate.resolve();
    await processHost.close();
  }
});

test("cancellation races delayed spawn and terminates the late child before bootstrap", async () => {
  const processHost = new DelayedSpawnProcessHost();
  const executor = new ProcessExecutor(await options({ processHost }));
  const execution = request({ mode: "echo", value: "late-spawn" }, "cancel-spawn");
  const handle = await executor.submit(execution);
  await processHost.started.promise;
  try {
    await executor.cancel(execution.taskId, execution.attemptId);
    clock.advanceBy(100);
    let result: Awaited<typeof handle.result> | undefined;
    let drained = false;
    void handle.result.then((value) => {
      result = value;
    });
    void executor.drain({}).then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result, undefined);
    assert.equal(drained, false);
    processHost.gate.resolve();
    await processHost.returned.promise;
    await eventually(
      () => {
        assert.equal(result?.status, "cancelled");
        assert.equal(drained, true);
        assert.equal(processHost.activeProcessCount, 0);
      },
      {
        attempts: 1_000,
        advance: () => new Promise((resolve) => setImmediate(resolve)),
      },
    );
    assert.equal(processHost.spawnCount, 1);
  } finally {
    processHost.gate.resolve();
    await processHost.close();
  }
});

test("late-spawn cancellation cannot be blocked by stalled stdin closure", async () => {
  const processHost = new StalledCloseDelayedSpawnProcessHost();
  const executor = new ProcessExecutor(await options({ processHost }));
  const execution = request({ mode: "echo", value: "stalled-close" }, "cancel-stalled-close");
  const handle = await executor.submit(execution);
  await processHost.started.promise;
  try {
    await executor.cancel(execution.taskId, execution.attemptId);
    clock.advanceBy(100);
    const draining = executor.drain({});
    processHost.gate.resolve();
    await processHost.returned.promise;
    assert.equal((await handle.result).status, "cancelled");
    await draining;
    await eventually(() => assert.equal(processHost.activeProcessCount, 0), {
      attempts: 100,
      advance: () => new Promise((resolve) => setImmediate(resolve)),
    });
  } finally {
    processHost.gate.resolve();
    await processHost.close();
  }
});

test("late-spawn cleanup retains its reservation before replacement and drain complete", async () => {
  const processHost = new DelayedSpawnProcessHost();
  const executor = new ProcessExecutor(await options({ processHost, maxConcurrency: 1 }));
  const first = request({ mode: "echo", value: "first" }, "cancel-reserved-spawn");
  const firstHandle = await executor.submit(first);
  await processHost.started.promise;
  try {
    await executor.cancel(first.taskId, first.attemptId);
    clock.advanceBy(100);
    const replacement = request({ mode: "echo", value: "replacement" }, "replacement-after-cancel");
    const replacementHandle = await executor.submit(replacement);
    let firstSettled = false;
    void firstHandle.result.then(() => {
      firstSettled = true;
    });
    const draining = executor.drain({});
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(firstSettled, false);
    assert.equal(processHost.spawnCount, 1);

    processHost.gate.resolve();
    assert.equal((await firstHandle.result).status, "cancelled");
    assert.equal((await replacementHandle.result).status, "succeeded");
    await draining;
    assert.equal(processHost.spawnCount, 2);
    assert.equal(processHost.peakActiveProcessCount, 1);
    assert.equal(processHost.activeProcessCount, 0);
  } finally {
    processHost.gate.resolve();
    await processHost.close();
  }
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

test("queued terminal attempts release their deadline sleeper", async () => {
  const started = Promise.withResolvers<void>();
  let activeSleeps = 0;
  const countingClock: Clock = {
    now: () => clock.now(),
    async sleep(delay, signal) {
      activeSleeps += 1;
      try {
        await clock.sleep(delay, signal);
      } finally {
        activeSleeps -= 1;
      }
    },
  };
  const executor = new ProcessExecutor(
    await options({
      clock: countingClock,
      maxConcurrency: 1,
      events: {
        async emit(type) {
          if (type === "run.started") started.resolve();
        },
      },
    }),
  );
  const running = request({ mode: "wait" }, "deadline-sleeper-running");
  const queued = request({ mode: "wait" }, "deadline-sleeper-queued");
  const runningHandle = await executor.submit(running);
  await started.promise;
  const queuedHandle = await executor.submit(queued);
  try {
    assert.equal(activeSleeps, 2);
    await executor.cancel(queued.taskId, queued.attemptId);
    await queuedHandle.result;
    assert.equal(activeSleeps, 1);
  } finally {
    await executor.cancel(running.taskId, running.attemptId);
    clock.advanceBy(100);
    await runningHandle.result;
    await executor.drain({});
  }
  assert.equal(activeSleeps, 0);
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

test("drain still replays an existing terminal attempt handle", async () => {
  const executor = new ProcessExecutor(await options());
  const execution = request({ mode: "echo", value: "cached" }, "drain-replay");
  const handle = await executor.submit(execution);
  const result = await handle.result;
  await executor.drain({});
  const duplicate = await executor.submit(execution);
  assert.strictEqual(duplicate, handle);
  assert.strictEqual(await duplicate.result, result);
});

test("executor drain releases owned children without closing the injected process driver", async () => {
  const processHost = new TestProcessHost();
  const executor = new ProcessExecutor(await options({ processHost }));
  const handled = await executor.submit(
    request({ mode: "echo", value: "done" }, "driver-ownership"),
  );
  await handled.result;
  await executor.drain({});
  assert.equal(processHost.activeProcessCount, 0);
  assert.equal((await processHost.health()).status, "healthy");
  await processHost.close();
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
    await eventually(() => assert.equal(processHost.signalCount, 1), {
      attempts: 1_000,
      advance: () => new Promise((resolve) => setImmediate(resolve)),
    });
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

test("an invalid drain deadline leaves admission and later shutdown usable", async () => {
  const processHost = new TestProcessHost();
  const executor = new ProcessExecutor(await options({ processHost }));
  await assert.rejects(executor.drain({ deadline: "not-a-deadline" }), TypeError);
  const handled = await executor.submit(
    request({ mode: "echo", value: "still-accepted" }, "invalid-drain"),
  );
  assert.equal((await handled.result).output, "still-accepted");
  await executor.drain({});
  await executor.close();
  assert.equal((await executor.health()).accepting, false);
  await processHost.close();
});

test("forced cleanup releases capacity when host wait never settles after kill", async () => {
  const finished = Promise.withResolvers<void>();
  const processHost = new NonSettlingWaitProcessHost();
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
    request({ mode: "ignore-sigterm", value: "complete" }, "non-settling-wait"),
  );
  try {
    await finished.promise;
    await eventually(() => assert.equal(processHost.signalCount, 1), {
      attempts: 1_000,
      advance: () => new Promise((resolve) => setImmediate(resolve)),
    });
    clock.advanceBy(100);
    let settled = false;
    void handle.result.then(() => {
      settled = true;
    });
    await eventually(() => assert.equal(settled, true), {
      attempts: 100,
      advance: () => new Promise((resolve) => setImmediate(resolve)),
    });
    assert.equal((await executor.health()).active, 0);
  } finally {
    await processHost.close();
  }
});

test("failed final kill quarantines the executor and reports unhealthy capacity", async () => {
  const started = Promise.withResolvers<void>();
  const processHost = new RejectingKillProcessHost();
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
  const execution = request({ mode: "ignore-cancel" }, "rejected-kill");
  const handle = await executor.submit(execution);
  try {
    await started.promise;
    await executor.cancel(execution.taskId, execution.attemptId);
    clock.advanceBy(100);
    let result: Awaited<typeof handle.result> | undefined;
    void handle.result.then((value) => {
      result = value;
    });
    await eventually(() => assert.notEqual(result, undefined), {
      attempts: 100,
      advance: () => new Promise((resolve) => setImmediate(resolve)),
    });
    if (result === undefined) throw new Error("Execution result is missing");
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostic?.code, "EXECUTOR_PROCESS_KILL_FAILED");
    assert.deepEqual(await executor.health(), {
      status: "unhealthy",
      checkedAt: clock.now().toISOString(),
      message: "EXECUTOR_PROCESS_KILL_FAILED: SIGKILL delivery failed",
      id: "process-local",
      type: "process",
      accepting: false,
      active: 1,
      queued: 0,
      retainedAttempts: 1,
    });
    assert.deepEqual(await executor.probe(), {
      id: "process-local",
      type: "process",
      available: false,
      maxConcurrency: 2,
      availableCapacity: 0,
      securityIsolation: true,
    });
    await assert.rejects(
      executor.submit(request({ mode: "echo", value: "blocked" }, "after-rejected-kill")),
      (error: unknown) => diagnosticCode(error) === "EXECUTOR_DRAINING",
    );
  } finally {
    await processHost.close();
  }
});

test("fatal quarantine still replays the existing failed attempt handle", async () => {
  const started = Promise.withResolvers<void>();
  const processHost = new RejectingKillProcessHost();
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
  const execution = request({ mode: "ignore-cancel" }, "quarantine-replay");
  const handle = await executor.submit(execution);
  try {
    await started.promise;
    await executor.cancel(execution.taskId, execution.attemptId);
    clock.advanceBy(100);
    const result = await handle.result;
    assert.equal(result.diagnostic?.code, "EXECUTOR_PROCESS_KILL_FAILED");
    const duplicate = await executor.submit(execution);
    assert.strictEqual(duplicate, handle);
    assert.strictEqual(await duplicate.result, result);
  } finally {
    await processHost.close();
  }
});

test("fatal quarantine fails queued work without spawning replacement children", async () => {
  const started = Promise.withResolvers<void>();
  const processHost = new RejectingKillProcessHost();
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
  const running = request({ mode: "ignore-cancel" }, "quarantine-running");
  const runningHandle = await executor.submit(running);
  await started.promise;
  const queued = request({ mode: "echo", value: "must-not-run" }, "quarantine-queued");
  const queuedHandle = await executor.submit(queued);
  try {
    await executor.cancel(running.taskId, running.attemptId);
    clock.advanceBy(100);
    const runningResult = await runningHandle.result;
    assert.equal(runningResult.status, "failed");
    assert.equal(runningResult.diagnostic?.code, "EXECUTOR_PROCESS_KILL_FAILED");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(processHost.spawnCount, 1);
    const queuedResult = await queuedHandle.result;
    assert.equal(queuedResult.status, "failed");
    assert.equal(queuedResult.diagnostic?.code, "EXECUTOR_PROCESS_KILL_FAILED");
    assert.deepEqual(await executor.observe(queued.taskId, queued.attemptId), {
      state: "terminal",
      result: queuedResult,
    });
    const health = await executor.health();
    assert.equal(health.active, 1);
    assert.equal(health.queued, 0);
    assert.equal(health.accepting, false);
    await executor.drain({});
  } finally {
    await processHost.close();
  }
});

test("throwing quarantine logger cannot prevent terminal failure containment", async () => {
  const started = Promise.withResolvers<void>();
  const processHost = new RejectingKillProcessHost();
  const executor = new ProcessExecutor(
    await options({
      processHost,
      logger: {
        debug() {},
        error() {
          throw new Error("logger failed");
        },
        info() {},
        warn() {},
      },
      events: {
        async emit(type) {
          if (type === "run.started") started.resolve();
        },
      },
    }),
  );
  const execution = request({ mode: "ignore-cancel" }, "throwing-quarantine-logger");
  const handle = await executor.submit(execution);
  try {
    await started.promise;
    await executor.cancel(execution.taskId, execution.attemptId);
    clock.advanceBy(100);
    let result: Awaited<typeof handle.result> | undefined;
    void handle.result.then((value) => {
      result = value;
    });
    await eventually(() => assert.notEqual(result, undefined), {
      attempts: 100,
      advance: () => new Promise((resolve) => setImmediate(resolve)),
    });
    if (result === undefined) throw new Error("Execution result is missing");
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostic?.code, "EXECUTOR_PROCESS_KILL_FAILED");
  } finally {
    await processHost.close();
  }
});

test("fatal quarantine stops an already-dequeued delayed resolution before spawn", async () => {
  const started = Promise.withResolvers<void>();
  const resolverGate = Promise.withResolvers<void>();
  const processHost = new RejectingKillProcessHost();
  const base = await options({ processHost });
  const executor = new ProcessExecutor({
    ...base,
    maxConcurrency: 2,
    async resolveComponent(execution) {
      if (execution.attemptId === "attempt-quarantine-delayed") {
        await resolverGate.promise;
      }
      return base.resolveComponent(execution);
    },
    events: {
      async emit(type) {
        if (type === "run.started") started.resolve();
      },
    },
  });
  const running = request({ mode: "ignore-cancel" }, "quarantine-race-running");
  const delayed = request({ mode: "echo", value: "must-not-spawn" }, "quarantine-delayed");
  const runningHandle = await executor.submit(running);
  await started.promise;
  const delayedHandle = await executor.submit(delayed);
  try {
    await executor.cancel(running.taskId, running.attemptId);
    clock.advanceBy(100);
    assert.equal((await runningHandle.result).diagnostic?.code, "EXECUTOR_PROCESS_KILL_FAILED");
    resolverGate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(processHost.spawnCount, 1);
    const delayedResult = await delayedHandle.result;
    assert.equal(delayedResult.status, "failed");
    assert.equal(delayedResult.diagnostic?.code, "EXECUTOR_PROCESS_KILL_FAILED");
  } finally {
    resolverGate.resolve();
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

test("captured authenticated broker frames cannot be replayed", async () => {
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
          return "parent-only-secret";
        },
      },
    }),
  );
  try {
    const result = await (await executor.submit(request({ mode: "replay-rpc" }, "replay-rpc")))
      .result;
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostic?.code, "PROTOCOL_PROCESS_FRAME_AUTHENTICATION_FAILED");
    assert.equal(secretCalls, 1);
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
