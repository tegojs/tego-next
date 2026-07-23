import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExecutionRequest, ExecutionResult, Executor, JsonValue } from "@tegojs/contracts";

export type ExecutorFactory = () => Executor | Promise<Executor>;

export interface ExecutorConformanceFixture {
  request(input: JsonValue, suffix: string): ExecutionRequest;
  readonly echoInput: JsonValue;
  readonly echoOutput: JsonValue;
  readonly waitingInput: JsonValue;
  readonly crashInput: JsonValue;
  readonly replacementInput: JsonValue;
  readonly replacementOutput: JsonValue;
  readonly oversizedInput: JsonValue;
  readonly oversizedOutputInput: JsonValue;
  activeResourceCount(): number;
  spawnFailureFactory(): Executor | Promise<Executor>;
  shutdownHostTwice(): Promise<void>;
  advanceClock(milliseconds: number): Promise<void> | void;
}

async function terminal(executor: Executor, request: ExecutionRequest): Promise<ExecutionResult> {
  const handle = await executor.submit(request);
  return handle.result;
}

export function executorConformance(
  factory: ExecutorFactory,
  fixture: ExecutorConformanceFixture,
): void {
  describe("Executor conformance", () => {
    test("@spec:executor-runtime/uniform-executor-contract/probe", async () => {
      const executor = await factory();
      try {
        const capabilities = await executor.probe();
        assert.equal(capabilities.type, executor.type);
        assert.equal(capabilities.available, true);
        assert.ok(capabilities.maxConcurrency > 0);
      } finally {
        await executor.drain({});
      }
    });

    test("@spec:executor-runtime/uniform-executor-contract/echo", async () => {
      const executor = await factory();
      try {
        const result = await terminal(executor, fixture.request(fixture.echoInput, "echo"));
        assert.equal(result.status, "succeeded");
        assert.deepEqual(result.output, fixture.echoOutput);
        assert.equal(result.executor.kind, executor.type);
      } finally {
        await executor.drain({});
      }
    });

    test("@spec:executor-runtime/stable-task-and-attempt-identity/duplicate-assignment", async () => {
      const executor = await factory();
      try {
        const request = fixture.request(fixture.waitingInput, "duplicate");
        const first = await executor.submit(request);
        const duplicate = await executor.submit(request);
        assert.strictEqual(duplicate, first);
        await executor.cancel(request.taskId, request.attemptId);
        await fixture.advanceClock(1_000);
        assert.equal((await first.result).status, "cancelled");
        assert.equal((await duplicate.result).status, "cancelled");
      } finally {
        await executor.drain({});
      }
    });

    test("attempt identity rejects a different request fingerprint", async () => {
      const executor = await factory();
      try {
        const original = fixture.request(fixture.waitingInput, "conflict");
        await executor.submit(original);
        await assert.rejects(
          executor.submit({ ...original, input: fixture.echoInput }),
          (error: unknown) =>
            error instanceof Error &&
            /identity|fingerprint|idempotency|conflict/iu.test(error.message),
        );
        await executor.cancel(original.taskId, original.attemptId);
        await fixture.advanceClock(1_000);
      } finally {
        await executor.drain({});
      }
    });

    test("@spec:executor-runtime/cancellation-and-deadline/cancel", async () => {
      const executor = await factory();
      try {
        const request = fixture.request(fixture.waitingInput, "cancel");
        const handle = await executor.submit(request);
        await executor.cancel(request.taskId, request.attemptId);
        await fixture.advanceClock(1_000);
        assert.equal((await handle.result).status, "cancelled");
      } finally {
        await executor.drain({});
      }
    });

    test("@spec:executor-runtime/cancellation-and-deadline/deadline", async () => {
      const executor = await factory();
      try {
        const request = fixture.request(fixture.waitingInput, "deadline");
        const handle = await executor.submit({
          ...request,
          deadline: new Date(100).toISOString(),
        });
        await fixture.advanceClock(101);
        assert.equal((await handle.result).status, "timed-out");
      } finally {
        await executor.drain({});
      }
    });

    test("@spec:executor-runtime/executor-failure-containment/crash-replacement", async () => {
      const executor = await factory();
      try {
        const crashed = await terminal(executor, fixture.request(fixture.crashInput, "crash"));
        assert.equal(crashed.status, "failed");
        assert.equal(fixture.activeResourceCount(), 0);

        const replacement = await terminal(
          executor,
          fixture.request(fixture.replacementInput, "replacement"),
        );
        assert.equal(replacement.status, "succeeded");
        assert.deepEqual(replacement.output, fixture.replacementOutput);
        assert.equal(fixture.activeResourceCount(), 0);
      } finally {
        await executor.drain({});
      }
    });

    test("executor input and output limits fail closed without leaking resources", async () => {
      const executor = await factory();
      try {
        await assert.rejects(
          executor.submit(fixture.request(fixture.oversizedInput, "oversized-input")),
        );
        const output = await terminal(
          executor,
          fixture.request(fixture.oversizedOutputInput, "oversized-output"),
        );
        assert.equal(output.status, "failed");
        assert.equal(fixture.activeResourceCount(), 0);
      } finally {
        await executor.drain({});
      }
    });

    test("spawn failure releases executor capacity and process resources", async () => {
      const executor = await fixture.spawnFailureFactory();
      try {
        const failure = await terminal(executor, fixture.request(fixture.echoInput, "spawn-failure"));
        assert.equal(failure.status, "failed");
        assert.equal((await executor.health()).active, 0);
        assert.equal(fixture.activeResourceCount(), 0);
      } finally {
        await executor.drain({});
      }
    });

    test("process-host shutdown is idempotent", async () => {
      await fixture.shutdownHostTwice();
      assert.equal(fixture.activeResourceCount(), 0);
    });

    test("observe returns running and cached terminal attempts", async () => {
      const executor = await factory();
      try {
        const request = fixture.request(fixture.waitingInput, "observe");
        const handle = await executor.submit(request);
        const running = await executor.observe(request.taskId, request.attemptId);
        assert.ok(running?.state === "accepted" || running?.state === "running");
        await executor.cancel(request.taskId, request.attemptId);
        await fixture.advanceClock(1_000);
        const result = await handle.result;
        assert.deepEqual(await executor.observe(request.taskId, request.attemptId), {
          state: "terminal",
          result,
        });
      } finally {
        await executor.drain({});
      }
    });

    test("drain refuses new submissions and health remains diagnosable", async () => {
      const executor = await factory();
      const request = fixture.request(fixture.waitingInput, "drain");
      const handle = await executor.submit(request);
      const draining = executor.drain({});
      await assert.rejects(
        executor.submit(fixture.request(fixture.echoInput, "after-drain")),
        /drain|closed|accept/iu,
      );
      await executor.cancel(request.taskId, request.attemptId);
      await fixture.advanceClock(1_000);
      await handle.result;
      await draining;
      const health = await executor.health();
      assert.equal(health.active, 0);
      assert.equal(health.accepting, false);
    });
  });
}
