import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RuntimeLifecycleState } from "@tegojs/contracts";

export interface LifecycleConformanceFixture {
  current(): RuntimeLifecycleState | Promise<RuntimeLifecycleState>;
  transition(next: RuntimeLifecycleState): RuntimeLifecycleState | Promise<RuntimeLifecycleState>;
}

export type LifecycleConformanceFactory = () =>
  | LifecycleConformanceFixture
  | Promise<LifecycleConformanceFixture>;

export function lifecycleConformance(factory: LifecycleConformanceFactory): void {
  describe("Runtime lifecycle conformance", () => {
    test("@spec:runtime-operations/reusable-conformance-test-kits/lifecycle-transitions", async () => {
      const fixture = await factory();
      assert.equal(await fixture.current(), "created");
      for (const state of [
        "opening",
        "recovering",
        "electing",
        "running",
        "draining",
        "stopping",
        "stopped",
      ] as const) {
        assert.equal(await fixture.transition(state), state);
        assert.equal(await fixture.current(), state);
      }
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/lifecycle-idempotency", async () => {
      const fixture = await factory();
      assert.equal(await fixture.transition("created"), "created");
      assert.equal(await fixture.transition("opening"), "opening");
      assert.equal(await fixture.transition("opening"), "opening");
      assert.equal(await fixture.current(), "opening");
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/lifecycle-invalid-transition", async () => {
      const fixture = await factory();
      await assert.rejects(Promise.resolve().then(() => fixture.transition("running")));
      assert.equal(await fixture.current(), "created");
    });
  });
}
