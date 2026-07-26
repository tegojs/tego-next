import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { parseRuntimeStatus, type RuntimeStatus } from "@tegojs/contracts";
import type { ControlClientOptions } from "../src/control/client.js";
import type { ControlResponse } from "../src/control/protocol.js";
import { defaultControlEndpoint, parseCommand } from "../src/parse-command.js";
import { runCli } from "../src/run-cli.js";

function runningStatus(): RuntimeStatus {
  return parseRuntimeStatus({
    identity: {
      runtimeId: "runtime-cli-test",
      applicationId: "application-cli-test",
      nodeId: "node-cli-test",
    },
    mode: "single-main",
    lifecycle: "running",
    liveness: true,
    readiness: true,
    acceptingOperations: true,
    drivers: [],
    counts: {
      deployments: 0,
      installations: 0,
      recoverableOperations: 0,
      tasks: 0,
      workers: 0,
    },
  });
}

function capture() {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  let output = "";
  stream.on("data", (chunk: string) => {
    output += chunk;
  });
  return {
    stream,
    read: () => output,
  };
}

function response(
  result: ControlResponse["result"],
  requestId = "request-cli-test",
): ControlResponse {
  return {
    protocolVersion: "1.0",
    requestId,
    ok: true,
    ...(result === undefined ? {} : { result }),
  };
}

test("@spec:runtime-operations/local-runtime-operations/json-status", async () => {
  const stdout = capture();
  const stderr = capture();
  const requests: string[] = [];
  const exitCode = await runCli({
    argv: ["runtime", "status", "--json"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async (request) => {
      requests.push(request.operation);
      return response(runningStatus(), request.requestId);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stdout.read()).lifecycle, "running");
  assert.equal(stderr.read(), "");
  assert.deepEqual(requests, ["runtime.status"]);
});

test("@spec:runtime-operations/local-runtime-operations/json-snapshot", async () => {
  const stdout = capture();
  const stderr = capture();
  const requests: ControlClientOptions[] = [];
  const snapshot = {
    installations: { items: [] },
    deployments: { items: [] },
    instances: { items: [] },
    operations: { items: [] },
    tasks: { items: [] },
  };
  const exitCode = await runCli({
    argv: ["runtime", "snapshot", "--endpoint", "control.sock", "--json"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async (request) => {
      requests.push(request);
      return response(snapshot, request.requestId);
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout.read()), snapshot);
  assert.equal(stderr.read(), "");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.endpoint, "control.sock");
  assert.equal(requests[0]?.operation, "runtime.snapshot");
  assert.deepEqual(requests[0]?.input, {});
});

test("@spec:runtime-operations/local-runtime-operations/structured-command-diagnostic", async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli({
    argv: ["unknown", "--json"],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.read(), "");
  assert.equal(JSON.parse(stderr.read()).diagnostic.code, "PROTOCOL_COMMAND_INVALID");
});

test("@spec:runtime-operations/local-runtime-operations/parse-runtime-lifecycle-commands", () => {
  assert.deepEqual(parseCommand(["runtime", "snapshot", "--json", "--endpoint", "control.sock"]), {
    kind: "runtime.snapshot",
    endpoint: "control.sock",
    input: {},
    json: true,
  });
  assert.deepEqual(parseCommand(["runtime", "status", "--json", "--endpoint", "control.sock"]), {
    kind: "runtime.status",
    endpoint: "control.sock",
    json: true,
  });
  assert.deepEqual(parseCommand(["runtime", "stop", "--endpoint", "control.sock"]), {
    kind: "runtime.stop",
    endpoint: "control.sock",
    json: false,
  });
  assert.deepEqual(
    parseCommand([
      "runtime",
      "start",
      "--detach",
      "--json",
      "--data-dir",
      "/tmp/tego-runtime",
      "--endpoint",
      "control.sock",
      "--runtime-id",
      "runtime-one",
      "--application-id",
      "application-one",
      "--node-id",
      "node-one",
    ]),
    {
      kind: "runtime.start",
      applicationId: "application-one",
      dataDirectory: "/tmp/tego-runtime",
      detach: true,
      endpoint: "control.sock",
      json: true,
      mode: "single-main",
      nodeId: "node-one",
      runtimeId: "runtime-one",
    },
  );
});

test("@spec:runtime-operations/local-runtime-operations/foreground-start-is-default", async () => {
  const stdout = capture();
  const stderr = capture();
  let foregroundStarts = 0;
  let detachedStarts = 0;
  const exitCode = await runCli({
    argv: ["runtime", "start", "--json"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    startForeground: async () => {
      foregroundStarts += 1;
      return runningStatus();
    },
    startDetached: async () => {
      detachedStarts += 1;
      return runningStatus();
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stdout.read()).lifecycle, "running");
  assert.equal(stderr.read(), "");
  assert.equal(foregroundStarts, 1);
  assert.equal(detachedStarts, 0);
});

test("@spec:runtime-operations/local-runtime-operations/detached-start-waits-for-running", async () => {
  const stdout = capture();
  const stderr = capture();
  let detachedStarts = 0;
  const exitCode = await runCli({
    argv: ["runtime", "start", "--detach", "--json"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    startDetached: async () => {
      detachedStarts += 1;
      return runningStatus();
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(detachedStarts, 1);
  assert.equal(JSON.parse(stdout.read()).readiness, true);
  assert.equal(stderr.read(), "");
});

test("@spec:runtime-operations/local-runtime-operations/graceful-idempotent-stop", async () => {
  const firstStdout = capture();
  const secondStdout = capture();
  const stderr = capture();
  const requests: string[] = [];
  let stopped = false;
  const requestControl = async (request: ControlClientOptions) => {
    requests.push(request.operation);
    if (stopped) {
      const error = new Error("connect ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    stopped = true;
    return response({ stopped: true }, request.requestId);
  };
  const firstExitCode = await runCli({
    argv: ["runtime", "stop", "--json"],
    stdout: firstStdout.stream,
    stderr: stderr.stream,
    requestControl,
  });
  const secondExitCode = await runCli({
    argv: ["runtime", "stop", "--json"],
    stdout: secondStdout.stream,
    stderr: stderr.stream,
    requestControl,
  });

  assert.equal(firstExitCode, 0);
  assert.equal(secondExitCode, 0);
  assert.deepEqual(requests, ["runtime.stop", "runtime.stop"]);
  assert.deepEqual(JSON.parse(firstStdout.read()), { stopped: true });
  assert.deepEqual(JSON.parse(secondStdout.read()), { alreadyStopped: true, stopped: true });
  assert.equal(stderr.read(), "");
});

test("@spec:runtime-operations/local-runtime-operations/cli-diagnostics-redact-host-secrets", async () => {
  const stdout = capture();
  const stderr = capture();
  const secret = "postgresql://user:hunter2@localhost/database?token=raw /Users/alice/private";
  const error = new Error(secret);
  error.stack = `Error: ${secret}\n at /Users/alice/private/file.js:1:1`;
  const exitCode = await runCli({
    argv: ["runtime", "status", "--json"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: () => Promise.reject(error),
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.read(), "");
  assert.doesNotMatch(stderr.read(), /hunter2|token=raw|\/Users\/alice|postgresql:\/\/user/u);
});

test("@spec:runtime-operations/local-runtime-operations/windows-pipe-uses-complete-scoped-path-hash", () => {
  type EndpointOptions = {
    readonly platform: NodeJS.Platform;
    readonly runtimeScope: string;
    readonly userScope: string;
  };
  const deriveEndpoint = defaultControlEndpoint as (
    dataDirectory: string,
    options: EndpointOptions,
  ) => string;
  const options = {
    platform: "win32",
    runtimeScope: "runtime-main",
    userScope: "user-1000",
  } satisfies EndpointOptions;
  const first = deriveEndpoint("C:\\first\\shared\\suffix", options);
  const second = deriveEndpoint("D:\\second\\shared\\suffix", options);
  const normalized = deriveEndpoint("C:\\first\\nested\\..\\shared\\suffix", options);

  assert.match(first, /^\\\\\.\\pipe\\tego-[a-f0-9]{64}$/u);
  assert.notEqual(first, second);
  assert.equal(first, normalized);
  assert.notEqual(
    first,
    deriveEndpoint("C:\\first\\shared\\suffix", {
      ...options,
      userScope: "user-2000",
    }),
  );
  assert.notEqual(
    first,
    deriveEndpoint("C:\\first\\shared\\suffix", {
      ...options,
      runtimeScope: "runtime-worker",
    }),
  );
});
