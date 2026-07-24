import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import { canonicalJsonBytes, createDeterministicArchive } from "../src/artifacts/archive-codec.js";
import {
  PreparedArtifactCache,
  type PreparedArtifactCacheOptions,
} from "../src/artifacts/prepared-artifact-cache.js";

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

async function cleanupRoot(root: string): Promise<void> {
  async function writable(path: string): Promise<void> {
    let identity: Awaited<ReturnType<typeof lstat>>;
    try {
      identity = await lstat(path);
    } catch {
      return;
    }
    if (identity.isSymbolicLink() || !identity.isDirectory()) return;
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await writable(join(path, entry));
  }
  await writable(root);
  await rm(root, { force: true, recursive: true });
}

test("@spec:plugin-artifacts/immutable-artifacts/prepares-atomically", async (context) => {
  const { artifactDigest, artifacts, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await cleanupRoot(root);
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

test("@spec:plugin-artifacts/immutable-artifacts/crash-stale-lock-does-not-block-prepare", async (context) => {
  const { artifactDigest, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await cleanupRoot(root);
  });
  const legacyLock = join(root, `${artifactDigest.slice("sha256:".length)}.lock`);
  await writeFile(legacyLock, "stale legacy lock\n");

  const prepared = await cache.prepare({ digest: artifactDigest });

  assert.equal(await readFile(join(prepared.root, "components/component.js"), "utf8"), source);
  await cache.release(artifactDigest);
});

test("@spec:plugin-artifacts/immutable-artifacts/concurrent-cache-processes-converge", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tego-prepared-concurrent-"));
  const artifacts = new MemoryArtifacts();
  const bytes = archive();
  const artifactDigest = digest(bytes);
  artifacts.set(artifactDigest, bytes);
  const leftCache = new PreparedArtifactCache({ artifacts, root });
  const rightCache = new PreparedArtifactCache({ artifacts, root });
  context.after(async () => {
    await Promise.all([leftCache.close(), rightCache.close()]);
    await cleanupRoot(root);
  });

  const [left, right] = await Promise.all([
    leftCache.prepare({ digest: artifactDigest }),
    rightCache.prepare({ digest: artifactDigest }),
  ]);

  assert.equal(left.root, right.root);
  assert.equal(await readFile(join(left.root, "components/component.js"), "utf8"), source);
  const objects = (await readdir(root)).filter((entry) => entry.startsWith(".object-"));
  const pointer = await readFile(join(root, artifactDigest.slice("sha256:".length)), "utf8");
  assert.deepEqual(objects, [pointer.split("/")[0]]);
  await leftCache.release(artifactDigest);
  await rightCache.release(artifactDigest);
});

test("@spec:plugin-artifacts/immutable-artifacts/publishes-only-readonly-roots", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tego-prepared-publish-crash-"));
  const artifacts = new MemoryArtifacts();
  const bytes = archive();
  const artifactDigest = digest(bytes);
  artifacts.set(artifactDigest, bytes);
  let observed = 0;
  const crashing = new PreparedArtifactCache(
    {
      artifacts,
      root,
      afterPublish: async (publishedRoot: string) => {
        observed += 1;
        assert.equal((await stat(publishedRoot)).mode & 0o222, 0);
        throw new Error("simulated immediate publisher crash");
      },
    } as PreparedArtifactCacheOptions & {
      readonly afterPublish: (publishedRoot: string) => Promise<void>;
    },
  );
  context.after(async () => {
    await crashing.close();
    await cleanupRoot(root);
  });

  await assert.rejects(
    crashing.prepare({ digest: artifactDigest }),
    /simulated immediate publisher crash/u,
  );
  assert.equal(observed, 1);

  const restarted = new PreparedArtifactCache({ artifacts, root });
  const prepared = await restarted.prepare({ digest: artifactDigest });
  assert.equal((await stat(prepared.root)).mode & 0o222, 0);
  assert.equal(await readFile(join(prepared.root, "components/component.js"), "utf8"), source);
  assert.deepEqual(
    (await readdir(root)).filter((entry) => entry.startsWith(".tmp-")),
    [],
  );
  const objects = (await readdir(root)).filter((entry) => entry.startsWith(".object-"));
  const pointer = await readFile(join(root, artifactDigest.slice("sha256:".length)), "utf8");
  assert.deepEqual(objects, [pointer.split("/")[0]]);
  await restarted.release(artifactDigest);
  await restarted.close();
});

test("@spec:plugin-artifacts/immutable-artifacts/reuses-legacy-direct-target", async (context) => {
  const { artifactDigest, artifacts, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await cleanupRoot(root);
  });
  const prepared = await cache.prepare({ digest: artifactDigest });
  await cache.release(artifactDigest);
  await cache.close();
  const directTarget = join(root, artifactDigest.slice("sha256:".length));
  await rm(directTarget);
  await chmod(prepared.root, 0o700);
  await rename(prepared.root, directTarget);
  await chmod(directTarget, 0o555);

  const restarted = new PreparedArtifactCache({ artifacts, root });
  const reused = await restarted.prepare({ digest: artifactDigest });

  assert.equal(reused.root, await realpath(directTarget));
  assert.equal((await stat(reused.root)).mode & 0o222, 0);
  await restarted.release(artifactDigest);
  await restarted.close();
});

test("prepared cache rejects changed archive bytes and removes its temporary directory", async (context) => {
  const { artifactDigest, artifacts, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await cleanupRoot(root);
  });
  artifacts.set(artifactDigest, archive("export default { changed: true };\n"));

  await assert.rejects(
    cache.prepare({ digest: artifactDigest }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "diagnostic" in error &&
      (error as { diagnostic: { code?: unknown } }).diagnostic.code === "ARTIFACT_DIGEST_MISMATCH",
  );
  assert.deepEqual(await readdir(root), []);
});

test("prepared cache never trusts or overwrites a changed completed directory", async (context) => {
  const { artifactDigest, artifacts, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await cleanupRoot(root);
  });
  const prepared = await cache.prepare({ digest: artifactDigest });
  await cache.release(artifactDigest);
  await chmod(join(prepared.root, "components/component.js"), 0o600);
  await writeFile(join(prepared.root, "components/component.js"), "tampered\n");

  const restarted = new PreparedArtifactCache({ artifacts, root });
  await assert.rejects(
    restarted.prepare({ digest: artifactDigest }),
    /prepared artifact|cache|conflict|digest/iu,
  );
  assert.equal(
    await readFile(join(prepared.root, "components/component.js"), "utf8"),
    "tampered\n",
  );
  await restarted.close();
});

test("@spec:plugin-artifacts/immutable-artifacts/published-tree-is-read-only", async (context) => {
  const { artifactDigest, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await cleanupRoot(root);
  });

  const prepared = await cache.prepare({ digest: artifactDigest });
  const [rootMode, componentMode] = await Promise.all([
    stat(prepared.root),
    stat(join(prepared.root, "components/component.js")),
  ]);

  assert.equal(rootMode.mode & 0o222, 0);
  assert.equal(componentMode.mode & 0o222, 0);
  await cache.release(artifactDigest);
});

test("@spec:plugin-artifacts/immutable-artifacts/live-cache-hit-revalidates-content", async (context) => {
  const { artifactDigest, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await cleanupRoot(root);
  });
  const prepared = await cache.prepare({ digest: artifactDigest });
  await cache.release(artifactDigest);
  await chmod(join(prepared.root, "components/component.js"), 0o600);
  await writeFile(join(prepared.root, "components/component.js"), "live tamper\n");

  await assert.rejects(cache.prepare({ digest: artifactDigest }), /cache|conflict|digest/iu);
});

test("@spec:plugin-artifacts/immutable-artifacts/rejects-extra-empty-directory", async (context) => {
  const { artifactDigest, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await cleanupRoot(root);
  });
  const prepared = await cache.prepare({ digest: artifactDigest });
  await cache.release(artifactDigest);
  await chmod(prepared.root, 0o700);
  await mkdir(join(prepared.root, "unexpected-empty"));

  await assert.rejects(cache.prepare({ digest: artifactDigest }), /cache|conflict|directory/iu);
});

test("@spec:plugin-artifacts/immutable-artifacts/rejects-published-root-replacement", async (context) => {
  const { artifactDigest, cache, root } = await fixture();
  context.after(async () => {
    await cache.close();
    await cleanupRoot(root);
  });
  const prepared = await cache.prepare({ digest: artifactDigest });
  await cache.release(artifactDigest);
  const moved = `${prepared.root}-moved`;
  await chmod(prepared.root, 0o700);
  await rename(prepared.root, moved);
  await symlink(moved, prepared.root);

  await assert.rejects(
    cache.prepare({ digest: artifactDigest }),
    /cache|conflict|identity|symlink/iu,
  );
});

test("@spec:plugin-artifacts/immutable-artifacts/close-fences-pending-reference-acquisition", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tego-prepared-close-"));
  const bytes = archive();
  const artifactDigest = digest(bytes);
  const started = deferred();
  const proceed = deferred();
  const artifacts: ArtifactStore = {
    scope: "local",
    open: async () => {},
    close: async () => {},
    health: async () => ({ status: "healthy", checkedAt: new Date(0).toISOString() }),
    put: async () => {},
    read: async function* () {
      yield bytes.subarray(0, 600);
      started.resolve();
      await proceed.promise;
      yield bytes.subarray(600);
    },
  };
  const cache = new PreparedArtifactCache({ artifacts, root });
  context.after(async () => {
    await cache.close();
    await cleanupRoot(root);
  });

  const pending = cache.prepare({ digest: artifactDigest });
  await started.promise;
  const closing = cache.close();
  proceed.resolve();

  await assert.rejects(
    pending,
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "diagnostic" in error &&
      (error as { diagnostic: { code?: unknown } }).diagnostic.code === "ARTIFACT_CACHE_CLOSED",
  );
  await closing;
});

test("@spec:plugin-artifacts/immutable-artifacts/acquired-reference-releases-after-close", async (context) => {
  const { artifactDigest, cache, root } = await fixture();
  context.after(async () => {
    await cleanupRoot(root);
  });
  await cache.prepare({ digest: artifactDigest });
  await cache.close();

  await cache.release(artifactDigest);
});

test("@spec:plugin-artifacts/immutable-artifacts/cleanup-failure-is-diagnostic", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tego-prepared-cleanup-"));
  const original = archive();
  const changed = archive("export default { changed: true };\n");
  const artifactDigest = digest(original);
  const started = deferred();
  const proceed = deferred();
  const artifacts: ArtifactStore = {
    scope: "local",
    open: async () => {},
    close: async () => {},
    health: async () => ({ status: "healthy", checkedAt: new Date(0).toISOString() }),
    put: async () => {},
    read: async function* () {
      yield changed.subarray(0, 600);
      started.resolve();
      await proceed.promise;
      yield changed.subarray(600);
    },
  };
  const cache = new PreparedArtifactCache({ artifacts, root });
  context.after(async () => {
    await chmod(root, 0o700);
    await cache.close();
    await cleanupRoot(root);
  });

  const pending = cache.prepare({ digest: artifactDigest });
  await started.promise;
  await chmod(root, 0o500);
  proceed.resolve();

  await assert.rejects(
    pending,
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "diagnostic" in error &&
      (error as { diagnostic: { code?: unknown } }).diagnostic.code ===
        "ARTIFACT_PREPARATION_CLEANUP_FAILED",
  );
});
