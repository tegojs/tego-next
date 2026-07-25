import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DiagnosticError, runtimeDiagnostic } from "@tegojs/contracts";

export interface BuildPluginOptions {
  readonly pluginDirectory: string;
  readonly tsconfigPath?: string;
}

export interface BuiltPlugin {
  readonly outputDirectory: string;
  cleanup(): Promise<void>;
}

const MAX_BUILD_OUTPUT_BYTES = 1024 * 1024;

function buildError(code: `ARTIFACT_${string}`, message: string, path?: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "artifact", id: "build" },
      ...(path === undefined ? {} : { details: { path } }),
    }),
  );
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

async function assertNoSymlinkAncestors(pluginRoot: string, candidate: string): Promise<void> {
  let current = pluginRoot;
  for (const segment of relative(pluginRoot, candidate)
    .split(sep)
    .filter((value) => value.length > 0)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw buildError(
        "ARTIFACT_BUILD_PATH_UNSAFE",
        "Build path cannot contain symbolic links",
        current,
      );
    }
  }
}

async function assertRegularPathWithin(
  pluginRoot: string,
  candidate: string,
  kind: "directory" | "file",
): Promise<string> {
  const absolute = resolve(candidate);
  if (!isContained(pluginRoot, absolute)) {
    throw buildError(
      "ARTIFACT_BUILD_PATH_UNSAFE",
      "Build path escapes the plugin directory",
      absolute,
    );
  }
  await assertNoSymlinkAncestors(pluginRoot, absolute);
  const metadata = await lstat(absolute);
  if (
    metadata.isSymbolicLink() ||
    (kind === "directory" ? !metadata.isDirectory() : !metadata.isFile())
  ) {
    throw buildError(
      "ARTIFACT_BUILD_PATH_UNSAFE",
      `Build ${kind} must be a real ${kind}`,
      absolute,
    );
  }
  const canonical = await realpath(absolute);
  if (!isContained(pluginRoot, canonical)) {
    throw buildError(
      "ARTIFACT_BUILD_PATH_UNSAFE",
      "Build path resolves outside the plugin directory",
      absolute,
    );
  }
  return canonical;
}

async function assertTreeHasNoSymlinks(pluginRoot: string, directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw buildError(
        "ARTIFACT_BUILD_PATH_UNSAFE",
        "Plugin source tree cannot contain symbolic links",
        path,
      );
    }
    const canonical = await realpath(path);
    if (!isContained(pluginRoot, canonical)) {
      throw buildError(
        "ARTIFACT_BUILD_PATH_UNSAFE",
        "Plugin source path resolves outside the plugin directory",
        path,
      );
    }
    if (metadata.isDirectory()) {
      await assertTreeHasNoSymlinks(pluginRoot, canonical);
    } else if (!metadata.isFile()) {
      throw buildError(
        "ARTIFACT_BUILD_PATH_UNSAFE",
        "Plugin source tree contains an unsupported filesystem entry",
        path,
      );
    }
  }
}

async function runCompiler(
  pluginRoot: string,
  sourceRoot: string,
  tsconfigPath: string,
  temporaryRoot: string,
  outputDirectory: string,
): Promise<void> {
  const require = createRequire(import.meta.url);
  const compilerPath = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  const compilerConfiguration = join(temporaryRoot, "tsconfig.json");
  const sdkTypesPath = fileURLToPath(import.meta.resolve("@tegojs/plugin-sdk")).replace(
    /\.js$/u,
    ".d.ts",
  );
  await writeFile(
    compilerConfiguration,
    JSON.stringify({
      extends: tsconfigPath,
      compilerOptions: {
        paths: {
          "@tegojs/plugin-sdk": [sdkTypesPath],
        },
        skipLibCheck: true,
      },
    }),
  );
  const child = spawn(
    process.execPath,
    [
      compilerPath,
      "-p",
      compilerConfiguration,
      "--rootDir",
      sourceRoot,
      "--outDir",
      outputDirectory,
      "--declaration",
      "false",
      "--declarationMap",
      "false",
      "--sourceMap",
      "false",
      "--inlineSourceMap",
      "false",
      "--inlineSources",
      "false",
      "--incremental",
      "false",
      "--composite",
      "false",
      "--noEmit",
      "false",
      "--emitDeclarationOnly",
      "false",
      "--tsBuildInfoFile",
      join(temporaryRoot, ".tsbuildinfo"),
    ],
    {
      cwd: pluginRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  const collect = (chunk: Buffer) => {
    if (outputBytes >= MAX_BUILD_OUTPUT_BYTES) return;
    const remaining = MAX_BUILD_OUTPUT_BYTES - outputBytes;
    chunks.push(Buffer.from(chunk.subarray(0, remaining)));
    outputBytes += Math.min(chunk.byteLength, remaining);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  }).catch((error: unknown) => {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "ARTIFACT_BUILD_FAILED",
        message: "Plugin TypeScript compiler could not be started",
        source: { kind: "artifact", id: "build" },
        cause:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: "UnknownCause", message: String(error) },
      }),
    );
  });
  await rm(compilerConfiguration, { force: true });

  if (exitCode !== 0) {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "ARTIFACT_BUILD_FAILED",
        message: "Plugin TypeScript compilation failed",
        source: { kind: "artifact", id: "build" },
        details: { exitCode, output: Buffer.concat(chunks).toString("utf8") },
      }),
    );
  }
}

export async function buildPlugin(options: BuildPluginOptions): Promise<BuiltPlugin> {
  const pluginMetadata = await lstat(options.pluginDirectory);
  if (pluginMetadata.isSymbolicLink() || !pluginMetadata.isDirectory()) {
    throw buildError(
      "ARTIFACT_BUILD_PATH_UNSAFE",
      "Plugin root must be a real directory",
      options.pluginDirectory,
    );
  }
  const pluginRoot = await realpath(options.pluginDirectory);
  const sourceRoot = await assertRegularPathWithin(
    pluginRoot,
    join(pluginRoot, "src"),
    "directory",
  );
  await assertTreeHasNoSymlinks(pluginRoot, sourceRoot);
  const tsconfigPath = await assertRegularPathWithin(
    pluginRoot,
    options.tsconfigPath ?? join(pluginRoot, "tsconfig.json"),
    "file",
  );
  const temporaryRoot = await mkdtemp(join(pluginRoot, ".tego-build-"));
  await chmod(temporaryRoot, 0o700);
  const outputDirectory = join(temporaryRoot, "components");
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(temporaryRoot, { force: true, recursive: true });
  };

  try {
    await runCompiler(pluginRoot, sourceRoot, tsconfigPath, temporaryRoot, outputDirectory);
    return { cleanup, outputDirectory: temporaryRoot };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
