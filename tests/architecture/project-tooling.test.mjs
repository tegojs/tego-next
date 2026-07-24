import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const commitlintBinary = join(root, "node_modules", ".bin", "commitlint");
const hook = join(root, ".husky", "commit-msg");

test("root tooling declares the conventional commit toolchain", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  assert.equal(packageJson.scripts.prepare, "husky");
  assert.equal(packageJson.scripts.commitlint, "commitlint");
  assert.equal(packageJson.devDependencies.husky, "9.1.7");
  assert.equal(packageJson.devDependencies["@commitlint/cli"], "21.2.1");
  assert.equal(packageJson.devDependencies["@commitlint/config-conventional"], "21.2.0");

  const configPath = join(root, "commitlint.config.mjs");
  assert.equal(existsSync(configPath), true, "commitlint.config.mjs must exist");
  const config = (await import(pathToFileURL(configPath).href)).default;
  assert.deepEqual(config.extends, ["@commitlint/config-conventional"]);
});

test("commitlint accepts conventional messages and rejects free-form messages", () => {
  assert.equal(existsSync(commitlintBinary), true, "commitlint must be installed");

  const valid = spawnSync(commitlintBinary, [], {
    cwd: root,
    encoding: "utf8",
    input: "feat(runtime): add lifecycle\n",
  });
  const invalid = spawnSync(commitlintBinary, [], {
    cwd: root,
    encoding: "utf8",
    input: "added lifecycle support\n",
  });

  assert.equal(valid.status, 0, valid.stderr);
  assert.notEqual(invalid.status, 0);
});

test("the Husky commit-msg hook enforces the same rules", async () => {
  assert.equal(existsSync(hook), true, ".husky/commit-msg must exist");
  const directory = await mkdtemp(join(tmpdir(), "tego-commitlint-"));

  try {
    const validPath = join(directory, "valid");
    const invalidPath = join(directory, "invalid");
    await writeFile(validPath, "fix(worker): contain disconnect\n");
    await writeFile(invalidPath, "contain worker disconnect\n");

    const valid = spawnSync("sh", [hook, validPath], {
      cwd: root,
      encoding: "utf8",
    });
    const invalid = spawnSync("sh", [hook, invalidPath], {
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    assert.notEqual(invalid.status, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
