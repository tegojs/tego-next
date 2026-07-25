import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  parseArtifactDigest,
  parsePluginManifest,
  parseWorkerId,
  type ExecutionRequest,
} from "@tegojs/contracts";
import type { PreparedArtifact } from "@tegojs/runtime";
import {
  type WorkerStartCommand,
  parseCommand,
} from "../src/parse-command.js";
import { runCli } from "../src/run-cli.js";
import {
  createPreparedArtifactSelection,
  type WorkerReadiness,
} from "../src/worker/worker-process.js";

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
): PreparedArtifact {
  return {
    digest: parseArtifactDigest(`sha256:${digestSuffix.repeat(64)}`),
    root: `/prepared/${digestSuffix}`,
    manifest: parsePluginManifest({
      schemaVersion: "1.0",
      pluginId,
      version: `1.0.${digestSuffix === "a" ? "0" : "1"}`,
      contractRange: ">=0.0.0",
      nodeRange: ">=26.0.0 <27.0.0",
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
  assert.equal(
    exact.resolveComponent(exactRequest).artifactDigest,
    `sha256:${"a".repeat(64)}`,
  );

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
