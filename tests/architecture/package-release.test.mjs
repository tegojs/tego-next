import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
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

async function manifestFor(directory) {
  return JSON.parse(await readFile(join(root, "packages", directory, "package.json"), "utf8"));
}

test("public package manifests declare alpha publication metadata", async (t) => {
  assert.equal(existsSync(join(root, "LICENSE")), true, "root LICENSE must exist");
  const rootLicense = await readFile(join(root, "LICENSE"), "utf8");

  for (const directory of publicDirectories) {
    await t.test(directory, async () => {
      const manifest = await manifestFor(directory);
      assert.equal(manifest.license, "Apache-2.0");
      assert.equal(manifest.homepage, "https://github.com/tegojs/tego-next#readme");
      assert.deepEqual(manifest.bugs, { url: "https://github.com/tegojs/tego-next/issues" });
      assert.deepEqual(manifest.engines, { node: ">=26.5.0 <27" });
      assert.deepEqual(manifest.publishConfig, {
        access: "public",
        registry: "https://registry.npmjs.org/",
        tag: "alpha",
      });
      assert.equal(manifest.repository.directory, `packages/${directory}`);
      assert.match(manifest.description, /\S/u);
      const packageRoot = join(root, "packages", directory);
      const readme = await readFile(join(packageRoot, "README.md"), "utf8");
      assert.match(readme, new RegExp(`npm install @tego/${directory}@alpha`, "u"));
      assert.match(readme, /experimental/iu);
      assert.match(readme, /non-production/iu);
      assert.equal(await readFile(join(packageRoot, "LICENSE"), "utf8"), rootLicense);
    });
  }
});

test("packed public packages contain only consumer assets and install cleanly", async () => {
  const { packWorkspaceSet, verifyPackedConsumer } = await import(
    new URL("../../scripts/package-contract.mjs", import.meta.url)
  );
  const directory = await mkdtemp(join(tmpdir(), "tego-package-contract-"));

  try {
    const packed = await packWorkspaceSet(root, join(directory, "tarballs"));
    assert.equal(packed.length, publicDirectories.length);
    for (const workspace of packed) {
      for (const file of workspace.files) {
        assert.doesNotMatch(file.path, forbiddenPackedPath, `${workspace.name}: ${file.path}`);
      }
      for (const required of [
        "package/package.json",
        "package/README.md",
        "package/LICENSE",
        workspace.entryPoint,
      ]) {
        assert.ok(
          workspace.files.some((file) => file.path === required),
          `${workspace.name}: ${required}`,
        );
      }
      if (workspace.name === "@tego/cli") {
        const executable = workspace.files.find((file) => file.path === "package/dist/src/bin.js");
        assert.ok(executable, "CLI binary must be packed");
        assert.equal(executable.mode, 0o755, "packed CLI binary must be executable");
      }
    }
    await verifyPackedConsumer(packed, join(directory, "consumer"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
