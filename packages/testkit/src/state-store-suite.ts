import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  OUTBOX_PAYLOAD_MAX_BYTES,
  OUTBOX_TOPIC_MAX_LENGTH,
  STATE_QUERY_MAX_LIMIT,
  diagnosticCode,
  compareOperationJournalCursors,
  parseFencingEpoch,
  parseMessageId,
  parseOperationId,
  parseRevision,
  type JsonObject,
  type JsonValue,
  type OperationJournalCursor,
  type PersistedOperationJournalEntry,
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

function jsonKey(namespace: string, id: string): StateKey<JsonValue> {
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

async function recoverableOperations(
  store: StateStore,
  query: Parameters<StateStore["scanRecoverableOperations"]>[0] = {},
): Promise<readonly PersistedOperationJournalEntry[]> {
  const entries = [];
  for await (const entry of store.scanRecoverableOperations(query)) {
    entries.push(entry);
  }
  return entries;
}

async function operations(
  store: StateStore,
  query: Parameters<StateStore["scanOperations"]>[0] = {},
): Promise<readonly PersistedOperationJournalEntry[]> {
  const entries = [];
  for await (const entry of store.scanOperations(query)) {
    entries.push(entry);
  }
  return entries;
}

async function scannedIds(
  store: StateStore,
  query: Parameters<StateStore["scan"]>[0],
): Promise<readonly string[]> {
  const ids = [];
  for await (const entry of store.scan(query)) {
    ids.push(entry.key.id);
  }
  return ids;
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

    test("state scans page exclusively in stable code-unit identifier order", async () => {
      await withStore(factory, async (store) => {
        await store.transact({}, async (transaction) => {
          for (const id of ["A", "_", "a", "-"]) {
            await transaction.put(key("state-pagination", id), { label: id }, {});
          }
          return null;
        });

        const first = await scannedIds(store, {
          namespace: "state-pagination",
          collection: "examples",
          limit: 2,
        });
        const firstCursor = first.at(-1);
        assert.notEqual(firstCursor, undefined);
        const second = await scannedIds(store, {
          namespace: "state-pagination",
          collection: "examples",
          afterId: firstCursor ?? "",
          limit: 2,
        });
        const secondCursor = second.at(-1);
        assert.notEqual(secondCursor, undefined);
        const exhausted = await scannedIds(store, {
          namespace: "state-pagination",
          collection: "examples",
          afterId: secondCursor ?? "",
          limit: 2,
        });

        assert.deepEqual(first, ["-", "A"]);
        assert.deepEqual(second, ["_", "a"]);
        assert.deepEqual(exhausted, []);
        assert.deepEqual([...first, ...second], ["-", "A", "_", "a"]);
      });
    });

    test("state keys and queries reject NUL and ill-formed Unicode consistently", async () => {
      await withStore(factory, async (store) => {
        const valid = key("portable-state", "valid");
        const invalidStrings = ["nul\u0000value", "high-\uD800", "low-\uDC00"];

        for (const invalid of invalidStrings) {
          for (const invalidKey of [
            { ...valid, namespace: invalid },
            { ...valid, collection: invalid },
            { ...valid, id: invalid },
          ]) {
            await assert.rejects(store.read(invalidKey), expectDiagnostic("STATE_QUERY_INVALID"));
            await assert.rejects(
              store.transact({}, async (transaction) => {
                await transaction.get(invalidKey);
                return null;
              }),
              expectDiagnostic("STATE_QUERY_INVALID"),
            );
            await assert.rejects(
              store.transact({}, async (transaction) => {
                await transaction.put(invalidKey, { label: "invalid" }, {});
                return null;
              }),
              expectDiagnostic("STATE_DATA_INVALID"),
            );
            await assert.rejects(
              store.transact({}, async (transaction) => {
                await transaction.delete(invalidKey, {});
                return null;
              }),
              expectDiagnostic("STATE_DATA_INVALID"),
            );
          }

          for (const invalidQuery of [
            { namespace: invalid, collection: "examples" },
            { namespace: "portable-state", collection: invalid },
            { namespace: "portable-state", collection: "examples", idPrefix: invalid },
            { namespace: "portable-state", collection: "examples", afterId: invalid },
          ]) {
            await assert.rejects(
              scannedIds(store, invalidQuery),
              expectDiagnostic("STATE_QUERY_INVALID"),
            );
            await assert.rejects(
              store.transact({}, async (transaction) => {
                for await (const _entry of transaction.scan(invalidQuery)) {
                  // Invalid queries must fail before yielding state.
                }
                return null;
              }),
              expectDiagnostic("STATE_QUERY_INVALID"),
            );
          }
        }
      });
    });

    test("state prefix and cursor pagination use exact ECMAScript UTF-16 order", async () => {
      await withStore(factory, async (store) => {
        const astral = "group-\u{10000}";
        const privateUseBmp = "group-\uE000";
        for (const id of [privateUseBmp, "group-A", "other", astral]) {
          await store.transact({}, async (transaction) => {
            await transaction.put(key("unicode-pagination", id), { label: id }, {});
            return null;
          });
        }

        const first = await scannedIds(store, {
          namespace: "unicode-pagination",
          collection: "examples",
          idPrefix: "group-",
          limit: 2,
        });
        const second = await scannedIds(store, {
          namespace: "unicode-pagination",
          collection: "examples",
          idPrefix: "group-",
          afterId: astral,
          limit: 2,
        });

        assert.deepEqual(first, ["group-A", astral]);
        assert.deepEqual(second, [privateUseBmp]);
        assert.deepEqual(await store.read(key("unicode-pagination", astral)), {
          revision: parseRevision("4"),
          value: { label: astral },
        });
      });
    });

    test("transaction state scans apply pagination after staged mutations", async () => {
      await withStore(factory, async (store) => {
        const first = key("transaction-pagination", "A");
        const second = key("transaction-pagination", "B");
        const third = key("transaction-pagination", "C");
        await store.transact({}, async (transaction) => {
          await transaction.put(first, { label: "A" }, {});
          await transaction.put(second, { label: "B" }, {});
          await transaction.put(third, { label: "C" }, {});
          return null;
        });

        await store.transact({}, async (transaction) => {
          await transaction.delete(first, {});
          await transaction.delete(second, {});
          await transaction.put(key("transaction-pagination", "D"), { label: "D" }, {});
          const ids = [];
          for await (const entry of transaction.scan<ExampleRecord>({
            namespace: "transaction-pagination",
            collection: "examples",
            afterId: "B",
            limit: 1,
          })) {
            ids.push(entry.key.id);
          }
          assert.deepEqual(ids, ["C"]);
          return null;
        });
      });
    });

    test("state scan limit is a positive safe integer within the public maximum", async () => {
      await withStore(factory, async (store) => {
        for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, STATE_QUERY_MAX_LIMIT + 1]) {
          await assert.rejects(
            scannedIds(store, {
              namespace: "state-pagination",
              collection: "examples",
              limit,
            }),
            expectDiagnostic("STATE_QUERY_INVALID"),
          );
        }
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

    test("outbox claims are unique, fenced, retry-visible, and idempotently acknowledged", async () => {
      await withStore(factory, async (store) => {
        const operationId = parseOperationId("operation-outbox");
        const messageId = parseMessageId("message-outbox");
        const outboxCreatedAt = new Date().toISOString();
        await store.transact({}, async (transaction) => {
          await transaction.enqueueOutbox({
            availableAt: outboxCreatedAt,
            createdAt: outboxCreatedAt,
            messageId,
            operationId,
            payload: { effect: "start" },
            topic: "component.lifecycle",
          });
          return null;
        });

        const [left, right] = await Promise.all([
          store.claimOutbox({ leaseDurationMs: 30_000, limit: 1, owner: "owner-left" }),
          store.claimOutbox({ leaseDurationMs: 30_000, limit: 1, owner: "owner-right" }),
        ]);
        assert.equal(left.length + right.length, 1);
        const claim = left[0] ?? right[0];
        assert.ok(claim);
        assert.equal(claim.attempt, 1);
        assert.equal(claim.claimEpoch, parseFencingEpoch("1"));
        assert.equal(claim.message.messageId, messageId);

        const retryAt = new Date(Date.now() + 60_000).toISOString();
        const retried = await store.acknowledgeOutbox({
          claimEpoch: claim.claimEpoch,
          messageId,
          outcome: "retry",
          owner: claim.owner,
          retryAt,
        });
        assert.equal(retried.attempt, 1);
        assert.equal(retried.duplicate, false);
        assert.equal(retried.messageId, messageId);
        assert.equal(retried.outcome, "retry");
        assert.equal(retried.retryAt, retryAt);
        assert.equal(new Date(retried.acknowledgedAt).toISOString(), retried.acknowledgedAt);
        assert.deepEqual(
          await store.acknowledgeOutbox({
            claimEpoch: claim.claimEpoch,
            messageId,
            outcome: "retry",
            owner: claim.owner,
            retryAt,
          }),
          { ...retried, duplicate: true },
        );
        assert.deepEqual(
          await store.claimOutbox({ leaseDurationMs: 30_000, limit: 1, owner: "too-early" }),
          [],
        );
      });
    });

    test("duplicate acknowledgement with newer authority advances the durable control-plane fence", async () => {
      await withStore(factory, async (store) => {
        const createdAt = new Date().toISOString();
        await store.transact({}, async (transaction) => {
          for (const suffix of ["first", "second"]) {
            await transaction.enqueueOutbox({
              availableAt: createdAt,
              createdAt,
              messageId: parseMessageId(`message-fenced-${suffix}`),
              operationId: parseOperationId(`operation-fenced-${suffix}`),
              payload: { suffix },
              topic: "component.lifecycle",
            });
          }
          return null;
        });
        const [claim] = await store.claimOutbox({
          fencing: { resource: "runtime", epoch: parseFencingEpoch("1") },
          leaseDurationMs: 30_000,
          limit: 1,
          owner: "owner",
        });
        assert.ok(claim);
        const request = {
          claimEpoch: claim.claimEpoch,
          messageId: claim.message.messageId,
          outcome: "completed",
          owner: claim.owner,
        } as const;
        await store.acknowledgeOutbox({
          ...request,
          fencing: { resource: "runtime", epoch: parseFencingEpoch("1") },
        });
        assert.equal(
          (
            await store.acknowledgeOutbox({
              ...request,
              fencing: { resource: "runtime", epoch: parseFencingEpoch("3") },
            })
          ).duplicate,
          true,
        );
        await assert.rejects(
          store.claimOutbox({
            fencing: { resource: "runtime", epoch: parseFencingEpoch("2") },
            leaseDurationMs: 30_000,
            limit: 1,
            owner: "stale-owner",
          }),
          expectDiagnostic("STATE_FENCE_STALE"),
        );
      });
    });

    test("outbox claims are isolated by topic", async () => {
      await withStore(factory, async (store) => {
        const createdAt = new Date().toISOString();
        await store.transact({}, async (transaction) => {
          for (const [suffix, topic] of [
            ["a-unrelated", "task.assignment"],
            ["z-lifecycle", "component.lifecycle"],
          ] as const) {
            await transaction.enqueueOutbox({
              availableAt: createdAt,
              createdAt,
              messageId: parseMessageId(`message-topic-${suffix}`),
              operationId: parseOperationId(`operation-topic-${suffix}`),
              payload: { suffix },
              topic,
            });
          }
          return null;
        });

        const [claim] = await store.claimOutbox({
          leaseDurationMs: 30_000,
          limit: 1,
          owner: "lifecycle-owner",
          topic: "component.lifecycle",
        });
        assert.ok(claim);
        assert.equal(claim.message.topic, "component.lifecycle");
        assert.equal(claim.message.messageId, parseMessageId("message-topic-z-lifecycle"));
      });
    });

    test("outbox claims preserve journal enqueue order instead of message-id order", async () => {
      await withStore(factory, async (store) => {
        const createdAt = new Date().toISOString();
        await store.transact({}, async (transaction) => {
          for (const [messageId, operationId] of [
            ["z-first", "operation-first"],
            ["a-second", "operation-second"],
          ] as const) {
            await transaction.enqueueOutbox({
              availableAt: createdAt,
              createdAt,
              messageId: parseMessageId(messageId),
              operationId: parseOperationId(operationId),
              payload: { messageId },
              topic: "component.lifecycle",
            });
          }
          return null;
        });

        const claims = await store.claimOutbox({
          leaseDurationMs: 30_000,
          limit: 2,
          owner: "ordered-owner",
        });
        assert.deepEqual(
          claims.map((claim) => claim.message.messageId),
          [parseMessageId("z-first"), parseMessageId("a-second")],
        );
      });
    });

    test("same-transaction outbox identities are idempotent or conflict atomically", async () => {
      await withStore(factory, async (store) => {
        const createdAt = new Date().toISOString();
        const identical = {
          availableAt: createdAt,
          createdAt,
          messageId: parseMessageId("same-transaction-identical"),
          operationId: parseOperationId("same-transaction-operation"),
          payload: { alpha: 1, zebra: 2 },
          topic: "component.lifecycle",
        };
        await store.transact({}, async (transaction) => {
          await transaction.enqueueOutbox(identical);
          await transaction.enqueueOutbox({
            ...identical,
            payload: { zebra: 2, alpha: 1 },
          });
          return null;
        });
        const identicalClaims = await store.claimOutbox({
          leaseDurationMs: 30_000,
          limit: 2,
          owner: "same-transaction-owner",
        });
        assert.deepEqual(
          identicalClaims.map((claim) => claim.message.messageId),
          [identical.messageId],
        );

        for (const scenario of [
          {
            name: "operation",
            change: {
              operationId: parseOperationId("same-transaction-operation-changed"),
            },
          },
          {
            name: "topic",
            change: {
              topic: "component.lifecycle.changed",
            },
          },
          {
            name: "payload",
            change: {
              payload: { alpha: 1, zebra: 3 },
            },
          },
        ] as const) {
          const messageId = parseMessageId(`same-transaction-conflict-${scenario.name}`);
          await assert.rejects(
            store.transact({}, async (transaction) => {
              const original = {
                availableAt: createdAt,
                createdAt,
                messageId,
                operationId: parseOperationId(
                  `same-transaction-conflict-operation-${scenario.name}`,
                ),
                payload: { alpha: 1, zebra: 2 },
                topic: "component.lifecycle",
              };
              await transaction.enqueueOutbox(original);
              await transaction.enqueueOutbox({
                ...original,
                ...scenario.change,
              });
              return null;
            }),
            expectDiagnostic("STATE_IDEMPOTENCY_CONFLICT"),
          );
        }
        const conflictClaims = await store.claimOutbox({
          leaseDurationMs: 30_000,
          limit: 10,
          owner: "same-transaction-conflict-owner",
        });
        assert.deepEqual(conflictClaims, []);
      });
    });

    test("state and outbox values use canonical JSON boundaries without invoking accessors", async () => {
      await withStore(factory, async (store) => {
        let getterCalls = 0;
        const accessor = {};
        Object.defineProperty(accessor, "secret", {
          enumerable: true,
          get() {
            getterCalls += 1;
            return "leaked";
          },
        });
        await assert.rejects(
          store.transact({}, async (transaction) => {
            await transaction.put(jsonKey("wire", "accessor"), accessor as JsonValue, {
              expectedRevision: "absent",
            });
            return null;
          }),
          expectDiagnostic("PROTOCOL_WIRE_VALUE_INVALID"),
        );
        assert.equal(getterCalls, 0);
        for (const [suffix, invalid] of [
          ["undefined", undefined],
          ["function", () => "invalid"],
          ["exotic", new (class NonJsonValue {})()],
        ] as const) {
          await assert.rejects(
            store.transact({}, async (transaction) => {
              await transaction.put(jsonKey("wire", suffix), invalid as unknown as JsonValue, {
                expectedRevision: "absent",
              });
              return null;
            }),
            expectDiagnostic("PROTOCOL_WIRE_VALUE_INVALID"),
          );
        }

        await store.transact({}, async (transaction) => {
          await transaction.put(
            jsonKey("wire", "canonical"),
            { zebra: 1, alpha: 2 },
            { expectedRevision: "absent" },
          );
          return null;
        });
        const canonical = await store.read(jsonKey("wire", "canonical"));
        assert.deepEqual(Object.keys(canonical?.value ?? {}), ["alpha", "zebra"]);

        const createdAt = new Date().toISOString();
        const messageId = parseMessageId("canonical-payload");
        const operationId = parseOperationId("canonical-operation");
        await assert.rejects(
          store.transact({}, async (transaction) => {
            await transaction.enqueueOutbox({
              availableAt: createdAt,
              createdAt,
              messageId: parseMessageId("accessor-payload"),
              operationId: parseOperationId("accessor-operation"),
              payload: accessor as JsonValue,
              topic: "component.lifecycle",
            });
            return null;
          }),
          expectDiagnostic("PROTOCOL_WIRE_VALUE_INVALID"),
        );
        assert.equal(getterCalls, 0);
        await store.transact({}, async (transaction) => {
          await transaction.enqueueOutbox({
            availableAt: createdAt,
            createdAt,
            messageId,
            operationId,
            payload: { zebra: 1, alpha: 2 },
            topic: "component.lifecycle",
          });
          return null;
        });
        await store.transact({}, async (transaction) => {
          await transaction.enqueueOutbox({
            availableAt: createdAt,
            createdAt,
            messageId,
            operationId,
            payload: { alpha: 2, zebra: 1 },
            topic: "component.lifecycle",
          });
          return null;
        });
      });
    });

    test("outbox topic and payload bounds are enforced at enqueue", async () => {
      await withStore(factory, async (store) => {
        const createdAt = new Date().toISOString();
        for (const [suffix, topic, payload] of [
          ["topic", "x".repeat(OUTBOX_TOPIC_MAX_LENGTH + 1), {}],
          ["payload", "component.lifecycle", { data: "x".repeat(OUTBOX_PAYLOAD_MAX_BYTES + 1) }],
        ] as const) {
          await assert.rejects(
            store.transact({}, async (transaction) => {
              await transaction.enqueueOutbox({
                availableAt: createdAt,
                createdAt,
                messageId: parseMessageId(`bounded-${suffix}`),
                operationId: parseOperationId(`bounded-${suffix}`),
                payload,
                topic,
              });
              return null;
            }),
            expectDiagnostic("STATE_DATA_INVALID"),
          );
        }
      });
    });

    test("retry acknowledgement can be superseded by a corrected stable message", async () => {
      await withStore(factory, async (store) => {
        const createdAt = new Date().toISOString();
        const messageId = parseMessageId("corrected-stable-message");
        const operationId = parseOperationId("corrected-stable-operation");
        await store.transact({}, async (transaction) => {
          await transaction.enqueueOutbox({
            availableAt: createdAt,
            createdAt,
            messageId,
            operationId,
            payload: { executor: "process" },
            topic: "component.lifecycle",
          });
          return null;
        });
        const [original] = await store.claimOutbox({
          leaseDurationMs: 30_000,
          owner: "corrector",
        });
        assert.ok(original);
        await store.acknowledgeOutbox({
          claimEpoch: original.claimEpoch,
          messageId,
          outcome: "retry",
          owner: original.owner,
          retryAt: createdAt,
        });
        await store.transact({}, async (transaction) => {
          await transaction.enqueueOutbox({
            availableAt: createdAt,
            createdAt,
            messageId,
            operationId,
            payload: { executor: "thread" },
            topic: "component.lifecycle",
          });
          return null;
        });

        const [corrected] = await store.claimOutbox({
          leaseDurationMs: 30_000,
          owner: "corrected-owner",
        });
        assert.ok(corrected);
        assert.deepEqual(corrected.message.payload, { executor: "thread" });
        assert.equal(corrected.attempt, 1);
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

    test("@spec:runtime-bootstrap/durable-restart-recovery/deterministic-operation-journal-query", async () => {
      await withStore(factory, async (store) => {
        await store.transact({}, async (transaction) => {
          for (const [operationId, status] of [
            ["operation-z", "planned"],
            ["operation-a", "executing"],
            ["operation-completed", "completed"],
          ] as const) {
            await transaction.appendOperation({
              operationId: parseOperationId(operationId),
              kind: "deploy",
              status,
              state: { operationId },
              updatedAt: "2026-07-23T00:00:00.000Z",
            });
          }
          return null;
        });
        await store.transact({}, async (transaction) => {
          await transaction.appendOperation({
            operationId: parseOperationId("operation-b"),
            kind: "install",
            status: "planned",
            state: null,
            updatedAt: "2026-07-23T00:00:01.000Z",
          });
          await transaction.appendOperation({
            operationId: parseOperationId("operation-failed"),
            kind: "install",
            status: "failed",
            state: null,
            updatedAt: "2026-07-23T00:00:01.000Z",
          });
          return null;
        });

        const firstPage = await recoverableOperations(store, { limit: 2 });
        assert.deepEqual(
          firstPage.map(({ operationId, revision }) => [operationId, revision]),
          [
            ["operation-a", parseRevision("1")],
            ["operation-z", parseRevision("1")],
          ],
        );
        const cursor = {
          revision: firstPage[1]?.revision ?? parseRevision("0"),
          operationId: firstPage[1]?.operationId ?? parseOperationId("missing"),
        };
        const secondPage = await recoverableOperations(store, { after: cursor, limit: 2 });
        assert.deepEqual(
          secondPage.map(({ operationId, revision }) => [operationId, revision]),
          [["operation-b", parseRevision("2")]],
        );
      });
    });

    test("operation scans return every latest status while recoverable scans remain filtered", async () => {
      await withStore(factory, async (store) => {
        await store.transact({}, async (transaction) => {
          for (const [operationId, status] of [
            ["operation-completed", "completed"],
            ["operation-executing", "executing"],
            ["operation-failed", "failed"],
            ["operation-transitioned", "planned"],
          ] as const) {
            await transaction.appendOperation({
              operationId: parseOperationId(operationId),
              kind: "deploy",
              status,
              state: { status },
              updatedAt: "2026-07-23T00:00:00.000Z",
            });
          }
          return null;
        });
        await store.transact({}, async (transaction) => {
          await transaction.appendOperation({
            operationId: parseOperationId("operation-transitioned"),
            kind: "deploy",
            status: "completed",
            state: { status: "completed" },
            updatedAt: "2026-07-23T00:00:01.000Z",
          });
          return null;
        });

        const firstPage = await operations(store, { limit: 2 });
        const cursor = {
          revision: firstPage.at(-1)?.revision ?? parseRevision("0"),
          operationId:
            firstPage.at(-1)?.operationId ?? parseOperationId("missing-operation-cursor"),
        };
        const secondPage = await operations(store, { after: cursor, limit: 2 });

        assert.deepEqual(
          [...firstPage, ...secondPage].map(({ operationId, revision, status }) => [
            operationId,
            revision,
            status,
          ]),
          [
            ["operation-completed", parseRevision("1"), "completed"],
            ["operation-executing", parseRevision("1"), "executing"],
            ["operation-failed", parseRevision("1"), "failed"],
            ["operation-transitioned", parseRevision("2"), "completed"],
          ],
        );
        assert.deepEqual(
          (await recoverableOperations(store)).map(({ operationId, status }) => [
            operationId,
            status,
          ]),
          [["operation-executing", "executing"]],
        );
      });
    });

    test("operation journal cursor ordering is exact above Number.MAX_SAFE_INTEGER", () => {
      const left = {
        revision: parseRevision("9007199254740992"),
        operationId: parseOperationId("operation-z"),
      } satisfies OperationJournalCursor;
      const right = {
        revision: parseRevision("9007199254740993"),
        operationId: parseOperationId("operation-a"),
      } satisfies OperationJournalCursor;

      assert.equal(compareOperationJournalCursors(left, right), -1);
      assert.equal(compareOperationJournalCursors(right, left), 1);
    });
  });
}
