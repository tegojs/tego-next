import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function safeName(value) {
  const name = value.replaceAll(/[^a-zA-Z0-9._-]/gu, "-");
  if (name.length === 0 || name === "." || name === "..") {
    throw new Error(`INVALID_TEMP_WORKSPACE_NAME:${value}`);
  }
  return name;
}

async function directoryExists(directory) {
  return stat(directory).then(
    (entry) => entry.isDirectory(),
    (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    },
  );
}

export async function createTempWorkspace(testName) {
  const directory = await mkdtemp(join(tmpdir(), `tego-${safeName(testName)}-`));

  return Object.freeze({
    directory,
    path: (...segments) => join(directory, ...segments),
    async assertExists() {
      if (!(await directoryExists(directory))) {
        throw new Error(`TEMP_WORKSPACE_MISSING:${directory}`);
      }
    },
    async assertRemoved() {
      if (await directoryExists(directory)) {
        throw new Error(`TEMP_WORKSPACE_LEAK:${directory}`);
      }
    },
    async dispose() {
      await rm(directory, { force: true, recursive: true });
    },
  });
}

export async function useTempWorkspace(testContext, testName) {
  const workspace = await createTempWorkspace(testName);
  testContext.after(async () => {
    await workspace.dispose();
    await workspace.assertRemoved();
  });
  return workspace;
}
