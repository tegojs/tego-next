import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnosticCode,
  parseFencingEpoch,
  runtimeDiagnostic,
  type CampaignRequest,
  type CoordinationProvider,
  type CoordinationWatchRequest,
  type DriverHealth,
  type JsonValue,
  type LeadershipHandle,
  type RuntimeDiagnostic,
} from "@tegojs/contracts";
import { FakeClock, eventually } from "@tegojs/testkit";
import { LeadershipController } from "../src/leadership-controller.js";

function healthy(clock: FakeClock): DriverHealth {
  return { status: "healthy", checkedAt: clock.now().toISOString() };
}

class ControlledCoordination implements CoordinationProvider {
  readonly scope = "distributed";
  readonly campaigns: CampaignRequest[] = [];
  readonly releases: string[] = [];
  failRelease = false;
  #pending: Array<ReturnType<typeof Promise.withResolvers<LeadershipHandle>>> = [];
  #failures: Error[] = [];

  open(): Promise<void> {
    return Promise.resolve();
  }

  campaign(request: CampaignRequest): Promise<LeadershipHandle> {
    this.campaigns.push(request);
    const failure = this.#failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    const pending = Promise.withResolvers<LeadershipHandle>();
    this.#pending.push(pending);
    return pending.promise;
  }

  failNext(error: Error): void {
    this.#failures.push(error);
  }

  acquire(epoch: string): {
    readonly lose: (diagnostic?: RuntimeDiagnostic) => void;
  } {
    return this.acquireLeadership({
      resource: "runtime:runtime-01",
      epoch: parseFencingEpoch(epoch),
    });
  }

  acquireLeadership(leadership: {
    readonly resource: string;
    readonly epoch: ReturnType<typeof parseFencingEpoch>;
  }): {
    readonly lose: (diagnostic?: RuntimeDiagnostic) => void;
  } {
    const pending = this.#pending.shift();
    assert.ok(pending, "a campaign must be pending before acquisition");
    const lost = Promise.withResolvers<RuntimeDiagnostic>();
    pending.resolve({
      leadership,
      lost: lost.promise,
      release: async () => {
        this.releases.push(leadership.epoch);
        if (this.failRelease) throw new Error("release failed");
        lost.resolve(
          runtimeDiagnostic({
            code: "COORDINATION_LEADERSHIP_RELEASED",
            message: "Leadership was released",
            source: { kind: "coordination", id: leadership.resource },
            observedAt: "2026-07-24T00:00:00.000Z",
          }),
        );
      },
    });
    return {
      lose: (
        diagnostic = runtimeDiagnostic({
          code: "COORDINATION_LEADERSHIP_LOST",
          message: "Leadership was lost",
          source: { kind: "coordination", id: leadership.resource },
          observedAt: "2026-07-24T00:00:00.000Z",
        }),
      ) => lost.resolve(diagnostic),
    };
  }

  acquireLease(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }

  nextEpoch(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }

  compareAndSet<_T extends JsonValue>(): Promise<{ readonly applied: false }> {
    return Promise.resolve({ applied: false });
  }

  watch(_request: CoordinationWatchRequest): AsyncIterable<never> {
    return {
      async *[Symbol.asyncIterator]() {},
    };
  }

  health(): Promise<DriverHealth> {
    return Promise.resolve(healthy(new FakeClock()));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

test("@spec:runtime-bootstrap/recovery/leadership-reacquisition", async () => {
  const coordination = new ControlledCoordination();
  const events: string[] = [];
  const controller = new LeadershipController({
    coordination,
    clock: new FakeClock(),
    resource: "runtime:runtime-01",
    onAcquired: async (leadership) => {
      events.push(`acquired:${leadership.epoch}`);
    },
    onLost: async (leadership) => {
      events.push(`lost:${leadership.epoch}`);
    },
  });

  await controller.start();
  await eventually(() => assert.equal(coordination.campaigns.length, 1));
  const first = coordination.acquire("7");
  await eventually(() => assert.deepEqual(events, ["acquired:7"]));
  first.lose();
  await eventually(() => assert.equal(coordination.campaigns.length, 2));
  assert.deepEqual(events, ["acquired:7", "lost:7"]);

  coordination.acquire("8");
  await eventually(() => assert.deepEqual(events, ["acquired:7", "lost:7", "acquired:8"]));
  await controller.stop();
  assert.deepEqual(events, ["acquired:7", "lost:7", "acquired:8", "lost:8"]);
  assert.deepEqual(coordination.releases, ["8"]);
});

test("provider failures retry through bounded deterministic Clock backoff", async () => {
  const coordination = new ControlledCoordination();
  const clock = new FakeClock();
  const diagnostics: RuntimeDiagnostic[] = [];
  coordination.failNext(new Error("first failure"));
  coordination.failNext(new Error("second failure"));
  const controller = new LeadershipController({
    coordination,
    clock,
    resource: "runtime:runtime-01",
    onAcquired: async () => {},
    onLost: async () => {},
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });

  await controller.start();
  await eventually(() => assert.equal(coordination.campaigns.length, 1));
  await eventually(() => assert.equal(diagnostics.at(-1)?.code, "COORDINATION_CAMPAIGN_FAILED"));
  clock.advanceBy(99);
  await Promise.resolve();
  assert.equal(coordination.campaigns.length, 1);
  clock.advanceBy(1);
  await eventually(() => assert.equal(coordination.campaigns.length, 2));
  await eventually(() => assert.equal(diagnostics.length, 2));
  clock.advanceBy(199);
  await Promise.resolve();
  assert.equal(coordination.campaigns.length, 2);
  clock.advanceBy(1);
  await eventually(() => assert.equal(coordination.campaigns.length, 3));

  await controller.stop();
});

test("stop interrupts pending campaign and releases a late acquisition without callbacks", async () => {
  const coordination = new ControlledCoordination();
  const events: string[] = [];
  const controller = new LeadershipController({
    coordination,
    clock: new FakeClock(),
    resource: "runtime:runtime-01",
    onAcquired: async () => {
      events.push("acquired");
    },
    onLost: async () => {
      events.push("lost");
    },
  });

  await controller.start();
  await eventually(() => assert.equal(coordination.campaigns.length, 1));
  await controller.stop();
  coordination.acquire("9");
  await eventually(() => assert.deepEqual(coordination.releases, ["9"]));
  assert.deepEqual(events, []);
});

test("callback failures are diagnosed, cleaned up, and never escape the background loop", async () => {
  const coordination = new ControlledCoordination();
  const clock = new FakeClock();
  const diagnostics: RuntimeDiagnostic[] = [];
  const cleanedUp: string[] = [];
  const controller = new LeadershipController({
    coordination,
    clock,
    resource: "runtime:runtime-01",
    onAcquired: async () => {
      throw new Error("activation failed");
    },
    onLost: async (leadership) => {
      cleanedUp.push(leadership.epoch);
    },
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });

  await controller.start();
  await eventually(() => assert.equal(coordination.campaigns.length, 1));
  coordination.acquire("3");
  await eventually(() =>
    assert.equal(
      diagnostics.some(
        (diagnostic) => diagnostic.code === "COORDINATION_LEADERSHIP_CALLBACK_FAILED",
      ),
      true,
    ),
  );
  await eventually(() => assert.deepEqual(coordination.releases, ["3"]));
  assert.deepEqual(cleanedUp, ["3"]);
  await Promise.resolve();
  assert.equal(coordination.campaigns.length, 1);
  clock.advanceBy(99);
  await Promise.resolve();
  assert.equal(coordination.campaigns.length, 1);
  clock.advanceBy(1);
  await eventually(() => assert.equal(coordination.campaigns.length, 2));
  await controller.stop();
});

test("failed leadership-loss cleanup prevents a new campaign", async () => {
  const coordination = new ControlledCoordination();
  const diagnostics: RuntimeDiagnostic[] = [];
  const controller = new LeadershipController({
    coordination,
    clock: new FakeClock(),
    resource: "runtime:runtime-01",
    onAcquired: async () => {},
    onLost: async () => {
      throw new Error("cleanup failed");
    },
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });

  await controller.start();
  await eventually(() => assert.equal(coordination.campaigns.length, 1));
  const acquired = coordination.acquire("4");
  acquired.lose();
  await eventually(() =>
    assert.equal(
      diagnostics.some(
        (diagnostic) => diagnostic.code === "COORDINATION_LEADERSHIP_CALLBACK_FAILED",
      ),
      true,
    ),
  );
  await Promise.resolve();
  assert.equal(coordination.campaigns.length, 1);
  await assert.rejects(
    controller.stop(),
    (error: unknown) => diagnosticCode(error) === "COORDINATION_LEADERSHIP_SHUTDOWN_FAILED",
  );
});

test("invalid leadership is released, exposed, and terminates without a hot campaign loop", async () => {
  const coordination = new ControlledCoordination();
  const diagnostics: RuntimeDiagnostic[] = [];
  const controller = new LeadershipController({
    coordination,
    clock: new FakeClock(),
    resource: "runtime:runtime-01",
    onAcquired: async () => {},
    onLost: async () => {},
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });

  await controller.start();
  await eventually(() => assert.equal(coordination.campaigns.length, 1));
  coordination.acquireLeadership({
    resource: "",
    epoch: parseFencingEpoch("5"),
  });

  await assert.rejects(
    controller.waitForAuthority(),
    (error: unknown) => diagnosticCode(error) === "COORDINATION_LEADERSHIP_INVALID",
  );
  await eventually(() => assert.deepEqual(coordination.releases, ["5"]));
  await Promise.resolve();
  assert.equal(coordination.campaigns.length, 1);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.code === "COORDINATION_LEADERSHIP_INVALID"),
    true,
  );
  await controller.stop();
});

test("stop aggregates loss cleanup and release failures after attempting both", async () => {
  const coordination = new ControlledCoordination();
  const diagnostics: RuntimeDiagnostic[] = [];
  let acquired = false;
  coordination.failRelease = true;
  const controller = new LeadershipController({
    coordination,
    clock: new FakeClock(),
    resource: "runtime:runtime-01",
    onAcquired: async () => {
      acquired = true;
    },
    onLost: async () => {
      throw new Error("cleanup failed");
    },
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });

  await controller.start();
  await eventually(() => assert.equal(coordination.campaigns.length, 1));
  coordination.acquire("6");
  await eventually(() => assert.equal(acquired, true));
  await assert.rejects(
    controller.stop(),
    (error: unknown) => diagnosticCode(error) === "COORDINATION_LEADERSHIP_SHUTDOWN_FAILED",
  );
  assert.deepEqual(coordination.releases, ["6"]);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    ["COORDINATION_LEADERSHIP_CALLBACK_FAILED", "COORDINATION_LEADERSHIP_RELEASE_FAILED"],
  );
});

test("provider failure consumes an asynchronously rejected diagnostic sink", async (t) => {
  const coordination = new ControlledCoordination();
  const clock = new FakeClock();
  const unhandled: unknown[] = [];
  let sinkCalls = 0;
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  coordination.failNext(new Error("campaign failed"));
  const controller = new LeadershipController({
    coordination,
    clock,
    resource: "runtime:runtime-01",
    onAcquired: async () => {},
    onLost: async () => {},
    onDiagnostic: async () => {
      sinkCalls += 1;
      throw new Error("diagnostic sink failed");
    },
  });

  await controller.start();
  await eventually(() => assert.equal(coordination.campaigns.length, 1));
  await eventually(() => assert.equal(sinkCalls, 1));
  clock.advanceBy(100);
  await eventually(() => assert.equal(coordination.campaigns.length, 2));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  await controller.stop();
});

test("invalid leadership consumes an asynchronously rejected diagnostic sink", async (t) => {
  const coordination = new ControlledCoordination();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const controller = new LeadershipController({
    coordination,
    clock: new FakeClock(),
    resource: "runtime:runtime-01",
    onAcquired: async () => {},
    onLost: async () => {},
    onDiagnostic: async () => {
      throw new Error("diagnostic sink failed");
    },
  });

  await controller.start();
  await eventually(() => assert.equal(coordination.campaigns.length, 1));
  coordination.acquireLeadership({
    resource: "",
    epoch: parseFencingEpoch("17"),
  });
  await assert.rejects(
    controller.waitForAuthority(),
    (error: unknown) => diagnosticCode(error) === "COORDINATION_LEADERSHIP_INVALID",
  );
  await eventually(() => assert.deepEqual(coordination.releases, ["17"]));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  await controller.stop();
});
