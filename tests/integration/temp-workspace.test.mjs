import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { createTempWorkspace } from "../support/temp-workspace.mjs";

test("@spec:runtime-kernel-phase-1/repository-and-test-harness/temporary-workspace", async () => {
  const workspace = await createTempWorkspace("shared-helper");
  const marker = workspace.resolve("marker.txt");

  await writeFile(marker, "created\n");
  assert.equal((await stat(marker)).isFile(), true);
  await workspace.dispose();
  await workspace.assertRemoved();
});
