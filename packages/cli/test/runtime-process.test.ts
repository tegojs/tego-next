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
  const events = watch(directory, { signal });
  let nextEvent = events.next();
  try {
    try {
      await access(path);
      return;
    } catch {}
    while (!(await nextEvent).done) {
      try {
        await access(path);
        return;
      } catch {}
      nextEvent = events.next();
    }
    throw new Error(`PATH_READY_TIMEOUT:${path}`);
  } finally {
    await events.return?.();
  }
}

async function waitForExit(child: ChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}>;
async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}>;
async function waitForExit(
  child: ChildProcess,
  timeoutMs = deadlineMs,
): Promise<{
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
    }, timeoutMs);
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
    stop: () => {
      throw new Error("runtime stop failed");
    },
    operations: {} as Runtime["operations"],
    events: {
      async *[Symbol.asyncIterator]() {},
    },
  };
}

function mainProcessRuntime(
  overrides: Partial<Pick<Runtime, "start" | "status" | "stop">>,
): Runtime {
  return {
    start: async () => undefined,
    status: async () => ({ lifecycle: "running" }) as RuntimeStatus,
    stop: async () => undefined,
    operations: {} as Runtime["operations"],
    events: {
      async *[Symbol.asyncIterator]() {},
    },
    ...overrides,
  };
}

async function settlesBeforeDeadline(
  promise: PromiseLike<unknown>,
  timeoutMs = 100,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function failOnBackgroundError(error: Error): never {
  throw error;
}

function detachedRuntimeCommand(
  directory: string,
  endpoint: string,
  suffix: string,
): RuntimeStartCommand {
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
    `runtime-${suffix}`,
    "--application-id",
    `application-${suffix}`,
    "--node-id",
    `node-${suffix}`,
  ]);
  assert.equal(parsed.kind, "runtime.start");
  return parsed as RuntimeStartCommand;
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

  await assert.rejects(
    runWithFactory({
      endpoint: "",
      runtime: controlledRuntime(),
      onBackgroundError: failOnBackgroundError,
      signal: controller.signal,
      onReady: () => controller.abort(),
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

test("@spec:runtime-operations/local-runtime-operations/control-stop-response-precedes-server-close", {
  timeout: deadlineMs,
}, async () => {
  const directory = await temporaryRuntimeDirectory("tego-control-stop-response-");
  const endpoint = join(directory, "control.sock");
  const stopStarted = Promise.withResolvers<void>();
  const stopCompletion = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  let stopCalls = 0;
  let stopPromise: Promise<void> | undefined;
  const controller = new AbortController();
  const runtime: Runtime = {
    start: async () => undefined,
    status: async () => ({ lifecycle: "running" }) as RuntimeStatus,
    stop: () => {
      stopPromise ??= (async () => {
        stopCalls += 1;
        stopStarted.resolve();
        await stopCompletion.promise;
      })();
      return stopPromise;
    },
    operations: {} as Runtime["operations"],
    events: {
      async *[Symbol.asyncIterator]() {
        await stopStarted.promise;
        yield { current: "stopped" };
      },
    } as Runtime["events"],
  };
  const running = runMainProcess({
    endpoint,
    runtime,
    onBackgroundError: failOnBackgroundError,
    onReady: () => ready.resolve(),
    signal: controller.signal,
  });
  try {
    await ready.promise;
    const response = requestControl({
      endpoint,
      operation: "runtime.stop",
      input: {},
      timeoutMs: 1_000,
    });
    await stopStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    stopCompletion.resolve();

    const result = await response;
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { stopped: true });
    assert.equal(stopCalls, 1);
    await running;
  } finally {
    controller.abort();
    stopCompletion.resolve();
    assert.equal(await settlesBeforeDeadline(running, 1_000), true);
    await rm(directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/local-runtime-operations/pending-start-abort-stops-before-control", async () => {
  const start = Promise.withResolvers<void>();
  const startCalled = Promise.withResolvers<void>();
  const stopCalled = Promise.withResolvers<void>();
  const stopCompletion = Promise.withResolvers<void>();
  let serverCreated = false;
  let settled = false;
  const runtime: Runtime = {
    start: () => {
      startCalled.resolve();
      return start.promise;
    },
    status: async () => ({ lifecycle: "running" }) as RuntimeStatus,
    stop: () => {
      stopCalled.resolve();
      return stopCompletion.promise;
    },
    operations: {} as Runtime["operations"],
    events: {
      async *[Symbol.asyncIterator]() {},
    },
  };
  const controller = new AbortController();
  const running = runMainProcess({
    endpoint: "in-memory",
    runtime,
    onBackgroundError: failOnBackgroundError,
    signal: controller.signal,
    controlServerFactory: async () => {
      serverCreated = true;
      return {
        endpoint: "in-memory",
        close: async () => undefined,
      };
    },
  });
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await startCalled.promise;
  controller.abort();
  const stopBeforeStartSettled = await Promise.race([
    stopCalled.promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  start.resolve();
  await stopCalled.promise;
  assert.equal(settled, false);
  stopCompletion.resolve();
  await running;

  assert.equal(stopBeforeStartSettled, true);
  assert.equal(serverCreated, false);
});

test("@spec:runtime-operations/local-runtime-operations/pending-status-abort-suppresses-readiness", async () => {
  const status = Promise.withResolvers<RuntimeStatus>();
  const statusCalled = Promise.withResolvers<void>();
  const stopCalled = Promise.withResolvers<void>();
  const closeCalled = Promise.withResolvers<void>();
  let readyCalls = 0;
  const controller = new AbortController();
  const running = runMainProcess({
    endpoint: "in-memory",
    onBackgroundError: failOnBackgroundError,
    runtime: mainProcessRuntime({
      status: () => {
        statusCalled.resolve();
        return status.promise;
      },
      stop: async () => {
        stopCalled.resolve();
      },
    }),
    signal: controller.signal,
    onReady: () => {
      readyCalls += 1;
    },
    controlServerFactory: async () => ({
      endpoint: "in-memory",
      close: async () => {
        closeCalled.resolve();
      },
    }),
  });

  await statusCalled.promise;
  controller.abort();
  const cleanedBeforeStatus = await settlesBeforeDeadline(
    Promise.all([stopCalled.promise, closeCalled.promise]),
  );
  status.resolve({ lifecycle: "running" } as RuntimeStatus);
  await running;

  assert.equal(cleanedBeforeStatus, true);
  assert.equal(readyCalls, 0);
});

test("@spec:runtime-operations/local-runtime-operations/pending-on-ready-abort-does-not-block-cleanup", async () => {
  const ready = Promise.withResolvers<void>();
  const readyCalled = Promise.withResolvers<void>();
  const stopCalled = Promise.withResolvers<void>();
  const closeCalled = Promise.withResolvers<void>();
  const controller = new AbortController();
  const running = runMainProcess({
    endpoint: "in-memory",
    onBackgroundError: failOnBackgroundError,
    runtime: mainProcessRuntime({
      stop: async () => {
        stopCalled.resolve();
      },
    }),
    signal: controller.signal,
    onReady: () => {
      readyCalled.resolve();
      return ready.promise;
    },
    controlServerFactory: async () => ({
      endpoint: "in-memory",
      close: async () => {
        closeCalled.resolve();
      },
    }),
  });
  const outcome = running.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ error, ok: false as const }),
  );

  await readyCalled.promise;
  controller.abort();
  const settledBeforeCallback = await settlesBeforeDeadline(outcome);
  const cleanupStarted = await settlesBeforeDeadline(
    Promise.all([stopCalled.promise, closeCalled.promise]),
  );
  ready.reject(new Error("late readiness callback failure"));
  const result = await outcome;

  assert.equal(settledBeforeCallback, true);
  assert.equal(cleanupStarted, true);
  assert.equal(result.ok, true);
});

test("@spec:runtime-operations/local-runtime-operations/pending-control-factory-abort-closes-late-server", async () => {
  const factory = Promise.withResolvers<ControlServer>();
  const factoryCalled = Promise.withResolvers<void>();
  const stopCalled = Promise.withResolvers<void>();
  const lateCloseCalled = Promise.withResolvers<void>();
  const controller = new AbortController();
  let factorySignal: AbortSignal | undefined;
  let statusCalls = 0;
  type AbortAwareMainOptions = Omit<MainProcessOptions, "controlServerFactory"> & {
    readonly controlServerFactory: (options: {
      readonly signal?: AbortSignal;
    }) => Promise<ControlServer>;
  };
  const runAbortAware = runMainProcess as (options: AbortAwareMainOptions) => Promise<void>;
  const running = runAbortAware({
    endpoint: "in-memory",
    onBackgroundError: failOnBackgroundError,
    runtime: mainProcessRuntime({
      status: async () => {
        statusCalls += 1;
        return { lifecycle: "running" } as RuntimeStatus;
      },
      stop: async () => {
        stopCalled.resolve();
      },
    }),
    signal: controller.signal,
    controlServerFactory: (options) => {
      factorySignal = options.signal;
      factoryCalled.resolve();
      return factory.promise;
    },
  });

  await factoryCalled.promise;
  controller.abort();
  const settledBeforeFactory = await settlesBeforeDeadline(running);
  factory.resolve({
    endpoint: "in-memory",
    close: async () => {
      lateCloseCalled.resolve();
    },
  });
  const lateServerClosed = await settlesBeforeDeadline(lateCloseCalled.promise);
  await running;

  assert.equal(settledBeforeFactory, true);
  assert.equal(lateServerClosed, true);
  assert.equal(factorySignal, controller.signal);
  assert.equal(statusCalls, 0);
  await stopCalled.promise;
});

test("@spec:runtime-operations/local-runtime-operations/late-factory-close-failure-reaches-background-sink", {
  timeout: deadlineMs,
}, async () => {
  const factory = Promise.withResolvers<ControlServer>();
  const factoryCalled = Promise.withResolvers<void>();
  const backgroundError = Promise.withResolvers<unknown>();
  const controller = new AbortController();
  type BackgroundAwareMainOptions = MainProcessOptions & {
    readonly onBackgroundError: (error: unknown) => void;
  };
  const runBackgroundAware = runMainProcess as (
    options: BackgroundAwareMainOptions,
  ) => Promise<void>;
  const running = runBackgroundAware({
    endpoint: "in-memory",
    runtime: mainProcessRuntime({}),
    signal: controller.signal,
    onBackgroundError: (error) => backgroundError.resolve(error),
    controlServerFactory: () => {
      factoryCalled.resolve();
      return factory.promise;
    },
  });

  await factoryCalled.promise;
  controller.abort();
  assert.equal(await settlesBeforeDeadline(running), true);
  factory.resolve({
    endpoint: "in-memory",
    close: () => Promise.reject(new Error("secret late close path /Users/alice")),
  });
  const reported = await settlesBeforeDeadline(backgroundError.promise);
  assert.equal(reported, true);
  const error = await backgroundError.promise;
  assert.ok(error instanceof Error);
  assert.equal(error.message, "LIFECYCLE_BACKGROUND_CLEANUP_FAILED");
  await running;
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

test("@spec:runtime-operations/local-runtime-operations/pre-readiness-sigterm-never-creates-endpoint", async () => {
  const directory = await temporaryRuntimeDirectory("tego-pending-start-signal-");
  const endpoint = join(directory, "control.sock");
  const starting = join(directory, "startup.entered");
  const stopped = join(directory, "runtime.stopped");
  const fixture = fileURLToPath(new URL("fixtures/pending-start-main.js", import.meta.url));
  const child = spawn(process.execPath, [fixture], {
    env: {
      ...process.env,
      TEGO_PENDING_START_OPTIONS: JSON.stringify({ directory, endpoint }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForPath(starting, directory);
    assert.equal(child.kill("SIGTERM"), true);
    const exit = await waitForExit(child, 1_000);
    assert.deepEqual(exit, { code: 0, signal: null });
    await access(stopped);
    await assert.rejects(access(endpoint));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/local-runtime-operations/detached-failure-confirms-term-kill-exit", async () => {
  const directory = await temporaryRuntimeDirectory("tego-detached-timeout-");
  const endpoint = join(directory, "control.sock");
  const command = detachedRuntimeCommand(directory, endpoint, "detached-failure");
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
        readinessTimeoutMs: deadlineMs,
        terminationTimeoutMs: 100,
      }),
      /LIFECYCLE_DETACHED_START_FAILED/u,
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

test("@spec:runtime-operations/local-runtime-operations/detached-readiness-timeout-is-bounded", async () => {
  const directory = await temporaryRuntimeDirectory("tego-detached-timeout-");
  const endpoint = join(directory, "control.sock");
  const command = detachedRuntimeCommand(directory, endpoint, "detached-timeout");
  type DetachedOptions = {
    readonly mainProcessPath: string;
    readonly readinessTimeoutMs: number;
    readonly terminationTimeoutMs: number;
  };
  const configurableStart = startRuntimeDetached as (
    command: RuntimeStartCommand,
    options: DetachedOptions,
  ) => Promise<RuntimeStatus>;
  try {
    await assert.rejects(
      configurableStart(command, {
        mainProcessPath: fileURLToPath(new URL("fixtures/silent-main.js", import.meta.url)),
        readinessTimeoutMs: 1,
        terminationTimeoutMs: 100,
      }),
      /LIFECYCLE_DETACHED_START_TIMEOUT/u,
    );
    await assert.rejects(access(endpoint));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
