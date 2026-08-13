import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
const forbiddenPackedPath =
  /\.tsbuildinfo$|(^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.(?:[cm]?js|d\.ts)(?:\.map)?$|(?<!\.d)\.ts$/u;

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
      assert.equal(manifest.types, "./dist/src/index.d.ts");
      assert.deepEqual(manifest.exports, {
        ".": {
          types: "./dist/src/index.d.ts",
          import: "./dist/src/index.js",
        },
      });
      if (directory === "cli") assert.deepEqual(manifest.bin, { tego: "./dist/src/bin.js" });
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
      assert.match(workspace.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
      assert.equal(typeof workspace.dependencies, "object");
      assert.equal(typeof workspace.devDependencies, "object");
      assert.equal(typeof workspace.optionalDependencies, "object");
      assert.equal(typeof workspace.peerDependencies, "object");
      for (const file of workspace.files) {
        assert.doesNotMatch(file.path, forbiddenPackedPath, `${workspace.name}: ${file.path}`);
      }
      for (const required of [
        "package/package.json",
        "package/README.md",
        "package/LICENSE",
        workspace.entryPoint,
        "package/dist/src/index.d.ts",
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
        assert.ok(
          workspace.files.some(
            (file) => file.path === "package/dist/src/control/windows-pipe-security.ps1",
          ),
          "CLI package must include the fixed Windows pipe-security helper",
        );
      }
    }
    await verifyPackedConsumer(packed, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("Windows pipe-security helper owns a bounded fail-fast watchdog", async () => {
  const helper = await readFile(join(root, "scripts", "windows-pipe-security.ps1"), "utf8");

  assert.match(helper, /Environment\.FailFast\(/u);
  assert.match(helper, /StartWatchdog\(9000\)/u);
  assert.match(helper, /\$watchdog\.Dispose\(\)/u);
});

test("workspace inspection rejects duplicate public names and non-alpha versions", async () => {
  const { inspectWorkspacePackages } = await import(
    new URL("../../scripts/package-contract.mjs", import.meta.url)
  );
  const directory = await mkdtemp(join(tmpdir(), "tego-package-manifests-"));
  const packageRoot = join(directory, "packages");

  try {
    for (const name of publicDirectories) {
      const manifest = await manifestFor(name);
      if (name === "runtime") manifest.name = "@tego/contracts";
      if (name === "testkit") manifest.version = "2.0.0-alpha.2";
      await mkdir(join(packageRoot, name), { recursive: true });
      await writeFile(join(packageRoot, name, "package.json"), JSON.stringify(manifest));
    }
    await assert.rejects(inspectWorkspacePackages(directory), /named|version/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("package packing rejects emitted test assets and missing declarations", async () => {
  const { assertPackedFiles, packWorkspaceSet } = await import(
    new URL("../../scripts/package-contract.mjs", import.meta.url)
  );
  const directory = await mkdtemp(join(tmpdir(), "tego-package-output-"));
  const declaration = join(root, "packages", "contracts", "dist", "src", "index.d.ts");
  const heldDeclaration = `${declaration}.package-contract-held`;

  try {
    assert.throws(
      () =>
        assertPackedFiles(
          "@tego/contracts",
          [
            { path: "package/package.json" },
            { path: "package/README.md" },
            { path: "package/LICENSE" },
            { path: "package/dist/src/index.js" },
            { path: "package/dist/src/index.d.ts" },
            { path: "package/dist/src/__tests__/contract.spec.d.ts.map" },
          ],
          "package/dist/src/index.js",
        ),
      /forbidden path/u,
    );
    await rename(declaration, heldDeclaration);
    await assert.rejects(packWorkspaceSet(root, directory), /declaration|index\.d\.ts/u);
  } finally {
    await rename(heldDeclaration, declaration).catch(() => undefined);
    await rm(directory, { force: true, recursive: true });
  }
});

test("clean-consumer verification rejects broad targets before deletion", async () => {
  const { verifyPackedConsumer } = await import(
    new URL("../../scripts/package-contract.mjs", import.meta.url)
  );
  await assert.rejects(verifyPackedConsumer([], tmpdir()), /safe consumer directory/u);
  await assert.rejects(verifyPackedConsumer([], root), /safe consumer directory/u);
});

test("root exposes only the explicit alpha release modes", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts["release:alpha"], "node scripts/publish-alpha.mjs");

  const { parseRecordedReleaseEvidence, validateRecordedReleaseEvidence } = await import(
    new URL("../../scripts/verify-release.mjs", import.meta.url)
  );
  const sha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const evidence = parseRecordedReleaseEvidence(`before\n\`\`\`release-evidence
{"gitSha":"${sha}","localVerification":"passed","authoritativeCi":{"status":"passed","gitSha":"${sha}","url":"https://github.com/tegojs/tego-next/actions/runs/1"}}
\`\`\`\nafter\n`);
  assert.deepEqual(validateRecordedReleaseEvidence(evidence, sha), []);
  evidence.authoritativeCi.status = "failed";
  assert.match(validateRecordedReleaseEvidence(evidence, sha).join("\n"), /authoritative/u);
});
