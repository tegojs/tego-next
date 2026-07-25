import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  type JsonValue,
  parseTaskRecord,
  type RunTaskRequest,
  type RuntimeOperations,
} from "@tegojs/contracts";
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

function response(result: JsonValue, requestId = "request-task-command-test"): ControlResponse {
  return {
    protocolVersion: "1.0",
    requestId,
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
    requestControl: async (request: ControlClientOptions) => {
      requests.push(request);
      return request.operation === "task.run"
        ? response(
            {
              ...(taskRecord("accepted") as Record<string, JsonValue>),
              request: request.input,
            },
            request.requestId,
          )
        : response(
            {
              ...(taskRecord("terminal", {
                taskId: "task-cli-test",
                attemptId: "attempt-cli-test",
                status: "succeeded",
                output: { message: "hi" },
                executor: { kind: "thread" },
                startedAt: "2026-07-25T00:00:00.000Z",
                completedAt: "2026-07-25T00:00:01.000Z",
              }) as Record<string, JsonValue>),
              request: requests[0]?.input ?? null,
            },
            request.requestId,
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
      return response(
        {
          ...(taskRecord("accepted") as Record<string, JsonValue>),
          request: request.input,
        },
        request.requestId,
      );
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
    if (request.operation === "task.status") return response(null, request.requestId);
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
      request.requestId,
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
        requestControl: async (request) => response(record, request.requestId),
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

test("@spec:runtime-operations/task-operations/direct-and-socket-success-values-are-sanitized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-task-command-sanitize-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\tego-task-sanitize-${process.pid}-${Date.now()}`
      : join(directory, "control.sock");
  const secret = "postgresql://user:hunter2@localhost/private /Users/alice/private";
  const record = parseTaskRecord(
    taskRecord("terminal", {
      taskId: "task-cli-test",
      attemptId: "attempt-cli-test",
      status: "indeterminate",
      diagnostic: {
        code: "EXECUTOR_RESULT_INDETERMINATE",
        message: secret,
        severity: "error",
        retryable: false,
        observedAt: "2026-07-25T00:00:01.000Z",
        source: { kind: "executor", id: secret },
      },
      executor: { kind: "remote" },
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
    operations: { operations, status: unused, stop: unused },
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
        requestControl: async (request) => response(record, request.requestId),
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
    assert.deepEqual(JSON.parse(directStdout.read()), JSON.parse(socketStdout.read()));
    assert.doesNotMatch(directStdout.read(), /hunter2|\/Users\/alice|postgresql:/u);
  } finally {
    await server.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/task-operations/diagnostic-shaped-business-input-correlates-through-direct-and-socket-wait", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-task-command-business-input-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\tego-task-business-input-${process.pid}-${Date.now()}`
      : join(directory, "control.sock");
  const secret = "postgresql://user:hunter2@localhost/private";
  const businessInput = {
    code: "EXECUTOR_BUSINESS_PAYLOAD",
    message: secret,
    severity: "error",
    retryable: false,
    observedAt: "2026-07-25T00:00:00.000Z",
    source: { kind: "executor", id: secret },
    details: { privatePath: "/Users/alice/private", token: secret },
  };
  const terminalResult = {
    taskId: "task-cli-test",
    attemptId: "attempt-cli-test",
    status: "succeeded",
    output: { message: "complete" },
    executor: { kind: "thread" },
    startedAt: "2026-07-25T00:00:00.000Z",
    completedAt: "2026-07-25T00:00:01.000Z",
  } satisfies JsonValue;
  let socketRequest: RunTaskRequest | undefined;
  const unused = () => Promise.reject(new Error("TEST_OPERATION_UNUSED"));
  const operations: RuntimeOperations = {
    installPlugin: unused,
    deployPlugin: unused,
    pluginStatus: unused,
    runTask: async (request) => {
      socketRequest = request;
      return parseTaskRecord({
        ...(taskRecord("accepted") as Record<string, JsonValue>),
        request,
      });
    },
    taskStatus: unused,
    waitTask: async () => {
      if (socketRequest === undefined) throw new Error("TEST_RUN_REQUEST_MISSING");
      return parseTaskRecord({
        ...(taskRecord("terminal", terminalResult) as Record<string, JsonValue>),
        request: socketRequest,
      });
    },
    cancelTask: unused,
    recoveredOperations: async () => [],
  };
  const server = await startControlServer({
    endpoint,
    operations: { operations, status: unused, stop: unused },
  });
  const directStdout = capture();
  const socketStdout = capture();
  const directStderr = capture();
  const socketStderr = capture();
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const argv = [
    "task",
    "run",
    "org.example.echo/echo",
    "--input",
    JSON.stringify(businessInput),
    "--deadline",
    deadline,
    "--json",
  ];
  let directRequest: JsonValue = null;
  try {
    const directExitCode = await runCli({
      argv,
      stdout: directStdout.stream,
      stderr: directStderr.stream,
      requestControl: async (request) => {
        if (request.operation === "task.run") {
          directRequest = request.input;
          return response(
            {
              ...(taskRecord("accepted") as Record<string, JsonValue>),
              request: request.input,
            },
            request.requestId,
          );
        }
        return response(
          {
            ...(taskRecord("terminal", terminalResult) as Record<string, JsonValue>),
            request: directRequest,
          },
          request.requestId,
        );
      },
    });
    const socketExitCode = await runCli({
      argv: [...argv.slice(0, -1), "--endpoint", endpoint, "--json"],
      stdout: socketStdout.stream,
      stderr: socketStderr.stream,
    });

    assert.deepEqual({ directExitCode, socketExitCode }, { directExitCode: 0, socketExitCode: 0 });
    assert.equal(directStderr.read(), "");
    assert.equal(socketStderr.read(), "");
    assert.deepEqual(JSON.parse(directStdout.read()), JSON.parse(socketStdout.read()));
    assert.doesNotMatch(directStdout.read(), /hunter2|\/Users\/alice|postgresql:/u);
    assert.equal(JSON.parse(directStdout.read()).result.status, "succeeded");
  } finally {
    await server.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/task-operations/rejects-success-without-result", async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli({
    argv: ["task", "status", "task-cli-test", "--json"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async (request) => ({
      protocolVersion: "1.0",
      requestId: request.requestId ?? "",
      ok: true,
    }),
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.read(), "");
  assert.equal(JSON.parse(stderr.read()).diagnostic.code, "PROTOCOL_CONTROL_FRAME_INVALID");
});

test("@spec:runtime-operations/task-operations/no-wait-uses-short-submission-timeout", async () => {
  const stdout = capture();
  const stderr = capture();
  const timeouts: number[] = [];
  const exitCode = await runCli({
    argv: [
      "task",
      "run",
      "org.example.echo/echo",
      "--deadline",
      "2099-01-01T00:00:00.000Z",
      "--no-wait",
      "--json",
    ],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async (request) => {
      timeouts.push(request.timeoutMs);
      return response(
        {
          ...(taskRecord("accepted") as Record<string, JsonValue>),
          request: request.input,
        },
        request.requestId,
      );
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.deepEqual(timeouts, [5_000]);
});

test("@spec:runtime-operations/task-operations/run-and-wait-share-one-time-budget", async () => {
  const stdout = capture();
  const stderr = capture();
  const timeouts: number[] = [];
  let monotonicTime = 10_000;
  let submittedInput: JsonValue = null;
  const runOptions = {
    argv: [
      "task",
      "run",
      "org.example.echo/echo",
      "--deadline",
      "2099-01-01T00:00:00.000Z",
      "--timeout-ms",
      "1000",
      "--json",
    ],
    stdout: stdout.stream,
    stderr: stderr.stream,
    monotonicNow: () => monotonicTime,
    requestControl: async (request: ControlClientOptions) => {
      timeouts.push(request.timeoutMs);
      if (request.operation === "task.run") {
        submittedInput = request.input;
        monotonicTime += 650;
        return response(
          {
            ...(taskRecord("accepted") as Record<string, JsonValue>),
            request: request.input,
          },
          request.requestId,
        );
      }
      return response(
        {
          ...(taskRecord("terminal", {
            taskId: "task-cli-test",
            attemptId: "attempt-cli-test",
            status: "succeeded",
            output: { message: "hi" },
            executor: { kind: "thread" },
            startedAt: "2026-07-25T00:00:00.000Z",
            completedAt: "2026-07-25T00:00:01.000Z",
          }) as Record<string, JsonValue>),
          request: submittedInput,
        },
        request.requestId,
      );
    },
  };
  const exitCode = await runCli(runOptions);

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.deepEqual(timeouts, [1_000, 350]);
});

test("@spec:runtime-operations/task-operations/correlates-canonical-wire-equivalent-requests", async () => {
  const stdout = capture();
  const stderr = capture();
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const exitCode = await runCli({
    argv: [
      "task",
      "run",
      "org.example.echo/echo",
      "--input",
      '{"nested":{"b":1,"a":-0}}',
      "--deadline",
      deadline,
      "--no-wait",
      "--json",
    ],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async (request) => {
      const submitted = request.input as unknown as RunTaskRequest;
      return response(
        {
          ...(taskRecord("accepted") as Record<string, JsonValue>),
          request: {
            orphanPolicy: submitted.orphanPolicy,
            deadline: submitted.deadline,
            input: { nested: { a: 0, b: 1 } },
            componentId: submitted.componentId,
            pluginId: submitted.pluginId,
            applicationId: submitted.applicationId,
          },
        },
        request.requestId,
      );
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(JSON.parse(stdout.read()).state, "accepted");
});

test("@spec:runtime-operations/task-operations/rejects-mismatched-task-identities", async () => {
  for (const command of ["status", "wait", "cancel"] as const) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli({
      argv: ["task", command, "task-cli-test", "--json"],
      stdout: stdout.stream,
      stderr: stderr.stream,
      requestControl: async (request) =>
        response(
          {
            ...(taskRecord("accepted") as Record<string, JsonValue>),
            taskId: "task-other",
          },
          request.requestId,
        ),
    });

    assert.equal(exitCode, 1, command);
    assert.equal(stdout.read(), "");
    assert.equal(JSON.parse(stderr.read()).diagnostic.code, "PROTOCOL_CONTROL_REQUEST_MISMATCH");
  }
});

test("@spec:runtime-operations/task-operations/rejects-run-request-and-wait-identity-mismatches", async () => {
  for (const mismatch of ["request", "wait"] as const) {
    const stdout = capture();
    const stderr = capture();
    const deadline = new Date(Date.now() + 60_000).toISOString();
    let submittedInput: JsonValue = null;
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
        if (request.operation === "task.run") {
          submittedInput = request.input;
          const accepted = taskRecord("accepted") as Record<string, JsonValue>;
          return response(
            {
              ...accepted,
              request:
                mismatch === "request"
                  ? { ...(accepted.request as Record<string, JsonValue>), componentId: "other" }
                  : request.input,
            },
            request.requestId,
          );
        }
        const terminal = taskRecord("terminal", {
          taskId: "task-cli-test",
          attemptId: mismatch === "wait" ? "attempt-other" : "attempt-cli-test",
          status: "succeeded",
          executor: { kind: "thread" },
          startedAt: "2026-07-25T00:00:00.000Z",
          completedAt: "2026-07-25T00:00:01.000Z",
        }) as Record<string, JsonValue>;
        return response(
          {
            ...terminal,
            attemptId: mismatch === "wait" ? "attempt-other" : "attempt-cli-test",
            request: submittedInput,
          },
          request.requestId,
        );
      },
    });

    assert.equal(exitCode, 1, mismatch);
    assert.equal(stdout.read(), "");
    assert.equal(JSON.parse(stderr.read()).diagnostic.code, "PROTOCOL_CONTROL_REQUEST_MISMATCH");
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
    return response(cancelled, request.requestId);
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
