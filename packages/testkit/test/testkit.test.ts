import assert from "node:assert/strict";
import { test } from "node:test";
import { eventually, FakeClock } from "../src/index.js";

test("FakeClock advances sleepers deterministically", async () => {
  const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
  let resolved = false;
  const sleeping = clock.sleep(25).then(() => {
    resolved = true;
  });

  clock.advanceBy(24);
  await Promise.resolve();
  assert.equal(resolved, false);

  clock.advanceBy(1);
  await sleeping;
  assert.equal(resolved, true);
  assert.equal(clock.now().toISOString(), "2026-01-01T00:00:00.025Z");
});

test("eventually retries without a real-time sleep", async () => {
  let attempts = 0;
  const result = await eventually(
    () => {
      attempts += 1;
      assert.equal(attempts, 3);
      return "ready";
    },
    { attempts: 3 },
  );

  assert.equal(result, "ready");
});
