import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveNpmCli } from "./run-ci-test.mjs";

const execute = promisify(execFile);
const npmCli = resolveNpmCli();
const forbiddenPackedPath =
  /\.tsbuildinfo$|(^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.(?:[cm]?js|d\.ts)(?:\.map)?$|(?<!\.d)\.ts$/u;
const allowedPackedPath =
  /^package\/(?:LICENSE|README\.md|package\.json|dist\/src\/.+\.(?:d\.ts(?:\.map)?|js(?:\.map)?)|dist\/src\/control\/windows-control-broker\.(?:ps1|cs))$/u;
const releaseVersion = "2.0.0-alpha.1";
const expectedPackages = [
  {
    directory: "cli",
    name: "@tego/cli",
    dependencies: {
      "@tego/contracts": releaseVersion,
      "@tego/drivers-local": releaseVersion,
      "@tego/drivers-postgres": releaseVersion,
      "@tego/executor-node": releaseVersion,
      "@tego/plugin-sdk": releaseVersion,
      "@tego/runtime": releaseVersion,
      "@tego/transport-websocket": releaseVersion,
    },
  },
  { directory: "contracts", name: "@tego/contracts", dependencies: {} },
  {
    directory: "drivers-local",
    name: "@tego/drivers-local",
    dependencies: { "@tego/contracts": releaseVersion, "@tego/testkit": releaseVersion },
  },
  {
    directory: "drivers-postgres",
    name: "@tego/drivers-postgres",
    dependencies: { "@tego/contracts": releaseVersion, "@tego/testkit": releaseVersion },
  },
  {
    directory: "executor-node",
    name: "@tego/executor-node",
    dependencies: {
      "@tego/contracts": releaseVersion,
      "@tego/plugin-sdk": releaseVersion,
      "@tego/testkit": releaseVersion,
    },
  },
  {
    directory: "plugin-sdk",
    name: "@tego/plugin-sdk",
    dependencies: { "@tego/contracts": releaseVersion },
  },
  {
    directory: "runtime",
    name: "@tego/runtime",
    dependencies: { "@tego/contracts": releaseVersion, "@tego/testkit": releaseVersion },
  },
  {
    directory: "testkit",
    name: "@tego/testkit",
    dependencies: { "@tego/contracts": releaseVersion },
  },
  {
    directory: "transport-websocket",
    name: "@tego/transport-websocket",
    dependencies: { "@tego/contracts": releaseVersion, "@tego/testkit": releaseVersion },
  },
];

function rootPath(root) {
  return root instanceof URL ? fileURLToPath(root) : resolve(root);
}

function internalDependencies(manifest) {
  const dependencies = {};
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (!name.startsWith("@tego/")) continue;
      if (Object.hasOwn(dependencies, name))
        throw new Error(`internal dependency ${name} is declared more than once`);
      dependencies[name] = version;
    }
  }
  return dependencies;
}

function assertExact(value, expected, message) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(message);
}

function assertPackageManifest(manifest, expected, source) {
  if (manifest.name !== expected.name) throw new Error(`${source} must be named ${expected.name}`);
  if (manifest.version !== releaseVersion)
    throw new Error(`${source} must use version ${releaseVersion}`);
  if (manifest.license !== "Apache-2.0") throw new Error(`${source} must declare Apache-2.0`);
  if (manifest.homepage !== "https://github.com/tegojs/tego-next#readme")
    throw new Error(`${source} must declare the public homepage`);
  assertExact(
    manifest.bugs,
    { url: "https://github.com/tegojs/tego-next/issues" },
    `${source} has invalid bugs metadata`,
  );
  assertExact(manifest.engines, { node: ">=26.5.0 <27" }, `${source} has invalid Node engine`);
  assertExact(
    manifest.publishConfig,
    { access: "public", registry: "https://registry.npmjs.org/", tag: "alpha" },
    `${source} has invalid publish configuration`,
  );
  if (manifest.repository?.directory !== `packages/${expected.directory}`)
    throw new Error(`${source} has invalid repository directory`);
  if (typeof manifest.description !== "string" || manifest.description.trim() === "")
    throw new Error(`${source} must have a description`);
  if (manifest.types !== "./dist/src/index.d.ts")
    throw new Error(`${source} must advertise index declarations`);
  assertExact(
    manifest.exports,
    { ".": { types: "./dist/src/index.d.ts", import: "./dist/src/index.js" } },
    `${source} has invalid root export`,
  );
  const expectedBin = expected.directory === "cli" ? { tego: "./dist/src/bin.js" } : undefined;
  assertExact(manifest.bin, expectedBin, `${source} has invalid binary metadata`);
  assertExact(
    internalDependencies(manifest),
    expected.dependencies,
    `${source} has invalid internal dependencies`,
  );
}

async function npm(root, arguments_, options = {}) {
  return execute(process.execPath, [npmCli, ...arguments_], {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

export function assertPackedFiles(name, files, entryPoint, platform = process.platform) {
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
    "package/dist/src/index.d.ts",
  ]) {
    if (!files.some((file) => file.path === required))
      throw new Error(`${name} omits required path: ${required}`);
  }
  if (name === "@tego/cli") {
    const executable = files.find((file) => file.path === "package/dist/src/bin.js");
    if (platform !== "win32" && executable?.mode !== 0o755) {
      throw new Error(`${name} CLI binary must have mode 0755`);
    }
    for (const asset of ["windows-control-broker.ps1", "windows-control-broker.cs"]) {
      if (!files.some((file) => file.path === `package/dist/src/control/${asset}`)) {
        throw new Error(`${name} omits the Windows control broker asset: ${asset}`);
      }
    }
  }
}

export async function inspectWorkspacePackages(root) {
  const absoluteRoot = rootPath(root);
  const inspections = [];
  const names = new Set();
  for (const expected of expectedPackages) {
    const { directory } = expected;
    const manifest = JSON.parse(
      await readFile(join(absoluteRoot, "packages", directory, "package.json"), "utf8"),
    );
    assertPackageManifest(manifest, expected, `packages/${directory}/package.json`);
    if (names.has(manifest.name))
      throw new Error(`public package names must be unique: ${manifest.name}`);
    names.add(manifest.name);
    inspections.push({
      directory,
      entryPoint: `package/${manifest.bin ? "dist/src/bin.js" : "dist/src/index.js"}`,
      name: manifest.name,
      version: manifest.version,
    });
  }
  assertExact(
    [...names].sort(),
    expectedPackages.map(({ name }) => name).sort(),
    "public package name set is invalid",
  );
  return inspections;
}

export async function packWorkspaceSet(root, outputDirectory) {
  const absoluteRoot = rootPath(root);
  const absoluteOutputDirectory = resolve(outputDirectory);
  const inspections = await inspectWorkspacePackages(absoluteRoot);
  await mkdir(absoluteOutputDirectory, { recursive: true });
  const packedWorkspaces = [];
  for (const inspection of inspections) {
    const { stdout } = await npm(absoluteRoot, [
      "pack",
      "--json",
      "--pack-destination",
      absoluteOutputDirectory,
      "--workspace",
      inspection.name,
    ]);
    const results = JSON.parse(stdout);
    if (!Array.isArray(results) || results.length !== 1)
      throw new Error(`npm pack returned an invalid result for ${inspection.name}`);
    const [result] = results;
    if (
      result?.id !== `${inspection.name}@${releaseVersion}` ||
      result.name !== inspection.name ||
      result.version !== releaseVersion
    )
      throw new Error(`npm pack returned the wrong package identity for ${inspection.name}`);
    const tarball = join(absoluteOutputDirectory, result.filename);
    const packedManifest = JSON.parse(
      (await execute("tar", ["-xOf", tarball, "package/package.json"])).stdout,
    );
    assertPackageManifest(
      packedManifest,
      expectedPackages.find(({ name }) => name === inspection.name),
      `${inspection.name} packed package.json`,
    );
    const packed = {
      ...inspection,
      integrity: result.integrity,
      dependencies: packedManifest.dependencies ?? {},
      devDependencies: packedManifest.devDependencies ?? {},
      files: result.files.map((file) => ({ ...file, path: `package/${file.path}` })),
      optionalDependencies: packedManifest.optionalDependencies ?? {},
      peerDependencies: packedManifest.peerDependencies ?? {},
      tarball,
    };
    assertPackedFiles(packed.name, packed.files, packed.entryPoint);
    packedWorkspaces.push(packed);
  }
  return packedWorkspaces;
}

function isTemporaryParent(directory) {
  const relativePath = relative(resolve(tmpdir()), directory);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export async function withPackedConsumer(packedWorkspaces, consumerParentDirectory, callback) {
  const consumerParent = resolve(consumerParentDirectory);
  if (!isTemporaryParent(consumerParent))
    throw new Error("safe consumer directory must be an existing temporary parent");
  const parentStats = await lstat(consumerParent).catch(() => undefined);
  if (!parentStats?.isDirectory())
    throw new Error("safe consumer directory must be an existing temporary parent");
  if (typeof callback !== "function") throw new TypeError("packed consumer callback is required");
  const names = new Set();
  for (const workspace of packedWorkspaces) {
    if (names.has(workspace.name))
      throw new Error(`packed workspace names must be unique: ${workspace.name}`);
    names.add(workspace.name);
  }
  assertExact(
    [...names],
    expectedPackages.map(({ name }) => name),
    "packed consumer requires exactly the nine public packages in canonical order",
  );
  const consumerDirectory = await mkdtemp(join(consumerParent, "tego-packed-consumer-"));
  try {
    if ((await readdir(consumerDirectory)).length !== 0)
      throw new Error("packed consumer must start empty");
    const dependencies = {};
    for (const { name, tarball } of packedWorkspaces) dependencies[name] = `file:${tarball}`;
    await writeFile(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify({ name: "tego-packed-consumer", private: true, type: "module", dependencies }, null, 2)}\n`,
    );
    await npm(consumerDirectory, ["install", "--ignore-scripts"]);
    const canonicalConsumerDirectory = await realpath(consumerDirectory);
    for (const workspace of packedWorkspaces) {
      const installedRoot = join(consumerDirectory, "node_modules", ...workspace.name.split("/"));
      const installedStats = await lstat(installedRoot);
      const canonicalInstalledRoot = await realpath(installedRoot);
      if (
        !installedStats.isDirectory() ||
        installedStats.isSymbolicLink() ||
        relative(canonicalConsumerDirectory, canonicalInstalledRoot).startsWith("..")
      ) {
        throw new Error(`${workspace.name} must be a physical clean-consumer install`);
      }
      await execute(
        process.execPath,
        ["--input-type=module", "--eval", `await import(${JSON.stringify(workspace.name)})`],
        { cwd: consumerDirectory, env: { ...process.env, NODE_PATH: "" } },
      );
    }
    const cliRoot = join(consumerDirectory, "node_modules", "@tego", "cli");
    const cli = join(cliRoot, "dist", "src", "bin.js");
    await execute(process.execPath, [cli, "--help"], {
      cwd: consumerDirectory,
      env: { ...process.env, NODE_PATH: "" },
    });
    const brokerPowerShell = join(cliRoot, "dist", "src", "control", "windows-control-broker.ps1");
    const brokerCSharp = join(cliRoot, "dist", "src", "control", "windows-control-broker.cs");
    for (const asset of ["windows-control-broker.ps1", "windows-control-broker.cs"]) {
      const installed = await readFile(join(cliRoot, "dist", "src", "control", asset));
      if (installed.byteLength === 0) throw new Error(`clean consumer has an empty ${asset}`);
    }
    return await callback({
      brokerCSharp,
      brokerPowerShell,
      cliRoot,
      directory: consumerDirectory,
      packageNames: [...names],
    });
  } finally {
    await rm(consumerDirectory, { force: true, recursive: true });
  }
}

export async function verifyPackedConsumer(packedWorkspaces, consumerParentDirectory) {
  await withPackedConsumer(packedWorkspaces, consumerParentDirectory, async () => undefined);
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--verify")
    throw new Error("Usage: node scripts/package-contract.mjs --verify");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = await mkdtemp(join(tmpdir(), "tego-packed-workspaces-"));
  try {
    const packed = await packWorkspaceSet(root, output);
    await verifyPackedConsumer(packed, output);
    process.stdout.write(
      `${JSON.stringify({ ok: true, packages: packed.map(({ name }) => name) })}\n`,
    );
  } finally {
    await rm(output, { force: true, recursive: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
