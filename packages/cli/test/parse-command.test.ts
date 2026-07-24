import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { parseRuntimeStatus, type RuntimeStatus } from "@tegojs/contracts";
import type { ControlResponse } from "../src/control/protocol.js";
import { parseCommand } from "../src/parse-command.js";
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

function response(result?: ControlResponse["result"]): ControlResponse {
  return {
    protocolVersion: "1.0",
    requestId: "request-cli-test",
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
    requestControl: async (request: { readonly operation: string }) => {
      requests.push(request.operation);
      return response(runningStatus());
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stdout.read()).lifecycle, "running");
  assert.equal(stderr.read(), "");
  assert.deepEqual(requests, ["runtime.status"]);
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
  const stdout = capture();
  const stderr = capture();
  const requests: string[] = [];
  const exitCode = await runCli({
    argv: ["runtime", "stop", "--json"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async (request: { readonly operation: string }) => {
      requests.push(request.operation);
      return response({ stopped: true });
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requests, ["runtime.stop"]);
  assert.deepEqual(JSON.parse(stdout.read()), { stopped: true });
  assert.equal(stderr.read(), "");
});
