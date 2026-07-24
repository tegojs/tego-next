import { setTimeout as delay } from "node:timers/promises";
import {
  DiagnosticError,
  parseFencingEpoch,
  parseRevision,
  runtimeDiagnostic,
  serializeWireValue,
  type CampaignRequest,
  type CasResult,
  type Clock,
  type CompareAndSetRequest,
  type CoordinationChange,
  type CoordinationProvider,
  type CoordinationWatchRequest,
  type DriverHealth,
  type FencingEpoch,
  type JsonValue,
  type Leadership,
  type Lease,
  type LeaseRequest,
  type Revision,
} from "@tegojs/contracts";

const localEpoch = parseFencingEpoch("1");

const systemClock: Clock = {
  now: () => new Date(),
  sleep: async (delayMs, signal) => {
    await delay(delayMs, undefined, signal === undefined ? undefined : { signal });
  },
};

interface CoordinationRecord {
  readonly value: JsonValue;
  readonly revision: Revision;
}

export interface LocalCoordinationProviderOptions {
  readonly clock?: Clock;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return serializeWireValue(JSON.parse(JSON.stringify(serializeWireValue(value))) as unknown) as T;
}

class CoordinationWatchIterator
  implements AsyncIterator<CoordinationChange>, AsyncIterable<CoordinationChange>
{
  readonly #onClose: () => void;
  readonly #queue: CoordinationChange[];
  readonly #waiters: Array<(result: IteratorResult<CoordinationChange>) => void> = [];
  #closed = false;

  constructor(changes: readonly CoordinationChange[], onClose: () => void) {
    this.#queue = changes.map((change) => ({
      key: change.key,
      revision: change.revision,
      value: cloneJson(change.value),
    }));
    this.#onClose = onClose;
  }

  [Symbol.asyncIterator](): AsyncIterator<CoordinationChange> {
    return this;
  }

  next(): Promise<IteratorResult<CoordinationChange>> {
    const change = this.#queue.shift();
    if (change !== undefined) {
      return Promise.resolve({ done: false, value: change });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  return(): Promise<IteratorResult<CoordinationChange>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(change: CoordinationChange): void {
    if (this.#closed) {
      return;
    }
    const cloned = {
      key: change.key,
      revision: change.revision,
      value: cloneJson(change.value),
    };
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#queue.push(cloned);
    } else {
      waiter({ done: false, value: cloned });
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#queue.length = 0;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
    this.#onClose();
  }
}

export class LocalCoordinationProvider implements CoordinationProvider {
  readonly scope = "local" as const;
  readonly #clock: Clock;
  readonly #records = new Map<string, CoordinationRecord>();
  readonly #changes: CoordinationChange[] = [];
  readonly #watchers = new Set<CoordinationWatchIterator>();
  #revision = 0n;
  #lifecycle: "closed" | "created" | "open" = "created";

  constructor(options: LocalCoordinationProviderOptions = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  async open(): Promise<void> {
    if (this.#lifecycle === "closed") {
      throw this.#closedError();
    }
    this.#lifecycle = "open";
  }

  async campaign(request: CampaignRequest): Promise<Leadership> {
    this.#assertOpen();
    this.#assertResource(request.resource);
    return {
      resource: request.resource,
      epoch: localEpoch,
    };
  }

  async acquireLease(request: LeaseRequest): Promise<Lease> {
    this.#assertOpen();
    this.#assertResource(request.resource);
    if (request.owner.length === 0) {
      throw this.#requestError("Lease owner must not be empty", { owner: request.owner });
    }
    if (!Number.isFinite(request.durationMs) || request.durationMs <= 0) {
      throw this.#requestError("Lease duration must be a positive finite number", {
        durationMs: request.durationMs,
      });
    }
    const acquiredAt = this.#clock.now();
    return {
      resource: request.resource,
      owner: request.owner,
      epoch: localEpoch,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(acquiredAt.getTime() + request.durationMs).toISOString(),
    };
  }

  async nextEpoch(resource: string): Promise<FencingEpoch> {
    this.#assertOpen();
    this.#assertResource(resource);
    return localEpoch;
  }

  async compareAndSet<T extends JsonValue>(
    request: CompareAndSetRequest<T>,
  ): Promise<CasResult<T>> {
    this.#assertOpen();
    if (request.key.length === 0) {
      throw this.#requestError("Compare-and-set key must not be empty", { key: request.key });
    }
    const current = this.#records.get(request.key);
    const matches =
      request.expectedRevision === undefined ||
      (request.expectedRevision === "absent"
        ? current === undefined
        : current?.revision === request.expectedRevision);
    if (!matches) {
      return current === undefined
        ? { applied: false }
        : {
            applied: false,
            value: cloneJson(current.value) as T,
            revision: current.revision,
          };
    }

    this.#revision += 1n;
    const revision = parseRevision(this.#revision.toString());
    const value = cloneJson(request.value);
    this.#records.set(request.key, { value, revision });
    const change: CoordinationChange = {
      key: request.key,
      revision,
      value: cloneJson(value),
    };
    this.#changes.push(change);
    for (const watcher of this.#watchers) {
      watcher.push(change);
    }
    return {
      applied: true,
      value: cloneJson(value),
      revision,
    };
  }

  watch(request: CoordinationWatchRequest): AsyncIterable<CoordinationChange> {
    this.#assertOpen();
    const cursor = BigInt(request.cursor);
    let watcher: CoordinationWatchIterator;
    watcher = new CoordinationWatchIterator(
      this.#changes.filter((change) => BigInt(change.revision) > cursor),
      () => this.#watchers.delete(watcher),
    );
    this.#watchers.add(watcher);
    return watcher;
  }

  async health(): Promise<DriverHealth> {
    this.#assertOpen();
    return {
      status: "healthy",
      checkedAt: this.#clock.now().toISOString(),
    };
  }

  async close(): Promise<void> {
    if (this.#lifecycle === "closed") {
      return;
    }
    this.#lifecycle = "closed";
    for (const watcher of [...this.#watchers]) {
      watcher.close();
    }
  }

  #assertOpen(): void {
    if (this.#lifecycle !== "open") {
      throw this.#closedError();
    }
  }

  #assertResource(resource: string): void {
    if (resource.length === 0) {
      throw this.#requestError("Coordination resource must not be empty", { resource });
    }
  }

  #requestError(message: string, details: JsonValue): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "COORDINATION_REQUEST_INVALID",
        message,
        source: { kind: "coordination", id: "local-coordination" },
        details,
        observedAt: this.#clock.now().toISOString(),
      }),
    );
  }

  #closedError(): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "COORDINATION_CLOSED",
        message: "Local coordination provider is closed",
        source: { kind: "coordination", id: "local-coordination" },
        details: { lifecycle: this.#lifecycle },
        observedAt: this.#clock.now().toISOString(),
      }),
    );
  }
}
