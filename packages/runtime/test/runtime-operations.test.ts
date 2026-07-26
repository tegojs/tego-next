import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareOperationJournalCursors,
  createRuntimeSnapshotStateCursor,
  DiagnosticError,
  type JsonObject,
  type JsonValue,
  type PersistedOperationJournalEntry,
  parseOperationId,
  parseRevision,
  parseRuntimeSnapshotCursor,
  parseRuntimeSnapshotResponse,
  type RuntimeOperations,
  type ScannedState,
  type StateQuery,
  type StateStore,
} from "@tegojs/contracts";
import { FakeClock } from "@tegojs/testkit";
import { RuntimeOperationController } from "../src/runtime-operations.js";

interface SnapshotRequest {
  readonly limit?: number;
  readonly cursors?: {
    readonly deployments?: string;
    readonly installations?: string;
    readonly instances?: string;
    readonly operations?: string;
    readonly tasks?: string;
  };
  readonly projection?: {
    readonly deploymentConfiguration?: boolean;
    readonly taskInput?: boolean;
    readonly taskOutput?: boolean;
  };
}

interface SnapshotPage {
  readonly items: readonly JsonObject[];
  readonly nextCursor?: string;
}

interface SnapshotResponse {
  readonly deployments: SnapshotPage;
  readonly installations: SnapshotPage;
  readonly instances: SnapshotPage;
  readonly operations: SnapshotPage;
  readonly tasks: SnapshotPage;
}

function snapshotOperation(
  controller: RuntimeOperationController,
): (request: SnapshotRequest) => Promise<SnapshotResponse> {
  return (
    controller as unknown as RuntimeOperations & {
      snapshot(request: SnapshotRequest): Promise<SnapshotResponse>;
    }
  ).snapshot.bind(controller);
}

const cursorPrefix = "tego.snapshot.v1.";

function cursorFromJson(json: string, padded = false): string {
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  return `${cursorPrefix}${encoded}${padded ? "=" : ""}`;
}

function record(id: string, value: JsonObject, revision: string): ScannedState<JsonObject> {
  return {
    key: { namespace: "tego", collection: "unused", id },
    revision: parseRevision(revision),
    value,
  };
}

function stateStore() {
  const scans: StateQuery<JsonValue>[] = [];
  const latestOperationScans: unknown[] = [];
  const operationScans: unknown[] = [];
  const records = new Map<string, readonly ScannedState<JsonObject>[]>([
    [
      "installations",
      [
        record(
          "installation-a",
          {
            pluginId: "plugin-a",
            version: "1.0.0",
            digest: `sha256:${"a".repeat(64)}`,
            installedAt: "2026-07-25T00:00:00.000Z",
            manifest: { metadata: { privateBuildNote: "do-not-export" } },
          },
          "1",
        ),
        record(
          "installation-b",
          {
            pluginId: "plugin-b",
            version: "1.0.0",
            digest: `sha256:${"b".repeat(64)}`,
            installedAt: "2026-07-25T00:00:00.000Z",
            manifest: { metadata: { privateBuildNote: "do-not-export" } },
          },
          "2",
        ),
      ],
    ],
    [
      "deployments",
      [
        record(
          "application-a/plugin-a",
          {
            applicationId: "application-a",
            pluginId: "plugin-a",
            version: "1.0.0",
            artifactDigest: `sha256:${"a".repeat(64)}`,
            generation: "1",
            state: "active",
            essential: false,
            configuration: {
              token: "deployment-secret",
              authority: "configuration-authority",
              epoch: "configuration-epoch",
              session: "configuration-session",
              sessionId: "configuration-session-id",
            },
            permissionGrants: [],
            capabilityBindings: {},
          },
          "3",
        ),
      ],
    ],
    [
      "component-instances",
      [
        record(
          "instance-a",
          {
            instanceId: "instance-a",
            applicationId: "application-a",
            pluginId: "plugin-a",
            componentId: "component-a",
            deploymentGeneration: "1",
            observedGeneration: "1",
            lifecycle: "ready",
            executor: "thread",
            authority: { resource: "runtime:one", epoch: "19" },
          },
          "4",
        ),
      ],
    ],
    [
      "tasks",
      [
        record(
          "task-a",
          {
            taskId: "task-a",
            attemptId: "attempt-a",
            request: {
              applicationId: "application-a",
              pluginId: "plugin-a",
              componentId: "component-a",
              input: {
                token: "task-input-secret",
                authority: "input-authority",
                epoch: "input-epoch",
                session: "input-session",
                sessionId: "input-session-id",
              },
              deadline: "2026-07-25T01:00:00.000Z",
              orphanPolicy: "cancel",
            },
            state: "terminal",
            createdAt: "2026-07-25T00:00:00.000Z",
            updatedAt: "2026-07-25T00:00:01.000Z",
            authority: { resource: "runtime:one", epoch: "19" },
            cancellation: {
              requestedAt: "2026-07-25T00:00:00.500Z",
              authority: { resource: "runtime:one", epoch: "19" },
            },
            result: {
              taskId: "task-a",
              attemptId: "attempt-a",
              executor: { kind: "thread" },
              startedAt: "2026-07-25T00:00:00.000Z",
              completedAt: "2026-07-25T00:00:01.000Z",
              status: "succeeded",
              output: {
                token: "task-output-secret",
                authority: "output-authority",
                epoch: "output-epoch",
                session: "output-session",
                sessionId: "output-session-id",
              },
            },
          },
          "5",
        ),
      ],
    ],
  ]);
  const operations: PersistedOperationJournalEntry[] = [
    {
      operationId: parseOperationId("operation-a"),
      kind: "reconcile.prepare",
      status: "completed" as const,
      state: {
        privateState: "do-not-export",
        authority: { resource: "runtime:one", epoch: "19" },
      },
      updatedAt: "2026-07-25T00:00:01.000Z",
      revision: parseRevision("6"),
    },
  ];
  const scanOperations = (
    source: readonly PersistedOperationJournalEntry[],
    query: {
      readonly after?: { readonly revision: string; readonly operationId: string };
      readonly limit?: number;
    },
  ) => {
    const candidates = source
      .filter(
        (entry) =>
          query.after === undefined ||
          compareOperationJournalCursors(entry, {
            revision: parseRevision(query.after.revision),
            operationId: parseOperationId(query.after.operationId),
          }) > 0,
      )
      .sort(compareOperationJournalCursors)
      .slice(0, query.limit);
    return {
      async *[Symbol.asyncIterator]() {
        yield* candidates;
      },
    };
  };
  const state = {
    scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>> {
      scans.push(query as StateQuery<JsonValue>);
      const candidates = (records.get(query.collection) ?? [])
        .filter((entry) => query.afterId === undefined || entry.key.id > query.afterId)
        .slice(0, query.limit);
      return {
        async *[Symbol.asyncIterator]() {
          for (const entry of candidates) {
            yield {
              ...entry,
              key: { ...entry.key, collection: query.collection },
            } as ScannedState<T>;
          }
        },
      };
    },
    scanOperations(query: {
      readonly after?: { readonly revision: string; readonly operationId: string };
      readonly limit?: number;
    }) {
      latestOperationScans.push(query);
      const latest = new Map<string, PersistedOperationJournalEntry>();
      for (const entry of operations) latest.set(entry.operationId, entry);
      return scanOperations([...latest.values()], query);
    },
    scanOperationHistory(query: {
      readonly after?: { readonly revision: string; readonly operationId: string };
      readonly limit?: number;
    }) {
      operationScans.push(query);
      return scanOperations(operations, query);
    },
  } as unknown as StateStore;
  return { latestOperationScans, operationScans, operations, scans, state };
}

test("runtime snapshot pages durable sections with stable cursors and safe default projections", async () => {
  const fixture = stateStore();
  const controller = new RuntimeOperationController({
    clock: new FakeClock(new Date("2026-07-25T00:00:00.000Z")),
    state: fixture.state,
  });
  controller.openReadOnly();

  const result = await snapshotOperation(controller)({
    limit: 1,
  });

  assert.deepEqual(
    fixture.scans.map((query) => ({
      collection: query.collection,
      afterId: query.afterId,
      limit: query.limit,
    })),
    [
      { collection: "installations", afterId: undefined, limit: 1 },
      { collection: "deployments", afterId: undefined, limit: 1 },
      { collection: "component-instances", afterId: undefined, limit: 1 },
      { collection: "tasks", afterId: undefined, limit: 1 },
    ],
  );
  assert.deepEqual(fixture.operationScans, [{ limit: 1 }]);
  assert.deepEqual(fixture.latestOperationScans, []);
  assert.equal(typeof result.installations.nextCursor, "string");
  assert.notEqual(result.installations.nextCursor, "installation-a");
  assert.equal(typeof result.operations.nextCursor, "string");
  assert.equal(result.operations.nextCursor?.includes("operation-a"), false);
  const installationsCursor = result.installations.nextCursor;
  const operationsCursor = result.operations.nextCursor;
  assert.ok(installationsCursor);
  assert.ok(operationsCursor);

  await snapshotOperation(controller)({
    limit: 1,
    cursors: {
      installations: installationsCursor,
      operations: operationsCursor,
    },
  });
  assert.equal(fixture.scans[4]?.afterId, "installation-a");
  assert.deepEqual(fixture.operationScans[1], {
    after: { revision: "6", operationId: "operation-a" },
    limit: 1,
  });

  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes("deployment-secret"), false);
  assert.equal(encoded.includes("task-input-secret"), false);
  assert.equal(encoded.includes("task-output-secret"), false);
  assert.equal(encoded.includes("privateBuildNote"), false);
  assert.equal(encoded.includes("privateState"), false);
  assert.equal(encoded.includes('"authority"'), false);
  assert.equal(encoded.includes('"epoch"'), false);
});

test("runtime snapshot exposes sensitive task and deployment fields only through explicit projection", async () => {
  const fixture = stateStore();
  const controller = new RuntimeOperationController({
    clock: new FakeClock(new Date("2026-07-25T00:00:00.000Z")),
    state: fixture.state,
  });
  controller.openReadOnly();

  const result = await snapshotOperation(controller)({
    projection: {
      deploymentConfiguration: true,
      taskInput: true,
      taskOutput: true,
    },
  });
  const encoded = JSON.stringify(result);

  assert.equal(encoded.includes("deployment-secret"), true);
  assert.equal(encoded.includes("task-input-secret"), true);
  assert.equal(encoded.includes("task-output-secret"), true);
  assert.equal(encoded.includes("configuration-authority"), true);
  assert.equal(encoded.includes("configuration-epoch"), true);
  assert.equal(encoded.includes("configuration-session"), true);
  assert.equal(encoded.includes("configuration-session-id"), true);
  assert.equal(encoded.includes("input-authority"), true);
  assert.equal(encoded.includes("input-epoch"), true);
  assert.equal(encoded.includes("input-session"), true);
  assert.equal(encoded.includes("input-session-id"), true);
  assert.equal(encoded.includes("output-authority"), true);
  assert.equal(encoded.includes("output-epoch"), true);
  assert.equal(encoded.includes("output-session"), true);
  assert.equal(encoded.includes("output-session-id"), true);
  assert.equal(encoded.includes("runtime:one"), false);
  assert.equal(encoded.includes('"19"'), false);
});

test("runtime snapshot rejects malformed and cross-section cursor tokens", async () => {
  const fixture = stateStore();
  const controller = new RuntimeOperationController({
    clock: new FakeClock(new Date("2026-07-25T00:00:00.000Z")),
    state: fixture.state,
  });
  controller.openReadOnly();
  const first = await snapshotOperation(controller)({ limit: 1 });
  assert.equal(typeof first.installations.nextCursor, "string");
  const installationsCursor = first.installations.nextCursor;
  assert.ok(installationsCursor);

  for (const cursor of ["not-a-snapshot-cursor", installationsCursor]) {
    await assert.rejects(
      snapshotOperation(controller)({
        cursors: { deployments: cursor },
      }),
      (error: unknown) => {
        assert.ok(error instanceof DiagnosticError);
        assert.equal(error.diagnostic.code, "PROTOCOL_OPERATION_INVALID");
        return true;
      },
    );
  }
});

test("runtime snapshot rejects every non-canonical cursor encoding in requests and responses", async () => {
  const fixture = stateStore();
  const controller = new RuntimeOperationController({
    clock: new FakeClock(new Date("2026-07-25T00:00:00.000Z")),
    state: fixture.state,
  });
  controller.openReadOnly();
  const canonical = createRuntimeSnapshotStateCursor("installations", "installation-a");
  const nonCanonical = [
    cursorFromJson('{"section":"installations","version":1,"position":{"id":"installation-a"}}'),
    cursorFromJson('{"version":1, "section":"installations","position":{"id":"installation-a"}}'),
    cursorFromJson(
      String.raw`{"version":1,"section":"installations","position":{"id":"installation-\u0061"}}`,
    ),
    cursorFromJson('{"version":1.0,"section":"installations","position":{"id":"installation-a"}}'),
    `${canonical}=`,
  ];

  for (const cursor of nonCanonical) {
    await assert.rejects(snapshotOperation(controller)({ cursors: { installations: cursor } }));
    assert.throws(() =>
      parseRuntimeSnapshotResponse({
        installations: { items: [], nextCursor: cursor },
        deployments: { items: [] },
        instances: { items: [] },
        operations: { items: [] },
        tasks: { items: [] },
      }),
    );
  }
});

test("runtime snapshot cursor factory round-trips a 7000-character durable state ID", () => {
  const id = "record-".padEnd(7_000, "x");
  const cursor = createRuntimeSnapshotStateCursor("instances", id);
  assert.ok(cursor.length > 8_192);
  assert.deepEqual(parseRuntimeSnapshotCursor(cursor, "instances"), {
    section: "instances",
    afterId: id,
  });

  const response = {
    installations: { items: [] },
    deployments: { items: [] },
    instances: {
      items: [{ id, revision: parseRevision("1"), value: { instanceId: id } }],
      nextCursor: cursor,
    },
    operations: { items: [] },
    tasks: { items: [] },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") < 768 * 1_024);
  assert.deepEqual(parseRuntimeSnapshotResponse(response), response);
});

test("runtime snapshot pages immutable operation versions across a concurrent status update", async () => {
  const fixture = stateStore();
  fixture.operations.splice(
    0,
    fixture.operations.length,
    {
      operationId: parseOperationId("operation-a"),
      kind: "task.run",
      status: "planned",
      state: {},
      updatedAt: "2026-07-25T00:00:01.000Z",
      revision: parseRevision("1"),
    },
    {
      operationId: parseOperationId("operation-b"),
      kind: "task.run",
      status: "planned",
      state: {},
      updatedAt: "2026-07-25T00:00:02.000Z",
      revision: parseRevision("2"),
    },
  );
  const controller = new RuntimeOperationController({
    clock: new FakeClock(new Date("2026-07-25T00:00:00.000Z")),
    state: fixture.state,
  });
  controller.openReadOnly();

  const first = await snapshotOperation(controller)({ limit: 1 });
  const firstCursor = first.operations.nextCursor;
  assert.ok(firstCursor);
  fixture.operations.push({
    operationId: parseOperationId("operation-a"),
    kind: "task.run",
    status: "completed",
    state: {},
    updatedAt: "2026-07-25T00:00:03.000Z",
    revision: parseRevision("3"),
  });
  const second = await snapshotOperation(controller)({
    limit: 1,
    cursors: { operations: firstCursor },
  });
  const secondCursor = second.operations.nextCursor;
  assert.ok(secondCursor);
  const third = await snapshotOperation(controller)({
    limit: 1,
    cursors: { operations: secondCursor },
  });

  assert.deepEqual(
    [first, second, third].map((page) => page.operations.items[0]?.revision),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    [first, second, third].map((page) => page.operations.items[0]?.operationId),
    ["operation-a", "operation-b", "operation-a"],
  );
  assert.equal(fixture.latestOperationScans.length, 0);
  assert.equal(fixture.operationScans.length, 3);
});

test("runtime snapshot rejects an unbounded page limit", async () => {
  const fixture = stateStore();
  const controller = new RuntimeOperationController({
    clock: new FakeClock(new Date("2026-07-25T00:00:00.000Z")),
    state: fixture.state,
  });
  controller.openReadOnly();

  await assert.rejects(snapshotOperation(controller)({ limit: 101 }), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.diagnostic.code, "PROTOCOL_OPERATION_INVALID");
    return true;
  });
});
