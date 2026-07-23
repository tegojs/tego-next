import { createHash } from "node:crypto";
import {
  parseArtifactDigest,
  parsePluginManifest,
  type ArtifactDigest,
  type PluginManifest,
} from "@tegojs/contracts";

export function createPluginManifestFixture(
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  const base = {
    schemaVersion: "1.0",
    pluginId: "org.example.echo",
    version: "1.0.0",
    contractRange: ">=2.0.0 <3.0.0",
    nodeRange: ">=26.0.0 <27.0.0",
    moduleFormat: "esm",
    components: [
      {
        componentId: "echo",
        kind: "task",
        entrypoint: "components/component.js",
        executors: ["process"],
      },
    ],
    permissions: [],
    capabilities: { provides: [], requires: [] },
  };
  return parsePluginManifest(structuredClone({ ...base, ...overrides }));
}

export function artifactDigest(bytes: Uint8Array): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

export async function* artifactBytesSource(
  bytes: Uint8Array,
  chunkSize = 64 * 1024,
): AsyncIterable<Uint8Array> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError("chunkSize must be a positive safe integer");
  }
  const stable = Buffer.from(bytes);
  for (let offset = 0; offset < stable.byteLength; offset += chunkSize) {
    yield stable.subarray(offset, Math.min(offset + chunkSize, stable.byteLength));
  }
}
