import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseComponentId,
  parseComponentInstanceId,
  parseGeneration,
  parsePluginId,
  parseTaskId,
  type ExecutionRequest,
} from "@tegojs/contracts";
import { eventually, FakeClock } from "@tegojs/testkit";
import {
  ComponentSandboxSession,
  type ComponentSessionTransport,
} from "../src/host/component-session.js";

const clock = new FakeClock(new Date(0));
const target: ExecutionRequest["target"] = {
  instanceId: parseComponentInstanceId("app.org.example.session.echo.g1"),
  deploymentGeneration: parseGeneration("1"),
  artifactDigest: parseArtifactDigest(`sha256:${"d".repeat(64)}`),
  executor: { id: "thread-local", type: "thread" },
};
const identity = {
  applicationId: parseApplicationId("app"),
  pluginId: parsePluginId("org.example.session"),
  componentId: parseComponentId("echo"),
};

function request(suffix: string): ExecutionRequest {
  return {
    taskId: parseTaskId(`session-task-${suffix}`),
    attemptId: parseAttemptId(`session-attempt-${suffix}`),
    target,
    ...identity,
    input: { value: suffix },
    deadline: new Date(clock.now().getTime() + 60_000).toISOString(),
    orphanPolicy: "cancel",
  };
}

function session(transport: ComponentSessionTransport & { terminate(): Promise<void> }) {
  const options = {
    id: "thread-local",
    type: "thread" as const,
    target,
    identity,
    transport,
    clock,
    maxConcurrency: 1,
    maxQueue: 256,
    shutdownGraceMs: 100,
  };
  return new ComponentSandboxSession(options);
}

function hangingTransport() {
  const run = Promise.withResolvers<never>();
  let terminateCalls = 0;
  const transport = {
    executor: { kind: "thread" as const, metadata: { executorId: "thread-local" } },
    run: () => run.promise,
    async cancel() {},
    async health() {
      return { status: "healthy" as const };
    },
    async close() {},
    async terminate() {
      terminateCalls += 1;
      run.reject(new Error("transport terminated"));
    },
  };
  return { transport, terminateCalls: () => terminateCalls };
}

test("component session drain deadline cancels active work and force-terminates its transport", async () => {
  const fixture = hangingTransport();
  const sandbox = session(fixture.transport);
  const handle = await sandbox.submit(request("drain-deadline"));
  let drained = false;
  void sandbox.drain({ deadline: new Date(clock.now().getTime() + 100).toISOString() }).then(() => {
    drained = true;
  });

  clock.advanceBy(100);
  await eventually(() => assert.equal(drained, true), {
    attempts: 10,
    advance: () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
  assert.equal(fixture.terminateCalls(), 1);
  assert.equal((await handle.result).status, "cancelled");
});

test("component session close applies a default shutdown deadline", async () => {
  const fixture = hangingTransport();
  const sandbox = session(fixture.transport);
  const handle = await sandbox.submit(request("close-deadline"));
  let closed = false;
  void sandbox.close().then(() => {
    closed = true;
  });

  clock.advanceBy(100);
  await eventually(() => assert.equal(closed, true), {
    attempts: 10,
    advance: () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
  assert.equal(fixture.terminateCalls(), 1);
  assert.equal((await handle.result).status, "cancelled");
});

test("component session close does not await a non-settling transport termination forever", async () => {
  const run = Promise.withResolvers<never>();
  const transport = {
    executor: { kind: "thread" as const, metadata: { executorId: "thread-local" } },
    run: () => run.promise,
    async cancel() {},
    async health() {
      return { status: "healthy" as const };
    },
    async close() {},
    terminate: () => new Promise<void>(() => {}),
  };
  const sandbox = session(transport);
  await sandbox.submit(request("termination-timeout"));
  let rejection: unknown;
  void sandbox.close().catch((error: unknown) => {
    rejection = error;
  });

  clock.advanceBy(100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  clock.advanceBy(100);
  await eventually(() => assert.notEqual(rejection, undefined), {
    attempts: 10,
    advance: () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
  assert.equal(
    (rejection as { readonly diagnostic?: { readonly code?: unknown } }).diagnostic?.code,
    "EXECUTOR_SESSION_TERMINATION_TIMEOUT",
  );
});

test("component session prunes terminal attempt retention at its hard bound", async () => {
  const transport = {
    executor: { kind: "thread" as const, metadata: { executorId: "thread-local" } },
    async run(execution: ExecutionRequest) {
      return { status: "succeeded" as const, output: execution.input };
    },
    async cancel() {},
    async health() {
      return { status: "healthy" as const };
    },
    async close() {},
    async terminate() {},
  };
  const sandbox = session(transport);
  const first = request("retained-000");
  await (await sandbox.submit(first)).result;
  for (let index = 1; index <= 256; index += 1) {
    await (await sandbox.submit(request(`retained-${String(index).padStart(3, "0")}`))).result;
  }

  assert.equal(await sandbox.observe(first.taskId, first.attemptId), undefined);
  assert.equal((await sandbox.health()).retainedAttempts, 256);
  await sandbox.close();
});

test("component session diagnostics do not expose raw transport error messages", async () => {
  const transport = {
    executor: { kind: "thread" as const, metadata: { executorId: "thread-local" } },
    async run() {
      throw new Error("password=raw-plugin-secret");
    },
    async cancel() {},
    async health() {
      return { status: "healthy" as const };
    },
    async close() {},
    async terminate() {},
  };
  const sandbox = session(transport);
  const result = await (await sandbox.submit(request("redaction"))).result;

  assert.equal(result.status, "failed");
  assert.doesNotMatch(JSON.stringify(result.diagnostic), /raw-plugin-secret/u);
  await sandbox.close();
});
