import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  diagnosticCode,
  parseFencingEpoch,
  parseRevision,
  type JsonObject,
  type JsonValue,
  type StateKey,
  type StateStore,
  type StateTransactionOptions,
} from "@tegojs/contracts";

export type StateStoreFactory = () => StateStore | Promise<StateStore>;

export interface StateStoreConformanceOptions {
  readonly name?: string;
}

interface ExampleRecord extends JsonObject {
  readonly label: string;
}

const zero = parseRevision("0");

function key(namespace: string, id: string): StateKey<ExampleRecord> {
  return { namespace, collection: "examples", id };
}

async function withStore<T>(
  factory: StateStoreFactory,
  run: (store: StateStore) => Promise<T>,
): Promise<T> {
  const store = await factory();
  await store.open();
  try {
    return await run(store);
  } finally {
    await store.close();
  }
}

function expectDiagnostic(code: string): (error: unknown) => boolean {
  return (error) => diagnosticCode(error) === code;
}

export function stateStoreConformance(
  factory: StateStoreFactory,
  options: StateStoreConformanceOptions = {},
): void {
  describe(options.name ?? "StateStore conformance", () => {
    test("@spec:runtime-operations/reusable-conformance-test-kits/atomic-commit", async () => {
      await withStore(factory, async (store) => {
        const first = key("atomic", "first");
        const second = key("atomic", "second");

        await store.transact({}, async (transaction) => {
          await transaction.put(first, { label: "one" }, { expectedRevision: "absent" });
          await transaction.put(second, { label: "two" }, { expectedRevision: "absent" });
          return null;
        });

        const [firstRecord, secondRecord] = await Promise.all([
          store.read(first),
          store.read(second),
        ]);
        assert.deepEqual(firstRecord?.value, { label: "one" });
        assert.deepEqual(secondRecord?.value, { label: "two" });
        assert.equal(firstRecord?.revision, secondRecord?.revision);
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/rollback", async () => {
      await withStore(factory, async (store) => {
        const aborted = key("rollback", "aborted");
        await assert.rejects(
          store.transact({}, async (transaction) => {
            await transaction.put(aborted, { label: "discarded" }, {});
            throw new Error("abort");
          }),
          /abort/u,
        );
        assert.equal(await store.read(aborted), undefined);

        const committed = key("rollback", "committed");
        await store.transact({}, async (transaction) => {
          await transaction.put(committed, { label: "kept" }, {});
          return null;
        });
        assert.equal((await store.read(committed))?.revision, parseRevision("1"));
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/revision-conflict", async () => {
      await withStore(factory, async (store) => {
        const recordKey = key("conflict", "record");
        await store.transact({}, async (transaction) => {
          await transaction.put(recordKey, { label: "initial" }, { expectedRevision: "absent" });
          return null;
        });

        await assert.rejects(
          store.transact({}, async (transaction) => {
            await transaction.put(
              recordKey,
              { label: "stale" },
              { expectedRevision: parseRevision("0") },
            );
            return null;
          }),
          expectDiagnostic("STATE_REVISION_CONFLICT"),
        );
        assert.deepEqual((await store.read(recordKey))?.value, { label: "initial" });
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/decimal-revisions", async () => {
      await withStore(factory, async (store) => {
        const first = key("revisions", "first");
        const second = key("revisions", "second");
        await store.transact({}, async (transaction) => {
          await transaction.put(first, { label: "one" }, {});
          return null;
        });
        await store.transact({}, async () => null);
        await store.transact({}, async (transaction) => {
          await transaction.put(second, { label: "two" }, {});
          return null;
        });

        assert.equal((await store.read(first))?.revision, parseRevision("1"));
        assert.equal((await store.read(second))?.revision, parseRevision("2"));
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/namespaces", async () => {
      await withStore(factory, async (store) => {
        const left = key("left", "shared");
        const right = key("right", "shared");
        await store.transact({}, async (transaction) => {
          await transaction.put(left, { label: "left" }, {});
          await transaction.put(right, { label: "right" }, {});
          return null;
        });

        assert.deepEqual((await store.read(left))?.value, { label: "left" });
        assert.deepEqual((await store.read(right))?.value, { label: "right" });
        const leftRecords = [];
        for await (const record of store.scan<ExampleRecord>({
          namespace: "left",
          collection: "examples",
        })) {
          leftRecords.push(record);
        }
        assert.deepEqual(
          leftRecords.map((record) => record.key),
          [left],
        );
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/code-unit-order", async () => {
      await withStore(factory, async (store) => {
        const ids = ["A", "_", "a", "-"];
        const iterator = store.watch(zero)[Symbol.asyncIterator]();
        await store.transact({}, async (transaction) => {
          for (const id of ids) {
            await transaction.put(key("order", id), { label: id }, {});
          }
          return null;
        });

        const scanned = [];
        for await (const record of store.scan<ExampleRecord>({
          namespace: "order",
          collection: "examples",
        })) {
          scanned.push(record.key.id);
        }
        const changed = [];
        for (const _id of ids) {
          const result = await iterator.next();
          assert.equal(result.done, false);
          changed.push(result.value?.key.id);
        }
        await iterator.return?.();

        assert.deepEqual(scanned, ["-", "A", "_", "a"]);
        assert.deepEqual(changed, ["-", "A", "_", "a"]);
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/watch-cursor", async () => {
      await withStore(factory, async (store) => {
        const beforeCursor = key("watch", "before");
        await store.transact({}, async (transaction) => {
          await transaction.put(beforeCursor, { label: "before" }, {});
          return null;
        });
        const cursor = (await store.read(beforeCursor))?.revision;
        assert.notEqual(cursor, undefined);

        const iterator = store.watch(cursor ?? zero)[Symbol.asyncIterator]();
        const nextChange = iterator.next();
        const afterCursor = key("watch", "after");
        await store.transact({}, async (transaction) => {
          await transaction.put(afterCursor, { label: "after" }, {});
          return null;
        });

        assert.deepEqual(await nextChange, {
          done: false,
          value: {
            revision: parseRevision("2"),
            key: afterCursor,
            kind: "put",
            value: { label: "after" },
          },
        });
        await iterator.return?.();
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/idempotency-replay", async () => {
      await withStore(factory, async (store) => {
        let invocations = 0;
        const recordKey = key("idempotency", "record");
        const run = () =>
          store.transact<JsonValue>(
            {
              idempotencyKey: "stable-key",
              idempotencyFingerprint: "stable-request",
            },
            async (transaction) => {
              invocations += 1;
              await transaction.put(recordKey, { label: `run-${invocations}` }, {});
              return { invocation: invocations };
            },
          );

        const first = await run();
        const replay = await run();

        assert.deepEqual(replay, first);
        assert.equal(invocations, 1);
        assert.equal((await store.read(recordKey))?.revision, parseRevision("1"));
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/reentrant-idempotency-replay", async () => {
      await withStore(factory, async (store) => {
        let nestedWorkInvocations = 0;
        let nestedResult!: Promise<JsonValue>;
        const options = {
          idempotencyKey: "reentrant-key",
          idempotencyFingerprint: "same-request",
        } as const;

        const outerResult = await store.transact<JsonValue>(options, async () => {
          nestedResult = store.transact<JsonValue>(options, async () => {
            nestedWorkInvocations += 1;
            return { source: "nested" };
          });
          await Promise.resolve();
          return { source: "outer" };
        });

        assert.deepEqual(outerResult, { source: "outer" });
        assert.deepEqual(await nestedResult, outerResult);
        assert.equal(nestedWorkInvocations, 0);
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/reentrant-idempotency-conflict", async () => {
      await withStore(factory, async (store) => {
        let nestedWorkInvocations = 0;
        let nestedRejection!: Promise<void>;

        const outerResult = await store.transact<JsonValue>(
          {
            idempotencyKey: "reentrant-conflict-key",
            idempotencyFingerprint: "outer-request",
          },
          async () => {
            const nested = store.transact(
              {
                idempotencyKey: "reentrant-conflict-key",
                idempotencyFingerprint: "nested-request",
              },
              async () => {
                nestedWorkInvocations += 1;
                return null;
              },
            );
            nestedRejection = assert.rejects(
              nested,
              expectDiagnostic("STATE_IDEMPOTENCY_CONFLICT"),
            );
            await Promise.resolve();
            return { source: "outer" };
          },
        );

        assert.deepEqual(outerResult, { source: "outer" });
        await nestedRejection;
        assert.equal(nestedWorkInvocations, 0);
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/reentrant-idempotency-failure", async () => {
      await withStore(factory, async (store) => {
        let nestedWorkInvocations = 0;
        let nestedOutcome!: Promise<
          | { readonly error: unknown; readonly status: "rejected" }
          | { readonly status: "fulfilled"; readonly value: JsonValue }
        >;
        const options = {
          idempotencyKey: "reentrant-failure-key",
          idempotencyFingerprint: "failing-request",
        } as const;

        await assert.rejects(
          store.transact(options, async () => {
            const nested = store.transact(options, async () => {
              nestedWorkInvocations += 1;
              return { source: "nested" };
            });
            nestedOutcome = nested.then(
              (value) => ({ status: "fulfilled", value }),
              (error: unknown) => ({ status: "rejected", error }),
            );
            await Promise.resolve();
            throw new Error("outer failure");
          }),
          /outer failure/u,
        );
        const outcome = await nestedOutcome;
        assert.equal(outcome.status, "rejected");
        if (outcome.status === "rejected") {
          assert.match(String(outcome.error), /outer failure/u);
        }
        assert.equal(nestedWorkInvocations, 0);

        const retry = await store.transact(options, async () => ({ source: "retry" }));
        assert.deepEqual(retry, { source: "retry" });
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/idempotency-conflict", async () => {
      await withStore(factory, async (store) => {
        let invocations = 0;
        await store.transact(
          {
            idempotencyKey: "reused-key",
            idempotencyFingerprint: "request-one",
          },
          async () => {
            invocations += 1;
            return null;
          },
        );

        await assert.rejects(
          store.transact(
            {
              idempotencyKey: "reused-key",
              idempotencyFingerprint: "request-two",
            },
            async () => {
              invocations += 1;
              return null;
            },
          ),
          expectDiagnostic("STATE_IDEMPOTENCY_CONFLICT"),
        );
        assert.equal(invocations, 1);
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/idempotency-options", async () => {
      await withStore(factory, async (store) => {
        let invocations = 0;
        const invalidOptions = [
          { idempotencyKey: "missing-fingerprint" },
          { idempotencyFingerprint: "missing-key" },
        ] as unknown as readonly StateTransactionOptions[];

        for (const options of invalidOptions) {
          await assert.rejects(
            store.transact(options, async () => {
              invocations += 1;
              return null;
            }),
            expectDiagnostic("STATE_IDEMPOTENCY_CONFLICT"),
          );
        }
        assert.equal(invocations, 0);
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/stale-fence", async () => {
      await withStore(factory, async (store) => {
        await store.transact(
          { fencing: { resource: "runtime", epoch: parseFencingEpoch("2") } },
          async (transaction) => {
            await transaction.put(key("fence", "leader"), { label: "current" }, {});
            return null;
          },
        );

        const stale = key("fence", "stale");
        await assert.rejects(
          store.transact(
            { fencing: { resource: "runtime", epoch: parseFencingEpoch("1") } },
            async (transaction) => {
              await transaction.put(stale, { label: "rejected" }, {});
              return null;
            },
          ),
          expectDiagnostic("STATE_FENCE_STALE"),
        );
        assert.equal(await store.read(stale), undefined);
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/close-cleanup", async () => {
      const store = await factory();
      await store.open();
      const iterator = store.watch(zero)[Symbol.asyncIterator]();
      const pending = iterator.next();

      await store.close();
      await store.close();

      assert.deepEqual(await pending, { done: true, value: undefined });
      await assert.rejects(store.read(key("closed", "record")), expectDiagnostic("STATE_CLOSED"));
    });
  });
}
