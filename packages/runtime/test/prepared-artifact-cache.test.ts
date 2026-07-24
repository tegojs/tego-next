import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseArtifactDigest,
  parseComponentId,
  parsePluginId,
  type ArtifactDigest,
  type ArtifactStore,
  type DriverHealth,
} from "@tegojs/contracts";
import {
  canonicalJsonBytes,
  createDeterministicArchive,
} from "../src/artifacts/archive-codec.js";
import { PreparedArtifactCache } from "../src/artifacts/prepared-artifact-cache.js";

const encoder = new TextEncoder();
const source = "export default { value: 'prepared' };\n";
const manifest = {
  schemaVersion: "1.0" as const,
  pluginId: parsePluginId("prepared-cache"),
  version: "1.0.0",
  contractRange: ">=1 <2",
  nodeRange: ">=26 <27",
  moduleFormat: "esm" as const,
  components: [
    {
      componentId: parseComponentId("component"),
      kind: "task" as const,
      entrypoint: "components/component.js",
      executors: ["thread" as const],
    },
  ],
  permissions: [],
  capabilities: { provides: [], requires: [] },
};

function digest(bytes: Uint8Array): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

function archive(componentSource = source): Uint8Array {
  const payload = [
    { path: "components/component.js", bytes: encoder.encode(componentSource) },
    { path: "manifest.json", bytes: canonicalJsonBytes(manifest) },
    {
      path: "metadata/sbom.json",
      bytes: canonicalJsonBytes({ packages: [], schemaVersion: "1.0" }),
    },
  ];
  const files = payload.map((entry) => ({
    path: entry.path,
    sha256: digest(entry.bytes),
    size: entry.bytes.byteLength,
  }));
  return createDeterministicArchive([
    ...payload,
    {
      path: "metadata/files.json",
      bytes: canonicalJsonBytes({ files, schemaVersion: "1.0" }),
    },
  ]);
}

class MemoryArtifacts implements ArtifactStore {
  readonly scope = "local" as const;
  readonly #values = new Map<ArtifactDigest, Uint8Array>();
  reads = 0;

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async health(): Promise<DriverHealth> {
    return { status: "healthy", checkedAt: new Date(0).toISOString() };
  }
  async put(expected: ArtifactDigest, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const values: Uint8Array[] = [];
    for await (const chunk of chunks) values.push(chunk);
    const bytes = Buffer.concat(values);
    assert.equal(digest(bytes), expected);
    this.#values.set(expected, bytes);
  }
  set(expected: ArtifactDigest, bytes: Uint8Array): void {
    this.#values.set(expected, bytes);
  }
  async *read(expected: ArtifactDigest): AsyncIterable<Uint8Array> {
    this.reads += 1;
    const bytes = this.#values.get(expected);
    if (bytes === undefined) throw new Error("missing artifact");
    for (let offset = 0; offset < bytes.byteLength; offset += 67) {
      yield bytes.subarray(offset, Math.min(offset + 67, bytes.byteLength));
    }
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tego-prepared-cache-"));
  const artifacts = new MemoryArtifacts();
  const bytes = archive();
  const artifactDigest = digest(bytes);
  artifacts.set(artifactDigest, bytes);
  const cache = new PreparedArtifactCache({ artifacts, root });
  return { artifactDigest, artifacts, cache, root };
}

test("@spec:plugin-artifacts/immutable-artifacts/prepares-atomically", async (context) => {
  const { artifactDigest, artifacts, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await rm(root, { force: true, recursive: true });
  });

  const [left, right] = await Promise.all([
    cache.prepare({ digest: artifactDigest }),
    cache.prepare({ digest: artifactDigest }),
  ]);

  assert.equal(left.root, right.root);
  assert.equal(left.manifest.pluginId, manifest.pluginId);
  assert.equal(await readFile(join(left.root, "components/component.js"), "utf8"), source);
  assert.equal(artifacts.reads, 1);
  assert.deepEqual(
    (await readdir(root)).filter((entry) => entry.startsWith(".tmp-")),
    [],
  );
  await cache.release(artifactDigest);
  await cache.release(artifactDigest);
});

test("prepared cache rejects changed archive bytes and removes its temporary directory", async (context) => {
  const { artifactDigest, artifacts, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await rm(root, { force: true, recursive: true });
  });
  artifacts.set(artifactDigest, archive("export default { changed: true };\n"));

  await assert.rejects(
    cache.prepare({ digest: artifactDigest }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "diagnostic" in error &&
      (error as { diagnostic: { code?: unknown } }).diagnostic.code ===
        "ARTIFACT_DIGEST_MISMATCH",
  );
  assert.deepEqual(await readdir(root), []);
});

test("prepared cache never trusts or overwrites a changed completed directory", async (context) => {
  const { artifactDigest, artifacts, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await rm(root, { force: true, recursive: true });
  });
  const prepared = await cache.prepare({ digest: artifactDigest });
  await cache.release(artifactDigest);
  await writeFile(join(prepared.root, "components/component.js"), "tampered\n");

  const restarted = new PreparedArtifactCache({ artifacts, root });
  await assert.rejects(
    restarted.prepare({ digest: artifactDigest }),
    /prepared artifact|cache|conflict|digest/iu,
  );
  assert.equal(await readFile(join(prepared.root, "components/component.js"), "utf8"), "tampered\n");
  await restarted.close();
});
