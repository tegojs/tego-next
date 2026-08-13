import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

test("CLI build finalization makes a freshly emitted binary executable", async () => {
  const { finalizeCliBuild } = await import(
    new URL("../../scripts/copy-windows-pipe-security.mjs", import.meta.url)
  );
  const directory = await mkdtemp(join(tmpdir(), "tego-cli-build-finalization-"));
  const binary = join(directory, "bin.js");
  const helperSource = join(directory, "source.ps1");
  const helperDestination = join(directory, "control", "windows-pipe-security.ps1");

  try {
    await writeFile(binary, "#!/usr/bin/env node\n", { mode: 0o644 });
    await writeFile(helperSource, "helper\n");
    await finalizeCliBuild({ binary, helperDestination, helperSource, platform: "linux" });

    assert.equal((await lstat(binary)).mode & 0o777, 0o755);
    assert.equal(await readFile(helperDestination, "utf8"), "helper\n");
  } finally {
    await rm(directory, { force: true, recursive: true });
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

test("Windows pipe-security helper owns a bounded fail-fast watchdog through early failures", async () => {
  const helper = await readFile(join(root, "scripts", "windows-pipe-security.ps1"), "utf8");

  assert.match(helper, /Environment\.FailFast\(/u);
  assert.match(helper, /StartWatchdog\(9000\)/u);
  assert.match(
    helper,
    /\$watchdog = \$null[\s\S]*try \{[\s\S]*\$watchdog = \[TegoWindowsPipeSecurityNative\]::StartWatchdog\(9000\)[\s\S]*\$handle = \[TegoWindowsPipeSecurityNative\]::CreateFile\([\s\S]*\} finally \{[\s\S]*Close-TegoResource \$handle[\s\S]*Close-TegoResource \$watchdog/u,
  );
  assert.match(helper, /TEGO_WINDOWS_PIPE_SECURITY_\$\{failureStage\}_FAILED/u);
  assert.doesNotMatch(helper, /\[Console\]::Error\.WriteLine\(\$_.+\)/u);
});

test("Windows control gate emits fixed diagnostics without exception details", async () => {
  const gate = await readFile(
    join(root, "packages", "cli", "test", "windows-control-gate.ts"),
    "utf8",
  );

  assert.match(gate, /TEGO_WINDOWS_CONTROL_GATE_FAILED/u);
  assert.doesNotMatch(gate, /error\.(?:message|stack)|String\(error\)/u);
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
  const targetSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const evidence = parseRecordedReleaseEvidence(`before\n\`\`\`release-evidence
{"schemaVersion":1,"targetSha":"${targetSha}","localVerification":{"status":"passed","sourceSha":"${targetSha}"},"authoritativeCi":{"status":"passed","sourceSha":"${targetSha}","url":"https://github.com/tegojs/tego-next/actions/runs/1"}}
\`\`\`\nafter\n`);
  assert.deepEqual(validateRecordedReleaseEvidence(evidence), []);
  evidence.authoritativeCi.status = "failed";
  assert.match(validateRecordedReleaseEvidence(evidence).join("\n"), /authoritative/u);
});

test("release evidence separates tested target from later evidence commit", async () => {
  const { validateReleaseEvidenceTarget } = await import(
    new URL("../../scripts/verify-release.mjs", import.meta.url)
  );
  const targetSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const evidenceSha = "fedcbafedcbafedcbafedcbafedcbafedcbafedc";
  const headSha = "1234567890abcdef1234567890abcdef12345678";
  const calls = [];
  const evidence = {
    schemaVersion: 1,
    targetSha,
    localVerification: { status: "passed", sourceSha: targetSha },
    authoritativeCi: {
      status: "passed",
      sourceSha: evidenceSha,
      url: "https://github.com/tegojs/tego-next/actions/runs/1",
    },
  };
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "merge-base") return { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "rev-list" && args[1] === "--reverse") {
      return { exitCode: 0, stdout: `${evidenceSha}\n${headSha}\n`, stderr: "" };
    }
    if (args[0] === "rev-list" && args[1] === "--parents") {
      const commit = args.at(-1);
      const parent = commit === evidenceSha ? targetSha : evidenceSha;
      return { exitCode: 0, stdout: `${commit} ${parent}\n`, stderr: "" };
    }
    if (args[0] === "diff-tree") {
      return {
        exitCode: 0,
        stdout:
          args.at(-1) === evidenceSha
            ? "openspec/changes/runtime-kernel-phase-1/verification-report.md\n"
            : "openspec/changes/runtime-kernel-phase-1/.comet.yaml\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  };
  assert.deepEqual(await validateReleaseEvidenceTarget({ evidence, headSha, run }), {
    targetSha,
    commitsAfterTarget: 2,
  });
  assert.equal(
    calls.every(({ command }) => command === "git"),
    true,
  );

  const unrelated = async (command, args) => {
    const result = await run(command, args);
    if (args[0] === "diff-tree" && args.at(-1) === evidenceSha) {
      return { ...result, stdout: "packages/runtime/src/index.ts\n" };
    }
    return result;
  };
  await assert.rejects(
    validateReleaseEvidenceTarget({ evidence, headSha, run: unrelated }),
    /unrelated.*packages\/runtime/u,
  );

  const nonAncestor = async (_command, args) => ({
    exitCode: args[0] === "merge-base" ? 1 : 0,
    stdout: "",
    stderr: "",
  });
  await assert.rejects(
    validateReleaseEvidenceTarget({ evidence, headSha, run: nonAncestor }),
    /ancestor/u,
  );

  const tooDistant = async (command, args) => {
    const result = await run(command, args);
    if (args[0] === "rev-list" && args[1] === "--reverse") {
      return {
        ...result,
        stdout: `0000000000000000000000000000000000000001\n${evidenceSha}\n${headSha}\n`,
      };
    }
    return result;
  };
  await assert.rejects(
    validateReleaseEvidenceTarget({ evidence, headSha, run: tooDistant }),
    /more than two/u,
  );

  evidence.localVerification.sourceSha = "0000000000000000000000000000000000000000";
  const tamperedSource = async (command, args) => {
    const result = await run(command, args);
    if (args[0] === "merge-base" && args.includes(evidence.localVerification.sourceSha)) {
      return { ...result, exitCode: 1 };
    }
    return result;
  };
  await assert.rejects(
    validateReleaseEvidenceTarget({ evidence, headSha, run: tamperedSource }),
    /source SHA.*evidence-only/u,
  );

  evidence.localVerification.sourceSha = targetSha;
  const changedThenReverted = async (command, args) => {
    const result = await run(command, args);
    if (args[0] === "diff-tree" && args.at(-1) === evidenceSha) {
      return { ...result, stdout: "packages/runtime/src/index.ts\n" };
    }
    return result;
  };
  await assert.rejects(
    validateReleaseEvidenceTarget({ evidence, headSha, run: changedThenReverted }),
    /unrelated.*packages\/runtime/u,
  );

  const mergeChain = async (command, args) => {
    const result = await run(command, args);
    if (args[0] === "rev-list" && args[1] === "--parents" && args.at(-1) === headSha) {
      return { ...result, stdout: `${headSha} ${evidenceSha} ${targetSha}\n` };
    }
    return result;
  };
  await assert.rejects(
    validateReleaseEvidenceTarget({ evidence, headSha, run: mergeChain }),
    /merge.*evidence/u,
  );
});
