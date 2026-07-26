import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunArtifacts } from "../support/run-artifacts.mjs";

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("run artifact cleanup preserves an explicitly configured CI evidence directory", async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), "tego-retained-artifacts-"));
  const previous = process.env.TEGO_TEST_ARTIFACTS_DIR;
  process.env.TEGO_TEST_ARTIFACTS_DIR = baseDirectory;
  try {
    const artifacts = await createRunArtifacts("retained");
    await artifacts.initialize("main");

    await artifacts.dispose();

    assert.equal(await exists(artifacts.directory), true);
  } finally {
    if (previous === undefined) delete process.env.TEGO_TEST_ARTIFACTS_DIR;
    else process.env.TEGO_TEST_ARTIFACTS_DIR = previous;
    await rm(baseDirectory, { force: true, recursive: true });
  }
});

test("run artifact cleanup removes harness-owned temporary evidence", async () => {
  const previous = process.env.TEGO_TEST_ARTIFACTS_DIR;
  delete process.env.TEGO_TEST_ARTIFACTS_DIR;
  let directory;
  try {
    const artifacts = await createRunArtifacts("temporary");
    directory = artifacts.directory;
    await artifacts.initialize("main");

    await artifacts.dispose();

    assert.equal(await exists(directory), false);
  } finally {
    if (previous !== undefined) process.env.TEGO_TEST_ARTIFACTS_DIR = previous;
    if (directory !== undefined) await rm(directory, { force: true, recursive: true });
  }
});
