import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DiagnosticError, runtimeDiagnostic } from "@tegojs/contracts";

export interface BuildPluginOptions {
  readonly pluginDirectory: string;
  readonly tsconfigPath?: string;
}

const MAX_BUILD_OUTPUT_BYTES = 1024 * 1024;

export async function buildPlugin(options: BuildPluginOptions): Promise<void> {
  const tsconfigPath = options.tsconfigPath ?? join(options.pluginDirectory, "tsconfig.json");
  const require = createRequire(import.meta.url);
  const compilerPath = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  const child = spawn(
    process.execPath,
    [compilerPath, "-p", tsconfigPath],
    {
      cwd: options.pluginDirectory,
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
    chunks.push(chunk.subarray(0, remaining));
    outputBytes += Math.min(chunk.byteLength, remaining);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
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
