import assert from "node:assert/strict";
import { rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTempWorkspace, useTempWorkspace } from "../support/temp-workspace.mjs";

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

test("temporary workspace rejects paths outside its root", async (t) => {
  const workspace = await useTempWorkspace(t, "safe-paths");

  assert.throws(() => workspace.path("..", "escape.txt"), /TEMP_WORKSPACE_PATH_ESCAPE/u);
  assert.throws(() => workspace.path(join(tmpdir(), "escape.txt")), /TEMP_WORKSPACE_PATH_ESCAPE/u);
});

test("temporary workspace rejects symlink traversal", async (t) => {
  const workspace = await useTempWorkspace(t, "symlink-path");
  const outside = await createTempWorkspace("symlink-target");
  t.after(() => outside.dispose());
  await symlink(outside.directory, join(workspace.directory, "escape"), "dir");

  assert.throws(() => workspace.path("escape", "outside.txt"), /TEMP_WORKSPACE_SYMLINK/u);
});

test("temporary workspace removal assertion detects a residual regular file", async () => {
  const workspace = await createTempWorkspace("residual-file");
  await workspace.dispose();
  await writeFile(workspace.directory, "residual\n");
  try {
    await assert.rejects(workspace.assertRemoved(), /TEMP_WORKSPACE_LEAK/u);
  } finally {
    await rm(workspace.directory, { force: true });
  }
});

test("temporary workspace removal assertion detects a directory symlink", async () => {
  const workspace = await createTempWorkspace("residual-directory-symlink");
  const target = await createTempWorkspace("residual-directory-target");
  await workspace.dispose();
  await symlink(target.directory, workspace.directory, "dir");
  try {
    await assert.rejects(workspace.assertRemoved(), /TEMP_WORKSPACE_LEAK/u);
  } finally {
    await rm(workspace.directory, { force: true });
    await target.dispose();
  }
});

test("temporary workspace removal assertion detects a dangling symlink", async () => {
  const workspace = await createTempWorkspace("residual-dangling-symlink");
  const missingTarget = `${workspace.directory}-missing-target`;
  await workspace.dispose();
  await symlink(missingTarget, workspace.directory);
  try {
    await assert.rejects(workspace.assertRemoved(), /TEMP_WORKSPACE_LEAK/u);
  } finally {
    await rm(workspace.directory, { force: true });
  }
});
