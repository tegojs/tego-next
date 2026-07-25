import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(root, ".tego-echo-plugin-"));
const outputDirectory = join(temporaryRoot, "components");
const require = createRequire(import.meta.url);
const compilerPath = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");

function run(command, arguments_, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: environment,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`command failed with ${signal ?? `exit code ${String(code)}`}`));
    });
  });
}

try {
  await run(process.execPath, [
    compilerPath,
    "-p",
    join(root, "tsconfig.json"),
    "--outDir",
    outputDirectory,
  ]);
  if (process.argv.includes("--test")) {
    await run(process.execPath, ["--test", join(root, "test/component.test.ts")], {
      ...process.env,
      TEGO_ECHO_COMPONENT_URL: pathToFileURL(join(outputDirectory, "component.js")).href,
    });
  }
} finally {
  await Promise.all([
    rm(temporaryRoot, { force: true, recursive: true }),
    rm(join(root, "build"), { force: true, recursive: true }),
  ]);
}
