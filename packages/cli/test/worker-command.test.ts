import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  type ArtifactDigest,
  createExecutionBinding,
  type ExecutionRequest,
  type JsonValue,
  parseApplicationId,
  parseArtifactDigest,
  parseCapabilityName,
  parseComponentInstanceId,
  parseFencingEpoch,
  parseGeneration,
  parsePluginManifest,
  parsePluginId,
  parseWorkerId,
  type StateFencing,
  type StateTransaction,
  type StateTransactionOptions,
} from "@tegojs/contracts";
import { MemoryStateStore, SqliteStateStore } from "@tegojs/drivers-local";
import type { PreparedArtifact } from "@tegojs/runtime";
import {
  connectMain,
  createMainEndpoint,
  listenForMain,
  MemoryRemoteAttemptStore,
  MemoryWorkerEpochAllocator,
  type RemoteAttemptRecord,
  RemoteExecutor,
  requestFingerprint,
  systemWorkerClock,
  type WorkerSession,
} from "@tegojs/transport-websocket";
import { parseCommand, type WorkerStartCommand } from "../src/parse-command.js";
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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
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
      "--labels",
      '{"region":"lab"}',
      "--resources",
      '{"cpuMillis":1000,"memoryBytes":268435456,"storageBytes":268435456}',
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
      labels: { region: "lab" },
      prepare: [resolve("./first.tego"), resolve("./second.tego")],
      resources: {
        cpuMillis: 1_000,
        memoryBytes: 256 * 1024 * 1024,
        storageBytes: 256 * 1024 * 1024,
      },
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
      labels: {},
      port: 0,
      prepare: [],
      resources: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
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
      permissions: [{ kind: "executor", executors: [...executors, "remote"] }],
      capabilities: { provides: [], requires: [] },
    }),
  };
}

function assignment(
  pluginId: string,
  remote: {
    readonly artifactDigest?: ArtifactDigest;
    readonly id: string;
    readonly workerId: ReturnType<typeof parseWorkerId>;
  } = {
    id: "remote-01",
    workerId: parseWorkerId("worker-01"),
  },
): ExecutionRequest {
  const target = {
    instanceId: parseComponentInstanceId("application-artifact-selection.plugin.echo.g1"),
    deploymentGeneration: parseGeneration("1"),
    artifactDigest:
      remote.artifactDigest ??
      parseArtifactDigest(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    executor: {
      id: remote.id,
      type: "remote" as const,
      workerId: remote.workerId,
    },
  };
  const identity = {
    applicationId: "application-artifact-selection" as ExecutionRequest["applicationId"],
    pluginId: pluginId as ExecutionRequest["pluginId"],
    componentId: "echo" as ExecutionRequest["componentId"],
    target,
  };
  return {
    taskId: "task-artifact-selection" as ExecutionRequest["taskId"],
    attemptId: "attempt-artifact-selection" as ExecutionRequest["attemptId"],
    ...identity,
    binding: createExecutionBinding(identity, {
      configuration: {},
      permissionGrants: [
        {
          kind: "executor",
          executors: ["remote"],
        },
      ],
      capabilityDefinitions: [],
      capabilityBindings: [],
    }),
    input: null,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    orphanPolicy: "cancel",
  };
}

test("execution binding parity forwards nested configuration, grants, and capabilities verbatim", () => {
  const selection = createPreparedArtifactSelection(
    [preparedArtifact("org.example.exact", "a")],
    "worker-runtime",
  );
  const base = assignment("org.example.exact");
  const request = {
    ...base,
    binding: createExecutionBinding(base, {
      configuration: {
        nested: {
          retries: 3,
          values: ["one", { enabled: true }],
        },
      },
      permissionGrants: [
        { kind: "executor", executors: ["process", "remote", "thread"] },
        { kind: "secret", names: ["api-token"] },
      ],
      capabilityDefinitions: [
        {
          identity: { name: parseCapabilityName("records"), protocolVersion: "1.0.0" },
          methods: ["query"],
          requestSchema: { type: "object" },
          responseSchema: { type: "object" },
        },
      ],
      capabilityBindings: [
        {
          capability: { name: parseCapabilityName("records"), protocolVersion: "1.0.0" },
          providerDeployment: {
            applicationId: parseApplicationId("application-artifact-selection"),
            pluginId: parsePluginId("records-provider"),
          },
        },
      ],
    }),
  };
  const component = selection.resolveComponent(request);

  assert.deepEqual(
    component.configuration,
    (request as ExecutionRequest & { readonly binding: { readonly configuration: JsonValue } })
      .binding.configuration,
  );
  assert.deepEqual(
    component.permissionGrants,
    (
      request as ExecutionRequest & {
        readonly binding: { readonly permissionGrants: readonly JsonValue[] };
      }
    ).binding.permissionGrants,
  );
  assert.deepEqual(
    component.capabilityDefinitions,
    (
      request as ExecutionRequest & {
        readonly binding: { readonly capabilityDefinitions: readonly JsonValue[] };
      }
    ).binding.capabilityDefinitions,
  );
  const generationMismatch = {
    ...structuredClone(request),
    target: {
      ...request.target,
      deploymentGeneration: parseGeneration("2"),
    },
  } as ExecutionRequest;
  assert.equal(
    selection.validateAssignment(generationMismatch)?.code,
    "PROTOCOL_EXECUTION_BINDING_INVALID",
  );
});

test("@spec:worker-protocol/prepared-artifact-admission/selects-one-digest-per-plugin", () => {
  const exact = createPreparedArtifactSelection(
    [preparedArtifact("org.example.exact", "a")],
    "worker-runtime",
  );
  const exactRequest = assignment("org.example.exact");
  assert.equal(exact.validateAssignment(exactRequest), undefined);
  assert.equal(exact.resolveComponent(exactRequest).artifactDigest, `sha256:${"a".repeat(64)}`);
  assert.deepEqual(
    exact.resolveComponent(exactRequest).permissionGrants,
    exactRequest.binding.permissionGrants,
  );
  const processOnly = createPreparedArtifactSelection(
    [preparedArtifact("org.example.process-only", "c", ["process"])],
    "worker-runtime",
  );
  const processRequest = assignment("org.example.process-only", {
    artifactDigest: parseArtifactDigest(`sha256:${"c".repeat(64)}`),
    id: "remote-01",
    workerId: parseWorkerId("worker-01"),
  });
  assert.equal(processOnly.selectExecutorKind(processRequest), "process");
  assert.deepEqual(
    processOnly.resolveComponent(processRequest).permissionGrants,
    processRequest.binding.permissionGrants,
  );

  const missing = exact.validateAssignment(assignment("org.example.missing"));
  assert.equal(missing?.code, "EXECUTOR_REMOTE_ARTIFACT_UNPREPARED");

  const multiple = createPreparedArtifactSelection(
    [
      preparedArtifact("org.example.ambiguous", "a"),
      preparedArtifact("org.example.ambiguous", "b"),
    ],
    "worker-runtime",
  );
  assert.equal(multiple.validateAssignment(assignment("org.example.ambiguous")), undefined);
  assert.equal(
    multiple.resolveComponent(assignment("org.example.ambiguous")).artifactDigest,
    `sha256:${"a".repeat(64)}`,
  );
  const missingDigest = multiple.validateAssignment(
    assignment("org.example.ambiguous", {
      artifactDigest: parseArtifactDigest(`sha256:${"c".repeat(64)}`),
      id: "remote-01",
      workerId: parseWorkerId("worker-01"),
    }),
  );
  assert.equal(missingDigest?.code, "EXECUTOR_REMOTE_ARTIFACT_UNPREPARED");
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
    state: "assigned" as const,
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

    const unknown = {
      ...(reopened ?? initial),
      state: "unknown" as const,
      updatedAt: new Date(1).toISOString(),
    };
    const committed = await store.commit(unknown, { expectedRevision: "1", expectedEpoch: "1" });
    assert.equal(committed?.revision, "2");
    assert.equal(
      await store.commit(
        { ...unknown, updatedAt: new Date(2).toISOString() },
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

class CapturingMemoryStateStore extends MemoryStateStore {
  readonly transactionOptions: StateTransactionOptions[] = [];

  override transact<T extends JsonValue>(
    options: StateTransactionOptions,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactionOptions.push(structuredClone(options));
    return super.transact(options, work);
  }
}

test("@spec:worker-protocol/durable-worker-attempts/fences-every-mutation-when-configured", async () => {
  const workerId = parseWorkerId("worker-fenced-attempts");
  const request = assignment("org.example.fenced-attempts", {
    id: "remote-fenced",
    workerId,
  });
  const initial: RemoteAttemptRecord = {
    workerId,
    request,
    fingerprint: requestFingerprint(request),
    state: "assigned",
    epoch: "1",
    updatedAt: new Date(0).toISOString(),
    revision: "0",
  };
  const fencing: StateFencing = {
    resource: "runtime:main-01",
    epoch: parseFencingEpoch("7"),
  };

  for (const configuredFencing of [fencing, undefined] as const) {
    const state = new CapturingMemoryStateStore();
    await state.open();
    try {
      const store = new StateRemoteAttemptStore({
        state,
        workerId,
        ...(configuredFencing === undefined ? {} : { fencing: configuredFencing }),
      });
      await store.save(initial);
      const committed = await store.commit(initial, { expectedRevision: "0" });
      assert.equal(committed?.revision, "1");
      await store.delete(request.taskId, request.attemptId);
      await store.load(request.taskId, request.attemptId);
      await store.list(workerId);

      assert.deepEqual(
        state.transactionOptions,
        Array.from({ length: 3 }, () =>
          configuredFencing === undefined ? {} : { fencing: configuredFencing },
        ),
      );
    } finally {
      await state.close();
    }
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
      permissions: [{ kind: "executor", executors: [...executors, "remote"] }],
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
      ...assignment("org.example.worker-echo", {
        artifactDigest: parseArtifactDigest(digest),
        id: remote.id,
        workerId,
      }),
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
  const { artifactPath, digest } = await createWorkerArtifact(directory, {
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
          ...assignment(pluginId, {
            artifactDigest: parseArtifactDigest(digest),
            id: remote.id,
            workerId,
          }),
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

test("@spec:worker-protocol/independent-worker-command/connect-retries-initial-network-failure-before-readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-worker-connect-initial-retry-"));
  const workerId = parseWorkerId("worker-connect-initial-retry");
  const disrupted = Promise.withResolvers<void>();
  const disruptor = createServer((socket) => {
    disrupted.resolve();
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    disruptor.once("error", reject);
    disruptor.listen(0, "127.0.0.1", resolve);
  });
  const address = disruptor.address();
  assert.ok(address !== null && typeof address !== "string");
  const main = createMainEndpoint({
    credential: "initial-retry-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const command = parseCommand([
    "worker",
    "start",
    "--connect",
    `ws://127.0.0.1:${String(address.port)}/worker`,
    "--credential",
    "initial-retry-secret",
    "--worker-id",
    workerId,
    "--data-dir",
    join(directory, "data"),
  ]) as WorkerStartCommand;
  const controller = new AbortController();
  const ready = Promise.withResolvers<WorkerReadiness>();
  let readinessCount = 0;
  const running = runWorkerProcess(command, {
    signal: controller.signal,
    onReady: (readiness) => {
      readinessCount += 1;
      ready.resolve(readiness);
    },
  });
  let listener: Awaited<ReturnType<typeof listenForMain>> | undefined;

  try {
    await beforeDeadline(disrupted.promise, "initial disrupted Worker connection");
    assert.equal(readinessCount, 0);
    await closeServer(disruptor);
    listener = await listenForMain({
      endpoint: main,
      host: "127.0.0.1",
      port: address.port,
    });
    await beforeDeadline(ready.promise, "Worker readiness after initial network recovery");
    assert.equal(readinessCount, 1);
    assert.equal(main.current(workerId)?.available, true);
  } finally {
    controller.abort();
    if (disruptor.listening) await closeServer(disruptor);
    await Promise.allSettled([listener?.close(), main.close()]);
    await beforeDeadline(running, "initial retry Worker cleanup");
    await cleanupDirectory(directory);
  }
});

test("@spec:worker-protocol/independent-worker-command/connect-abort-terminates-network-retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-worker-connect-retry-abort-"));
  const workerId = parseWorkerId("worker-connect-retry-abort");
  const disrupted = Promise.withResolvers<void>();
  const disruptor = createServer((socket) => {
    disrupted.resolve();
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    disruptor.once("error", reject);
    disruptor.listen(0, "127.0.0.1", resolve);
  });
  const address = disruptor.address();
  assert.ok(address !== null && typeof address !== "string");
  const command = parseCommand([
    "worker",
    "start",
    "--connect",
    `ws://127.0.0.1:${String(address.port)}/worker`,
    "--credential",
    "retry-abort-secret",
    "--worker-id",
    workerId,
    "--data-dir",
    join(directory, "data"),
  ]) as WorkerStartCommand;
  const controller = new AbortController();
  let readinessCount = 0;
  const running = runWorkerProcess(command, {
    signal: controller.signal,
    onReady: () => {
      readinessCount += 1;
    },
  });

  try {
    await beforeDeadline(disrupted.promise, "disrupted Worker connection before abort");
    await closeServer(disruptor);
    controller.abort();
    await beforeDeadline(running, "aborted Worker reconnect loop");
    assert.equal(readinessCount, 0);
  } finally {
    controller.abort();
    if (disruptor.listening) await closeServer(disruptor);
    await running.catch(() => undefined);
    await cleanupDirectory(directory);
  }
});

test("@spec:worker-protocol/independent-worker-command/connect-authentication-failure-is-not-retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-worker-connect-auth-failure-"));
  const workerId = parseWorkerId("worker-connect-auth-failure");
  const main = createMainEndpoint({
    credential: "correct-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const listener = await listenForMain({
    endpoint: main,
    host: "127.0.0.1",
    port: 0,
  });
  const command = parseCommand([
    "worker",
    "start",
    "--connect",
    listener.url.href,
    "--credential",
    "wrong-secret",
    "--worker-id",
    workerId,
    "--data-dir",
    join(directory, "data"),
  ]) as WorkerStartCommand;
  let readinessCount = 0;
  const running = runWorkerProcess(command, {
    onReady: () => {
      readinessCount += 1;
    },
  });

  try {
    await assert.rejects(
      beforeDeadline(running, "non-retryable Worker authentication failure"),
      /authentication|credential|protocol/iu,
    );
    assert.equal(readinessCount, 0);
  } finally {
    await Promise.allSettled([listener.close(), main.close()]);
    await running.catch(() => undefined);
    await cleanupDirectory(directory);
  }
});

test("@spec:worker-protocol/independent-worker-command/connect-recovers-buffered-result-after-network-loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-worker-connect-recovery-"));
  const { artifactPath, digest } = await createWorkerArtifact(directory);
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
      ...assignment("org.example.worker-echo", {
        artifactDigest: parseArtifactDigest(digest),
        id: remote.id,
        workerId,
      }),
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
