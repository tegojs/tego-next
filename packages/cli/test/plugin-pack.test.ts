import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DiagnosticError } from "@tegojs/contracts";
import { buildPlugin } from "../src/plugin/build-plugin.js";
import { packPlugin } from "../src/plugin/pack-plugin.js";
import { signArtifact } from "../src/plugin/sign-plugin.js";

const fixtureDirectory = fileURLToPath(
  new URL("../../../../examples/echo-plugin/", import.meta.url),
);

async function temporaryFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tego-plugin-pack-"));
  for (const path of ["manifest.json", "package.json", "tsconfig.json", "src/component.ts"]) {
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(fixtureDirectory, path), destination);
  }
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        declaration: false,
        erasableSyntaxOnly: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        outDir: "build/components",
        rootDir: "src",
        sourceMap: false,
        strict: true,
        target: "ES2024",
      },
      include: ["src/component.ts"],
    }),
  );
  return directory;
}

test("packs unchanged ESM plugin inputs into identical deterministic archives", async () => {
  const directory = await temporaryFixture();
  try {
    const firstPath = join(directory, "first.tego");
    const secondPath = join(directory, "second.tego");
    const first = await packPlugin({ artifactPath: firstPath, pluginDirectory: directory });
    const second = await packPlugin({ artifactPath: secondPath, pluginDirectory: directory });

    assert.equal(first.digest, second.digest);
    assert.deepEqual(await readFile(firstPath), await readFile(secondPath));
    assert.equal(
      first.digest,
      `sha256:${createHash("sha256")
        .update(await readFile(firstPath))
        .digest("hex")}`,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects undeclared TypeScript build outputs and source maps", async () => {
  const directory = await temporaryFixture();
  try {
    await mkdir(join(directory, "build/components"), { recursive: true });
    await writeFile(join(directory, "build/components/component.js"), "export default {};\n");
    await writeFile(join(directory, "build/components/component.js.map"), "{}");

    await assert.rejects(
      () =>
        packPlugin({
          artifactPath: join(directory, "plugin.tego"),
          build: false,
          pluginDirectory: directory,
        }),
      (error: unknown) => {
        assert.ok(error instanceof DiagnosticError);
        assert.equal(error.diagnostic.code, "ARTIFACT_BUILD_OUTPUT_UNDECLARED");
        return true;
      },
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("signs raw SHA-256 digest bytes with Ed25519 and emits a JSON-safe envelope", async () => {
  const directory = await temporaryFixture();
  try {
    const artifactPath = join(directory, "plugin.tego");
    const packed = await packPlugin({ artifactPath, pluginDirectory: directory });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const envelope = await signArtifact({
      artifactPath,
      keyId: "release",
      privateKey: privateKey.export({ format: "pem", type: "pkcs8" }),
    });

    assert.deepEqual(JSON.parse(JSON.stringify(envelope)), envelope);
    assert.equal(envelope.digest, packed.digest);
    assert.equal(
      verify(
        null,
        Buffer.from(packed.digest.slice("sha256:".length), "hex"),
        publicKey,
        Buffer.from(envelope.signature, "base64"),
      ),
      true,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("forces malicious TypeScript outDir into a private cleaned build directory", async () => {
  const directory = await temporaryFixture();
  const outside = join(dirname(directory), `${basename(directory)}-escaped`);
  try {
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: outside,
          rootDir: "src",
          strict: true,
          target: "ES2024",
        },
        include: ["src/component.ts"],
      }),
    );

    await packPlugin({
      artifactPath: join(directory, "plugin.tego"),
      pluginDirectory: directory,
    });
    await assert.rejects(access(outside));
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.startsWith(".tego-build-")),
      [],
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("build:false rejects a symlinked build root before reading external files", async () => {
  const directory = await temporaryFixture();
  const outside = await mkdtemp(join(tmpdir(), "tego-plugin-external-build-"));
  try {
    await mkdir(join(outside, "components"), { recursive: true });
    await writeFile(join(outside, "components/component.js"), "export default {};\n");
    await symlink(outside, join(directory, "build"), "dir");

    await assert.rejects(
      () =>
        packPlugin({
          artifactPath: join(directory, "plugin.tego"),
          build: false,
          pluginDirectory: directory,
        }),
      (error: unknown) => {
        assert.ok(error instanceof DiagnosticError);
        assert.equal(error.diagnostic.code, "ARTIFACT_BUILD_PATH_UNSAFE");
        return true;
      },
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("build rejects a tsconfig reached through a symlinked internal ancestor", async () => {
  const directory = await temporaryFixture();
  try {
    const pluginRoot = await realpath(directory);
    const configurationDirectory = join(pluginRoot, "configuration");
    await mkdir(configurationDirectory);
    await copyFile(
      join(pluginRoot, "tsconfig.json"),
      join(configurationDirectory, "tsconfig.json"),
    );
    await symlink(configurationDirectory, join(pluginRoot, "configuration-link"), "dir");
    await assert.rejects(
      () =>
        buildPlugin({
          pluginDirectory: pluginRoot,
          tsconfigPath: join(pluginRoot, "configuration-link/tsconfig.json"),
        }),
      (error: unknown) => {
        assert.ok(error instanceof DiagnosticError);
        assert.equal(error.diagnostic.code, "ARTIFACT_BUILD_PATH_UNSAFE");
        return true;
      },
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects host-resolved bare module specifiers without false positives", async (context) => {
  for (const [label, source] of [
    ["static import", 'import value from "left-pad";\nexport default value;\n'],
    ["export from", 'export { value as default } from "left-pad";\n'],
    ["dynamic import", 'export default () => import("left-pad");\n'],
    ["fake node builtin", 'import value from "node:left-pad";\nexport default value;\n'],
  ] as const) {
    await context.test(label, async () => {
      const directory = await temporaryFixture();
      try {
        await mkdir(join(directory, "build/components"), { recursive: true });
        await writeFile(join(directory, "build/components/component.js"), source);
        await assert.rejects(
          () =>
            packPlugin({
              artifactPath: join(directory, "plugin.tego"),
              build: false,
              pluginDirectory: directory,
            }),
          (error: unknown) => {
            assert.ok(error instanceof DiagnosticError);
            assert.equal(error.diagnostic.code, "ARTIFACT_IMPORT_UNSUPPORTED");
            return true;
          },
        );
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });
  }

  await context.test("strings and comments", async () => {
    const directory = await temporaryFixture();
    try {
      await mkdir(join(directory, "build/components"), { recursive: true });
      await writeFile(
        join(directory, "build/components/component.js"),
        [
          '// import value from "left-pad";',
          'const text = "export { value } from \\"left-pad\\"";',
          "export default text;",
        ].join("\n"),
      );
      await packPlugin({
        artifactPath: join(directory, "plugin.tego"),
        build: false,
        pluginDirectory: directory,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

test("rejects case-folded component path collisions", async () => {
  const directory = await temporaryFixture();
  try {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    manifest.components.push({
      ...manifest.components[0],
      componentId: "echo-upper",
      entrypoint: "components/COMPONENT.js",
    });
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await mkdir(join(directory, "build/components"), { recursive: true });
    await writeFile(join(directory, "build/components/component.js"), "export default {};\n");
    await writeFile(join(directory, "build/components/COMPONENT.js"), "export default {};\n");

    await assert.rejects(
      () =>
        packPlugin({
          artifactPath: join(directory, "plugin.tego"),
          build: false,
          pluginDirectory: directory,
        }),
      (error: unknown) => {
        assert.ok(error instanceof DiagnosticError);
        assert.equal(error.diagnostic.code, "ARTIFACT_ENTRY_COLLISION");
        return true;
      },
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("enforces deterministic pack entry and archive limits before allocation", async (context) => {
  await context.test("entry bytes", async () => {
    const directory = await temporaryFixture();
    try {
      await mkdir(join(directory, "build/components"), { recursive: true });
      await writeFile(join(directory, "build/components/component.js"), "export default {};\n");
      await assert.rejects(
        () =>
          packPlugin({
            artifactPath: join(directory, "plugin.tego"),
            build: false,
            limits: { maxEntryBytes: 8 },
            pluginDirectory: directory,
          }),
        (error: unknown) => {
          assert.ok(error instanceof DiagnosticError);
          assert.equal(error.diagnostic.code, "ARTIFACT_ENTRY_TOO_LARGE");
          return true;
        },
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  await context.test("archive bytes", async () => {
    const directory = await temporaryFixture();
    try {
      await mkdir(join(directory, "build/components"), { recursive: true });
      await writeFile(join(directory, "build/components/component.js"), "export default {};\n");
      await assert.rejects(
        () =>
          packPlugin({
            artifactPath: join(directory, "plugin.tego"),
            build: false,
            limits: { maxArchiveBytes: 1024 },
            pluginDirectory: directory,
          }),
        (error: unknown) => {
          assert.ok(error instanceof DiagnosticError);
          assert.equal(error.diagnostic.code, "ARTIFACT_ARCHIVE_TOO_LARGE");
          return true;
        },
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
