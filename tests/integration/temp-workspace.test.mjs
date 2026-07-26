import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { useTempWorkspace } from "../support/temp-workspace.mjs";

test("@spec:runtime-kernel-phase-1/repository-and-test-harness/temporary-workspace", async (t) => {
  let workspace;
  await t.test("registered workspace", async (t) => {
    workspace = await useTempWorkspace(t, "shared-helper");
    const marker = workspace.path("marker.txt");

    await writeFile(marker, "created\n");
    await workspace.assertExists();
    await assert.rejects(workspace.assertRemoved(), /TEMP_WORKSPACE_LEAK/u);
    assert.equal((await stat(marker)).isFile(), true);
  });
  await workspace.assertRemoved();
});
