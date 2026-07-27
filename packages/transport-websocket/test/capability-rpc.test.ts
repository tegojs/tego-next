import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  type ComponentCapabilityInvocation,
  type JsonValue,
  parseWorkerId,
} from "@tegojs/contracts";
import { FakeClock } from "@tegojs/testkit";
import {
  MemoryRemoteAttemptStore,
  RemoteExecutor,
  type RemoteCapabilityInvocation,
  WorkerRuntime,
} from "../src/index.js";
import {
  executionRequest,
  memorySessionPair,
  TestLocalExecutor,
} from "./remote-test-support.js";

const clock = new FakeClock(new Date(0));
const workerId = parseWorkerId("worker-capability");
const cleanups: Array<() => Promise<void>> = [];

const invocation: ComponentCapabilityInvocation = {
  identity: {
    name: "org.example.echo",
    protocolVersion: "1.0",
  },
  method: "echo",
  input: { value: "hello" },
};

function request(
  invocationId: string,
  input: JsonValue = invocation.input,
): RemoteCapabilityInvocation {
  const target = executionRequest(null, "capability-target").target;
  return {
    invocationId,
    target: {
      ...target,
      executor: {
        id: "remote",
        type: "remote",
        workerId,
      },
    },
    invocation: {
      ...invocation,
      input,
    },
  };
}

async function connected(
  invokeCapability: (
    request: RemoteCapabilityInvocation,
  ) => JsonValue | Promise<JsonValue>,
  options: { readonly maxCapabilityInvocations?: number } = {},
): Promise<{
  readonly remote: RemoteExecutor;
  readonly runtime: WorkerRuntime;
  readonly mainSession: ReturnType<typeof memorySessionPair>[0];
}> {
  const [mainSession, workerSession] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    invokeCapability,
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    ...options,
  });
  await remote.attach(mainSession);
  cleanups.push(async () => {
    await Promise.all([remote.close(), runtime.close()]);
  });
  return { remote, runtime, mainSession };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

test("capability invocation reaches the exact remote activation and duplicate callers attach", async () => {
  const observed: RemoteCapabilityInvocation[] = [];
  const release = Promise.withResolvers<void>();
  const { remote } = await connected(async (received) => {
    observed.push(received);
    await release.promise;
    return { echoed: received.invocation.input };
  });
  const expected = request("invocation-1");

  const first = remote.invokeCapability(expected);
  const duplicate = remote.invokeCapability({
    ...expected,
    target: { ...expected.target },
    invocation: {
      ...expected.invocation,
      identity: { ...expected.invocation.identity },
    },
  });
  release.resolve();

  assert.deepEqual(await first, { echoed: { value: "hello" } });
  assert.deepEqual(await duplicate, { echoed: { value: "hello" } });
  assert.deepEqual(observed, [expected]);
});

test("same invocation id with a different canonical payload is a protocol conflict", async () => {
  let calls = 0;
  const { remote } = await connected((received) => {
    calls += 1;
    return received.invocation.input;
  });

  assert.deepEqual(await remote.invokeCapability(request("invocation-conflict")), {
    value: "hello",
  });
  await assert.rejects(
    remote.invokeCapability(request("invocation-conflict", { value: "changed" })),
    (error: unknown) => {
      assert.equal(
        (error as { diagnostic?: { code?: unknown } }).diagnostic?.code,
        "PROTOCOL_CAPABILITY_INVOCATION_CONFLICT",
      );
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("capability invocation rejects a target outside the authenticated remote worker", async () => {
  let calls = 0;
  const { remote } = await connected(() => {
    calls += 1;
    return null;
  });
  const expected = request("invocation-target");

  await assert.rejects(
    remote.invokeCapability({
      ...expected,
      target: {
        ...expected.target,
        executor: {
          ...expected.target.executor,
          workerId: parseWorkerId("worker-other"),
        },
      },
    }),
    (error: unknown) => {
      assert.equal(
        (error as { diagnostic?: { code?: unknown } }).diagnostic?.code,
        "PROTOCOL_CAPABILITY_TARGET_INVALID",
      );
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("disconnect before the authoritative response is indeterminate and never retried", async () => {
  let calls = 0;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { remote, mainSession } = await connected(async () => {
    calls += 1;
    started.resolve();
    await release.promise;
    return "too-late";
  });
  const expected = request("invocation-disconnect");
  const pending = remote.invokeCapability(expected);
  await started.promise;
  mainSession.close();

  await assert.rejects(pending, (error: unknown) => {
    const diagnostic = (error as {
      diagnostic?: { code?: unknown; retryable?: unknown; details?: unknown };
    }).diagnostic;
    assert.equal(diagnostic?.code, "CAPABILITY_INVOCATION_INDETERMINATE");
    assert.equal(diagnostic?.retryable, false);
    assert.deepEqual(diagnostic?.details, {
      invocationId: expected.invocationId,
      fingerprint:
        "287a988529542112148b958085323a459d2a6fd8c50aa57834965b92b0caec24",
    });
    return true;
  });
  await assert.rejects(remote.invokeCapability(expected), {
    message: /indeterminate/iu,
  });
  assert.equal(calls, 1);
  release.resolve();
});

test("capability invocation admission is bounded", async () => {
  const { remote } = await connected((received) => received.invocation.input, {
    maxCapabilityInvocations: 1,
  });
  const bounded = remote as RemoteExecutor;

  assert.deepEqual(await bounded.invokeCapability(request("bounded-1")), {
    value: "hello",
  });
  await assert.rejects(
    bounded.invokeCapability(request("bounded-2")),
    /capacity|bounded|exhausted/iu,
  );
});
