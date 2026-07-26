import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Runtime } from "@tegojs/contracts";

export type LifecycleConformanceFactory = () => Runtime | Promise<Runtime>;

async function withRuntime<T>(
  factory: LifecycleConformanceFactory,
  run: (runtime: Runtime) => Promise<T>,
): Promise<T> {
  const runtime = await factory();
  try {
    return await run(runtime);
  } finally {
    await runtime.stop();
  }
}

export function lifecycleConformance(factory: LifecycleConformanceFactory): void {
  describe("Runtime lifecycle conformance", () => {
    test("@spec:runtime-operations/reusable-conformance-test-kits/lifecycle-start", async () => {
      await withRuntime(factory, async (runtime) => {
        assert.equal((await runtime.status()).lifecycle, "created");

        await Promise.all([runtime.start(), runtime.start()]);

        const running = await runtime.status();
        assert.equal(running.lifecycle, "running");
        assert.equal(running.liveness, true);
        assert.equal(running.readiness, true);
        assert.equal(running.acceptingOperations, true);

        await runtime.start();
        assert.equal((await runtime.status()).lifecycle, "running");
      });
    });

    test("@spec:runtime-operations/reusable-conformance-test-kits/lifecycle-stop", async () => {
      const runtime = await factory();
      await runtime.start();

      await Promise.all([runtime.stop(), runtime.stop()]);

      const stopped = await runtime.status();
      assert.equal(stopped.lifecycle, "stopped");
      assert.equal(stopped.liveness, false);
      assert.equal(stopped.readiness, false);
      assert.equal(stopped.acceptingOperations, false);

      await runtime.stop();
      assert.equal((await runtime.status()).lifecycle, "stopped");
    });
  });
}
