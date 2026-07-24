import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  Clock,
  JsonObject,
  JsonValue,
  RuntimeDiagnostic,
  SessionId,
  WorkerMessageType,
  WorkerId,
} from "@tegojs/contracts";
import { FakeClock } from "./fake-clock.js";

export type WorkerConnectionDirection = "main-initiated" | "worker-initiated";

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
  readonly correlationId?: string;
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
  attach(socket: WorkerSessionSocket): WorkerSessionLike;
  current(workerId: WorkerId): WorkerSessionLike | undefined;
  registration(workerId: WorkerId): WorkerRegistration | undefined;
  close(): Promise<void>;
}

export interface WorkerEndpointLike {
  attach(socket: WorkerSessionSocket): WorkerSessionLike;
  close(): Promise<void>;
}

export interface WorkerEndpointFactoryOptions {
  readonly clock: Clock;
  readonly credential: string;
  readonly protocol?: string;
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

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1 || this.peer?.readyState !== 1) {
      throw new Error("socket is not open");
    }
    const copy = typeof data === "string" ? data : Uint8Array.from(data);
    this.#sent.push(copy);
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

const WORKER_ID = "worker-1" as WorkerId;
const REGISTRATION: WorkerRegistrationInput = {
  labels: { region: "test" },
  resources: { cpu: 2 },
  executors: ["process"],
  preparedArtifacts: ["sha256:test"],
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
      const worker = await workerFactory({
        clock,
        credential: "shared-secret",
        protocol: "2.0",
        workerId: WORKER_ID,
        registration: REGISTRATION,
      });
      const [mainSocket, workerSocket] = socketPair();
      const mainSession = main.attach(mainSocket);
      const workerSession = worker.attach(workerSocket);
      await assert.rejects(
        Promise.all([mainSession.ready, workerSession.ready]),
        /protocol|version/iu,
      );
      assert.equal(mainSession.diagnostic?.code, "PROTOCOL_VERSION_UNSUPPORTED");
      await Promise.all([main.close(), worker.close()]);
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
        const received: WorkerSessionMessage[] = [];
        const unsubscribe = workerSession.onMessage((message) => received.push(message));
        const messageId = await mainSession.send("session.reconcile", { running: [] });
        await mainSession.send("session.reconcile", { running: [] }, { correlationId: messageId });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(received.length, 2);
        assert.equal(received[1]?.correlationId, messageId);
        const original = mainSocket.lastControlFrame();
        workerSocket.inject(original);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(received.length, 2);

        const conflict = JSON.parse(original) as Record<string, JsonValue>;
        conflict.messageId = "conformance-conflict";
        workerSocket.inject(JSON.stringify(conflict));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(workerSession.state, "closed");
        assert.equal(workerSession.diagnostic?.code, "PROTOCOL_SEQUENCE_REPLAY");
        unsubscribe();
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
