import assert from "node:assert/strict";
import { connect as connectTcp, type Socket } from "node:net";
import { test } from "node:test";
import { parseWorkerId } from "@tegojs/contracts";
import { eventually, FakeClock } from "@tegojs/testkit";
import {
  connectMain,
  connectWorker,
  createMainEndpoint,
  createWorkerEndpoint,
  listenForWorker,
  listenForMain,
  MemoryRemoteAttemptStore,
  MemoryWorkerEpochAllocator,
  RemoteExecutor,
  WorkerRuntime,
  type WorkerSession,
} from "../src/index.js";
import { executionRequest, memorySessionPair, TestLocalExecutor } from "./remote-test-support.js";

const deadlineMs = 2_000;

async function eventuallyWithIo<T>(assertion: () => Promise<T> | T): Promise<T> {
  return await eventually(assertion, {
    attempts: 100,
    advance: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  });
}

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

async function waitForSessionState(
  session: WorkerSession,
  predicate: (state: WorkerSession["state"]) => boolean,
): Promise<void> {
  if (predicate(session.state)) return;
  const signal = AbortSignal.timeout(deadlineMs);
  await new Promise<void>((resolve, reject) => {
    const remove = session.onStateChange((state) => {
      if (predicate(state)) finish();
    });
    const finish = (error?: unknown): void => {
      remove();
      signal.removeEventListener("abort", aborted);
      if (error === undefined) resolve();
      else reject(error);
    };
    const aborted = (): void => finish(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    if (predicate(session.state)) finish();
  });
}

function abortsDuringListenerRegistration(): AbortSignal {
  let aborted = false;
  const reason = new DOMException("deterministic registration race", "AbortError");
  return {
    get aborted() {
      return aborted;
    },
    reason,
    addEventListener(type: string) {
      if (type === "abort") aborted = true;
    },
    removeEventListener() {},
    dispatchEvent: () => false,
    onabort: null,
    throwIfAborted() {
      if (aborted) throw reason;
    },
  } as AbortSignal;
}

async function openRawConnection(port: number): Promise<{
  readonly closed: Promise<void>;
  readonly socket: Socket;
}> {
  const socket = connectTcp({ host: "127.0.0.1", port });
  const connected = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  socket.once("connect", () => connected.resolve());
  socket.once("error", (error) => connected.reject(error));
  socket.once("close", () => closed.resolve());
  await connected.promise;
  return { closed: closed.promise, socket };
}

test("@spec:worker-protocol/real-process-transport-acceptance/loopback-session", async () => {
  const workerId = parseWorkerId("worker-network-loopback");
  const main = createMainEndpoint({
    credential: "loopback-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const worker = createWorkerEndpoint({
    credential: "loopback-secret",
    workerId,
  });

  const listener = await listenForMain({
    endpoint: main,
    host: "127.0.0.1",
    port: 0,
  });
  const session = await connectWorker({ endpoint: worker, url: listener.url });

  try {
    await session.ready;
    assert.equal(main.current(workerId)?.available, true);
  } finally {
    await Promise.all([session.close(), listener.close(), main.close(), worker.close()]);
  }
});

test("@spec:worker-protocol/real-process-transport-acceptance/main-initiated-loopback", async () => {
  const workerId = parseWorkerId("worker-network-reverse");
  const main = createMainEndpoint({
    credential: "reverse-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const worker = createWorkerEndpoint({
    credential: "reverse-secret",
    workerId,
  });
  const listener = await listenForWorker({
    endpoint: worker,
    host: "127.0.0.1",
    port: 0,
  });
  const session = await connectMain({ endpoint: main, url: listener.url });

  try {
    await session.ready;
    await eventuallyWithIo(() => assert.equal(worker.current?.available, true));
  } finally {
    await Promise.all([session.close(), listener.close(), main.close(), worker.close()]);
  }
});

test("@spec:worker-protocol/real-process-transport-acceptance/reconnect-reconciles-buffered-result-once", async () => {
  const workerId = parseWorkerId("worker-network-recovery");
  const clock = new FakeClock(new Date(0));
  const local = new TestLocalExecutor();
  const remote = new RemoteExecutor({
    id: "network-remote",
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  const main = createMainEndpoint({
    clock,
    credential: "recovery-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const worker = createWorkerEndpoint({
    clock,
    credential: "recovery-secret",
    workerId,
  });
  let mainAttached = Promise.withResolvers<void>();
  const attachMain = async (session: WorkerSession): Promise<void> => {
    const attached = mainAttached;
    try {
      await session.ready;
      await remote.attach(session);
      attached.resolve();
    } catch (error) {
      attached.reject(error);
      throw error;
    }
  };
  let listener = await listenForMain({
    endpoint: main,
    host: "127.0.0.1",
    port: 0,
    onSession: attachMain,
  });
  let workerSession = await connectWorker({ endpoint: worker, url: listener.url });

  try {
    await workerSession.ready;
    await runtime.attach(workerSession);
    await beforeDeadline(mainAttached.promise, "initial Main execution attachment");
    assert.equal((await remote.probe()).available, true);
    const firstEpoch = workerSession.epoch;
    const request = executionRequest(
      { mode: "wait" },
      "real-network-recovery",
      "finish-and-buffer",
    );
    const handle = await remote.submit(request);
    let terminalResults = 0;
    void handle.result.then(() => {
      terminalResults += 1;
    });
    await eventuallyWithIo(() => assert.equal(local.executions, 1));
    const localAttempt = [...local.attempts.values()][0];
    assert.ok(localAttempt);

    const closed = waitForSessionState(workerSession, (state) => state === "closed");
    await listener.close();
    await closed;
    local.complete(localAttempt, "succeeded", "reconciled");
    await eventuallyWithIo(() => assert.equal(runtime.bufferedResultCount, 1));

    mainAttached = Promise.withResolvers<void>();
    listener = await listenForMain({
      endpoint: main,
      host: "127.0.0.1",
      port: 0,
      onSession: attachMain,
    });
    workerSession = await connectWorker({ endpoint: worker, url: listener.url });
    await workerSession.ready;
    await runtime.attach(workerSession);
    await beforeDeadline(mainAttached.promise, "reconnected Main execution attachment");

    assert.ok(BigInt(workerSession.epoch) > BigInt(firstEpoch));
    assert.equal((await handle.result).output, "reconciled");
    await eventuallyWithIo(() => assert.equal(runtime.bufferedResultCount, 0));
    assert.equal(terminalResults, 1);
    assert.equal(local.executions, 1);
  } finally {
    await Promise.all([
      listener.close(),
      remote.close(),
      runtime.close(),
      main.close(),
      worker.close(),
    ]);
  }
});

test("@spec:worker-protocol/real-process-transport-acceptance/connect-abort-registration-race", async () => {
  const workerId = parseWorkerId("worker-connect-abort-race");
  const main = createMainEndpoint({
    credential: "abort-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const worker = createWorkerEndpoint({ credential: "abort-secret", workerId });
  const listener = await listenForMain({ endpoint: main, host: "127.0.0.1", port: 0 });
  let unexpectedSession: WorkerSession | undefined;

  try {
    const outcome = await connectWorker({
      endpoint: worker,
      signal: abortsDuringListenerRegistration(),
      url: listener.url,
    }).then(
      (session) => {
        unexpectedSession = session;
        return "connected" as const;
      },
      () => "aborted" as const,
    );
    assert.equal(outcome, "aborted");
  } finally {
    await Promise.all([unexpectedSession?.close(), listener.close(), main.close(), worker.close()]);
  }
});

test("@spec:worker-protocol/real-process-transport-acceptance/listen-abort-registration-race", async () => {
  const workerId = parseWorkerId("worker-listen-abort-race");
  const main = createMainEndpoint({
    credential: "abort-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const outcome = await listenForMain({
    endpoint: main,
    host: "127.0.0.1",
    port: 0,
    signal: abortsDuringListenerRegistration(),
  }).then(
    (listener) => ({ listener }),
    (error: unknown) => ({ error }),
  );

  try {
    assert.equal("error" in outcome, true);
  } finally {
    if ("listener" in outcome) await outcome.listener.close();
    await main.close();
  }
});

test("@spec:worker-protocol/real-process-transport-acceptance/listener-errors-use-bounded-sink", async () => {
  const firstWorkerId = parseWorkerId("worker-listener-error-first");
  const secondWorkerId = parseWorkerId("worker-listener-error-second");
  const firstMain = createMainEndpoint({
    credential: "first-secret",
    workerId: firstWorkerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const secondMain = createMainEndpoint({
    credential: "second-secret",
    workerId: secondWorkerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const listener = await listenForMain({
    endpoint: firstMain,
    host: "127.0.0.1",
    port: 0,
  });
  const errors: Error[] = [];

  try {
    const outcome = await listenForMain({
      endpoint: secondMain,
      host: "127.0.0.1",
      port: Number(listener.url.port),
      onError: (error: Error) => errors.push(error),
    }).then(
      () => "listening" as const,
      () => "failed" as const,
    );
    assert.equal(outcome, "failed");
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as NodeJS.ErrnoException).code, "EADDRINUSE");
  } finally {
    await Promise.all([listener.close(), firstMain.close(), secondMain.close()]);
  }
});

test("@spec:worker-protocol/real-process-transport-acceptance/session-handler-failure-is-observable", async () => {
  const workerId = parseWorkerId("worker-session-handler-error");
  const main = createMainEndpoint({
    credential: "handler-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const worker = createWorkerEndpoint({
    credential: "handler-secret",
    workerId,
  });
  const errors: Error[] = [];
  const listener = await listenForMain({
    endpoint: main,
    host: "127.0.0.1",
    port: 0,
    onError: (error) => errors.push(error),
    onSession: async () => {
      throw new Error("session-handler-root-cause");
    },
  });
  const session = await connectWorker({ endpoint: worker, url: listener.url });

  try {
    await session.ready;
    await waitForSessionState(session, (state) => state === "closed");
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? "", /session-handler-root-cause/u);
  } finally {
    await Promise.all([session.close(), listener.close(), main.close(), worker.close()]);
  }
});

test("@spec:worker-protocol/real-process-transport-acceptance/pre-upgrade-connections-are-bounded-and-expire", async () => {
  const workerId = parseWorkerId("worker-pre-upgrade-limit");
  const main = createMainEndpoint({
    credential: "pre-upgrade-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const listener = await listenForMain({
    endpoint: main,
    handshakeTimeoutMs: 100,
    host: "127.0.0.1",
    maxConnections: 2,
    port: 0,
  });
  const connections: {
    readonly closed: Promise<void>;
    readonly socket: Socket;
  }[] = [];

  try {
    connections.push(await openRawConnection(Number(listener.url.port)));
    connections.push(await openRawConnection(Number(listener.url.port)));
    connections.push(await openRawConnection(Number(listener.url.port)));

    await beforeDeadline(connections[2]?.closed ?? Promise.resolve(), "excess raw TCP rejection");
    await beforeDeadline(
      Promise.all(connections.slice(0, 2).map((connection) => connection.closed)).then(
        () => undefined,
      ),
      "raw TCP handshake expiration",
    );
    assert.equal(
      connections.every((connection) => connection.socket.destroyed),
      true,
    );
  } finally {
    for (const connection of connections) connection.socket.destroy();
    await Promise.all([listener.close(), main.close()]);
  }
});

test("@spec:worker-protocol/prepared-artifact-admission/rejects-before-ack-and-persistence", async () => {
  for (const reason of ["missing", "ambiguous"] as const) {
    const workerId = parseWorkerId(`worker-artifact-${reason}`);
    const clock = new FakeClock(new Date(0));
    const local = new TestLocalExecutor();
    const workerStore = new MemoryRemoteAttemptStore();
    const remote = new RemoteExecutor({
      id: `remote-artifact-${reason}`,
      workerId,
      clock,
      attemptStore: new MemoryRemoteAttemptStore(),
    });
    const runtime = new WorkerRuntime({
      workerId,
      clock,
      attemptStore: workerStore,
      selectExecutor: () => local,
      validateAssignment: () => ({
        code: "EXECUTOR_REMOTE_ARTIFACT_UNPREPARED",
        message: `Prepared artifact selection is ${reason}`,
      }),
    });
    const [mainSession, workerSession] = memorySessionPair("1");
    await runtime.attach(workerSession);
    await remote.attach(mainSession);
    const request = executionRequest({ mode: "echo", value: reason }, `artifact-${reason}`);

    try {
      const result = await (await remote.submit(request)).result;
      assert.equal(result.status, "rejected");
      assert.equal(result.diagnostic?.code, "EXECUTOR_REMOTE_ARTIFACT_UNPREPARED");
      assert.deepEqual(await workerStore.list(workerId), []);
      assert.equal(local.executions, 0);
    } finally {
      await Promise.all([remote.close(), runtime.close()]);
    }
  }
});
