import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSemanticSnapshot,
  semanticSnapshotCollections,
  settleWithCleanup,
} from "../support/single-main-process.mjs";

function record(collection, index, suffix = "") {
  if (collection === "operations") {
    return {
      kind: "task.run",
      operationId: `operation-${String(index).padStart(2, "0")}${suffix}`,
      revision: String(index),
      status: "completed",
      updatedAt: "2026-07-27T00:00:00.000Z",
    };
  }
  return {
    id: `${collection}-${String(index).padStart(2, "0")}${suffix}`,
    revision: String(index),
    value: { index, suffix },
  };
}

function paginatedSnapshotFetcher({
  repeatCursorFor,
  duplicateBoundaryFor,
  lastSuffix = "-different",
} = {}) {
  const calls = [];
  const fetchSnapshot = async ({ cursors = {} }) => {
    calls.push(cursors);
    return Object.fromEntries(
      semanticSnapshotCollections.map((collection) => {
        const cursor = cursors[collection];
        if (cursor === undefined) {
          return [
            collection,
            {
              items: Array.from({ length: 25 }, (_, index) => record(collection, index + 1)),
              nextCursor: `${collection}-page-2`,
            },
          ];
        }
        assert.equal(cursor, `${collection}-page-2`);
        return [
          collection,
          {
            items: [
              record(
                collection,
                duplicateBoundaryFor === collection ? 25 : 26,
                duplicateBoundaryFor === collection ? "" : lastSuffix,
              ),
            ],
            ...(repeatCursorFor === collection ? { nextCursor: cursor } : {}),
          },
        ];
      }),
    );
  };
  return { calls, fetchSnapshot };
}

test("collectSemanticSnapshot detects a difference at record 26 in every collection", async () => {
  const follower = paginatedSnapshotFetcher({ lastSuffix: "-follower" });
  const leader = paginatedSnapshotFetcher({ lastSuffix: "-leader" });

  const followerSnapshot = await collectSemanticSnapshot(follower.fetchSnapshot);
  const leaderSnapshot = await collectSemanticSnapshot(leader.fetchSnapshot);

  assert.notDeepEqual(followerSnapshot, leaderSnapshot);
  for (const collection of semanticSnapshotCollections) {
    assert.equal(followerSnapshot[collection].length, 26);
    assert.equal(leaderSnapshot[collection].length, 26);
    assert.match(
      collection === "operations"
        ? followerSnapshot[collection][25].operationId
        : followerSnapshot[collection][25].id,
      /-follower$/,
    );
    assert.equal(
      follower.calls.some((cursors) => cursors[collection] === `${collection}-page-2`),
      true,
    );
    assert.equal(
      leader.calls.some((cursors) => cursors[collection] === `${collection}-page-2`),
      true,
    );
  }
});

test("collectSemanticSnapshot rejects a repeated pagination cursor", async () => {
  const { fetchSnapshot } = paginatedSnapshotFetcher({ repeatCursorFor: "tasks" });

  await assert.rejects(
    collectSemanticSnapshot(fetchSnapshot),
    /RUNTIME_SNAPSHOT_CURSOR_REPEATED:tasks/,
  );
});

test("collectSemanticSnapshot rejects a record duplicated across a page boundary", async () => {
  const { fetchSnapshot } = paginatedSnapshotFetcher({ duplicateBoundaryFor: "deployments" });

  await assert.rejects(
    collectSemanticSnapshot(fetchSnapshot),
    /RUNTIME_SNAPSHOT_RECORD_REPEATED:deployments/,
  );
});

test("settleWithCleanup attempts every cleanup and aggregates cleanup errors", async () => {
  const calls = [];
  const firstError = new Error("worker stop failed");
  const secondError = new Error("runtime stop failed");

  await assert.rejects(
    settleWithCleanup(
      async () => "result",
      [
        async () => {
          calls.push("worker");
          throw firstError;
        },
        async () => {
          calls.push("runtime");
          throw secondError;
        },
        async () => {
          calls.push("directory");
        },
      ],
    ),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [firstError, secondError]);
      return true;
    },
  );
  assert.deepEqual(calls, ["worker", "runtime", "directory"]);
});

test("settleWithCleanup preserves the operation error alongside cleanup errors", async () => {
  const operationError = new Error("test failed");
  const cleanupError = new Error("process stop failed");

  await assert.rejects(
    settleWithCleanup(async () => {
      throw operationError;
    }, [
      async () => {
        throw cleanupError;
      },
    ]),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [operationError, cleanupError]);
      return true;
    },
  );
});
