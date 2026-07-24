import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseApplicationId,
  parseAttemptId,
  parseComponentId,
  parseFencingEpoch,
  parsePluginId,
  parseRunTaskRequest,
  parseTaskId,
} from "@tegojs/contracts";
import { MemoryStateStore } from "@tegojs/drivers-local";
import { ProcessExecutor } from "@tegojs/executor-node";
import { TaskService } from "@tegojs/runtime";
import { FakeClock } from "@tegojs/testkit";

test("@spec:runtime-operations/task-operations/process-envelope-input-limit-is-authoritative", async () => {
  const clock = new FakeClock(new Date("2026-07-25T00:00:00.000Z"));
  const state = new MemoryStateStore({ clock });
  await state.open();
  const processHost = {
    activeProcessCount: 0,
    open: async () => {},
    spawn: async () => {
      throw new Error("oversized pre-attempt input must not spawn");
    },
    health: async () => ({ status: "healthy", checkedAt: clock.now().toISOString() }),
    close: async () => {},
  };
  const executor = new ProcessExecutor({
    id: "process-01",
    processHost,
    resolveComponent: async () => {
      throw new Error("oversized pre-attempt input must not resolve");
    },
    clock,
  });
  const base = {
    applicationId: parseApplicationId("application-01"),
    pluginId: parsePluginId("echo"),
    componentId: parseComponentId("echo"),
    deadline: "2026-07-25T00:05:00.000Z",
    orphanPolicy: "cancel",
  };
  let low = 0;
  let high = 1_048_576;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    try {
      parseRunTaskRequest({ ...base, input: "x".repeat(middle) });
      low = middle;
    } catch {
      high = middle;
    }
  }
  let realRejection;
  await assert.rejects(
    executor.submit({
      taskId: parseTaskId("task-real-process-envelope"),
      attemptId: parseAttemptId("attempt-real-process-envelope"),
      ...parseRunTaskRequest({ ...base, input: "x".repeat(low) }),
    }),
    (error) => {
      realRejection = error;
      return error?.diagnostic?.code === "EXECUTOR_INPUT_LIMIT_EXCEEDED";
    },
  );
  const rejectingExecutor = {
    id: executor.id,
    type: executor.type,
    probe: () => executor.probe(),
    submit: async () => {
      throw realRejection;
    },
    observe: async () => undefined,
    cancel: async () => {},
    drain: async () => {},
    health: () => executor.health(),
    close: async () => {},
  };
  const service = new TaskService({
    state,
    clock,
    selectExecutor: async () => rejectingExecutor,
    createIdentity: () => ({
      taskId: parseTaskId("task-process-envelope"),
      attemptId: parseAttemptId("attempt-process-envelope"),
    }),
  });
  await service.setAuthority({
    resource: "runtime:runtime-01",
    epoch: parseFencingEpoch("1"),
  });
  const terminal = await service.run({ ...base, input: "small" });
  assert.equal(terminal.state, "terminal");
  assert.equal(terminal.result?.status, "rejected");
  assert.equal(terminal.result?.diagnostic?.code, "EXECUTOR_INPUT_LIMIT_EXCEEDED");
  assert.equal(terminal.result?.diagnostic?.retryable, false);
  await service.close();
  await executor.close();
  await state.close();
});
