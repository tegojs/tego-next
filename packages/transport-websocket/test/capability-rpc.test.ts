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
  type RemoteCapabilityInvocation,
  RemoteExecutor,
  WorkerRuntime,
} from "../src/index.js";
import { executionRequest, memorySessionPair, TestLocalExecutor } from "./remote-test-support.js";

const clock = new FakeClock(new Date(0));
const workerId = parseWorkerId("worker-capability");
const cleanups: Array<() => Promise<void>> = [];

async function waitForReleases(
  releases: readonly PromiseWithResolvers<void>[],
  count: number,
): Promise<void> {
  for (let turn = 0; turn < 100 && releases.length < count; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(releases.length, count);
}

const invocation: ComponentCapabilityInvocation = {
  invocationId: "placeholder",
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
  const seed = executionRequest(null, "capability-target", "cancel", workerId);
  const target = seed.target;
  return {
    invocationId,
    bindingFingerprint: seed.binding.fingerprint,
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
      invocationId,
      input,
    },
  };
}

function activationFor(request: RemoteCapabilityInvocation) {
  const seed = executionRequest(null, "capability-target", "cancel", workerId);
  return {
    identity: {
      applicationId: seed.applicationId,
      pluginId: seed.pluginId,
      componentId: seed.componentId,
    },
    target: request.target,
    configuration: seed.binding.configuration,
    permissionGrants: seed.binding.permissionGrants,
    capabilityDefinitions: seed.binding.capabilityDefinitions,
    capabilityBindings: seed.binding.capabilityBindings,
    bindingFingerprint: request.bindingFingerprint,
  };
}

async function connected(
  invokeCapability: (request: RemoteCapabilityInvocation) => JsonValue | Promise<JsonValue>,
  options: {
    readonly maxCapabilityInvocations?: number;
    readonly maxIndeterminateCapabilityInvocations?: number;
  } = {},
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
    ...options,
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
          id: "remote",
          type: "remote",
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
  const { remote, runtime, mainSession } = await connected(
    async (received) => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      return received.invocation.input;
    },
    { maxCapabilityInvocations: 1 },
  );
  const expected = request("invocation-disconnect");
  await remote.activateComponent(activationFor(expected));
  const pending = remote.invokeCapability(expected);
  await started.promise;
  mainSession.close();

  await assert.rejects(pending, (error: unknown) => {
    const diagnostic = (
      error as {
        diagnostic?: { code?: unknown; retryable?: unknown; details?: unknown };
      }
    ).diagnostic;
    assert.equal(diagnostic?.code, "CAPABILITY_INVOCATION_INDETERMINATE");
    assert.equal(diagnostic?.retryable, false);
    assert.deepEqual(diagnostic?.details, {
      invocationId: expected.invocationId,
      fingerprint: "faca55c698a0b5172aaafdaccc8c4062270debbea0aee3fe7cc7d403d4b160cf",
    });
    return true;
  });
  await assert.rejects(remote.invokeCapability(expected), {
    message: /indeterminate/iu,
  });
  assert.equal(calls, 1);

  release.resolve();
  const [mainReplacement, workerReplacement] = memorySessionPair("2");
  await runtime.attach(workerReplacement);
  await remote.attach(mainReplacement);
  assert.deepEqual(await remote.invokeCapability(request("invocation-after-disconnect")), {
    value: "hello",
  });
  await assert.rejects(remote.invokeCapability(expected), /indeterminate/iu);
  assert.equal(calls, 2);

  await remote.stopComponent(expected.target);
  await remote.activateComponent(activationFor(expected));
  assert.deepEqual(await remote.invokeCapability(expected), { value: "hello" });
  assert.equal(calls, 3);
});

test("authoritative remote capability failure releases active admission capacity", async () => {
  let calls = 0;
  const { remote } = await connected(
    (received) => {
      calls += 1;
      if (calls === 1) throw new Error("authoritative provider failure");
      return received.invocation.input;
    },
    { maxCapabilityInvocations: 1 },
  );

  await assert.rejects(remote.invokeCapability(request("authoritative-failure-1")));
  assert.deepEqual(await remote.invokeCapability(request("authoritative-failure-2")), {
    value: "hello",
  });
  assert.equal(calls, 2);
});

test("remote indeterminate tombstones are bounded until exact component stop", async () => {
  let calls = 0;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { remote, runtime, mainSession } = await connected(
    async (received) => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      return received.invocation.input;
    },
    { maxIndeterminateCapabilityInvocations: 1 },
  );
  const first = request("bounded-tombstone-1");
  await remote.activateComponent(activationFor(first));
  const pending = remote.invokeCapability(first);
  await started.promise;
  mainSession.close();
  await assert.rejects(pending, /indeterminate/iu);
  release.resolve();

  const [mainReplacement, workerReplacement] = memorySessionPair("2");
  await runtime.attach(workerReplacement);
  await remote.attach(mainReplacement);
  await assert.rejects(
    remote.invokeCapability(request("bounded-tombstone-2")),
    /tombstone|capacity|exhausted/iu,
  );
  assert.equal(calls, 1);

  await remote.stopComponent(first.target);
  const second = request("bounded-tombstone-2");
  await remote.activateComponent(activationFor(second));
  assert.deepEqual(await remote.invokeCapability(second), { value: "hello" });
  assert.equal(calls, 2);
});

test("authoritative Main capability failure releases Worker admission capacity", async () => {
  let calls = 0;
  const [mainSession, workerSession] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    validateActivation: () => undefined,
    maxCapabilityInvocations: 1,
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    maxCapabilityInvocations: 1,
    routeCapability: (received) => {
      calls += 1;
      if (calls === 1) throw new Error("authoritative Main failure");
      return received.invocation.input;
    },
  });
  await remote.attach(mainSession);
  cleanups.push(async () => {
    await Promise.all([remote.close(), runtime.close()]);
  });
  const first = request("main-authoritative-failure-1");
  await remote.activateComponent(activationFor(first));

  await assert.rejects(runtime.invokeMainCapability(first));
  assert.deepEqual(await runtime.invokeMainCapability(request("main-authoritative-failure-2")), {
    value: "hello",
  });
  assert.equal(calls, 2);
});

test("capability invocation admission is bounded", async () => {
  const releases: Array<PromiseWithResolvers<void>> = [];
  const { remote } = await connected(
    async (received) => {
      const release = Promise.withResolvers<void>();
      releases.push(release);
      await release.promise;
      return received.invocation.input;
    },
    {
      maxCapabilityInvocations: 1,
    },
  );
  const first = remote.invokeCapability(request("bounded-1"));
  await Promise.resolve();
  await assert.rejects(
    remote.invokeCapability(request("bounded-2")),
    /capacity|bounded|exhausted/iu,
  );
  releases[0]?.resolve();
  assert.deepEqual(await first, { value: "hello" });
  const afterSettlement = remote.invokeCapability(request("bounded-3"));
  await waitForReleases(releases, 2);
  releases[1]?.resolve();
  assert.deepEqual(await afterSettlement, { value: "hello" });
});

test("remote consumer capability admission reuses settled capacity", async () => {
  const releases: Array<PromiseWithResolvers<void>> = [];
  const [mainSession, workerSession] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    validateActivation: () => undefined,
    maxCapabilityInvocations: 1,
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    maxCapabilityInvocations: 1,
    routeCapability: async (received) => {
      const release = Promise.withResolvers<void>();
      releases.push(release);
      await release.promise;
      return received.invocation.input;
    },
  });
  await remote.attach(mainSession);
  cleanups.push(async () => {
    for (const release of releases) release.resolve();
    await Promise.all([remote.close(), runtime.close()]);
  });
  const firstRequest = request("consumer-bounded-1");
  await remote.activateComponent(activationFor(firstRequest));

  const first = runtime.invokeMainCapability(firstRequest);
  await Promise.resolve();
  await assert.rejects(
    runtime.invokeMainCapability(request("consumer-bounded-2")),
    /capacity|bounded|exhausted/iu,
  );
  releases[0]?.resolve();
  assert.deepEqual(await first, { value: "hello" });
  const afterSettlement = runtime.invokeMainCapability(request("consumer-bounded-3"));
  await waitForReleases(releases, 2);
  releases[1]?.resolve();
  assert.deepEqual(await afterSettlement, { value: "hello" });
});

test("remote consumer invokes Main through its authenticated exact activation", async () => {
  const routed: RemoteCapabilityInvocation[] = [];
  const [mainSession, workerSession] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    validateActivation: () => undefined,
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    routeCapability: (received) => {
      routed.push(received);
      return { fromMain: received.invocation.input };
    },
  });
  await remote.attach(mainSession);
  cleanups.push(async () => {
    await Promise.all([remote.close(), runtime.close()]);
  });
  const expected = request("remote-consumer-main");
  await remote.activateComponent(activationFor(expected));

  assert.deepEqual(await runtime.invokeMainCapability(expected), {
    fromMain: { value: "hello" },
  });
  assert.deepEqual(routed, [expected]);
});

test("Worker indeterminate tombstones are bounded until exact component stop", async () => {
  let calls = 0;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const [mainSession, workerSession] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    validateActivation: () => undefined,
    maxIndeterminateCapabilityInvocations: 1,
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    maxIndeterminateCapabilityInvocations: 1,
    routeCapability: async (received) => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      return received.invocation.input;
    },
  });
  await remote.attach(mainSession);
  cleanups.push(async () => {
    release.resolve();
    await Promise.all([remote.close(), runtime.close()]);
  });
  const first = request("consumer-bounded-tombstone-1");
  await remote.activateComponent(activationFor(first));
  const pending = runtime.invokeMainCapability(first);
  await started.promise;
  workerSession.close();
  await assert.rejects(pending, /indeterminate/iu);
  release.resolve();

  const [mainReplacement, workerReplacement] = memorySessionPair("2");
  await runtime.attach(workerReplacement);
  await remote.attach(mainReplacement);
  await assert.rejects(
    runtime.invokeMainCapability(request("consumer-bounded-tombstone-2")),
    /tombstone|capacity|exhausted/iu,
  );
  assert.equal(calls, 1);

  await remote.stopComponent(first.target);
  const second = request("consumer-bounded-tombstone-2");
  await remote.activateComponent(activationFor(second));
  assert.deepEqual(await runtime.invokeMainCapability(second), { value: "hello" });
  assert.equal(calls, 2);
});

test("remote consumer to Main disconnect is indeterminate and is not auto-retried", async () => {
  let calls = 0;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const [mainSession, workerSession] = memorySessionPair("1");
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => new TestLocalExecutor(),
    validateActivation: () => undefined,
    maxCapabilityInvocations: 1,
  });
  await runtime.attach(workerSession);
  const remote = new RemoteExecutor({
    id: "remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    routeCapability: async () => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      return null;
    },
    maxCapabilityInvocations: 1,
  });
  await remote.attach(mainSession);
  cleanups.push(async () => {
    release.resolve();
    await Promise.all([remote.close(), runtime.close()]);
  });
  const expected = request("remote-consumer-disconnect");
  await remote.activateComponent(activationFor(expected));
  const pending = runtime.invokeMainCapability(expected);
  await started.promise;
  workerSession.close();

  await assert.rejects(pending, (error: unknown) => {
    const diagnostic = (error as { diagnostic?: { code?: unknown; retryable?: unknown } })
      .diagnostic;
    assert.equal(diagnostic?.code, "CAPABILITY_INVOCATION_INDETERMINATE");
    assert.equal(diagnostic?.retryable, false);
    return true;
  });
  await assert.rejects(runtime.invokeMainCapability(expected), /indeterminate/iu);
  assert.equal(calls, 1);

  release.resolve();
  const [mainReplacement, workerReplacement] = memorySessionPair("2");
  await runtime.attach(workerReplacement);
  await remote.attach(mainReplacement);
  assert.equal(await runtime.invokeMainCapability(request("consumer-after-disconnect")), null);
  await assert.rejects(runtime.invokeMainCapability(expected), /indeterminate/iu);
  assert.equal(calls, 2);

  await remote.stopComponent(expected.target);
  await remote.activateComponent(activationFor(expected));
  assert.equal(await runtime.invokeMainCapability(expected), null);
  assert.equal(calls, 3);
});
