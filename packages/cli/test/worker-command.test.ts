import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  parseArtifactDigest,
  parsePluginManifest,
  parseWorkerId,
  type ExecutionRequest,
} from "@tegojs/contracts";
import { SqliteStateStore } from "@tegojs/drivers-local";
import type { PreparedArtifact } from "@tegojs/runtime";
import {
  connectMain,
  createMainEndpoint,
  listenForMain,
  MemoryRemoteAttemptStore,
  MemoryWorkerEpochAllocator,
  RemoteExecutor,
  requestFingerprint,
  systemWorkerClock,
  type RemoteAttemptRecord,
  type WorkerSession,
} from "@tegojs/transport-websocket";
import { type WorkerStartCommand, parseCommand } from "../src/parse-command.js";
import { packPlugin } from "../src/plugin/pack-plugin.js";
import { runCli } from "../src/run-cli.js";
import {
  createPreparedArtifactSelection,
  runWorkerProcess,
  StateRemoteAttemptStore,
  type WorkerReadiness,
} from "../src/worker/worker-process.js";

const deadlineMs = 5_000;

async function beforeDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  const signal = AbortSignal.timeout(deadlineMs);
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error(`Timed out waiting for ${label}`, { cause: signal.reason })),
        { once: true },
      );
    }),
  ]);
}

async function waitForValue<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function cleanupDirectory(root: string): Promise<void> {
  async function makeDirectoriesWritable(path: string): Promise<void> {
    let identity: Awaited<ReturnType<typeof lstat>>;
    try {
      identity = await lstat(path);
    } catch {
      return;
    }
    if (identity.isSymbolicLink() || !identity.isDirectory()) return;
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) {
      await makeDirectoriesWritable(join(path, entry));
    }
  }

  await makeDirectoriesWritable(root);
  await rm(root, { force: true, recursive: true });
}

function capture() {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  let output = "";
  stream.on("data", (chunk: string) => {
    output += chunk;
  });
  return { stream, read: () => output };
}

test("@spec:worker-protocol/independent-worker-command/parses-both-connection-directions", () => {
  assert.deepEqual(
    parseCommand([
      "worker",
      "start",
      "--connect",
      "ws://127.0.0.1:8080/worker",
      "--credential",
      "shared-secret",
      "--data-dir",
      "./worker-data",
      "--worker-id",
      "worker-connect",
      "--prepare",
      "./first.tego",
      "--prepare",
      "./second.tego",
      "--json",
    ]),
    {
      kind: "worker.start",
      credential: "shared-secret",
      dataDirectory: resolve("./worker-data"),
      direction: "connect",
      json: true,
      prepare: [resolve("./first.tego"), resolve("./second.tego")],
      url: "ws://127.0.0.1:8080/worker",
      workerId: "worker-connect",
    },
  );
  assert.deepEqual(
    parseCommand([
      "worker",
      "start",
      "--listen",
      "127.0.0.1:0",
      "--credential",
      "shared-secret",
      "--worker-id",
      "worker-listen",
    ]),
    {
      kind: "worker.start",
      credential: "shared-secret",
      dataDirectory: resolve(".tego/workers/worker-listen"),
      direction: "listen",
      host: "127.0.0.1",
      json: false,
      port: 0,
      prepare: [],
      workerId: "worker-listen",
    },
  );
  assert.throws(
    () =>
      parseCommand([
        "worker",
        "start",
        "--connect",
        "ws://127.0.0.1:8080/worker",
        "--listen",
        "127.0.0.1:0",
      ]),
    /connect|listen|exactly/iu,
  );
});

test("@spec:worker-protocol/independent-worker-command/emits-exactly-one-structured-readiness-event", async () => {
  const stdout = capture();
  const stderr = capture();
  const readiness: WorkerReadiness = {
    type: "worker.ready",
    pid: 42,
    direction: "connect",
    url: "ws://127.0.0.1:8080/worker",
    workerId: parseWorkerId("worker-ready"),
    executors: [
      {
        id: "worker-ready:thread",
        type: "thread",
        available: true,
        maxConcurrency: 2,
        availableCapacity: 2,
        securityIsolation: true,
      },
      {
        id: "worker-ready:process",
        type: "process",
        available: true,
        maxConcurrency: 2,
        availableCapacity: 2,
        securityIsolation: true,
      },
    ],
  };
  let starts = 0;
  const exitCode = await runCli({
    argv: [
      "worker",
      "start",
      "--connect",
      readiness.url,
      "--credential",
      "shared-secret",
      "--worker-id",
      readiness.workerId,
      "--json",
    ],
    stdout: stdout.stream,
    stderr: stderr.stream,
    startWorker: async (
      _command: WorkerStartCommand,
      onReady: (readiness: WorkerReadiness) => Promise<void> | void,
    ) => {
      starts += 1;
      await onReady(readiness);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(starts, 1);
  assert.deepEqual(
    stdout
      .read()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [readiness],
  );
  assert.equal(stderr.read(), "");
});

function preparedArtifact(
  pluginId: string,
  digestSuffix: string,
  executors: readonly ("process" | "thread")[] = ["process", "thread"],
): PreparedArtifact {
  return {
    digest: parseArtifactDigest(`sha256:${digestSuffix.repeat(64)}`),
    root: `/prepared/${digestSuffix}`,
    manifest: parsePluginManifest({
      schemaVersion: "1.0",
      pluginId,
      version: `1.0.${digestSuffix === "a" ? "0" : "1"}`,
      contractRange: ">=0.0.0",
      nodeRange: ">=24.0.0 <27.0.0",
      moduleFormat: "esm",
      components: [
        {
          componentId: "echo",
          kind: "task",
          entrypoint: "components/echo.js",
          executors,
        },
      ],
      permissions: [{ kind: "executor", executors }],
      capabilities: { provides: [], requires: [] },
    }),
  };
}

function assignment(pluginId: string): ExecutionRequest {
  return {
    taskId: "task-artifact-selection" as ExecutionRequest["taskId"],
    attemptId: "attempt-artifact-selection" as ExecutionRequest["attemptId"],
    applicationId: "application-artifact-selection" as ExecutionRequest["applicationId"],
    pluginId: pluginId as ExecutionRequest["pluginId"],
    componentId: "echo" as ExecutionRequest["componentId"],
    input: null,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    orphanPolicy: "cancel",
  };
}

test("@spec:worker-protocol/prepared-artifact-admission/selects-one-digest-per-plugin", () => {
  const exact = createPreparedArtifactSelection(
    [preparedArtifact("org.example.exact", "a")],
    "worker-runtime",
  );
  const exactRequest = assignment("org.example.exact");
  assert.equal(exact.validateAssignment(exactRequest), undefined);
  assert.equal(exact.resolveComponent(exactRequest).artifactDigest, `sha256:${"a".repeat(64)}`);
  assert.deepEqual(exact.resolveComponent(exactRequest).permissionGrants, [
    { kind: "executor", executors: ["thread"] },
  ]);
  const processOnly = createPreparedArtifactSelection(
    [preparedArtifact("org.example.process-only", "c", ["process"])],
    "worker-runtime",
  );
  const processRequest = assignment("org.example.process-only");
  assert.equal(processOnly.selectExecutorKind(processRequest), "process");
  assert.deepEqual(processOnly.resolveComponent(processRequest).permissionGrants, [
    { kind: "executor", executors: ["process"] },
  ]);

  const missing = exact.validateAssignment(assignment("org.example.missing"));
  assert.equal(missing?.code, "EXECUTOR_REMOTE_ARTIFACT_UNPREPARED");

  const ambiguous = createPreparedArtifactSelection(
    [
      preparedArtifact("org.example.ambiguous", "a"),
      preparedArtifact("org.example.ambiguous", "b"),
    ],
    "worker-runtime",
  ).validateAssignment(assignment("org.example.ambiguous"));
  assert.equal(ambiguous?.code, "EXECUTOR_REMOTE_ARTIFACT_UNPREPARED");
});

test("@spec:worker-protocol/independent-worker-command/requires-a-bounded-worker-identity", () => {
  const command = parseCommand([
    "worker",
    "start",
    "--listen",
    "127.0.0.1:0",
    "--credential",
    "shared-secret",
    "--worker-id",
    "worker-bounded",
  ]);
  assert.equal(command.kind, "worker.start");
  assert.equal((command as WorkerStartCommand).workerId, "worker-bounded");
  assert.throws(
    () =>
      parseCommand([
        "worker",
        "start",
        "--listen",
        "127.0.0.1:0",
        "--credential",
        "shared-secret",
        "--worker-id",
        "x".repeat(129),
      ]),
    /worker|identity|invalid/iu,
  );
});

test("@spec:worker-protocol/independent-worker-command/requires-explicit-secret-and-stable-worker-id", () => {
  const previousCredential = process.env.TEGO_WORKER_CREDENTIAL;
  try {
    delete process.env.TEGO_WORKER_CREDENTIAL;
    assert.throws(
      () =>
        parseCommand([
          "worker",
          "start",
          "--listen",
          "127.0.0.1:0",
          "--worker-id",
          "worker-explicit-secret",
        ]),
      /credential|required/iu,
    );

    process.env.TEGO_WORKER_CREDENTIAL = "";
    assert.throws(
      () =>
        parseCommand([
          "worker",
          "start",
          "--listen",
          "127.0.0.1:0",
          "--worker-id",
          "worker-empty-secret",
        ]),
      /credential|required|empty/iu,
    );
    assert.throws(
      () =>
        parseCommand([
          "worker",
          "start",
          "--listen",
          "127.0.0.1:0",
          "--credential",
          "",
          "--worker-id",
          "worker-empty-flag-secret",
        ]),
      /credential|required|empty/iu,
    );

    process.env.TEGO_WORKER_CREDENTIAL = "environment-worker-secret";
    let missingIdentity: unknown;
    try {
      parseCommand(["worker", "start", "--listen", "127.0.0.1:0"]);
    } catch (error) {
      missingIdentity = error;
    }
    assert.ok(missingIdentity instanceof Error);
    assert.match(missingIdentity.message, /worker.*id|required/iu);
    assert.doesNotMatch(JSON.stringify(missingIdentity), /environment-worker-secret/u);
  } finally {
    if (previousCredential === undefined) {
      delete process.env.TEGO_WORKER_CREDENTIAL;
    } else {
      process.env.TEGO_WORKER_CREDENTIAL = previousCredential;
    }
  }
});

test("@spec:worker-protocol/durable-worker-attempts/sqlite-reopen-and-cas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-worker-attempt-store-"));
  const databasePath = join(directory, "state.sqlite");
  const workerId = parseWorkerId("worker-durable-attempts");
  const request = assignment("org.example.durable");
  const initial = {
    workerId,
    request,
    fingerprint: requestFingerprint(request),
    state: "acknowledged" as const,
    epoch: "1",
    updatedAt: new Date(0).toISOString(),
    revision: "0",
  };
  let state = new SqliteStateStore({ databasePath });
  try {
    await state.open();
    let store = new StateRemoteAttemptStore({ state, workerId });
    const created = await store.commit(initial, { expectedRevision: null });
    assert.equal(created?.revision, "1");
    await state.close();

    state = new SqliteStateStore({ databasePath });
    await state.open();
    store = new StateRemoteAttemptStore({ state, workerId });
    const reopened = await store.load(request.taskId, request.attemptId);
    assert.equal(reopened?.revision, "1");
    assert.equal(reopened?.fingerprint, initial.fingerprint);

    const running = {
      ...(reopened ?? initial),
      state: "running" as const,
      updatedAt: new Date(1).toISOString(),
    };
    const committed = await store.commit(running, { expectedRevision: "1", expectedEpoch: "1" });
    assert.equal(committed?.revision, "2");
    assert.equal(
      await store.commit(
        { ...running, state: "terminal", updatedAt: new Date(2).toISOString() },
        { expectedRevision: "1", expectedEpoch: "1" },
      ),
      undefined,
    );
    assert.deepEqual(
      (await store.list(workerId)).map((record: RemoteAttemptRecord) => record.revision),
      ["2"],
    );
  } finally {
    await state.close().catch(() => undefined);
    await rm(directory, { force: true, recursive: true });
  }
});

function attemptStateKey(record: RemoteAttemptRecord) {
  const { taskId, attemptId } = record.request;
  return {
    namespace: "tego",
    collection: "worker-attempts",
    id: `${record.workerId}:${taskId.length}:${taskId}${attemptId}`,
  } as const;
}

async function putRawAttempt(
  state: SqliteStateStore,
  keyRecord: RemoteAttemptRecord,
  value: RemoteAttemptRecord,
): Promise<void> {
  await state.transact({}, async (transaction) => {
    await transaction.put(attemptStateKey(keyRecord), value, {
      expectedRevision: "absent",
    });
    return null;
  });
}

test("@spec:worker-protocol/durable-worker-attempts/rejects-corrupt-sqlite-records-at-the-store-boundary", async () => {
  const workerId = parseWorkerId("worker-corrupt-attempts");
  const request = assignment("org.example.corrupt");
  const valid: RemoteAttemptRecord = {
    workerId,
    request,
    fingerprint: requestFingerprint(request),
    state: "acknowledged",
    epoch: "1",
    updatedAt: new Date(0).toISOString(),
    revision: "1",
  };
  const cases = [
    {
      name: "invalid epoch",
      value: { ...valid, epoch: "-1" },
    },
    {
      name: "wrong worker",
      value: { ...valid, workerId: parseWorkerId("worker-corrupt-other") },
    },
    {
      name: "request and key mismatch",
      value: {
        ...valid,
        request: {
          ...request,
          taskId: "task-corrupt-mismatch" as ExecutionRequest["taskId"],
        },
      },
    },
    {
      name: "fingerprint mismatch",
      value: { ...valid, fingerprint: "0".repeat(64) },
    },
  ] satisfies readonly {
    readonly name: string;
    readonly value: RemoteAttemptRecord;
  }[];

  for (const fixture of cases) {
    const state = new SqliteStateStore({ databasePath: ":memory:" });
    try {
      await state.open();
      await putRawAttempt(state, valid, fixture.value);
      const store = new StateRemoteAttemptStore({ state, workerId });
      await assert.rejects(
        store.load(request.taskId, request.attemptId),
        /attempt|epoch|fingerprint|worker|identity|invalid/iu,
        fixture.name,
      );
      await assert.rejects(
        store.list(workerId),
        /attempt|epoch|fingerprint|worker|identity|invalid/iu,
        fixture.name,
      );
    } finally {
      await state.close().catch(() => undefined);
    }
  }
});

test("@spec:worker-protocol/durable-worker-attempts/listen-fails-before-readiness-on-corrupt-state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-worker-corrupt-readiness-"));
  const dataDirectory = join(directory, "data");
  const workerId = parseWorkerId("worker-corrupt-readiness");
  const request = assignment("org.example.corrupt-readiness");
  const corrupt: RemoteAttemptRecord = {
    workerId,
    request,
    fingerprint: requestFingerprint(request),
    state: "running",
    epoch: "invalid",
    updatedAt: new Date(0).toISOString(),
    revision: "1",
  };
  const seed = new SqliteStateStore({
    databasePath: join(dataDirectory, "state.sqlite"),
  });
  await seed.open();
  await putRawAttempt(seed, corrupt, corrupt);
  await seed.close();
  const command = parseCommand([
    "worker",
    "start",
    "--listen",
    "127.0.0.1:0",
    "--credential",
    "corrupt-secret",
    "--worker-id",
    workerId,
    "--data-dir",
    dataDirectory,
  ]) as WorkerStartCommand;
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  const running = runWorkerProcess(command, {
    signal: controller.signal,
    onReady: () => ready.resolve(),
  });

  try {
    const outcome = await beforeDeadline(
      Promise.race([
        ready.promise.then(() => ({ kind: "ready" as const })),
        running.then(
          () => ({ kind: "stopped" as const }),
          (error: unknown) => ({ error, kind: "failed" as const }),
        ),
      ]),
      "corrupt Worker preflight",
    );
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.match(String(outcome.error), /attempt|epoch|invalid/iu);
    }
  } finally {
    controller.abort();
    await running.catch(() => undefined);
    await cleanupDirectory(directory);
  }
});

async function createWorkerArtifact(
  directory: string,
  options: {
    readonly executors?: readonly ("process" | "thread")[];
    readonly pluginId?: string;
  } = {},
): Promise<{
  readonly artifactPath: string;
  readonly digest: string;
}> {
  const executors = options.executors ?? ["thread", "process"];
  const pluginId = options.pluginId ?? "org.example.worker-echo";
  const pluginDirectory = join(directory, "plugin");
  const buildDirectory = join(pluginDirectory, "build");
  const artifactPath = join(directory, "echo.tego");
  await mkdir(buildDirectory, { recursive: true });
  await writeFile(
    join(pluginDirectory, "manifest.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      pluginId,
      version: "1.0.0",
      contractRange: ">=0.0.0",
      nodeRange: ">=24.0.0 <27.0.0",
      moduleFormat: "esm",
      components: [
        {
          componentId: "echo",
          kind: "task",
          entrypoint: "component.js",
          executors,
        },
      ],
      permissions: [{ kind: "executor", executors }],
      capabilities: { provides: [], requires: [] },
    }),
  );
  await writeFile(
    join(buildDirectory, "component.js"),
    'export default { protocol: "tego.component/1.0", kind: "task", async run(_context, input) { if (input.delayMs) await new Promise((resolve) => setTimeout(resolve, input.delayMs)); return input; } };\n',
  );
  const packed = await packPlugin({
    artifactPath,
    build: false,
    pluginDirectory,
  });
  return { artifactPath, digest: packed.digest };
}

test("@spec:worker-protocol/independent-worker-command/listen-prepares-advertises-and-executes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-worker-listen-process-"));
  const { artifactPath, digest } = await createWorkerArtifact(directory);
  const workerId = parseWorkerId("worker-listen-process");
  const command = parseCommand([
    "worker",
    "start",
    "--listen",
    "127.0.0.1:0",
    "--credential",
    "listen-secret",
    "--worker-id",
    workerId,
    "--data-dir",
    join(directory, "data"),
    "--prepare",
    artifactPath,
  ]) as WorkerStartCommand;
  const controller = new AbortController();
  const ready = Promise.withResolvers<WorkerReadiness>();
  let readinessCount = 0;
  const running = runWorkerProcess(command, {
    signal: controller.signal,
    onReady: (readiness: WorkerReadiness) => {
      readinessCount += 1;
      ready.resolve(readiness);
    },
  });
  const main = createMainEndpoint({
    credential: "listen-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const remote = new RemoteExecutor({
    id: "listen-remote",
    workerId,
    clock: systemWorkerClock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  let session: Awaited<ReturnType<typeof connectMain>> | undefined;

  try {
    const readiness = await beforeDeadline(ready.promise, "listen Worker readiness");
    assert.equal(readiness.direction, "listen");
    assert.equal(readiness.workerId, workerId);
    assert.equal(readiness.executors.length, 2);
    session = await connectMain({ endpoint: main, url: new URL(readiness.url) });
    await session.ready;
    await remote.attach(session);
    assert.deepEqual(main.registration(workerId)?.preparedArtifacts, [digest]);

    const request = {
      ...assignment("org.example.worker-echo"),
      input: { usable: true },
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    const result = await beforeDeadline(
      (await remote.submit(request)).result,
      "prepared Worker echo result",
    );
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.deepEqual(result.output, { usable: true });
    assert.equal(result.executor.metadata?.localExecutorKind, "thread");
    assert.equal(readinessCount, 1);
  } finally {
    controller.abort();
    await Promise.allSettled([session?.close(), remote.close(), main.close()]);
    await beforeDeadline(running, "listen Worker cleanup");
    await cleanupDirectory(directory);
  }
});

test("@spec:worker-protocol/independent-worker-command/process-only-artifact-executes-in-a-child-process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-worker-process-only-"));
  const pluginId = "org.example.worker-process-only";
  const { artifactPath } = await createWorkerArtifact(directory, {
    executors: ["process"],
    pluginId,
  });
  const workerId = parseWorkerId("worker-process-only");
  const command = parseCommand([
    "worker",
    "start",
    "--listen",
    "127.0.0.1:0",
    "--credential",
    "process-secret",
    "--worker-id",
    workerId,
    "--data-dir",
    join(directory, "data"),
    "--prepare",
    artifactPath,
  ]) as WorkerStartCommand;
  const controller = new AbortController();
  const ready = Promise.withResolvers<WorkerReadiness>();
  const running = runWorkerProcess(command, {
    signal: controller.signal,
    onReady: (readiness) => ready.resolve(readiness),
  });
  const main = createMainEndpoint({
    credential: "process-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const remote = new RemoteExecutor({
    id: "process-only-remote",
    workerId,
    clock: systemWorkerClock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  let session: WorkerSession | undefined;

  try {
    const readiness = await beforeDeadline(ready.promise, "process-only Worker readiness");
    session = await connectMain({ endpoint: main, url: new URL(readiness.url) });
    await session.ready;
    await remote.attach(session);
    const result = await beforeDeadline(
      (
        await remote.submit({
          ...assignment(pluginId),
          input: { processOnly: true },
          deadline: new Date(Date.now() + 60_000).toISOString(),
        })
      ).result,
      "process-only Worker result",
    );

    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.deepEqual(result.output, { processOnly: true });
    assert.equal(result.executor.metadata?.localExecutorKind, "process");
  } finally {
    controller.abort();
    await Promise.allSettled([session?.close(), remote.close(), main.close()]);
    await beforeDeadline(running, "process-only Worker cleanup");
    await cleanupDirectory(directory);
  }
});

test("@spec:worker-protocol/independent-worker-command/connect-attaches-runtime-before-readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-worker-connect-process-"));
  const workerId = parseWorkerId("worker-connect-process");
  const main = createMainEndpoint({
    credential: "connect-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const remote = new RemoteExecutor({
    id: "connect-remote",
    workerId,
    clock: systemWorkerClock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  const attached = Promise.withResolvers<void>();
  const listener = await listenForMain({
    endpoint: main,
    host: "127.0.0.1",
    port: 0,
    onSession: async (session) => {
      await remote.attach(session);
      attached.resolve();
    },
  });
  const command = parseCommand([
    "worker",
    "start",
    "--connect",
    listener.url.href,
    "--credential",
    "connect-secret",
    "--worker-id",
    workerId,
    "--data-dir",
    join(directory, "data"),
  ]) as WorkerStartCommand;
  const controller = new AbortController();
  const ready = Promise.withResolvers<WorkerReadiness>();
  const running = runWorkerProcess(command, {
    signal: controller.signal,
    onReady: (readiness: WorkerReadiness) => ready.resolve(readiness),
  });

  try {
    const readiness = await beforeDeadline(ready.promise, "connect Worker readiness");
    await beforeDeadline(attached.promise, "connect Worker runtime attachment");
    assert.equal(readiness.url, listener.url.href);
    assert.equal((await remote.probe()).available, true);
  } finally {
    controller.abort();
    await Promise.allSettled([remote.close(), listener.close(), main.close()]);
    await beforeDeadline(running, "connect Worker cleanup");
    await cleanupDirectory(directory);
  }
});

test("@spec:worker-protocol/independent-worker-command/connect-recovers-buffered-result-after-network-loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-worker-connect-recovery-"));
  const { artifactPath } = await createWorkerArtifact(directory);
  const workerId = parseWorkerId("worker-connect-recovery");
  const main = createMainEndpoint({
    credential: "recovery-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const remote = new RemoteExecutor({
    id: "connect-recovery-remote",
    workerId,
    clock: systemWorkerClock,
    attemptStore: new MemoryRemoteAttemptStore(),
    orphanTimeoutMs: 2_000,
  });
  let attached = Promise.withResolvers<WorkerSession>();
  const attach = async (session: WorkerSession): Promise<void> => {
    await remote.attach(session);
    attached.resolve(session);
  };
  let listener = await listenForMain({
    endpoint: main,
    host: "127.0.0.1",
    port: 0,
    onSession: attach,
  });
  const reconnectPort = Number(listener.url.port);
  const command = parseCommand([
    "worker",
    "start",
    "--connect",
    listener.url.href,
    "--credential",
    "recovery-secret",
    "--worker-id",
    workerId,
    "--data-dir",
    join(directory, "data"),
    "--prepare",
    artifactPath,
  ]) as WorkerStartCommand;
  const controller = new AbortController();
  const ready = Promise.withResolvers<WorkerReadiness>();
  const observerState = new SqliteStateStore({
    databasePath: join(directory, "data", "state.sqlite"),
  });
  const observerAttempts = new StateRemoteAttemptStore({
    state: observerState,
    workerId,
  });
  let readinessCount = 0;
  const running = runWorkerProcess(command, {
    signal: controller.signal,
    onReady: (readiness: WorkerReadiness) => {
      readinessCount += 1;
      ready.resolve(readiness);
    },
  });

  try {
    await beforeDeadline(ready.promise, "initial connect Worker readiness");
    await observerState.open();
    const firstSession = await beforeDeadline(attached.promise, "initial Worker attachment");
    const firstSessionClosed = Promise.withResolvers<void>();
    firstSession.onStateChange((state) => {
      if (state === "closed") firstSessionClosed.resolve();
    });
    const handle = await remote.submit({
      ...assignment("org.example.worker-echo"),
      input: { delayMs: 200, recovered: true },
      deadline: new Date(Date.now() + 60_000).toISOString(),
      orphanPolicy: "finish-and-buffer",
    });
    let terminalResults = 0;
    void handle.result.then(() => {
      terminalResults += 1;
    });

    await listener.close();
    await beforeDeadline(firstSessionClosed.promise, "initial Worker session close");
    await beforeDeadline(
      waitForValue(
        () => observerAttempts.load(handle.taskId, handle.attemptId),
        (record) => record?.state === "terminal",
      ),
      "offline terminal Worker attempt",
    );
    attached = Promise.withResolvers<WorkerSession>();
    listener = await listenForMain({
      endpoint: main,
      host: "127.0.0.1",
      port: reconnectPort,
      onSession: attach,
    });
    const replacement = await beforeDeadline(attached.promise, "reconnected Worker attachment");
    const result = await beforeDeadline(handle.result, "reconnected buffered result");

    assert.ok(BigInt(replacement.epoch) > BigInt(firstSession.epoch));
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.deepEqual(result.output, { delayMs: 200, recovered: true });
    assert.equal(terminalResults, 1);
    assert.equal(readinessCount, 1);
  } finally {
    controller.abort();
    await Promise.allSettled([
      observerState.close(),
      remote.close(),
      listener.close(),
      main.close(),
    ]);
    await beforeDeadline(running, "reconnecting Worker cleanup");
    await cleanupDirectory(directory);
  }
});
