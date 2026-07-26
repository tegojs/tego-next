import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginManifest } from "@tegojs/contracts";

export interface ManifestConformanceFixture {
  parse(input: unknown): PluginManifest | Promise<PluginManifest>;
}

export type ManifestConformanceFactory = () =>
  | ManifestConformanceFixture
  | Promise<ManifestConformanceFixture>;

const validManifest = {
  schemaVersion: "1.0",
  pluginId: "org.example.conformance",
  version: "1.0.0",
  contractRange: ">=2.0.0 <3.0.0",
  nodeRange: ">=26.0.0 <27.0.0",
  moduleFormat: "esm",
  components: [
    {
      componentId: "echo",
      kind: "task",
      entrypoint: "components/echo.js",
      executors: ["process", "thread", "remote"],
    },
  ],
  permissions: [
    {
      kind: "executor",
      executors: ["process", "thread", "remote"],
    },
  ],
  capabilities: {
    provides: [],
    requires: [],
  },
} as const;

export function manifestConformance(factory: ManifestConformanceFactory): void {
  describe("Plugin manifest conformance", () => {
    test("@spec:runtime-operations/reusable-conformance-test-kits/manifest-positive", async () => {
      const fixture = await factory();
      const parsed = await fixture.parse(structuredClone(validManifest));
      assert.deepEqual(parsed, validManifest);
    });

    for (const [name, mutate] of [
      [
        "missing required field",
        (manifest: Record<string, unknown>) => {
          delete manifest.pluginId;
        },
      ],
      [
        "unsupported module format",
        (manifest: Record<string, unknown>) => {
          manifest.moduleFormat = "commonjs";
        },
      ],
      [
        "duplicate executor",
        (manifest: Record<string, unknown>) => {
          manifest.components = [
            {
              componentId: "echo",
              kind: "task",
              entrypoint: "components/echo.js",
              executors: ["process", "process"],
            },
          ];
        },
      ],
    ] as const) {
      test(`@spec:runtime-operations/reusable-conformance-test-kits/manifest-negative/${name}`, async () => {
        const fixture = await factory();
        const invalid = structuredClone(validManifest) as unknown as Record<string, unknown>;
        mutate(invalid);
        await assert.rejects(Promise.resolve().then(() => fixture.parse(invalid)));
      });
    }
  });
}
