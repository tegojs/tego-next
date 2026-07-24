import {
  parseSequence,
  parseWorkerId,
  type Clock,
  type JsonObject,
  type WorkerId,
  type WorkerProtocolVersion,
} from "@tegojs/contracts";
import { assertWorkerProtocolVersion, type WorkerProtocolLimitOverrides } from "./codec.js";
import { systemWorkerClock } from "./clock.js";
import { WorkerSession, type WorkerRegistration } from "./session.js";

export interface WorkerRegistrationInput {
  readonly labels: JsonObject;
  readonly resources: JsonObject;
  readonly executors: readonly string[];
  readonly preparedArtifacts: readonly string[];
}

export interface WorkerSessionEndpointOptions {
  readonly clock?: Clock;
  readonly protocol?: WorkerProtocolVersion;
  readonly limits?: WorkerProtocolLimitOverrides;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
}

export interface MainEndpointOptions extends WorkerSessionEndpointOptions {
  readonly credential?: string;
  readonly workerId?: WorkerId;
  readonly credentials?: Readonly<Record<string, string>>;
}

export interface WorkerEndpointOptions extends WorkerSessionEndpointOptions {
  readonly credential: string;
  readonly workerId?: WorkerId;
  readonly registration?: WorkerRegistrationInput;
}

export class MainEndpoint {
  readonly #options: MainEndpointOptions;
  readonly #credentials: ReadonlyMap<WorkerId, string>;
  readonly #sessions = new Set<WorkerSession>();
  readonly #current = new Map<WorkerId, WorkerSession>();
  readonly #registrations = new Map<WorkerId, WorkerRegistration>();
  readonly #epochs = new Map<WorkerId, bigint>();
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

  #register(session: WorkerSession, registration: WorkerRegistration): string {
    if (this.#closed) {
      throw new Error("Main Worker endpoint is closed");
    }
    const workerId = parseWorkerId(registration.workerId);
    const nextEpoch = (this.#epochs.get(workerId) ?? 0n) + 1n;
    const predecessor = this.#current.get(workerId);
    this.#epochs.set(workerId, nextEpoch);
    this.#current.set(workerId, session);
    this.#registrations.set(workerId, registration);
    predecessor?.replace();
    return parseSequence(nextEpoch.toString());
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
