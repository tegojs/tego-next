import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveNpmCli } from "./run-ci-test.mjs";

const execute = promisify(execFile);
const npmCli = resolveNpmCli();
const publicDirectories = [
  "cli",
  "contracts",
  "drivers-local",
  "drivers-postgres",
  "executor-node",
  "plugin-sdk",
  "runtime",
  "testkit",
  "transport-websocket",
];
const forbiddenPackedPath = /\.tsbuildinfo$|(^|\/)test\/|\.test\.[cm]?js$|(?<!\.d)\.ts$/u;
const allowedPackedPath =
  /^package\/(?:LICENSE|README\.md|package\.json|dist\/src\/.+\.(?:d\.ts(?:\.map)?|js(?:\.map)?))$/u;

function rootPath(root) {
  return root instanceof URL ? fileURLToPath(root) : resolve(root);
}

async function npm(root, arguments_, options = {}) {
  return execute(process.execPath, [npmCli, ...arguments_], {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

function assertPackedFiles(name, files, entryPoint) {
  for (const file of files) {
    if (forbiddenPackedPath.test(file.path))
      throw new Error(`${name} packs forbidden path: ${file.path}`);
    if (!allowedPackedPath.test(file.path))
      throw new Error(`${name} packs path outside the consumer allowlist: ${file.path}`);
  }
  for (const required of [
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    entryPoint,
  ]) {
    if (!files.some((file) => file.path === required))
      throw new Error(`${name} omits required path: ${required}`);
  }
  if (name === "@tego/cli") {
    const executable = files.find((file) => file.path === "package/dist/src/bin.js");
    if (executable?.mode !== 0o755) throw new Error(`${name} CLI binary must have mode 0755`);
  }
}

export async function inspectWorkspacePackages(root) {
  const absoluteRoot = rootPath(root);
  return Promise.all(
    publicDirectories.map(async (directory) => {
      const manifest = JSON.parse(
        await readFile(join(absoluteRoot, "packages", directory, "package.json"), "utf8"),
      );
      return {
        directory,
        entryPoint: `package/${manifest.bin ? "dist/src/bin.js" : "dist/src/index.js"}`,
        name: manifest.name,
      };
    }),
  );
}

export async function packWorkspaceSet(root, outputDirectory) {
  const absoluteRoot = rootPath(root);
  const inspections = await inspectWorkspacePackages(absoluteRoot);
  await mkdir(outputDirectory, { recursive: true });
  return Promise.all(
    inspections.map(async (inspection) => {
      const { stdout } = await npm(absoluteRoot, [
        "pack",
        "--json",
        "--pack-destination",
        outputDirectory,
        "--workspace",
        inspection.name,
      ]);
      const [result] = JSON.parse(stdout);
      const tarball = join(outputDirectory, result.filename);
      const packed = {
        ...inspection,
        files: result.files.map((file) => ({ ...file, path: `package/${file.path}` })),
        tarball,
      };
      assertPackedFiles(packed.name, packed.files, packed.entryPoint);
      return packed;
    }),
  );
}

export async function verifyPackedConsumer(packedWorkspaces, consumerDirectory) {
  await rm(consumerDirectory, { force: true, recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  const dependencies = Object.fromEntries(
    packedWorkspaces.map(({ name, tarball }) => [name, `file:${tarball}`]),
  );
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "tego-packed-consumer", private: true, type: "module", dependencies }, null, 2)}\n`,
  );
  await npm(consumerDirectory, ["install", "--ignore-scripts"]);
  for (const workspace of packedWorkspaces) {
    await execute(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(workspace.name)})`],
      { cwd: consumerDirectory },
    );
  }
  const cli = join(consumerDirectory, "node_modules", "@tego", "cli", "dist", "src", "bin.js");
  await execute(process.execPath, [cli, "--help"], { cwd: consumerDirectory });
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--verify")
    throw new Error("Usage: node scripts/package-contract.mjs --verify");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = await mkdtemp(join(tmpdir(), "tego-packed-workspaces-"));
  try {
    const packed = await packWorkspaceSet(root, output);
    await verifyPackedConsumer(packed, join(output, "consumer"));
    process.stdout.write(
      `${JSON.stringify({ ok: true, packages: packed.map(({ name }) => name) })}\n`,
    );
  } finally {
    await rm(output, { force: true, recursive: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
