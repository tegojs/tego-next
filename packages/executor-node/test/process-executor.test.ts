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
  ProcessExecutor,
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
      while (!context.cancellation.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { cancelled: true };
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
