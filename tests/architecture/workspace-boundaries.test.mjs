import test from "node:test";
import assert from "node:assert/strict";
import { checkWorkspaceBoundaries } from "../../scripts/check-boundaries.mjs";

test("@spec:runtime-operations/layer-one-dependency-boundary/architecture-dependency-check", async () => {
  const violations = await checkWorkspaceBoundaries(new URL("../../", import.meta.url));
  assert.deepEqual(violations, []);
});
