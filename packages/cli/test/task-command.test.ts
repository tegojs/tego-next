import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { type JsonValue, parseTaskRecord, type RuntimeOperations } from "@tegojs/contracts";
import type { ControlClientOptions } from "../src/control/client.js";
import type { ControlResponse } from "../src/control/protocol.js";
import { startControlServer } from "../src/control/server.js";
import { runCli } from "../src/run-cli.js";

function capture() {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  let output = "";
  stream.on("data", (chunk: string) => {
    output += chunk;
  });
  return { read: () => output, stream };
}

function response(result: JsonValue): ControlResponse {
  return {
    protocolVersion: "1.0",
    requestId: "request-task-command-test",
    ok: true,
    result,
  };
}

function taskRecord(state: "accepted" | "terminal", result?: JsonValue): JsonValue {
  return {
    taskId: "task-cli-test",
    attemptId: "attempt-cli-test",
    request: {
      applicationId: "application-default",
      pluginId: "org.example.echo",
      componentId: "echo",
      input: { message: "hi" },
      deadline: "2026-07-25T00:05:00.000Z",
      orphanPolicy: "cancel",
    },
    state,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...(result === undefined ? {} : { result }),
  };
}

test("@spec:runtime-operations/task-operations/run-example-task", async () => {
  const stdout = capture();
  const stderr = capture();
  const requests: ControlClientOptions[] = [];
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const exitCode = await runCli({
    argv: [
      "task",
      "run",
      "org.example.echo/echo",
      "--input",
      '{"message":"hi"}',
      "--deadline",
      deadline,
      "--json",
    ],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async (request) => {
      requests.push(request);
      return request.operation === "task.run"
        ? response(taskRecord("accepted"))
        : response(
            taskRecord("terminal", {
              taskId: "task-cli-test",
              attemptId: "attempt-cli-test",
              status: "succeeded",
              output: { message: "hi" },
              executor: { kind: "thread" },
              startedAt: "2026-07-25T00:00:00.000Z",
              completedAt: "2026-07-25T00:00:01.000Z",
            }),
          );
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.deepEqual(JSON.parse(stdout.read()).result.output, { message: "hi" });
  assert.deepEqual(
    requests.map(({ operation, input }) => ({ input, operation })),
    [
      {
        operation: "task.run",
        input: {
          applicationId: "application-default",
          pluginId: "org.example.echo",
          componentId: "echo",
          input: { message: "hi" },
          deadline,
          orphanPolicy: "cancel",
        },
      },
      { operation: "task.wait", input: { taskId: "task-cli-test" } },
    ],
  );
});

test("@spec:runtime-operations/task-operations/no-wait-returns-accepted-task", async () => {
  const stdout = capture();
  const stderr = capture();
  const requests: ControlClientOptions[] = [];
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const exitCode = await runCli({
    argv: [
      "task",
      "run",
      "org.example.echo/echo",
      "--input",
      "null",
      "--deadline",
      deadline,
      "--no-wait",
      "--json",
    ],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async (request) => {
      requests.push(request);
      return response(taskRecord("accepted"));
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(JSON.parse(stdout.read()).state, "accepted");
  assert.deepEqual(
    requests.map(({ operation }) => operation),
    ["task.run"],
  );
});

test("@spec:runtime-operations/task-operations/unknown-and-indeterminate-remain-distinct", async () => {
  const unknownStdout = capture();
  const indeterminateStdout = capture();
  const stderr = capture();
  const requestControl = async (request: ControlClientOptions) => {
    if (request.operation === "task.status") return response(null);
    return response(
      taskRecord("terminal", {
        taskId: "task-cli-test",
        attemptId: "attempt-cli-test",
        status: "indeterminate",
        diagnostic: {
          code: "EXECUTOR_RESULT_INDETERMINATE",
          message: "Executor operation failed",
          severity: "error",
          retryable: false,
          observedAt: "2026-07-25T00:00:01.000Z",
          source: { kind: "executor" },
        },
        executor: { kind: "remote" },
        startedAt: "2026-07-25T00:00:00.000Z",
        completedAt: "2026-07-25T00:00:01.000Z",
      }),
    );
  };

  assert.equal(
    await runCli({
      argv: ["task", "status", "missing-task", "--json"],
      stdout: unknownStdout.stream,
      stderr: stderr.stream,
      requestControl,
    }),
    0,
  );
  assert.equal(
    await runCli({
      argv: ["task", "wait", "task-cli-test", "--json"],
      stdout: indeterminateStdout.stream,
      stderr: stderr.stream,
      requestControl,
    }),
    0,
  );

  assert.equal(stderr.read(), "");
  assert.equal(JSON.parse(unknownStdout.read()), null);
  const indeterminate = JSON.parse(indeterminateStdout.read());
  assert.equal(indeterminate.result.status, "indeterminate");
  assert.equal(indeterminate.result.diagnostic.retryable, false);
  assert.equal("output" in indeterminate.result, false);
});

test("@spec:runtime-operations/task-operations/direct-and-socket-json-parity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-task-command-socket-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\tego-task-command-${process.pid}-${Date.now()}`
      : join(directory, "control.sock");
  const record = parseTaskRecord(
    taskRecord("terminal", {
      taskId: "task-cli-test",
      attemptId: "attempt-cli-test",
      status: "succeeded",
      output: { message: "hi" },
      executor: { kind: "thread" },
      startedAt: "2026-07-25T00:00:00.000Z",
      completedAt: "2026-07-25T00:00:01.000Z",
    }),
  );
  const unused = () => Promise.reject(new Error("TEST_OPERATION_UNUSED"));
  const operations: RuntimeOperations = {
    installPlugin: unused,
    deployPlugin: unused,
    pluginStatus: unused,
    runTask: unused,
    taskStatus: async () => record,
    waitTask: unused,
    cancelTask: unused,
    recoveredOperations: async () => [],
  };
  const server = await startControlServer({
    endpoint,
    operations: {
      operations,
      status: unused,
      stop: unused,
    },
  });
  const directStdout = capture();
  const socketStdout = capture();
  const stderr = capture();
  try {
    assert.equal(
      await runCli({
        argv: ["task", "status", "task-cli-test", "--json"],
        stdout: directStdout.stream,
        stderr: stderr.stream,
        requestControl: async () => response(record),
      }),
      0,
    );
    assert.equal(
      await runCli({
        argv: ["task", "status", "task-cli-test", "--endpoint", endpoint, "--json"],
        stdout: socketStdout.stream,
        stderr: stderr.stream,
      }),
      0,
    );

    assert.equal(stderr.read(), "");
    assert.deepEqual(JSON.parse(socketStdout.read()), JSON.parse(directStdout.read()));
  } finally {
    await server.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/task-operations/cancel-returns-canonical-task", async () => {
  const jsonStdout = capture();
  const humanStdout = capture();
  const stderr = capture();
  const requests: ControlClientOptions[] = [];
  const cancelled = taskRecord("terminal", {
    taskId: "task-cli-test",
    attemptId: "attempt-cli-test",
    status: "cancelled",
    executor: { kind: "thread" },
    startedAt: "2026-07-25T00:00:00.000Z",
    completedAt: "2026-07-25T00:00:01.000Z",
  });
  const requestControl = async (request: ControlClientOptions) => {
    requests.push(request);
    return response(cancelled);
  };

  assert.equal(
    await runCli({
      argv: ["task", "cancel", "task-cli-test", "--json"],
      stdout: jsonStdout.stream,
      stderr: stderr.stream,
      requestControl,
    }),
    0,
  );
  assert.equal(
    await runCli({
      argv: ["task", "cancel", "task-cli-test"],
      stdout: humanStdout.stream,
      stderr: stderr.stream,
      requestControl,
    }),
    0,
  );

  assert.equal(stderr.read(), "");
  assert.deepEqual(
    requests.map(({ input, operation }) => ({ input, operation })),
    [
      { operation: "task.cancel", input: { taskId: "task-cli-test" } },
      { operation: "task.cancel", input: { taskId: "task-cli-test" } },
    ],
  );
  assert.deepEqual(JSON.parse(humanStdout.read()), JSON.parse(jsonStdout.read()));
  assert.equal(JSON.parse(jsonStdout.read()).result.status, "cancelled");
});

test("@spec:runtime-operations/task-operations/reject-invalid-json-before-control", async () => {
  const stdout = capture();
  const stderr = capture();
  let requests = 0;
  const exitCode = await runCli({
    argv: ["task", "run", "org.example.echo/echo", "--input", "{invalid", "--json"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async () => {
      requests += 1;
      return response(null);
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(requests, 0);
  assert.equal(stdout.read(), "");
  assert.equal(JSON.parse(stderr.read()).diagnostic.code, "PROTOCOL_COMMAND_INVALID");
});

test("@spec:runtime-operations/task-operations/reject-past-deadline-before-control", async () => {
  const stdout = capture();
  const stderr = capture();
  let requests = 0;
  const exitCode = await runCli({
    argv: [
      "task",
      "run",
      "org.example.echo/echo",
      "--deadline",
      "2020-01-01T00:00:00.000Z",
      "--json",
    ],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async () => {
      requests += 1;
      return response(null);
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(requests, 0);
  assert.equal(stdout.read(), "");
  assert.equal(JSON.parse(stderr.read()).diagnostic.code, "PROTOCOL_COMMAND_INVALID");
});

test("@spec:runtime-operations/task-operations/reject-oversized-json-before-control", async () => {
  const stdout = capture();
  const stderr = capture();
  let requests = 0;
  const exitCode = await runCli({
    argv: [
      "task",
      "run",
      "org.example.echo/echo",
      "--input",
      JSON.stringify("x".repeat(1_048_576)),
      "--json",
    ],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async () => {
      requests += 1;
      return response(null);
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(requests, 0);
  assert.equal(stdout.read(), "");
  assert.equal(JSON.parse(stderr.read()).diagnostic.code, "PROTOCOL_COMMAND_INVALID");
});

test("@spec:runtime-operations/task-operations/reject-timer-overflow-before-control", async () => {
  const stdout = capture();
  const stderr = capture();
  let requests = 0;
  const exitCode = await runCli({
    argv: ["task", "wait", "task-cli-test", "--timeout-ms", "2147483648", "--json"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async () => {
      requests += 1;
      return response(
        taskRecord("terminal", {
          taskId: "task-cli-test",
          attemptId: "attempt-cli-test",
          status: "succeeded",
          executor: { kind: "thread" },
          startedAt: "2026-07-25T00:00:00.000Z",
          completedAt: "2026-07-25T00:00:01.000Z",
        }),
      );
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(requests, 0);
  assert.equal(stdout.read(), "");
  assert.equal(JSON.parse(stderr.read()).diagnostic.code, "PROTOCOL_COMMAND_INVALID");
});
