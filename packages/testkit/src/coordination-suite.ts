import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test } from "node:test";
import {
  diagnosticCode,
  parseRevision,
  type CoordinationChange,
  type CoordinationProvider,
} from "@tegojs/contracts";

export type CoordinationFactory = (
  namespace?: string,
) => CoordinationProvider | Promise<CoordinationProvider>;

export interface CoordinationConformanceOptions {
  readonly name?: string;
}

async function openProvider(factory: CoordinationFactory, namespace?: string) {
  const provider = await factory(namespace);
  await provider.open();
  return provider;
}

async function nextChange(
  iterator: AsyncIterator<CoordinationChange>,
  timeoutMs = 2_000,
): Promise<IteratorResult<CoordinationChange>> {
  return Promise.race([
    iterator.next(),
    delay(timeoutMs).then(() => {
      throw new Error("Timed out waiting for a coordination change");
    }),
  ]);
}

export function coordinationConformance(
  factory: CoordinationFactory,
  options: CoordinationConformanceOptions = {},
): void {
  describe(options.name ?? "CoordinationProvider conformance", () => {
    test("@spec:coordination-provider/provider-conformance-contract/namespaces", async () => {
      const left = await openProvider(factory, "left");
      const right = await openProvider(factory, "right");
      try {
        const [leftResult, rightResult] = await Promise.all([
          left.compareAndSet({
            key: "shared-key",
            expectedRevision: "absent",
            value: { namespace: "left" },
          }),
          right.compareAndSet({
            key: "shared-key",
            expectedRevision: "absent",
            value: { namespace: "right" },
          }),
        ]);
        assert.equal(leftResult.applied, true);
        assert.equal(rightResult.applied, true);
        assert.deepEqual(leftResult.value, { namespace: "left" });
        assert.deepEqual(rightResult.value, { namespace: "right" });
      } finally {
        await Promise.all([left.close(), right.close()]);
      }
    });

    test("@spec:coordination-provider/fenced-leadership/exclusive-monotonic-takeover", async () => {
      const leader = await openProvider(factory, "leadership");
      const follower = await openProvider(factory, "leadership");
      try {
        const first = await leader.campaign({ resource: "runtime" });
        let followerSettled = false;
        const takeover = follower.campaign({ resource: "runtime" }).then((value) => {
          followerSettled = true;
          return value;
        });
        await delay(50);
        assert.equal(followerSettled, false);

        await leader.close();
        const second = await takeover;
        assert.equal(second.resource, first.resource);
        assert.ok(BigInt(second.epoch) > BigInt(first.epoch));
        assert.equal(await follower.campaign({ resource: "runtime" }), second);
      } finally {
        await Promise.all([leader.close(), follower.close()]);
      }
    });

    test("@spec:coordination-provider/expiring-exclusive-leases/provider-time", async () => {
      const first = await openProvider(factory, "leases");
      const second = await openProvider(factory, "leases");
      try {
        const lease = await first.acquireLease({
          resource: "task/example",
          owner: "worker-a",
          durationMs: 100,
        });
        assert.equal(new Date(lease.acquiredAt).toISOString(), lease.acquiredAt);
        assert.equal(new Date(lease.expiresAt).toISOString(), lease.expiresAt);
        assert.ok(Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt));

        await assert.rejects(
          second.acquireLease({
            resource: "task/example",
            owner: "worker-b",
            durationMs: 100,
          }),
          (error: unknown) => diagnosticCode(error) === "COORDINATION_LEASE_HELD",
        );
        await delay(125);
        const takeover = await second.acquireLease({
          resource: "task/example",
          owner: "worker-b",
          durationMs: 100,
        });
        assert.ok(BigInt(takeover.epoch) > BigInt(lease.epoch));
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    });

    test("@spec:coordination-provider/atomic-compare-and-set/concurrent-writers", async () => {
      const left = await openProvider(factory, "cas");
      const right = await openProvider(factory, "cas");
      try {
        const initial = await left.compareAndSet({
          key: "contended",
          expectedRevision: "absent",
          value: { writer: "initial" },
        });
        assert.equal(initial.applied, true);
        assert.ok(initial.revision);

        const outcomes = await Promise.all([
          left.compareAndSet({
            key: "contended",
            expectedRevision: initial.revision,
            value: { writer: "left" },
          }),
          right.compareAndSet({
            key: "contended",
            expectedRevision: initial.revision,
            value: { writer: "right" },
          }),
        ]);
        assert.equal(outcomes.filter((outcome) => outcome.applied).length, 1);
        assert.equal(outcomes.filter((outcome) => !outcome.applied).length, 1);
        assert.ok(outcomes.every((outcome) => outcome.revision !== undefined));
      } finally {
        await Promise.all([left.close(), right.close()]);
      }
    });

    test("@spec:coordination-provider/lossless-watch-recovery/durable-catch-up", async () => {
      const writer = await openProvider(factory, "watch");
      const watcher = await openProvider(factory, "watch");
      try {
        const first = await writer.compareAndSet({
          key: "first",
          expectedRevision: "absent",
          value: { sequence: 1 },
        });
        assert.ok(first.revision);
        const second = await writer.compareAndSet({
          key: "second",
          expectedRevision: "absent",
          value: { sequence: 2 },
        });
        assert.ok(second.revision);

        const iterator = watcher.watch({ cursor: parseRevision("0") })[Symbol.asyncIterator]();
        assert.deepEqual(await nextChange(iterator), {
          done: false,
          value: {
            key: "first",
            revision: first.revision,
            value: { sequence: 1 },
          },
        });
        assert.deepEqual(await nextChange(iterator), {
          done: false,
          value: {
            key: "second",
            revision: second.revision,
            value: { sequence: 2 },
          },
        });
        await iterator.return?.();
      } finally {
        await Promise.all([writer.close(), watcher.close()]);
      }
    });

    test("@spec:coordination-provider/provider-conformance-contract/close-cleanup", async () => {
      const provider = await openProvider(factory, "close");
      const iterator = provider.watch({ cursor: parseRevision("0") })[Symbol.asyncIterator]();
      const pending = iterator.next();

      await provider.close();
      await provider.close();

      assert.deepEqual(await pending, { done: true, value: undefined });
      await assert.rejects(
        provider.compareAndSet({
          key: "closed",
          expectedRevision: "absent",
          value: null,
        }),
        (error: unknown) => diagnosticCode(error) === "COORDINATION_CLOSED",
      );
    });
  });
}
