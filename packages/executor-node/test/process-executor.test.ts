import assert from "node:assert/strict";
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
  type ExecutionRequest,
  type JsonValue,
} from "@tegojs/contracts";
import { NodeProcessHost } from "@tegojs/drivers-local";
import {
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

after(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
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
      setInterval(() => {}, 1000);
      return new Promise(() => {});
    }
    if (input.mode === "crash") process.exit(42);
    if (input.mode === "stderr") {
      process.stderr.write("diagnostic " + "x".repeat(200000));
      return input.value;
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
    permissions: [{ kind: "executor", executors: ["process", "thread"] }],
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
    processHost: new NodeProcessHost({ clock }),
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
      (error: unknown) =>
        diagnosticCode(error) === "PROTOCOL_PROCESS_FRAME_LENGTH_INVALID",
    );
    assert.equal(parseCalls, 0);
  } finally {
    JSON.parse = originalParse;
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
  const processHost = new NodeProcessHost({ clock });
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

test("an active deadline uses the shared clock and cannot be overwritten by a late exit", async () => {
  const started = Promise.withResolvers<void>();
  const processHost = new NodeProcessHost({ clock });
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
  const executor = new ProcessExecutor(
    await options({ maxConcurrency: 1, maxQueue: 0 }),
  );
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
    const result = await (
      await executor.submit(request({ mode: "large-output" }, "large-out"))
    ).result;
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostic?.code, "EXECUTOR_OUTPUT_LIMIT_EXCEEDED");
  } finally {
    await executor.drain({});
  }
});

test("spawn failure leaks neither capacity nor hosted process handles", async () => {
  const processHost = new NodeProcessHost({ clock });
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
  const host = new NodeProcessHost({ clock });
  await Promise.all([host.open(), host.open()]);
  assert.equal((await host.health()).status, "healthy");
  await Promise.all([host.close(), host.close()]);
  assert.equal(host.activeProcessCount, 0);
});

test("drain and close leave no active child process", async () => {
  const processHost = new NodeProcessHost({ clock });
  const executor = new ProcessExecutor(await options({ processHost }));
  const handled = await executor.submit(request({ mode: "echo", value: "done" }, "close"));
  assert.equal((await handled.result).status, "succeeded");
  await Promise.all([executor.drain({}), executor.drain({})]);
  await Promise.all([executor.close(), executor.close()]);
  assert.equal(processHost.activeProcessCount, 0);
  assert.equal((await executor.health()).active, 0);
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
