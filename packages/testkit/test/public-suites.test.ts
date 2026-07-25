import { lifecycleConformance, manifestConformance, workerConformance } from "@tegojs/testkit";
import {
  parsePluginManifest,
  type JsonValue,
  type MessageId,
  type RuntimeLifecycleState,
  type WorkerId,
} from "@tegojs/contracts";

manifestConformance(() => ({
  parse: parsePluginManifest,
}));

class PublicLifecycleFixture {
  #state: RuntimeLifecycleState = "created";

  current(): RuntimeLifecycleState {
    return this.#state;
  }

  transition(next: RuntimeLifecycleState): RuntimeLifecycleState {
    if (next === this.#state) {
      return this.#state;
    }
    const allowed: Readonly<Record<RuntimeLifecycleState, readonly RuntimeLifecycleState[]>> = {
      created: ["failed", "opening", "stopping"],
      opening: ["failed", "recovering", "stopping"],
      recovering: ["electing", "failed", "stopping"],
      electing: ["failed", "running", "stopping"],
      running: ["draining", "failed"],
      draining: ["failed", "stopping"],
      stopping: ["failed", "stopped"],
      stopped: [],
      failed: ["stopping"],
    };
    if (!allowed[this.#state].includes(next)) {
      throw new Error(`invalid lifecycle transition: ${this.#state} -> ${next}`);
    }
    this.#state = next;
    return this.#state;
  }
}

lifecycleConformance(() => new PublicLifecycleFixture());

interface PublicWorkerRecord {
  readonly workerId: WorkerId;
  readonly epoch: string;
  readonly labels: Readonly<Record<string, JsonValue>>;
  readonly resources: Readonly<Record<string, JsonValue>>;
  readonly executors: readonly string[];
  readonly preparedArtifacts: readonly string[];
  readonly available: boolean;
  readonly heartbeatCount: number;
  readonly deliveryCount: number;
}

class PublicWorkerFixture {
  readonly #records = new Map<WorkerId, PublicWorkerRecord>();
  readonly #delivered = new Map<WorkerId, Set<MessageId>>();

  register(
    input: Omit<PublicWorkerRecord, "available" | "deliveryCount" | "epoch" | "heartbeatCount">,
  ) {
    const record = {
      ...structuredClone(input),
      epoch: "1",
      available: true,
      heartbeatCount: 0,
      deliveryCount: 0,
    } satisfies PublicWorkerRecord;
    this.#records.set(input.workerId, record);
    this.#delivered.set(input.workerId, new Set());
    return record;
  }

  snapshot(workerId: WorkerId): PublicWorkerRecord | undefined {
    return this.#records.get(workerId);
  }

  heartbeat(workerId: WorkerId): PublicWorkerRecord {
    return this.#update(workerId, (record) => ({
      ...record,
      available: true,
      heartbeatCount: record.heartbeatCount + 1,
    }));
  }

  disconnect(workerId: WorkerId): void {
    this.#update(workerId, (record) => ({ ...record, available: false }));
  }

  reconnect(workerId: WorkerId): PublicWorkerRecord {
    return this.#update(workerId, (record) => ({
      ...record,
      epoch: (BigInt(record.epoch) + 1n).toString(),
      available: true,
    }));
  }

  deliver(workerId: WorkerId, messageId: MessageId, _payload: JsonValue): boolean {
    const delivered = this.#delivered.get(workerId);
    if (delivered === undefined) {
      throw new Error("worker is not registered");
    }
    if (delivered.has(messageId)) {
      return false;
    }
    delivered.add(messageId);
    this.#update(workerId, (record) => ({
      ...record,
      deliveryCount: record.deliveryCount + 1,
    }));
    return true;
  }

  close(): void {
    this.#records.clear();
    this.#delivered.clear();
  }

  #update(
    workerId: WorkerId,
    update: (record: PublicWorkerRecord) => PublicWorkerRecord,
  ): PublicWorkerRecord {
    const current = this.#records.get(workerId);
    if (current === undefined) {
      throw new Error("worker is not registered");
    }
    const next = update(current);
    this.#records.set(workerId, next);
    return next;
  }
}

workerConformance(() => new PublicWorkerFixture());
