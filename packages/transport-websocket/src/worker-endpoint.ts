import { parseWorkerId, type WorkerId } from "@tegojs/contracts";
import { systemWorkerClock } from "./clock.js";
import { assertWorkerProtocolVersion } from "./codec.js";
import type { WorkerEndpointOptions, WorkerRegistrationInput } from "./main-endpoint.js";
import { compareWorkerEpoch, WorkerSession, type WorkerRegistration } from "./session.js";

function registrationFrom(options: WorkerEndpointOptions): WorkerRegistration {
  const workerId = parseWorkerId(options.workerId);
  const registration: WorkerRegistrationInput = options.registration ?? {
    labels: {},
    resources: {},
    executors: [],
    preparedArtifacts: [],
  };
  return {
    workerId,
    labels: registration.labels,
    resources: registration.resources,
    executors: [...registration.executors],
    preparedArtifacts: [...registration.preparedArtifacts],
  };
}

export class WorkerEndpoint {
  readonly #options: WorkerEndpointOptions;
  readonly #workerId: WorkerId;
  readonly #registration: WorkerRegistration;
  readonly #sessions = new Set<WorkerSession>();
  #current: WorkerSession | undefined;
  #highestAcceptedEpoch = "0";
  #closed = false;

  constructor(options: WorkerEndpointOptions) {
    assertWorkerProtocolVersion(options.protocol ?? "1.0");
    this.#options = options;
    this.#workerId = parseWorkerId(options.workerId);
    this.#registration = registrationFrom(options);
  }

  get workerId(): WorkerId {
    return this.#workerId;
  }

  get current(): WorkerSession | undefined {
    return this.#current;
  }

  get activeSessionCount(): number {
    return this.#sessions.size;
  }

  attach(socket: unknown): WorkerSession {
    if (this.#closed) {
      throw new Error("Worker endpoint is closed");
    }
    const session = new WorkerSession({
      role: "worker",
      socket,
      clock: this.#options.clock ?? systemWorkerClock,
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
      worker: this.#registration,
      onClosed: (closedSession) => {
        this.#sessions.delete(closedSession);
        if (this.#current === closedSession) {
          this.#current = undefined;
        }
      },
    });
    this.#sessions.add(session);
    void session.ready.then(
      () => {
        if (this.#closed || session.state !== "ready") {
          return;
        }
        const predecessor = this.#current;
        if (compareWorkerEpoch(session.epoch, this.#highestAcceptedEpoch) > 0) {
          this.#highestAcceptedEpoch = session.epoch;
          this.#current = session;
          if (predecessor !== session) {
            predecessor?.replace();
          }
        } else if (predecessor !== session) {
          session.replace();
        }
      },
      () => {
        this.#sessions.delete(session);
      },
    );
    return session;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.all([...this.#sessions].map(async (session) => session.close()));
    this.#sessions.clear();
    this.#current = undefined;
  }
}

export function createWorkerEndpoint(options: WorkerEndpointOptions): WorkerEndpoint {
  return new WorkerEndpoint(options);
}
