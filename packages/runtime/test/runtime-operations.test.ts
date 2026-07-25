import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DiagnosticError,
  type JsonObject,
  type JsonValue,
  parseOperationId,
  parseRevision,
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
    readonly operations?: {
      readonly revision: string;
      readonly operationId: string;
    };
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
  readonly nextCursor?: unknown;
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

function record(id: string, value: JsonObject, revision: string): ScannedState<JsonObject> {
  return {
    key: { namespace: "tego", collection: "unused", id },
    revision: parseRevision(revision),
    value,
  };
}

function stateStore() {
  const scans: StateQuery<JsonValue>[] = [];
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
            configuration: { token: "deployment-secret" },
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
              input: { token: "task-input-secret" },
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
              output: { token: "task-output-secret" },
            },
          },
          "5",
        ),
      ],
    ],
  ]);
  const operations = [
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
    scanOperations(query: unknown) {
      operationScans.push(query);
      return {
        async *[Symbol.asyncIterator]() {
          yield* operations;
        },
      };
    },
  } as unknown as StateStore;
  return { operationScans, scans, state };
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
    cursors: {
      installations: "installation-0",
      operations: { revision: "5", operationId: "operation-before" },
    },
  });

  assert.deepEqual(
    fixture.scans.map((query) => ({
      collection: query.collection,
      afterId: query.afterId,
      limit: query.limit,
    })),
    [
      { collection: "installations", afterId: "installation-0", limit: 1 },
      { collection: "deployments", afterId: undefined, limit: 1 },
      { collection: "component-instances", afterId: undefined, limit: 1 },
      { collection: "tasks", afterId: undefined, limit: 1 },
    ],
  );
  assert.deepEqual(fixture.operationScans, [
    {
      after: { revision: "5", operationId: "operation-before" },
      limit: 1,
    },
  ]);
  assert.equal(result.installations.nextCursor, "installation-a");
  assert.deepEqual(result.operations.nextCursor, {
    revision: "6",
    operationId: "operation-a",
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
  assert.equal(encoded.includes('"authority"'), false);
  assert.equal(encoded.includes('"epoch"'), false);
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
