import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Runtime, RuntimeStatus } from "@tegojs/contracts";
import { startRuntimeDetached } from "../src/commands/runtime.js";
import { requestControl } from "../src/control/client.js";
import type { ControlServer } from "../src/control/server.js";
import { parseCommand, type RuntimeStartCommand } from "../src/parse-command.js";
import { type MainProcessOptions, runMainProcess } from "../src/runtime/main-process.js";

const deadlineMs = 5_000;

async function temporaryRuntimeDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function waitForPath(path: string, directory: string): Promise<void> {
  try {
    await access(path);
    return;
  } catch {}
  const signal = AbortSignal.timeout(deadlineMs);
  for await (const _event of watch(directory, { signal })) {
    try {
      await access(path);
      return;
    } catch {}
  }
  throw new Error(`PATH_READY_TIMEOUT:${path}`);
}

async function waitForExit(child: ChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("PROCESS_EXIT_TIMEOUT"));
    }, deadlineMs);
    timer.unref();
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function controlledRuntime(): Runtime {
  return {
    start: async () => undefined,
    status: async () => ({ lifecycle: "running" }) as RuntimeStatus,
    stop: () => Promise.reject(new Error("runtime stop failed")),
    operations: {} as Runtime["operations"],
    events: {
      async *[Symbol.asyncIterator]() {},
    },
  };
}

test("@spec:runtime-operations/local-runtime-operations/stop-failure-still-aggregates-control-cleanup", async () => {
  let closeAttempted = false;
  type MainProcessWithFactory = MainProcessOptions & {
    readonly controlServerFactory: () => Promise<ControlServer>;
  };
  const runWithFactory = runMainProcess as (
    options: MainProcessWithFactory,
  ) => ReturnType<typeof runMainProcess>;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runWithFactory({
      endpoint: "",
      runtime: controlledRuntime(),
      signal: controller.signal,
      controlServerFactory: async () => ({
        endpoint: "in-memory",
        close: async () => {
          closeAttempted = true;
          throw new Error("control close failed");
        },
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((entry: unknown) => (entry as Error).message).sort(), [
        "control close failed",
        "runtime stop failed",
      ]);
      return true;
    },
  );
  assert.equal(closeAttempted, true);
});

test("@spec:runtime-operations/local-runtime-operations/foreground-sigterm-cleans-endpoint", async () => {
  const directory = await temporaryRuntimeDirectory("tego-foreground-signal-");
  const endpoint = join(directory, "control.sock");
  const bin = fileURLToPath(new URL("../src/bin.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      bin,
      "runtime",
      "start",
      "--json",
      "--data-dir",
      directory,
      "--endpoint",
      endpoint,
      "--runtime-id",
      "runtime-foreground-signal",
      "--application-id",
      "application-foreground-signal",
      "--node-id",
      "node-foreground-signal",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await waitForPath(endpoint, directory);
    assert.equal(child.kill("SIGTERM"), true);
    const exit = await waitForExit(child);
    assert.deepEqual(exit, { code: 0, signal: null });
    await assert.rejects(access(endpoint));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/local-runtime-operations/detached-timeout-confirms-term-kill-exit", async () => {
  const directory = await temporaryRuntimeDirectory("tego-detached-timeout-");
  const endpoint = join(directory, "control.sock");
  const parsed = parseCommand([
    "runtime",
    "start",
    "--detach",
    "--json",
    "--data-dir",
    directory,
    "--endpoint",
    endpoint,
    "--runtime-id",
    "runtime-detached-timeout",
    "--application-id",
    "application-detached-timeout",
    "--node-id",
    "node-detached-timeout",
  ]);
  assert.equal(parsed.kind, "runtime.start");
  const command = parsed as RuntimeStartCommand;
  type DetachedOptions = {
    readonly mainProcessPath: string;
    readonly readinessTimeoutMs: number;
    readonly terminationTimeoutMs: number;
  };
  const configurableStart = startRuntimeDetached as (
    command: RuntimeStartCommand,
    options: DetachedOptions,
  ) => Promise<RuntimeStatus>;
  let pid: number | undefined;
  try {
    await assert.rejects(
      configurableStart(command, {
        mainProcessPath: fileURLToPath(new URL("fixtures/stubborn-main.js", import.meta.url)),
        readinessTimeoutMs: 50,
        terminationTimeoutMs: 100,
      }),
      /LIFECYCLE_DETACHED_START_TIMEOUT/u,
    );
    pid = Number(await readFile(join(directory, "stubborn.pid"), "utf8"));
    assert.throws(
      () => process.kill(pid as number, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    await assert.rejects(access(endpoint));
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    try {
      await requestControl({
        endpoint,
        operation: "runtime.stop",
        input: {},
        timeoutMs: 500,
      });
    } catch {}
    await rm(directory, { force: true, recursive: true });
  }
});
