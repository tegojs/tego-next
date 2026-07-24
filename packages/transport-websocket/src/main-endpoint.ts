import {
  parseSequence,
  parseWorkerId,
  type Clock,
  type JsonObject,
  type WorkerId,
} from "@tegojs/contracts";
import type { WorkerProtocolLimitOverrides } from "./codec.js";
import { WorkerSession, type WorkerRegistration } from "./session.js";

const systemClock: Clock = {
  now: () => new Date(),
  sleep(delayMs, signal): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason);
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, delayMs);
      const abort = () => {
        clearTimeout(timeout);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      timeout.unref();
    });
  },
};

export interface WorkerRegistrationInput {
  readonly labels: JsonObject;
  readonly resources: JsonObject;
  readonly executors: readonly string[];
  readonly preparedArtifacts: readonly string[];
}

export interface WorkerEndpointOptions {
  readonly clock?: Clock;
  readonly credential: string;
  readonly protocol?: string;
  readonly limits?: WorkerProtocolLimitOverrides;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly workerId?: WorkerId;
  readonly registration?: WorkerRegistrationInput;
}

export class MainEndpoint {
  readonly #options: WorkerEndpointOptions;
  readonly #sessions = new Set<WorkerSession>();
  readonly #current = new Map<WorkerId, WorkerSession>();
  readonly #registrations = new Map<WorkerId, WorkerRegistration>();
  readonly #epochs = new Map<WorkerId, bigint>();
  #closed = false;

  constructor(options: WorkerEndpointOptions) {
    this.#options = options;
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
      clock: this.#options.clock ?? systemClock,
      credential: this.#options.credential,
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
        this.#sessions.delete(closedSession);
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
}

export function createMainEndpoint(options: WorkerEndpointOptions): MainEndpoint {
  return new MainEndpoint(options);
}
