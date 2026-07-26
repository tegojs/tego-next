import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseArtifactDigest,
  parseWorkerId,
  type ArtifactDigest,
  type Clock,
  type ExecutorKind,
  type FencingEpoch,
  type JsonObject,
  type JsonValue,
  type RuntimeDiagnostic,
  type SessionId,
  type WorkerMessageType,
  type WorkerProtocolVersion,
  type WorkerId,
} from "@tegojs/contracts";
import { FakeClock } from "./fake-clock.js";

export type WorkerConnectionDirection = "main-initiated" | "worker-initiated";

export interface WorkerConformanceRegistration {
  readonly workerId: WorkerId;
  readonly executors: readonly ExecutorKind[];
  readonly preparedArtifacts: readonly ArtifactDigest[];
}

export interface WorkerHeartbeatObservation {
  readonly beforeExpiry: boolean;
  readonly afterExpiry: boolean;
}

export interface WorkerReconnectObservation {
  readonly previousEpoch: FencingEpoch;
  readonly currentEpoch: FencingEpoch;
  readonly authoritativeEpoch: FencingEpoch;
}

export interface WorkerConformanceFixture {
  registration(): WorkerConformanceRegistration | Promise<WorkerConformanceRegistration>;
  heartbeat(): WorkerHeartbeatObservation | Promise<WorkerHeartbeatObservation>;
  reconnect(): WorkerReconnectObservation | Promise<WorkerReconnectObservation>;
  deduplicate(payload: JsonValue): readonly JsonValue[] | Promise<readonly JsonValue[]>;
  close(): void | Promise<void>;
}

export type WorkerConformanceFactory = () =>
  | WorkerConformanceFixture
  | Promise<WorkerConformanceFixture>;

const CONFORMANCE_REGISTRATION: WorkerConformanceRegistration = {
  workerId: parseWorkerId("conformance-worker"),
  executors: ["process", "thread", "remote"],
  preparedArtifacts: [parseArtifactDigest(`sha256:${"0".repeat(64)}`)],
};

async function withWorkerFixture<T>(
  factory: WorkerConformanceFactory,
  run: (fixture: WorkerConformanceFixture) => Promise<T>,
): Promise<T> {
  const fixture = await factory();
  try {
    return await run(fixture);
  } finally {
    await fixture.close();
  }
}

export function workerConformance(factory: WorkerConformanceFactory): void {
  describe("Worker directory conformance", () => {
    test("@spec:runtime-operations/reusable-conformance-test-kits/worker-registration", async () => {
      await withWorkerFixture(factory, async (fixture) => {
        assert.deepEqual(await fixture.registration(), CONFORMANCE_REGISTRATION);
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/worker-heartbeat", async () => {
      await withWorkerFixture(factory, async (fixture) => {
        assert.deepEqual(await fixture.heartbeat(), {
          beforeExpiry: true,
          afterExpiry: false,
        });
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/worker-reconnect", async () => {
      await withWorkerFixture(factory, async (fixture) => {
        const reconnected = await fixture.reconnect();
        assert.ok(BigInt(reconnected.currentEpoch) > BigInt(reconnected.previousEpoch));
        assert.equal(reconnected.authoritativeEpoch, reconnected.currentEpoch);
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/worker-message-deduplication", async () => {
      await withWorkerFixture(factory, async (fixture) => {
        const payload = { value: 1 };
        assert.deepEqual(await fixture.deduplicate(payload), [payload]);
      });
    });
  });
}

export interface WorkerSocketMessage {
  readonly data: string | Uint8Array;
}

export interface WorkerSocketClose {
  readonly code: number;
  readonly reason: string;
}

export interface WorkerSessionSocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (event: WorkerSocketMessage) => void): this;
  on(event: "close", listener: (event: WorkerSocketClose) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "message", listener: (event: WorkerSocketMessage) => void): this;
  off(event: "close", listener: (event: WorkerSocketClose) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

export interface WorkerRegistration extends JsonObject {
  readonly workerId: WorkerId;
  readonly labels: JsonObject;
  readonly resources: JsonObject;
  readonly executors: readonly string[];
  readonly preparedArtifacts: readonly string[];
}

export interface WorkerRegistrationInput {
  readonly labels: JsonObject;
  readonly resources: JsonObject;
  readonly executors: readonly string[];
  readonly preparedArtifacts: readonly string[];
}

export interface WorkerSessionMessage {
  readonly messageId: string;
  readonly correlationId: string;
  readonly type: WorkerMessageType;
  readonly payload: JsonValue;
  readonly binary?: Uint8Array;
}

export interface WorkerSessionLike {
  readonly ready: Promise<void>;
  readonly sessionId: SessionId;
  readonly epoch: string;
  readonly state: "authenticating" | "closed" | "ready" | "unavailable";
  readonly available: boolean;
  readonly acceptingAssignments: boolean;
  readonly diagnostic: RuntimeDiagnostic | undefined;
  send(
    type: WorkerMessageType,
    payload: JsonValue,
    options?: {
      readonly correlationId?: string;
      readonly binary?: Uint8Array;
    },
  ): Promise<string>;
  onMessage(listener: (message: WorkerSessionMessage) => void): () => void;
  close(): Promise<void>;
}

export interface MainEndpointLike {
  readonly activeSessionCount: number;
  attach(socket: WorkerSessionSocket): WorkerSessionLike;
  current(workerId: WorkerId): WorkerSessionLike | undefined;
  registration(workerId: WorkerId): WorkerRegistration | undefined;
  close(): Promise<void>;
}

export interface WorkerEndpointLike {
  readonly activeSessionCount: number;
  readonly current: WorkerSessionLike | undefined;
  attach(socket: WorkerSessionSocket): WorkerSessionLike;
  close(): Promise<void>;
}

export interface WorkerEndpointFactoryOptions {
  readonly clock: Clock;
  readonly credential: string;
  readonly protocol?: WorkerProtocolVersion;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly workerId?: WorkerId;
  readonly registration?: WorkerRegistrationInput;
}

export type MainEndpointFactory = (
  options: WorkerEndpointFactoryOptions,
) => MainEndpointLike | Promise<MainEndpointLike>;

export type WorkerEndpointFactory = (
  options: WorkerEndpointFactoryOptions,
) => WorkerEndpointLike | Promise<WorkerEndpointLike>;

type MessageListener = (event: WorkerSocketMessage) => void;
type CloseListener = (event: WorkerSocketClose) => void;
type ErrorListener = (error: Error) => void;

class MemorySocket implements WorkerSessionSocket {
  readyState = 1;
  peer?: MemorySocket;
  readonly #messages = new Set<MessageListener>();
  readonly #closes = new Set<CloseListener>();
  readonly #errors = new Set<ErrorListener>();
  readonly #sent: (string | Uint8Array)[] = [];
  readonly #heldTypes = new Set<string>();
  readonly #held: (string | Uint8Array)[] = [];

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1 || this.peer?.readyState !== 1) {
      throw new Error("socket is not open");
    }
    const copy = typeof data === "string" ? data : Uint8Array.from(data);
    this.#sent.push(copy);
    if (
      typeof copy === "string" &&
      this.#heldTypes.has((JSON.parse(copy) as { type?: unknown }).type as string)
    ) {
      this.#held.push(copy);
      return;
    }
    this.#deliver(copy);
  }

  #deliver(copy: string | Uint8Array): void {
    queueMicrotask(() => {
      const peer = this.peer;
      for (const listener of peer === undefined ? [] : peer.#messages) {
        listener({ data: copy });
      }
    });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    const peer = this.peer;
    if (peer !== undefined) {
      peer.readyState = 3;
    }
    queueMicrotask(() => {
      const event = { code, reason };
      for (const listener of this.#closes) {
        listener(event);
      }
      for (const listener of peer === undefined ? [] : peer.#closes) {
        listener(event);
      }
    });
  }

  on(
    event: "message" | "close" | "error",
    listener: MessageListener | CloseListener | ErrorListener,
  ): this {
    this.#listeners(event).add(listener as never);
    return this;
  }

  off(
    event: "message" | "close" | "error",
    listener: MessageListener | CloseListener | ErrorListener,
  ): this {
    this.#listeners(event).delete(listener as never);
    return this;
  }

  lastControlFrame(): string {
    const frame = this.#sent.findLast(
      (candidate): candidate is string => typeof candidate === "string",
    );
    if (frame === undefined) {
      throw new Error("socket has not sent a control frame");
    }
    return frame;
  }

  inject(data: string | Uint8Array): void {
    const copy = typeof data === "string" ? data : Uint8Array.from(data);
    for (const listener of this.#messages) {
      listener({ data: copy });
    }
  }

  holdControlType(type: string): void {
    this.#heldTypes.add(type);
  }

  releaseHeld(): void {
    for (const frame of this.#held.splice(0)) {
      this.#deliver(frame);
    }
  }

  #listeners(
    event: "message" | "close" | "error",
  ): Set<MessageListener> | Set<CloseListener> | Set<ErrorListener> {
    if (event === "message") {
      return this.#messages;
    }
    if (event === "close") {
      return this.#closes;
    }
    return this.#errors;
  }
}

function socketPair(): readonly [MemorySocket, MemorySocket] {
  const left = new MemorySocket();
  const right = new MemorySocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

async function connect(
  main: MainEndpointLike,
  worker: WorkerEndpointLike,
  direction: WorkerConnectionDirection,
): Promise<readonly [WorkerSessionLike, WorkerSessionLike, MemorySocket, MemorySocket]> {
  const [mainSocket, workerSocket] = socketPair();
  const first =
    direction === "main-initiated" ? worker.attach(workerSocket) : main.attach(mainSocket);
  const second =
    direction === "main-initiated" ? main.attach(mainSocket) : worker.attach(workerSocket);
  const mainSession = direction === "main-initiated" ? second : first;
  const workerSession = direction === "main-initiated" ? first : second;
  await Promise.all([mainSession.ready, workerSession.ready]);
  return [mainSession, workerSession, mainSocket, workerSocket];
}

const WORKER_ID = parseWorkerId("worker-1");
const REGISTRATION: WorkerRegistrationInput = {
  labels: { region: "test" },
  resources: { cpu: 2 },
  executors: ["process"],
  preparedArtifacts: [parseArtifactDigest(`sha256:${"0".repeat(64)}`)],
};

export function workerSessionConformance(
  mainFactory: MainEndpointFactory,
  workerFactory: WorkerEndpointFactory,
): void {
  describe("Worker session conformance", () => {
    for (const direction of ["worker-initiated", "main-initiated"] as const) {
      test(`@spec:worker-protocol/direction-neutral-authenticated-session/${direction}`, async () => {
        const clock = new FakeClock();
        const main = await mainFactory({
          clock,
          credential: "shared-secret",
          workerId: WORKER_ID,
        });
        const worker = await workerFactory({
          clock,
          credential: "shared-secret",
          workerId: WORKER_ID,
          registration: REGISTRATION,
        });
        try {
          const [mainSession, workerSession] = await connect(main, worker, direction);
          assert.equal(mainSession.state, "ready");
          assert.equal(workerSession.state, "ready");
          assert.equal(main.current(WORKER_ID), mainSession);
          assert.deepEqual(main.registration(WORKER_ID), {
            workerId: WORKER_ID,
            ...REGISTRATION,
          });
        } finally {
          await Promise.all([main.close(), worker.close()]);
        }
      });
    }

    test("@spec:worker-protocol/direction-neutral-authenticated-session/invalid-bootstrap-credential", async () => {
      const clock = new FakeClock();
      const main = await mainFactory({
        clock,
        credential: "correct-secret",
        workerId: WORKER_ID,
      });
      const worker = await workerFactory({
        clock,
        credential: "wrong-secret",
        workerId: WORKER_ID,
        registration: REGISTRATION,
      });
      const [mainSocket, workerSocket] = socketPair();
      const mainSession = main.attach(mainSocket);
      const workerSession = worker.attach(workerSocket);
      await assert.rejects(
        Promise.all([mainSession.ready, workerSession.ready]),
        /auth|credential/iu,
      );
      assert.equal(main.current(WORKER_ID), undefined);
      assert.equal(mainSession.state, "closed");
      await Promise.all([main.close(), worker.close()]);
    });

    test("@spec:worker-protocol/versioned-reliable-message-envelope/unsupported-protocol-version", async () => {
      const clock = new FakeClock();
      const main = await mainFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
      });
      const [mainSocket, workerSocket] = socketPair();
      const mainSession = main.attach(mainSocket);
      workerSocket.send(
        JSON.stringify({
          protocol: "2.0",
          messageId: "unsupported-version",
          sessionId: "unsupported-session",
          sequence: "0",
          type: "hello",
          sentAt: clock.now().toISOString(),
          payload: {
            role: "worker",
            nonce: "0123456789abcdefghijklmn",
            workerId: WORKER_ID,
          },
        }),
      );
      await assert.rejects(mainSession.ready, /protocol|version/iu);
      assert.equal(mainSession.diagnostic?.code, "PROTOCOL_VERSION_UNSUPPORTED");
      await main.close();
    });

    test("messages are correlated and replayed message IDs are delivered once", async () => {
      const clock = new FakeClock();
      const main = await mainFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
      });
      const worker = await workerFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
        registration: REGISTRATION,
      });
      try {
        const [mainSession, workerSession, mainSocket, workerSocket] = await connect(
          main,
          worker,
          "worker-initiated",
        );
        const workerReceived: WorkerSessionMessage[] = [];
        const mainReceived: WorkerSessionMessage[] = [];
        const unsubscribeWorker = workerSession.onMessage((message) => workerReceived.push(message));
        const unsubscribeMain = mainSession.onMessage((message) => mainReceived.push(message));
        const messageId = await mainSession.send("session.reconcile", { running: [] });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(workerReceived.length, 1);
        const request = workerReceived[0];
        assert.ok(request);
        assert.equal(request.messageId, messageId);
        assert.equal(request.correlationId, request.messageId);

        await workerSession.send(
          "session.reconcile",
          { running: [] },
          { correlationId: request.messageId },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(mainReceived.length, 1);
        assert.equal(mainReceived[0]?.correlationId, request.messageId);

        const original = mainSocket.lastControlFrame();
        workerSocket.inject(original);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(workerReceived.length, 1);

        const conflict = JSON.parse(original) as Record<string, JsonValue>;
        conflict.messageId = "conformance-conflict";
        workerSocket.inject(JSON.stringify(conflict));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(workerSession.state, "closed");
        assert.equal(workerSession.diagnostic?.code, "PROTOCOL_SEQUENCE_REPLAY");
        unsubscribeWorker();
        unsubscribeMain();
      } finally {
        await Promise.all([main.close(), worker.close()]);
      }
    });

    test("@spec:worker-protocol/worker-liveness-and-capabilities/heartbeat-expires", async () => {
      const clock = new FakeClock();
      const main = await mainFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
        heartbeatTimeoutMs: 100,
      });
      const worker = await workerFactory({
        clock,
        credential: "shared-secret",
        heartbeatIntervalMs: 1_000,
        workerId: WORKER_ID,
        registration: REGISTRATION,
      });
      try {
        const [mainSession] = await connect(main, worker, "worker-initiated");
        clock.advanceBy(101);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(mainSession.available, false);
        assert.equal(mainSession.acceptingAssignments, false);
        assert.equal(mainSession.state, "unavailable");
        assert.equal(main.current(WORKER_ID), undefined);
        assert.equal(worker.current, undefined);
        assert.equal(main.activeSessionCount, 0);
        assert.equal(worker.activeSessionCount, 0);
      } finally {
        await Promise.all([main.close(), worker.close()]);
      }
    });

    test("a replacement session is authoritative and fences its predecessor", async () => {
      const clock = new FakeClock();
      const main = await mainFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
      });
      const firstWorker = await workerFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
        registration: REGISTRATION,
      });
      const secondWorker = await workerFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
        registration: REGISTRATION,
      });
      try {
        const [firstMain] = await connect(main, firstWorker, "worker-initiated");
        const [secondMain] = await connect(main, secondWorker, "main-initiated");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(main.current(WORKER_ID), secondMain);
        assert.notEqual(firstMain.sessionId, secondMain.sessionId);
        assert.equal(firstMain.available, false);
        assert.equal(firstMain.acceptingAssignments, false);
        await assert.rejects(
          firstMain.send("session.reconcile", {}),
          /closed|replaced|available/iu,
        );
      } finally {
        await Promise.all([main.close(), firstWorker.close(), secondWorker.close()]);
      }
    });

    test("out-of-order ready messages cannot roll back the Worker epoch", async () => {
      const clock = new FakeClock();
      const mainA = await mainFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
      });
      const mainB = await mainFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
      });
      const seedWorker = await workerFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
        registration: REGISTRATION,
      });
      const [seedMainSocket, seedWorkerSocket] = socketPair();
      const seedMainSession = mainB.attach(seedMainSocket);
      const seedWorkerSession = seedWorker.attach(seedWorkerSocket);
      await Promise.all([seedMainSession.ready, seedWorkerSession.ready]);
      await seedWorker.close();

      const targetWorker = await workerFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
        registration: REGISTRATION,
      });
      const [delayedMainSocket, delayedWorkerSocket] = socketPair();
      delayedMainSocket.holdControlType("session.ready");
      const delayedMainSession = mainA.attach(delayedMainSocket);
      const delayedWorkerSession = targetWorker.attach(delayedWorkerSocket);
      await delayedMainSession.ready;

      const [currentMainSocket, currentWorkerSocket] = socketPair();
      const currentMainSession = mainB.attach(currentMainSocket);
      const currentWorkerSession = targetWorker.attach(currentWorkerSocket);
      await Promise.all([currentMainSession.ready, currentWorkerSession.ready]);
      assert.equal(currentWorkerSession.epoch, "2");
      currentWorkerSocket.close(1006, "transport-lost");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(mainB.current(WORKER_ID), undefined);
      assert.equal(targetWorker.current, undefined);

      delayedMainSocket.releaseHeld();
      await delayedWorkerSession.ready;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(delayedWorkerSession.epoch, "1");
      assert.equal(delayedWorkerSession.state, "unavailable");
      assert.equal(currentWorkerSession.state, "closed");
      assert.equal(targetWorker.current, undefined);
      assert.equal(targetWorker.activeSessionCount, 0);

      await Promise.all([mainA.close(), mainB.close(), targetWorker.close()]);
    });

    test("close is idempotent and rejects later sends", async () => {
      const clock = new FakeClock();
      const main = await mainFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
      });
      const worker = await workerFactory({
        clock,
        credential: "shared-secret",
        workerId: WORKER_ID,
        registration: REGISTRATION,
      });
      const [mainSession] = await connect(main, worker, "worker-initiated");
      await Promise.all([mainSession.close(), mainSession.close()]);
      assert.equal(mainSession.state, "closed");
      await assert.rejects(mainSession.send("session.reconcile", {}), /closed/iu);
      await Promise.all([main.close(), worker.close()]);
    });
  });
}
