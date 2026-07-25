import {
  type ArtifactDigest,
  type Clock,
  type ExecutorKind,
  type FencingEpoch,
  type JsonObject,
  parseFencingEpoch,
  parseWorkerId,
  type WorkerId,
  type WorkerProtocolVersion,
} from "@tegojs/contracts";
import { systemWorkerClock } from "./clock.js";
import { assertWorkerProtocolVersion, type WorkerProtocolLimitOverrides } from "./codec.js";
import { compareWorkerEpoch, type WorkerRegistration, WorkerSession } from "./session.js";

export interface WorkerRegistrationInput {
  readonly labels: JsonObject;
  readonly resources: JsonObject;
  readonly executors: readonly ExecutorKind[];
  readonly preparedArtifacts: readonly ArtifactDigest[];
}

export interface WorkerSessionEndpointOptions {
  readonly clock?: Clock;
  readonly protocol?: WorkerProtocolVersion;
  readonly limits?: WorkerProtocolLimitOverrides;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface MainEndpointOptions extends WorkerSessionEndpointOptions {
  readonly credential?: string;
  readonly workerId?: WorkerId;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly epochAllocator: WorkerEpochAllocator;
  /** Must synchronously throw when the allocated registration may no longer be published. */
  readonly assertRegistrationPublishable?: (workerId: WorkerId, session: WorkerSession) => void;
}

export interface WorkerEndpointOptions extends WorkerSessionEndpointOptions {
  readonly credential: string;
  readonly workerId?: WorkerId;
  readonly registration?: WorkerRegistrationInput;
}

export interface WorkerEpochAllocator {
  next(workerId: WorkerId): Promise<FencingEpoch>;
}

export class MemoryWorkerEpochAllocator implements WorkerEpochAllocator {
  readonly #epochs = new Map<WorkerId, bigint>();

  constructor(highWaterMarks: Readonly<Record<string, string>> = {}) {
    for (const [workerId, epoch] of Object.entries(highWaterMarks)) {
      this.#epochs.set(parseWorkerId(workerId), BigInt(parseFencingEpoch(epoch)));
    }
  }

  async next(workerIdValue: WorkerId): Promise<FencingEpoch> {
    const workerId = parseWorkerId(workerIdValue);
    const nextEpoch = (this.#epochs.get(workerId) ?? 0n) + 1n;
    const parsed = parseFencingEpoch(nextEpoch.toString());
    this.#epochs.set(workerId, nextEpoch);
    return parsed;
  }
}

export class MainEndpoint {
  readonly #options: MainEndpointOptions;
  readonly #credentials: ReadonlyMap<WorkerId, string>;
  readonly #sessions = new Set<WorkerSession>();
  readonly #current = new Map<WorkerId, WorkerSession>();
  readonly #registrations = new Map<WorkerId, WorkerRegistration>();
  readonly #registrationTails = new Map<WorkerId, Promise<void>>();
  readonly #lastEpochs = new Map<WorkerId, FencingEpoch>();
  readonly #epochAllocator: WorkerEpochAllocator;
  #closed = false;

  constructor(options: MainEndpointOptions) {
    assertWorkerProtocolVersion(options.protocol ?? "1.0");
    this.#options = options;
    const credentials = new Map<WorkerId, string>();
    for (const [workerId, credential] of Object.entries(options.credentials ?? {})) {
      credentials.set(parseWorkerId(workerId), credential);
    }
    if (options.credential !== undefined || options.workerId !== undefined) {
      if (options.credential === undefined || options.workerId === undefined) {
        throw new TypeError("A single Worker credential requires its bound workerId");
      }
      credentials.set(parseWorkerId(options.workerId), options.credential);
    }
    if (credentials.size === 0) {
      throw new TypeError("Main endpoint requires at least one Worker-bound credential");
    }
    this.#credentials = credentials;
    this.#epochAllocator = options.epochAllocator;
  }

  get activeSessionCount(): number {
    return this.#sessions.size;
  }

  attach(socket: unknown): WorkerSession {
    if (this.#closed) {
      throw new Error("Main Worker endpoint is closed");
    }
    const session = new WorkerSession({
      role: "main",
      socket,
      clock: this.#options.clock ?? systemWorkerClock,
      resolveCredential: (workerId) => this.#credentials.get(workerId),
      ...(this.#options.protocol === undefined ? {} : { protocol: this.#options.protocol }),
      ...(this.#options.limits === undefined ? {} : { limits: this.#options.limits }),
      ...(this.#options.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: this.#options.heartbeatIntervalMs }),
      ...(this.#options.heartbeatTimeoutMs === undefined
        ? {}
        : { heartbeatTimeoutMs: this.#options.heartbeatTimeoutMs }),
      ...(this.#options.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: this.#options.handshakeTimeoutMs }),
      ...(this.#options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.#options.requestTimeoutMs }),
      onRegister: (registeredSession, registration) =>
        this.#register(registeredSession, registration),
      onClosed: (closedSession) => {
        this.#release(closedSession);
      },
    });
    this.#sessions.add(session);
    return session;
  }

  current(workerId: WorkerId): WorkerSession | undefined {
    return this.#current.get(parseWorkerId(workerId));
  }

  registration(workerId: WorkerId): WorkerRegistration | undefined {
    return this.#registrations.get(parseWorkerId(workerId));
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.all([...this.#sessions].map(async (session) => session.close()));
    this.#sessions.clear();
    this.#current.clear();
    this.#registrations.clear();
  }

  async #register(session: WorkerSession, registration: WorkerRegistration): Promise<FencingEpoch> {
    const workerId = parseWorkerId(registration.workerId);
    const predecessor = this.#registrationTails.get(workerId) ?? Promise.resolve();
    const registrationAttempt = predecessor
      .catch(() => undefined)
      .then(async () => this.#claimRegistration(workerId, session, registration));
    const tail = registrationAttempt.then(
      () => undefined,
      () => undefined,
    );
    this.#registrationTails.set(workerId, tail);
    try {
      return await registrationAttempt;
    } finally {
      if (this.#registrationTails.get(workerId) === tail) {
        this.#registrationTails.delete(workerId);
      }
    }
  }

  async #claimRegistration(
    workerId: WorkerId,
    session: WorkerSession,
    registration: WorkerRegistration,
  ): Promise<FencingEpoch> {
    this.#assertRegistrationCandidate(session);
    const nextEpoch = await this.#allocateEpoch(workerId, session);
    this.#assertRegistrationCandidate(session);
    this.#options.assertRegistrationPublishable?.(workerId, session);
    const predecessor = this.#current.get(workerId);
    this.#current.set(workerId, session);
    this.#registrations.set(workerId, registration);
    predecessor?.replace();
    return nextEpoch;
  }

  async #allocateEpoch(workerId: WorkerId, session: WorkerSession): Promise<FencingEpoch> {
    const allocation = Promise.resolve()
      .then(async () => this.#epochAllocator.next(workerId))
      .then((epoch) => parseFencingEpoch(epoch));
    let rejectClosed: ((error: Error) => void) | undefined;
    const closed = new Promise<never>((_resolve, reject) => {
      rejectClosed = reject;
    });
    const unsubscribe = session.onStateChange((state) => {
      if (state !== "authenticating") {
        rejectClosed?.(new Error("Worker session closed while allocating a session epoch"));
      }
    });
    if (session.state !== "authenticating") {
      rejectClosed?.(new Error("Worker session closed while allocating a session epoch"));
    }
    try {
      const nextEpoch = await Promise.race([allocation, closed]);
      if (!this.#recordAllocatedEpoch(workerId, nextEpoch)) {
        throw new Error("Worker session epoch allocator returned a stale epoch");
      }
      return nextEpoch;
    } catch (error) {
      if (session.state !== "authenticating") {
        void allocation
          .then((lateEpoch) => {
            this.#recordAllocatedEpoch(workerId, lateEpoch);
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      unsubscribe();
    }
  }

  #recordAllocatedEpoch(workerId: WorkerId, nextEpoch: FencingEpoch): boolean {
    const lastEpoch = this.#lastEpochs.get(workerId) ?? parseFencingEpoch("0");
    if (compareWorkerEpoch(nextEpoch, lastEpoch) <= 0) {
      return false;
    }
    this.#lastEpochs.set(workerId, nextEpoch);
    return true;
  }

  #assertRegistrationCandidate(session: WorkerSession): void {
    if (this.#closed) {
      throw new Error("Main Worker endpoint is closed");
    }
    if (!this.#sessions.has(session) || session.state !== "authenticating") {
      throw new Error("Worker session closed while allocating a session epoch");
    }
  }

  #release(session: WorkerSession): void {
    this.#sessions.delete(session);
    for (const [workerId, current] of this.#current) {
      if (current === session) {
        this.#current.delete(workerId);
        this.#registrations.delete(workerId);
      }
    }
  }
}

export function createMainEndpoint(options: MainEndpointOptions): MainEndpoint {
  return new MainEndpoint(options);
}
