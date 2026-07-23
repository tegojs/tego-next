import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DiagnosticError } from "@tegojs/contracts";
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
