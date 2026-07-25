import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type JsonValue,
  parseFencingEpoch,
  parseRevision,
  parseWorkerId,
  type StateStore,
  type StateTransaction,
  type Versioned,
} from "@tegojs/contracts";
import { StateWorkerEpochAllocator } from "../src/index.js";

const MAXIMUM_UNSIGNED_64 = "18446744073709551615";

test("persistent Worker epochs fail without mutating state after the protocol limit", async () => {
  const workerId = parseWorkerId("worker-limit");
  const current: Versioned<{
    readonly workerId: typeof workerId;
    readonly epoch: ReturnType<typeof parseFencingEpoch>;
  }> = {
    value: {
      workerId,
      epoch: parseFencingEpoch(MAXIMUM_UNSIGNED_64),
    },
    revision: parseRevision("1"),
  };
  let writes = 0;
  const transaction = {
    get: async () => current,
    put: async () => {
      writes += 1;
    },
  } as unknown as StateTransaction;
  const state = {
    scope: "local",
    transact: async <T extends JsonValue>(
      _options: Parameters<StateStore["transact"]>[0],
      work: (active: StateTransaction) => Promise<T>,
    ): Promise<T> => work(transaction),
  } as StateStore;

  const allocator = new StateWorkerEpochAllocator({ state });

  await assert.rejects(
    allocator.next(workerId),
    (error: unknown) =>
      error instanceof Error &&
      "diagnostic" in error &&
      (error as { diagnostic: { code: string } }).diagnostic.code === "WORKER_EPOCH_LIMIT_EXCEEDED",
  );
  assert.equal(writes, 0);
});
