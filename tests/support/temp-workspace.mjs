import { lstatSync } from "node:fs";
import { lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const cleanupRegistries = new WeakMap();

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

function workspacePath(directory, segments) {
  if (segments.some((segment) => isAbsolute(segment))) {
    throw new Error(`TEMP_WORKSPACE_PATH_ESCAPE:${directory}:${segments.join(sep)}`);
  }
  const target = resolve(directory, ...segments);
  const relativeTarget = relative(directory, target);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`TEMP_WORKSPACE_PATH_ESCAPE:${directory}:${target}`);
  }

  let current = directory;
  for (const segment of relativeTarget.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`TEMP_WORKSPACE_SYMLINK:${directory}:${current}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

export function registerTestCleanup(testContext, cleanup) {
  let registry = cleanupRegistries.get(testContext);
  if (registry === undefined) {
    registry = [];
    cleanupRegistries.set(testContext, registry);
    testContext.after(async () => {
      const errors = [];
      for (const dispose of registry.toReversed()) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "TEST_CLEANUP_FAILED");
    });
  }
  registry.push(cleanup);
}

export async function createTempWorkspace(testName) {
  const directory = await mkdtemp(join(tmpdir(), `tego-${safeName(testName)}-`));

  return Object.freeze({
    directory,
    path: (...segments) => workspacePath(directory, segments),
    async assertExists() {
      if (!(await directoryExists(directory))) {
        throw new Error(`TEMP_WORKSPACE_MISSING:${directory}`);
      }
    },
    async assertRemoved() {
      try {
        await lstat(directory);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      throw new Error(`TEMP_WORKSPACE_LEAK:${directory}`);
    },
    async dispose() {
      await rm(directory, { force: true, recursive: true });
    },
  });
}

export async function useTempWorkspace(testContext, testName) {
  const workspace = await createTempWorkspace(testName);
  registerTestCleanup(testContext, async () => {
    await workspace.dispose();
    await workspace.assertRemoved();
  });
  return workspace;
}
