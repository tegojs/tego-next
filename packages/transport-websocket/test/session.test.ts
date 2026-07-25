import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseMessageId,
  parseSequence,
  parseSessionId,
  type JsonValue,
  type WorkerId,
  type WorkerMessageType,
  type WorkerProtocolVersion,
} from "@tegojs/contracts";
import { eventually, FakeClock, workerSessionConformance } from "@tegojs/testkit";
import {
  createMainEndpoint,
  createWorkerCodec,
  createWorkerEndpoint,
  MemoryRemoteAttemptStore,
  MemoryWorkerEpochAllocator,
  RemoteExecutor,
  systemWorkerClock,
  WorkerRuntime,
  type MainEndpoint,
  type WorkerEpochAllocator,
  type WorkerControlEnvelope,
  type WorkerEndpoint,
  type WorkerSession,
} from "../src/index.js";
import { executionRequest, flush, TestLocalExecutor } from "./remote-test-support.js";

workerSessionConformance(
  (options) =>
    createMainEndpoint({
      ...options,
      epochAllocator: new MemoryWorkerEpochAllocator(),
    }),
  createWorkerEndpoint,
);

const ENVELOPE: WorkerControlEnvelope = {
  protocol: "1.0",
  messageId: parseMessageId("message-1"),
  sessionId: parseSessionId("session-1"),
  sequence: parseSequence("0"),
  type: "heartbeat",
  sentAt: new Date(0).toISOString(),
  payload: {},
};

test("codec rejects oversized control frames before JSON parsing", () => {
  const codec = createWorkerCodec({ maxFrameBytes: 64 });
  assert.throws(
    () => codec.decodeControl(`{"${"x".repeat(128)}":`),
    (error: unknown) =>
      error instanceof Error &&
      "diagnostic" in error &&
      (error as { diagnostic: { code: string } }).diagnostic.code === "PROTOCOL_FRAME_TOO_LARGE",
  );
});

test("the public protocol registry rejects locally configured unsupported versions", () => {
  assert.throws(
    () => createWorkerCodec({}, "2.0" as WorkerProtocolVersion),
    /protocol|version|supported/iu,
  );
  const clock = new FakeClock();
  assert.throws(
    () =>
      createMainEndpoint({
        clock,
        credential: "shared-secret",
        workerId: "unsupported-local" as WorkerId,
        epochAllocator: new MemoryWorkerEpochAllocator(),
        protocol: "2.0" as WorkerProtocolVersion,
      }),
    /protocol|version|supported/iu,
  );
});

test("an injected epoch allocator preserves the Worker high-water mark across Main restart", async () => {
  const workerId = "epoch-restart-worker" as WorkerId;
  const durableEpochs = new Map<WorkerId, bigint>([[workerId, 7n]]);
  const allocator = (): WorkerEpochAllocator => ({
    next: async (id) => {
      const next = (durableEpochs.get(id) ?? 0n) + 1n;
      durableEpochs.set(id, next);
      return next.toString();
    },
  });
  const firstMain = createMainEndpoint({
    credential: "shared-secret",
    workerId,
    epochAllocator: allocator(),
  });
  const firstWorker = createWorkerEndpoint({
    credential: "shared-secret",
    workerId,
  });
  const [firstMainSocket, firstWorkerSocket] = directSocketPair();
  const firstMainSession = firstMain.attach(firstMainSocket);
  const firstWorkerSession = firstWorker.attach(firstWorkerSocket);

  await Promise.all([firstMainSession.ready, firstWorkerSession.ready]);
  assert.equal(firstMainSession.epoch, "8");
  await Promise.all([firstMain.close(), firstWorker.close()]);

  const secondMain = createMainEndpoint({
    credential: "shared-secret",
    workerId,
    epochAllocator: allocator(),
  });
  const secondWorker = createWorkerEndpoint({
    credential: "shared-secret",
    workerId,
  });
  const [secondMainSocket, secondWorkerSocket] = directSocketPair();
  const secondMainSession = secondMain.attach(secondMainSocket);
  const secondWorkerSession = secondWorker.attach(secondWorkerSocket);
  await Promise.all([secondMainSession.ready, secondWorkerSession.ready]);
  assert.equal(secondMainSession.epoch, "9");
  assert.equal(secondWorkerSession.epoch, "9");
  await Promise.all([secondMain.close(), secondWorker.close()]);
});

test("a closed replacement cannot claim authority after delayed epoch allocation", async () => {
  const workerId = "delayed-replacement-worker" as WorkerId;
  let allocationCount = 0;
  let resolveReplacementEpoch: ((epoch: string) => void) | undefined;
  let replacementAllocationStarted: (() => void) | undefined;
  const replacementAllocation = new Promise<void>((resolve) => {
    replacementAllocationStarted = resolve;
  });
  const epochAllocator: WorkerEpochAllocator = {
    next: async () => {
      allocationCount += 1;
      if (allocationCount === 1) return "1";
      replacementAllocationStarted?.();
      return new Promise<string>((resolve) => {
        resolveReplacementEpoch = resolve;
      });
    },
  };
  const main = createMainEndpoint({
    credential: "shared-secret",
    workerId,
    epochAllocator,
  });
  const firstWorker = createWorkerEndpoint({ credential: "shared-secret", workerId });
  const [firstMainSocket, firstWorkerSocket] = directSocketPair();
  const firstMainSession = main.attach(firstMainSocket);
  const firstWorkerSession = firstWorker.attach(firstWorkerSocket);
  await Promise.all([firstMainSession.ready, firstWorkerSession.ready]);

  const replacementWorker = createWorkerEndpoint({ credential: "shared-secret", workerId });
  const [replacementMainSocket, replacementWorkerSocket] = directSocketPair();
  const replacementMainSession = main.attach(replacementMainSocket);
  const replacementWorkerSession = replacementWorker.attach(replacementWorkerSocket);
  await replacementAllocation;
  await replacementWorker.close();
  resolveReplacementEpoch?.("2");
  await assert.rejects(Promise.all([replacementMainSession.ready, replacementWorkerSession.ready]));
  await flush();

  assert.equal(main.current(workerId), firstMainSession);
  assert.equal(firstMainSession.state, "ready");
  assert.equal(firstWorkerSession.state, "ready");
  assert.equal(main.activeSessionCount, 1);
  await Promise.all([main.close(), firstWorker.close()]);
});

test("a timed-out epoch allocation cannot starve a later Worker registration", async () => {
  const clock = new FakeClock();
  const workerId = "stalled-allocation-worker" as WorkerId;
  let allocationCount = 0;
  let resolveFirstAllocation: ((epoch: string) => void) | undefined;
  let firstAllocationStarted: (() => void) | undefined;
  const allocationStarted = new Promise<void>((resolve) => {
    firstAllocationStarted = resolve;
  });
  const epochAllocator: WorkerEpochAllocator = {
    next: async () => {
      allocationCount += 1;
      if (allocationCount === 1) {
        firstAllocationStarted?.();
        return new Promise<string>((resolve) => {
          resolveFirstAllocation = resolve;
        });
      }
      return allocationCount.toString();
    },
  };
  const main = createMainEndpoint({
    clock,
    credential: "shared-secret",
    workerId,
    epochAllocator,
    handshakeTimeoutMs: 20,
  });
  const firstWorker = createWorkerEndpoint({
    clock,
    credential: "shared-secret",
    workerId,
    handshakeTimeoutMs: 20,
  });
  const [firstMainSocket, firstWorkerSocket] = directSocketPair();
  const firstMainSession = main.attach(firstMainSocket);
  const firstWorkerSession = firstWorker.attach(firstWorkerSocket);
  await allocationStarted;
  clock.advanceBy(21);
  await assert.rejects(Promise.all([firstMainSession.ready, firstWorkerSession.ready]));

  const secondWorker = createWorkerEndpoint({
    clock,
    credential: "shared-secret",
    workerId,
    handshakeTimeoutMs: 20,
  });
  const [secondMainSocket, secondWorkerSocket] = directSocketPair();
  const secondMainSession = main.attach(secondMainSocket);
  const secondWorkerSession = secondWorker.attach(secondWorkerSocket);

  await eventually(() => assert.equal(allocationCount, 2));
  await Promise.all([secondMainSession.ready, secondWorkerSession.ready]);
  assert.equal(main.current(workerId), secondMainSession);

  resolveFirstAllocation?.("3");
  await flush();
  const thirdWorker = createWorkerEndpoint({
    clock,
    credential: "shared-secret",
    workerId,
    handshakeTimeoutMs: 20,
  });
  const [thirdMainSocket, thirdWorkerSocket] = directSocketPair();
  const thirdMainSession = main.attach(thirdMainSocket);
  const thirdWorkerSession = thirdWorker.attach(thirdWorkerSocket);
  await assert.rejects(Promise.all([thirdMainSession.ready, thirdWorkerSession.ready]), /epoch/iu);
  assert.equal(main.current(workerId), secondMainSession);
  await Promise.all([main.close(), firstWorker.close(), secondWorker.close(), thirdWorker.close()]);
});

test("codec accepts only exact JSON data fields and decimal sequence values", () => {
  const codec = createWorkerCodec();
  assert.deepEqual(codec.decodeControl(codec.encodeControl(ENVELOPE)), ENVELOPE);
  assert.throws(() =>
    codec.decodeControl(
      JSON.stringify({
        ...ENVELOPE,
        sequence: 1,
      }),
    ),
  );
  assert.throws(() =>
    codec.decodeControl(
      JSON.stringify({
        ...ENVELOPE,
        unexpected: true,
      }),
    ),
  );
});

test("binary codec rejects partial, oversized, and inconsistent frames", () => {
  const codec = createWorkerCodec({ maxFrameBytes: 128, maxBinaryBytes: 64 });
  const frame = codec.encodeBinary({
    correlationId: "message-1",
    chunkIndex: 0,
    totalChunks: 1,
    payload: Uint8Array.of(1, 2, 3),
  });
  assert.deepEqual(codec.decodeBinary(frame), {
    correlationId: "message-1",
    chunkIndex: 0,
    totalChunks: 1,
    payload: Uint8Array.of(1, 2, 3),
  });
  assert.throws(() => codec.decodeBinary(frame.subarray(0, frame.length - 1)));
  assert.throws(() => codec.decodeBinary(new Uint8Array(129)));
});

type SocketEvent = "close" | "error" | "message";
type SocketListener = (...arguments_: unknown[]) => void;

class DirectSocket {
  readyState = 1;
  peer?: DirectSocket;
  automaticDelivery = true;
  synchronousDelivery = false;
  wsRawDelivery = false;
  holdControlType?: string;
  readonly sent: (string | Uint8Array)[] = [];
  readonly held: (string | Uint8Array)[] = [];
  readonly closeReasons: string[] = [];
  readonly #listeners = new Map<SocketEvent, Set<SocketListener>>([
    ["close", new Set()],
    ["error", new Set()],
    ["message", new Set()],
  ]);

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1 || this.peer?.readyState !== 1) {
      throw new Error("socket is closed");
    }
    const copy = typeof data === "string" ? data : Uint8Array.from(data);
    this.sent.push(copy);
    if (
      typeof copy === "string" &&
      this.holdControlType !== undefined &&
      (JSON.parse(copy) as { type?: unknown }).type === this.holdControlType
    ) {
      this.held.push(copy);
      return;
    }
    if (this.automaticDelivery) {
      const peer = this.peer;
      const deliver = () => {
        if (this.wsRawDelivery) {
          peer.#emit(
            "message",
            typeof copy === "string" ? Buffer.from(copy) : Buffer.from(copy),
            typeof copy !== "string",
          );
        } else {
          peer.#emit("message", { data: copy });
        }
      };
      if (this.synchronousDelivery) {
        deliver();
      } else {
        queueMicrotask(deliver);
      }
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.closeReasons.push(reason);
    const peer = this.peer;
    if (peer !== undefined) {
      peer.readyState = 3;
      peer.closeReasons.push(reason);
    }
    this.#emit("close", { code, reason });
    if (peer !== undefined) {
      peer.#emit("close", { code, reason });
    }
  }

  on(event: SocketEvent, listener: SocketListener): this {
    this.#listeners.get(event)?.add(listener);
    return this;
  }

  off(event: SocketEvent, listener: SocketListener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  deliver(index: number): void {
    const frame = this.sent[index];
    if (frame === undefined) {
      throw new RangeError(`missing frame ${index}`);
    }
    const peer = this.peer;
    if (peer !== undefined) {
      peer.#emit("message", { data: frame });
    }
  }

  inject(data: string | Uint8Array): void {
    this.#emit("message", { data });
  }

  clearSent(): void {
    this.sent.length = 0;
  }

  releaseHeld(): void {
    const peer = this.peer;
    if (peer === undefined) {
      throw new Error("socket has no peer");
    }
    for (const frame of this.held.splice(0)) {
      peer.#emit("message", { data: frame });
    }
  }

  listenerCount(): number {
    return [...this.#listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }

  #emit(event: SocketEvent, ...arguments_: unknown[]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      listener(...arguments_);
    }
  }
}

function directSocketPair(): readonly [DirectSocket, DirectSocket] {
  const mainSocket = new DirectSocket();
  const workerSocket = new DirectSocket();
  mainSocket.peer = workerSocket;
  workerSocket.peer = mainSocket;
  return [mainSocket, workerSocket];
}

interface DirectConnection {
  readonly clock: FakeClock;
  readonly main: MainEndpoint;
  readonly worker: WorkerEndpoint;
  readonly mainSession: WorkerSession;
  readonly workerSession: WorkerSession;
  readonly mainSocket: DirectSocket;
  readonly workerSocket: DirectSocket;
}

async function directConnection(options?: {
  readonly maxBinaryBytes?: number;
  readonly maxFrameBytes?: number;
  readonly maxPendingCorrelations?: number;
  readonly maxInflightMessages?: number;
  readonly requestTimeoutMs?: number;
  readonly epochAllocator?: WorkerEpochAllocator;
}): Promise<DirectConnection> {
  const clock = new FakeClock();
  const limits = {
    ...(options?.maxBinaryBytes === undefined ? {} : { maxBinaryBytes: options.maxBinaryBytes }),
    ...(options?.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    ...(options?.maxPendingCorrelations === undefined
      ? {}
      : { maxPendingCorrelations: options.maxPendingCorrelations }),
    ...(options?.maxInflightMessages === undefined
      ? {}
      : { maxInflightMessages: options.maxInflightMessages }),
  };
  const main = createMainEndpoint({
    clock,
    credential: "shared-secret",
    workerId: "direct-worker" as WorkerId,
    limits,
    epochAllocator: options?.epochAllocator ?? new MemoryWorkerEpochAllocator(),
    ...(options?.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const worker = createWorkerEndpoint({
    clock,
    credential: "shared-secret",
    limits,
    ...(options?.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    workerId: "direct-worker" as WorkerId,
    registration: {
      labels: {},
      resources: {},
      executors: ["process"],
      preparedArtifacts: [],
    },
  });
  const [mainSocket, workerSocket] = directSocketPair();
  const mainSession = main.attach(mainSocket);
  const workerSession = worker.attach(workerSocket);
  await Promise.all([mainSession.ready, workerSession.ready]);
  mainSocket.synchronousDelivery = true;
  workerSocket.synchronousDelivery = true;
  mainSocket.clearSent();
  workerSocket.clearSent();
  return {
    clock,
    main,
    worker,
    mainSession,
    workerSession,
    mainSocket,
    workerSocket,
  };
}

async function cleanup(connection: DirectConnection): Promise<void> {
  await Promise.all([connection.main.close(), connection.worker.close()]);
  assert.equal(connection.mainSocket.listenerCount(), 0);
  assert.equal(connection.workerSocket.listenerCount(), 0);
}

test("RemoteExecutor and WorkerRuntime survive timeout and reconnect over authenticated sessions", async () => {
  const workerId = "direct-worker" as WorkerId;
  const epochs = new MemoryWorkerEpochAllocator();
  const first = await directConnection({
    epochAllocator: epochs,
    maxFrameBytes: 64 * 1024,
    requestTimeoutMs: 100,
  });
  const local = new TestLocalExecutor();
  const remote = new RemoteExecutor({
    id: "remote-authenticated",
    workerId,
    clock: first.clock,
    attemptStore: new MemoryRemoteAttemptStore(),
  });
  const runtime = new WorkerRuntime({
    workerId,
    clock: first.clock,
    attemptStore: new MemoryRemoteAttemptStore(),
    selectExecutor: () => local,
  });
  let second: DirectConnection | undefined;
  try {
    await runtime.attach(first.workerSession);
    await remote.attach(first.mainSession);
    const echoed = await (
      await remote.submit(executionRequest({ mode: "echo", value: "secure" }, "real-session-echo"))
    ).result;
    assert.equal(echoed.output, "secure");

    first.mainSocket.holdControlType = "task.assign";
    const request = executionRequest({ mode: "wait" }, "real-session-timeout-reconnect");
    const handle = await remote.submit(request);
    await eventually(() => assert.equal(first.mainSocket.held.length, 1));
    first.clock.advanceBy(101);
    await flush();
    first.mainSocket.close();

    second = await directConnection({
      epochAllocator: epochs,
      maxFrameBytes: 64 * 1024,
      requestTimeoutMs: 100,
    });
    await runtime.attach(second.workerSession);
    await remote.attach(second.mainSession);
    await eventually(() => assert.equal(local.executions, 2));
    await remote.cancel(request.taskId, request.attemptId);
    assert.equal((await handle.result).status, "cancelled");
    assert.equal(local.executions, 2);

    await assert.rejects(
      remote.submit(
        executionRequest({ mode: "echo", value: "x".repeat(70 * 1024) }, "real-session-oversized"),
      ),
      /assignment|maxAssignmentBytes/iu,
    );
    assert.equal(second.mainSession.state, "ready");
    assert.equal(second.workerSession.state, "ready");
  } finally {
    await Promise.all([remote.close(), runtime.close()]);
    await cleanup(first);
    if (second !== undefined) await cleanup(second);
  }
});

test("request correlation is installed before a synchronous transport can respond", async () => {
  const connection = await directConnection({ maxInflightMessages: 1 });
  try {
    connection.workerSession.onMessage((message) => {
      void connection.workerSession.send(
        "session.reconcile",
        { accepted: true },
        { correlationId: message.messageId },
      );
    });
    const response = await Promise.race([
      connection.mainSession.request("session.reconcile", { running: [] }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("correlated response was lost")), 50),
      ),
    ]);
    assert.deepEqual(response.payload, { accepted: true });
  } finally {
    await cleanup(connection);
  }
});

test("application requests expire when the peer never sends a correlated response", async () => {
  const connection = await directConnection({ requestTimeoutMs: 100 });
  try {
    const pending = connection.mainSession.request("session.reconcile", { running: [] });
    connection.clock.advanceBy(101);
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof Error &&
        "diagnostic" in error &&
        (error as { diagnostic: { code: string } }).diagnostic.code === "WORKER_REQUEST_TIMEOUT",
    );
    assert.equal(connection.mainSession.state, "ready");
  } finally {
    await cleanup(connection);
  }
});

test("an invalid outgoing message cannot consume a sequence number", async () => {
  const connection = await directConnection();
  try {
    await assert.rejects(connection.mainSession.send("INVALID" as WorkerMessageType, {}));
    const received: JsonValue[] = [];
    connection.workerSession.onMessage((message) => received.push(message.payload));
    await connection.mainSession.send("session.reconcile", { valid: true });
    assert.deepEqual(received, [{ valid: true }]);
    assert.equal(connection.workerSession.state, "ready");
  } finally {
    await cleanup(connection);
  }
});

test("a consumer listener failure cannot terminate the authenticated session", async () => {
  const connection = await directConnection();
  try {
    connection.workerSession.onMessage(() => {
      throw new Error("consumer failure");
    });
    const received: JsonValue[] = [];
    connection.workerSession.onMessage((message) => received.push(message.payload));
    await connection.mainSession.send("session.reconcile", { valid: true });
    assert.deepEqual(received, [{ valid: true }]);
    assert.equal(connection.workerSession.state, "ready");
  } finally {
    await cleanup(connection);
  }
});

test("an identical raw replay is deduplicated and a conflicting replay closes the session", async () => {
  const connection = await directConnection();
  try {
    const received: JsonValue[] = [];
    connection.workerSession.onMessage((message) => received.push(message.payload));
    await connection.mainSession.send("session.reconcile", { once: true });
    const original = connection.mainSocket.sent[0];
    assert.equal(typeof original, "string");
    connection.workerSocket.inject(original as string);
    assert.deepEqual(received, [{ once: true }]);

    const conflict = JSON.parse(original as string) as Record<string, JsonValue>;
    conflict.messageId = "message-conflict";
    connection.workerSocket.inject(JSON.stringify(conflict));
    assert.equal(connection.workerSession.state, "closed");
    assert.equal(connection.workerSession.diagnostic?.code, "PROTOCOL_SEQUENCE_REPLAY");
  } finally {
    await cleanup(connection);
  }
});

test("binary chunks are correlated and reject out-of-order delivery before aggregation", async () => {
  const connection = await directConnection({ maxFrameBytes: 512 });
  try {
    connection.mainSocket.automaticDelivery = false;
    await connection.mainSession.send(
      "session.reconcile",
      { binary: true },
      { binary: new Uint8Array(700) },
    );
    assert.ok(connection.mainSocket.sent.length >= 3);
    connection.mainSocket.deliver(0);
    connection.mainSocket.deliver(2);
    assert.equal(connection.workerSession.state, "closed");
    assert.equal(connection.workerSession.diagnostic?.code, "PROTOCOL_BINARY_ORDER_INVALID");
  } finally {
    await cleanup(connection);
  }
});

test("authentication failures never expose either credential in diagnostics or close reasons", async () => {
  const clock = new FakeClock();
  const main = createMainEndpoint({
    clock,
    credential: "main-private-value",
    workerId: "redacted-worker" as WorkerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const worker = createWorkerEndpoint({
    clock,
    credential: "worker-private-value",
    workerId: "redacted-worker" as WorkerId,
  });
  const [mainSocket, workerSocket] = directSocketPair();
  const mainSession = main.attach(mainSocket);
  const workerSession = worker.attach(workerSocket);
  await assert.rejects(Promise.all([mainSession.ready, workerSession.ready]));
  const observable = JSON.stringify({
    main: mainSession.diagnostic,
    worker: workerSession.diagnostic,
    reasons: [...mainSocket.closeReasons, ...workerSocket.closeReasons],
  });
  assert.doesNotMatch(observable, /main-private-value|worker-private-value/u);
  await Promise.all([main.close(), worker.close()]);
});

test("a peer close reason is redacted from diagnostics and pending request failures", async () => {
  const connection = await directConnection();
  const sensitiveReason = "remote-token=do-not-expose";
  const pending = connection.mainSession.request("session.reconcile", { running: [] });

  connection.workerSocket.close(4001, sensitiveReason);

  let rejection: unknown;
  await assert.rejects(pending, (error: unknown) => {
    rejection = error;
    return true;
  });
  const diagnostic =
    typeof rejection === "object" && rejection !== null && "diagnostic" in rejection
      ? (rejection as { diagnostic: { details?: JsonValue } }).diagnostic
      : undefined;
  assert.deepEqual(diagnostic?.details, { category: "transport-closed" });
  assert.deepEqual(connection.mainSession.diagnostic?.details, {
    category: "transport-closed",
  });
  assert.doesNotMatch(
    JSON.stringify({
      rejection:
        rejection instanceof Error
          ? {
              message: rejection.message,
              diagnostic,
            }
          : rejection,
      session: connection.mainSession.diagnostic,
    }),
    new RegExp(sensitiveReason, "u"),
  );

  await cleanup(connection);
});

test("endpoints retain only authoritative live sessions across failed reconnects and replacement", async () => {
  const clock = new FakeClock();
  const main = createMainEndpoint({
    clock,
    credential: "shared-secret",
    workerId: "retained-worker" as WorkerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rejectedWorker = createWorkerEndpoint({
      clock,
      credential: "wrong-secret",
      workerId: "retained-worker" as WorkerId,
    });
    const [mainSocket, workerSocket] = directSocketPair();
    const mainSession = main.attach(mainSocket);
    const workerSession = rejectedWorker.attach(workerSocket);
    await assert.rejects(Promise.all([mainSession.ready, workerSession.ready]));
    await rejectedWorker.close();
  }
  assert.equal(main.activeSessionCount, 0);

  const firstWorker = createWorkerEndpoint({
    clock,
    credential: "shared-secret",
    workerId: "retained-worker" as WorkerId,
  });
  const firstSockets = directSocketPair();
  const firstMainSession = main.attach(firstSockets[0]);
  const firstWorkerSession = firstWorker.attach(firstSockets[1]);
  await Promise.all([firstMainSession.ready, firstWorkerSession.ready]);

  const replacementWorker = createWorkerEndpoint({
    clock,
    credential: "shared-secret",
    workerId: "retained-worker" as WorkerId,
  });
  const replacementSockets = directSocketPair();
  const replacementMainSession = main.attach(replacementSockets[0]);
  const replacementWorkerSession = replacementWorker.attach(replacementSockets[1]);
  await Promise.all([replacementMainSession.ready, replacementWorkerSession.ready]);
  assert.equal(main.activeSessionCount, 1);
  assert.equal(firstWorker.activeSessionCount, 0);
  assert.equal(replacementWorker.activeSessionCount, 1);

  await Promise.all([main.close(), firstWorker.close(), replacementWorker.close()]);
  assert.equal(main.activeSessionCount, 0);
  assert.equal(replacementWorker.activeSessionCount, 0);
});

test("sessions accept the ws message(data, isBinary) event signature", async () => {
  const clock = new FakeClock();
  const main = createMainEndpoint({
    clock,
    credential: "shared-secret",
    workerId: "ws-signature-worker" as WorkerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const worker = createWorkerEndpoint({
    clock,
    credential: "shared-secret",
    workerId: "ws-signature-worker" as WorkerId,
  });
  const [mainSocket, workerSocket] = directSocketPair();
  mainSocket.wsRawDelivery = true;
  workerSocket.wsRawDelivery = true;
  const mainSession = main.attach(mainSocket);
  const workerSession = worker.attach(workerSocket);
  await Promise.all([mainSession.ready, workerSession.ready]);
  const received: JsonValue[] = [];
  workerSession.onMessage((message) => received.push(message.payload));
  await mainSession.send("session.reconcile", { ws: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{ ws: true }]);
  await Promise.all([main.close(), worker.close()]);
});

test("@spec:worker-protocol/reliable-pre-consumer-delivery/flushes-once-in-exact-order", async () => {
  const connection = await directConnection();
  const received: string[] = [];
  await connection.mainSession.send("session.reconcile", { order: "first" });
  await connection.mainSession.send("session.reconcile", { order: "second" });
  await flush();

  connection.workerSession.onMessage((message) => {
    const payload = message.payload as { order: string };
    received.push(payload.order);
  });
  const duplicateConsumer: string[] = [];
  connection.workerSession.onMessage((message) => {
    duplicateConsumer.push((message.payload as { order: string }).order);
  });

  assert.deepEqual(received, ["first", "second"]);
  assert.deepEqual(duplicateConsumer, []);
  await cleanup(connection);
});

test(
  "@spec:worker-protocol/reliable-pre-consumer-delivery/bounds-buffered-message-bytes",
  { timeout: 2_000 },
  async () => {
    const connection = await directConnection({
      maxBinaryBytes: 64,
      maxFrameBytes: 512,
      maxInflightMessages: 10,
    });
    const closed = Promise.withResolvers<void>();
    connection.workerSession.onStateChange((state) => {
      if (state === "closed") closed.resolve();
    });
    await connection.mainSession.send("session.reconcile", { value: "x".repeat(180) });
    await assert.rejects(async () => {
      await connection.mainSession.send("session.reconcile", { value: "y".repeat(180) });
      await connection.mainSession.send("session.reconcile", { value: "z".repeat(180) });
    }, /closed|available/iu);

    await closed.promise;
    assert.equal(
      connection.workerSession.diagnostic?.code,
      "PROTOCOL_INFLIGHT_LIMIT_EXCEEDED",
    );
    await cleanup(connection);
  },
);

test("@spec:worker-protocol/reliable-pre-consumer-delivery/close-revokes-unconsumed-messages", async () => {
  const connection = await directConnection();
  await connection.mainSession.send("session.reconcile", { retained: true });
  await flush();
  await connection.workerSession.close();
  const received: JsonValue[] = [];
  connection.workerSession.onMessage((message) => received.push(message.payload));

  assert.deepEqual(received, []);
  await cleanup(connection);
});

test("an incomplete authentication handshake expires without retaining the socket", async () => {
  const clock = new FakeClock();
  const main = createMainEndpoint({
    clock,
    credential: "shared-secret",
    workerId: "incomplete-worker" as WorkerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
    handshakeTimeoutMs: 100,
  });
  const [mainSocket] = directSocketPair();
  const mainSession = main.attach(mainSocket);
  clock.advanceBy(101);
  await assert.rejects(mainSession.ready, /handshake|auth/iu);
  assert.equal(mainSession.diagnostic?.code, "PROTOCOL_HANDSHAKE_TIMEOUT");
  assert.equal(main.activeSessionCount, 0);
  assert.equal(mainSocket.listenerCount(), 0);
  await main.close();
});

test("the default Worker clock removes abort listeners after completed sleeps", async () => {
  const { getEventListeners } = await import("node:events");
  const controller = new AbortController();
  for (let index = 0; index < 16; index += 1) {
    await systemWorkerClock.sleep(1, controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("a peer hello arriving first cannot move authenticate before the local hello", async () => {
  const clock = new FakeClock();
  const main = createMainEndpoint({
    clock,
    credential: "shared-secret",
    workerId: "peer-worker" as WorkerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const [mainSocket] = directSocketPair();
  const session = main.attach(mainSocket);
  const codec = createWorkerCodec();
  mainSocket.inject(
    codec.encodeControl({
      protocol: "1.0",
      messageId: parseMessageId("peer-hello"),
      sessionId: parseSessionId("peer-session"),
      sequence: parseSequence("0"),
      type: "hello",
      sentAt: clock.now().toISOString(),
      payload: {
        role: "worker",
        nonce: "0123456789abcdefghijklmn",
        workerId: "peer-worker",
      },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const sentTypes = mainSocket.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => JSON.parse(frame) as { type: string })
    .map((envelope) => envelope.type);
  assert.deepEqual(sentTypes.slice(0, 2), ["hello", "authenticate"]);
  await main.close();
  await assert.rejects(session.ready);
});

test("a late lower epoch cannot replace the authoritative Worker session", async () => {
  const clock = new FakeClock();
  const workerId = "epoch-worker" as WorkerId;
  const mainA = createMainEndpoint({
    clock,
    credential: "shared-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const mainB = createMainEndpoint({
    clock,
    credential: "shared-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });

  const seedWorker = createWorkerEndpoint({
    clock,
    credential: "shared-secret",
    workerId,
  });
  const seedSockets = directSocketPair();
  const seedMainSession = mainB.attach(seedSockets[0]);
  const seedWorkerSession = seedWorker.attach(seedSockets[1]);
  await Promise.all([seedMainSession.ready, seedWorkerSession.ready]);
  await seedWorker.close();

  const targetWorker = createWorkerEndpoint({
    clock,
    credential: "shared-secret",
    workerId,
  });
  const delayedSockets = directSocketPair();
  delayedSockets[0].holdControlType = "session.ready";
  const delayedMainSession = mainA.attach(delayedSockets[0]);
  const delayedWorkerSession = targetWorker.attach(delayedSockets[1]);
  await delayedMainSession.ready;

  const currentSockets = directSocketPair();
  const currentMainSession = mainB.attach(currentSockets[0]);
  const currentWorkerSession = targetWorker.attach(currentSockets[1]);
  await Promise.all([currentMainSession.ready, currentWorkerSession.ready]);
  assert.equal(currentWorkerSession.epoch, "2");
  assert.equal(targetWorker.current, currentWorkerSession);

  delayedSockets[0].releaseHeld();
  await delayedWorkerSession.ready;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(delayedWorkerSession.epoch, "1");
  assert.equal(targetWorker.current, currentWorkerSession);
  assert.equal(delayedWorkerSession.state, "unavailable");
  assert.equal(currentWorkerSession.state, "ready");

  await Promise.all([mainA.close(), mainB.close(), targetWorker.close()]);
});

test("public send and request cannot re-enter reserved handshake transitions", async () => {
  const connection = await directConnection();
  try {
    const originalEpoch = connection.workerSession.epoch;
    await assert.rejects(
      connection.mainSession.send("session.ready", { epoch: "999" }),
      /handshake|reserved/iu,
    );
    await assert.rejects(
      connection.mainSession.request("worker.register", {
        workerId: "forged-worker",
        labels: {},
        resources: {},
        executors: [],
        preparedArtifacts: [],
      }),
      /handshake|reserved/iu,
    );
    assert.equal(connection.workerSession.epoch, originalEpoch);
    assert.equal(connection.workerSession.state, "ready");
    assert.equal(connection.mainSession.state, "ready");
  } finally {
    await cleanup(connection);
  }
});

test("a credential is bound to its authenticated Worker principal", async () => {
  const clock = new FakeClock();
  const main = createMainEndpoint({
    clock,
    credentials: {
      "bound-worker": "bound-secret",
      "other-worker": "other-secret",
    },
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const impersonator = createWorkerEndpoint({
    clock,
    credential: "bound-secret",
    workerId: "other-worker" as WorkerId,
  });
  const [mainSocket, workerSocket] = directSocketPair();
  const mainSession = main.attach(mainSocket);
  const workerSession = impersonator.attach(workerSocket);
  await assert.rejects(Promise.all([mainSession.ready, workerSession.ready]), /auth/iu);
  assert.equal(main.current("bound-worker" as WorkerId), undefined);
  assert.equal(main.current("other-worker" as WorkerId), undefined);
  await Promise.all([main.close(), impersonator.close()]);
});
