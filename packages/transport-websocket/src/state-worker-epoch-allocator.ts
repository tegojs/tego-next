import {
  DiagnosticError,
  parseFencingEpoch,
  parseWorkerId,
  runtimeDiagnostic,
  type FencingEpoch,
  type JsonObject,
  type StateKey,
  type StateStore,
  type WorkerId,
} from "@tegojs/contracts";
import type { WorkerEpochAllocator } from "./main-endpoint.js";

interface WorkerEpochRecord extends JsonObject {
  readonly workerId: WorkerId;
  readonly epoch: FencingEpoch;
}

export interface StateWorkerEpochAllocatorOptions {
  readonly state: StateStore;
}

function epochKey(workerId: WorkerId): StateKey<WorkerEpochRecord> {
  return {
    namespace: "tego",
    collection: "worker-session-epochs",
    id: workerId,
  };
}

function invalidRecord(workerId: WorkerId, cause?: unknown): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "WORKER_EPOCH_RECORD_INVALID",
      message: "Persisted Worker session epoch is invalid",
      source: { kind: "worker", id: workerId },
      details: {
        workerId,
        ...(cause instanceof Error ? { cause: cause.message } : {}),
      },
    }),
  );
}

export class StateWorkerEpochAllocator implements WorkerEpochAllocator {
  readonly #state: StateStore;

  constructor(options: StateWorkerEpochAllocatorOptions) {
    this.#state = options.state;
  }

  next(workerIdValue: WorkerId): Promise<FencingEpoch> {
    const workerId = parseWorkerId(workerIdValue);
    return this.#state.transact({}, async (transaction) => {
      const key = epochKey(workerId);
      const current = await transaction.get(key);
      let previous = 0n;
      if (current !== undefined) {
        try {
          if (
            current.value.workerId !== workerId ||
            parseWorkerId(current.value.workerId) !== workerId
          ) {
            throw new TypeError("Worker epoch record identity does not match its key");
          }
          previous = BigInt(parseFencingEpoch(current.value.epoch));
        } catch (error) {
          throw invalidRecord(workerId, error);
        }
      }
      let epoch: FencingEpoch;
      try {
        epoch = parseFencingEpoch((previous + 1n).toString());
      } catch (error) {
        throw invalidRecord(workerId, error);
      }
      await transaction.put(
        key,
        { workerId, epoch },
        {
          expectedRevision: current?.revision ?? "absent",
        },
      );
      return epoch;
    });
  }
}
