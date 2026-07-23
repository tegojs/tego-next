import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  DiagnosticError,
  parseArtifactDigest,
  parseComponentId,
  parsePluginId,
  type ArtifactDigest,
  type ArtifactStore,
  type DriverHealth,
  type JsonValue,
  type PluginManifest,
  type Revision,
  type ScannedState,
  type StateChange,
  type StateKey,
  type StateQuery,
  type StateStore,
  type StateTransaction,
  type StateTransactionOptions,
  type Versioned,
} from "@tegojs/contracts";
import { FakeClock } from "@tegojs/testkit";
import { ArtifactService } from "../src/artifacts/artifact-service.js";
import { readPluginArtifact } from "../src/artifacts/manifest-reader.js";

interface TarInput {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly type?: string;
}

const encoder = new TextEncoder();
const manifest = {
  schemaVersion: "1.0",
  pluginId: parsePluginId("org.example.echo"),
  version: "1.0.0",
  contractRange: ">=2.0.0 <3.0.0",
  nodeRange: ">=26.0.0 <27.0.0",
  moduleFormat: "esm",
  architectures: ["linux-x64"],
  components: [
    {
      componentId: parseComponentId("echo"),
      kind: "task",
      entrypoint: "components/component.js",
      executors: ["process"],
    },
  ],
  permissions: [],
  capabilities: { provides: [], requires: [] },
} satisfies PluginManifest;

function writeText(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(encoder.encode(value).subarray(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  writeText(target, offset, length, value.toString(8).padStart(length - 1, "0"));
}

function tar(
  entries: readonly TarInput[],
  options: { corruptChecksum?: boolean } = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    writeText(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeText(header, 156, 1, entry.type ?? "0");
    writeText(header, 257, 6, "ustar\0");
    writeText(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeOctal(header, 148, 7, checksum + (options.corruptChecksum === true ? 1 : 0));
    chunks.push(header, entry.bytes);
    const padding = (512 - (entry.bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return Buffer.concat(chunks);
}

function json(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function sha256(bytes: Uint8Array): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

function validEntries(
  manifestValue: unknown = manifest,
  extras: readonly TarInput[] = [],
  componentBytes = encoder.encode("export default {};\n"),
): readonly TarInput[] {
  const payload = [
    { name: "components/component.js", bytes: componentBytes },
    { name: "manifest.json", bytes: json(manifestValue) },
    { name: "metadata/sbom.json", bytes: json({ packages: [], schemaVersion: "1.0" }) },
    ...extras,
  ].sort((left, right) => left.name.localeCompare(right.name));
  const files = payload.map((entry) => ({
    path: entry.name,
    sha256: sha256(entry.bytes),
    size: entry.bytes.byteLength,
  }));
  return [
    ...payload,
    {
      name: "metadata/files.json",
      bytes: json({ files, schemaVersion: "1.0" }),
    },
  ].sort((left, right) => left.name.localeCompare(right.name));
}

class InstallationStateStore implements StateStore {
  readonly scope = "local" as const;
  readonly records = new Map<string, Versioned<JsonValue>>();
  writes = 0;

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async health(): Promise<DriverHealth> {
    return { status: "healthy", checkedAt: new Date(0).toISOString() };
  }
  async transact<T extends JsonValue>(
    _options: StateTransactionOptions,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T> {
    const staged = new Map<string, JsonValue>();
    const transaction = {
      get: async <Value extends JsonValue>(
        key: StateKey<Value>,
      ): Promise<Versioned<Value> | undefined> => {
        const record = this.records.get(JSON.stringify(key));
        return record as Versioned<Value> | undefined;
      },
      scan: async function* <Value extends JsonValue>(
        _query: StateQuery<Value>,
      ): AsyncIterable<ScannedState<Value>> {},
      put: async <Value extends JsonValue>(key: StateKey<Value>, value: Value): Promise<void> => {
        const serialized = JSON.stringify(key);
        if (this.records.has(serialized)) {
          throw new Error("expected absent");
        }
        staged.set(serialized, structuredClone(value));
      },
      delete: async () => {},
      appendOperation: async () => {},
      enqueueOutbox: async () => {},
    } satisfies StateTransaction;
    const result = await work(transaction);
    for (const [key, value] of staged) {
      this.writes += 1;
      this.records.set(key, { revision: "1" as Revision, value });
    }
    return result;
  }
  async read<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined> {
    return this.records.get(JSON.stringify(key)) as Versioned<T> | undefined;
  }
  async *scan<T extends JsonValue>(_query: StateQuery<T>): AsyncIterable<ScannedState<T>> {}
  async *scanRecoverableOperations(): AsyncIterable<never> {}
  async *watch(_cursor: Revision): AsyncIterable<StateChange> {}
}

class MemoryArtifactStore implements ArtifactStore {
  readonly scope = "local" as const;
  readonly #artifacts = new Map<ArtifactDigest, Uint8Array>();

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async health(): Promise<DriverHealth> {
    return { status: "healthy", checkedAt: new Date(0).toISOString() };
  }
  async put(digest: ArtifactDigest, source: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(sha256(bytes), digest);
    this.#artifacts.set(digest, bytes);
  }
  async *read(digest: ArtifactDigest): AsyncIterable<Uint8Array> {
    const bytes = this.#artifacts.get(digest);
    if (bytes === undefined) throw new Error("missing artifact");
    assert.equal(sha256(bytes), digest);
    for (let offset = 0; offset < bytes.byteLength; offset += 73) {
      yield bytes.subarray(offset, Math.min(offset + 73, bytes.byteLength));
    }
  }
}

async function source(bytes: Uint8Array): Promise<AsyncIterable<Uint8Array>> {
  return (async function* () {
    yield bytes;
  })();
}

async function serviceFor(
  archive: Uint8Array,
  options: {
    readonly trust?: ConstructorParameters<typeof ArtifactService>[0]["trust"];
    readonly state?: ConstructorParameters<typeof ArtifactService>[0]["state"];
  } = {},
): Promise<{
  readonly digest: ArtifactDigest;
  readonly service: ArtifactService;
  readonly store: MemoryArtifactStore;
}> {
  const store = new MemoryArtifactStore();
  await store.open();
  const digest = sha256(archive);
  await store.put(digest, await source(archive));
  const fallbackState = {
    scope: "local" as const,
    async open() {},
    async close() {},
    async health() {
      return { status: "healthy" as const, checkedAt: new Date(0).toISOString() };
    },
  };
  return {
    digest,
    store,
    service: new ArtifactService({
      artifacts: store,
      clock: new FakeClock(new Date("2026-01-02T03:04:05.000Z")),
      compatibility: {
        architecture: "x64",
        nodeVersion: "26.5.0",
        platform: "linux",
        tegoContractVersion: "2.0.0",
      },
      state: options.state ?? (fallbackState as never),
      ...(options.trust === undefined ? {} : { trust: options.trust }),
    }),
  };
}

async function rejectsCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.diagnostic.code, code);
    return true;
  });
}

test("invalid manifest is rejected without evaluating component code", async () => {
  const marker = "__tegoArtifactSideEffect";
  delete (globalThis as Record<string, unknown>)[marker];
  const entries = validEntries({ ...manifest, schemaVersion: "invalid" }).map((entry) =>
    entry.name === "components/component.js"
      ? { ...entry, bytes: encoder.encode(`globalThis.${marker} = true;`) }
      : entry,
  );
  const { digest, service } = await serviceFor(tar(entries));

  await rejectsCode(() => service.validate({ digest }), "ARTIFACT_SCHEMA_VERSION_UNSUPPORTED");
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
});

test("artifact parsing closes its source iterator without masking parse failures", async (context) => {
  await context.test("successful parse", async () => {
    const archive = tar(validEntries());
    let returned = 0;
    let yielded = false;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (yielded) return { done: true, value: undefined };
            yielded = true;
            return { done: false, value: archive };
          },
          async return() {
            returned += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };

    await readPluginArtifact(source);
    assert.equal(returned, 1);
  });

  await context.test("early parse failure", async () => {
    const archive = tar(validEntries(), { corruptChecksum: true });
    let returned = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: archive };
          },
          async return() {
            returned += 1;
            throw new Error("iterator cleanup failed");
          },
        };
      },
    };

    await rejectsCode(() => readPluginArtifact(source), "ARTIFACT_HEADER_CHECKSUM_INVALID");
    assert.equal(returned, 1);
  });
});

for (const [name, unsafePath] of [
  ["parent traversal", "../escape.js"],
  ["backslash traversal", String.raw`components\..\escape.js`],
  ["absolute path", "/etc/passwd"],
  ["drive path", "C:/escape.js"],
  ["UNC path", String.raw`\\server\share\escape.js`],
  ["non-normal path", "components//component.js"],
  ["non-NFC path", "components/e\u0301.js"],
  ["Windows device path", "components/CON.js"],
  ["Windows superscript device path", "components/COM¹.js"],
  ["Windows alternate stream path", "components/component.js:stream"],
] as const) {
  test(`rejects ${name}`, async () => {
    const archive = tar([{ name: unsafePath, bytes: encoder.encode("x") }]);
    const { digest, service } = await serviceFor(archive);
    await rejectsCode(() => service.validate({ digest }), "ARTIFACT_PATH_UNSAFE");
  });
}

for (const [name, type] of [
  ["symbolic link", "2"],
  ["hard link", "1"],
  ["character device", "3"],
  ["block device", "4"],
  ["directory", "5"],
  ["fifo", "6"],
  ["PAX override", "x"],
  ["GNU long name", "L"],
] as const) {
  test(`rejects ${name} entries`, async () => {
    const { digest, service } = await serviceFor(
      tar([{ name: "manifest.json", bytes: json(manifest), type }]),
    );
    await rejectsCode(() => service.validate({ digest }), "ARTIFACT_ENTRY_TYPE_UNSUPPORTED");
  });
}

test("rejects duplicate normalized names", async () => {
  const entries = [...validEntries(), { name: "manifest.json", bytes: json(manifest) }];
  const { digest, service } = await serviceFor(tar(entries));
  await rejectsCode(() => service.validate({ digest }), "ARTIFACT_ENTRY_DUPLICATE");
});

test("rejects case-folded archive and metadata declaration collisions", async (context) => {
  await context.test("archive entries", async () => {
    const entries = [...validEntries(), { name: "MANIFEST.JSON", bytes: json(manifest) }];
    const { digest, service } = await serviceFor(tar(entries));
    await rejectsCode(() => service.validate({ digest }), "ARTIFACT_ENTRY_COLLISION");
  });

  await context.test("metadata declarations", async () => {
    const entries = validEntries().map((entry) => {
      if (entry.name !== "metadata/files.json") return entry;
      const metadata = JSON.parse(new TextDecoder().decode(entry.bytes));
      metadata.files.push({
        path: "MANIFEST.JSON",
        sha256: sha256(json(manifest)),
        size: json(manifest).byteLength,
      });
      return { ...entry, bytes: json(metadata) };
    });
    const { digest, service } = await serviceFor(tar(entries));
    await rejectsCode(() => service.validate({ digest }), "ARTIFACT_ENTRY_COLLISION");
  });
});

test("rejects undeclared and missing declared files", async (context) => {
  await context.test("undeclared", async () => {
    const entries = [...validEntries(), { name: "surprise.js", bytes: encoder.encode("x") }];
    const { digest, service } = await serviceFor(tar(entries));
    await rejectsCode(() => service.validate({ digest }), "ARTIFACT_FILE_UNDECLARED");
  });
  await context.test("missing", async () => {
    const entries = validEntries().filter((entry) => entry.name !== "components/component.js");
    const { digest, service } = await serviceFor(tar(entries));
    await rejectsCode(() => service.validate({ digest }), "ARTIFACT_FILE_MISSING");
  });
});

test("rejects malformed, truncated, checksum-mismatched, and oversized archives", async (context) => {
  await context.test("malformed octal", async () => {
    const archive = tar(validEntries());
    archive[124] = "z".charCodeAt(0);
    archive.fill(0x20, 148, 156);
    const checksum = archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    writeOctal(archive, 148, 7, checksum);
    const { digest, service } = await serviceFor(archive);
    await rejectsCode(() => service.validate({ digest }), "ARTIFACT_ARCHIVE_MALFORMED");
  });
  await context.test("truncated", async () => {
    const archive = tar(validEntries()).subarray(0, 700);
    const { digest, service } = await serviceFor(archive);
    await rejectsCode(() => service.validate({ digest }), "ARTIFACT_ARCHIVE_TRUNCATED");
  });
  await context.test("checksum", async () => {
    const archive = tar(validEntries(), { corruptChecksum: true });
    const { digest, service } = await serviceFor(archive);
    await rejectsCode(() => service.validate({ digest }), "ARTIFACT_HEADER_CHECKSUM_INVALID");
  });
  await context.test("size limit", async () => {
    const archive = tar(validEntries());
    const { digest, store } = await serviceFor(archive);
    const limited = new ArtifactService({
      artifacts: store,
      clock: new FakeClock(),
      compatibility: {
        architecture: "x64",
        nodeVersion: "26.5.0",
        platform: "linux",
        tegoContractVersion: "2.0.0",
      },
      limits: { maxArchiveBytes: archive.byteLength - 1 },
      state: {} as never,
    });
    await rejectsCode(() => limited.validate({ digest }), "ARTIFACT_ARCHIVE_TOO_LARGE");
  });
  await context.test("entry size limit", async () => {
    const archive = tar(validEntries());
    const { digest, store } = await serviceFor(archive);
    const limited = new ArtifactService({
      artifacts: store,
      clock: new FakeClock(),
      compatibility: {
        architecture: "x64",
        nodeVersion: "26.5.0",
        platform: "linux",
        tegoContractVersion: "2.0.0",
      },
      limits: { maxEntryBytes: 8 },
      state: {} as never,
    });
    await rejectsCode(() => limited.validate({ digest }), "ARTIFACT_ENTRY_TOO_LARGE");
  });
  await context.test("entry count limit", async () => {
    const archive = tar(validEntries());
    const { digest, store } = await serviceFor(archive);
    const limited = new ArtifactService({
      artifacts: store,
      clock: new FakeClock(),
      compatibility: {
        architecture: "x64",
        nodeVersion: "26.5.0",
        platform: "linux",
        tegoContractVersion: "2.0.0",
      },
      limits: { maxEntries: 2 },
      state: {} as never,
    });
    await rejectsCode(() => limited.validate({ digest }), "ARTIFACT_ENTRY_COUNT_EXCEEDED");
  });
});

test("rejects manifest entrypoints that escape portable archive paths", async () => {
  const unsafeManifest = {
    ...manifest,
    components: [
      {
        ...manifest.components[0],
        entrypoint: String.raw`components\component.js`,
      },
    ],
  };
  const { digest, service } = await serviceFor(tar(validEntries(unsafeManifest)));
  await rejectsCode(() => service.validate({ digest }), "ARTIFACT_PATH_UNSAFE");
});

test("returns structured compatibility diagnostics", async (context) => {
  for (const [label, patch, code] of [
    ["CommonJS", { moduleFormat: "commonjs" }, "ARTIFACT_MODULE_FORMAT_UNSUPPORTED"],
    ["Node", { nodeRange: ">=27.0.0" }, "ARTIFACT_NODE_INCOMPATIBLE"],
    ["Tego", { contractRange: ">=3.0.0" }, "ARTIFACT_CONTRACT_INCOMPATIBLE"],
    ["architecture", { architectures: ["darwin-arm64"] }, "ARTIFACT_PLATFORM_INCOMPATIBLE"],
  ] as const) {
    await context.test(label, async () => {
      const { digest, service } = await serviceFor(tar(validEntries({ ...manifest, ...patch })));
      await rejectsCode(() => service.validate({ digest }), code);
    });
  }
});

test("accepts common partial semver comparators without evaluating plugin code", async () => {
  const compatibleManifest = {
    ...manifest,
    contractRange: "^2.0.0",
    nodeRange: ">=26 <27",
  };
  const { digest, service } = await serviceFor(tar(validEntries(compatibleManifest)));
  const validated = await service.validate({ digest });
  assert.equal(validated.manifest.nodeRange, ">=26 <27");
});

test("compatibility ranges never match empty or incomplete alternatives", async (context) => {
  for (const [range, compatible] of [
    [">=26 <27", true],
    ["26.x", true],
    ["~26.5.0", true],
    [">=27 || >=26 <27", true],
    ["||", false],
    [">=27 ||", false],
    ["|| >=26", false],
    [">=26 nonsense", false],
    ["nonsense || >=26", false],
    [">", false],
  ] as const) {
    await context.test(range, async () => {
      const archive = tar(validEntries({ ...manifest, nodeRange: range }));
      const { digest, service } = await serviceFor(archive);
      if (compatible) {
        await service.validate({ digest });
      } else {
        await rejectsCode(() => service.validate({ digest }), "ARTIFACT_NODE_INCOMPATIBLE");
      }
    });
  }
});

test("verifies Ed25519 signature envelopes over raw digest bytes", async (context) => {
  const archive = tar(validEntries());
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const digest = sha256(archive);
  const signature = sign(null, Buffer.from(digest.slice(7), "hex"), privateKey).toString("base64");
  const trust = {
    mode: "required" as const,
    keys: [{ keyId: "release", publicKey: publicKey.export({ format: "pem", type: "spki" }) }],
  };
  const configured = await serviceFor(archive, { trust });

  const valid = await configured.service.validate({
    digest,
    signature: { algorithm: "Ed25519", digest, keyId: "release", signature },
  });
  assert.equal(valid.signature?.verified, true);

  await context.test("tampered signature", async () => {
    await rejectsCode(
      () =>
        configured.service.validate({
          digest,
          signature: {
            algorithm: "Ed25519",
            digest,
            keyId: "release",
            signature: Buffer.from(signature, "base64").fill(0).toString("base64"),
          },
        }),
      "ARTIFACT_SIGNATURE_INVALID",
    );
  });
  await context.test("unknown key", async () => {
    await rejectsCode(
      () =>
        configured.service.validate({
          digest,
          signature: { algorithm: "Ed25519", digest, keyId: "unknown", signature },
        }),
      "ARTIFACT_SIGNATURE_KEY_UNKNOWN",
    );
  });
  await context.test("required but absent", async () => {
    await rejectsCode(() => configured.service.validate({ digest }), "ARTIFACT_SIGNATURE_REQUIRED");
  });
  for (const malformed of [`${signature}=`, `${signature.slice(0, 20)}=${signature.slice(21)}`]) {
    await context.test(`non-canonical ${malformed.length}`, async () => {
      await rejectsCode(
        () =>
          configured.service.validate({
            digest,
            signature: {
              algorithm: "Ed25519",
              digest,
              keyId: "release",
              signature: malformed,
            },
          }),
        "ARTIFACT_SIGNATURE_INVALID",
      );
    });
  }
});

test("hashes the exact ArtifactStore byte stream before accepting a signed digest", async () => {
  const archiveA = tar(validEntries());
  const archiveB = tar(
    validEntries(manifest, [], encoder.encode("export default { artifact: 'B' };\n")),
  );
  const digestA = sha256(archiveA);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signature = sign(null, Buffer.from(digestA.slice(7), "hex"), privateKey).toString("base64");
  const dishonestStore: ArtifactStore = {
    scope: "local",
    async open() {},
    async close() {},
    async health() {
      return { status: "healthy", checkedAt: new Date(0).toISOString() };
    },
    async put() {},
    async *read() {
      yield archiveB;
    },
  };
  const service = new ArtifactService({
    artifacts: dishonestStore,
    clock: new FakeClock(),
    compatibility: {
      architecture: "x64",
      nodeVersion: "26.5.0",
      platform: "linux",
      tegoContractVersion: "2.0.0",
    },
    state: {} as never,
    trust: {
      mode: "required",
      keys: [{ keyId: "release", publicKey: publicKey.export({ format: "pem", type: "spki" }) }],
    },
  });

  await rejectsCode(
    () =>
      service.validate({
        digest: digestA,
        signature: { algorithm: "Ed25519", digest: digestA, keyId: "release", signature },
      }),
    "ARTIFACT_DIGEST_MISMATCH",
  );
});

test("installs immutable plugin records transactionally and idempotently", async () => {
  const state = new InstallationStateStore();
  const firstArchive = tar(validEntries());
  const first = await serviceFor(firstArchive, { state });

  const installed = await first.service.install({ digest: first.digest });
  const repeated = await first.service.install({ digest: first.digest });

  assert.deepEqual(repeated, installed);
  assert.equal(state.writes, 2);
  assert.equal(installed.digest, first.digest);
  assert.equal(installed.installedAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(
    [...state.records.keys()].map((key) => JSON.parse(key)),
    [
      {
        collection: "installation-versions",
        id: "org.example.echo@1.0.0",
        namespace: "tego",
      },
      {
        collection: "installations",
        id: `org.example.echo@1.0.0@${first.digest}`,
        namespace: "tego",
      },
    ],
  );

  const conflictingArchive = tar(
    validEntries(manifest, [], encoder.encode("export default { changed: true };\n")),
  );
  const conflicting = await serviceFor(conflictingArchive, { state });
  await rejectsCode(
    () => conflicting.service.install({ digest: conflicting.digest }),
    "ARTIFACT_INSTALLATION_CONFLICT",
  );
  assert.equal(state.writes, 2);
});
