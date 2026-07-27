import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnosticCode,
  parseCapabilityName,
  parseComponentId,
  type PluginManifest,
  parseExecutorId,
  parsePluginManifest,
} from "@tegojs/contracts";
import {
  assertLocalComponentManifestSupported,
  canonicalJsonEqual,
  localComponentExecutorId,
} from "../src/runtime/local-component-session-host.js";

function manifest(
  input: {
    readonly kind?: "service" | "task";
    readonly provides?: PluginManifest["capabilities"]["provides"];
    readonly requires?: readonly {
      readonly name: string;
      readonly protocolRange: string;
    }[];
  } = {},
): PluginManifest {
  return parsePluginManifest({
    schemaVersion: "1.0",
    pluginId: "org.example.local",
    version: "1.0.0",
    contractRange: ">=0.0.0 <1.0.0",
    nodeRange: ">=26.0.0 <27.0.0",
    moduleFormat: "esm",
    components: [
      {
        componentId: "component",
        kind: input.kind ?? "task",
        entrypoint: "components/component.js",
        executors: ["process", "thread"],
      },
    ],
    permissions: [{ kind: "executor", executors: ["process", "thread"] }],
    capabilities: {
      provides: input.provides ?? [],
      requires: input.requires ?? [],
    },
  });
}

test("local executor ids hash maximum-length NodeIds into stable bounded identities", () => {
  const nodeId = `n${"x".repeat(127)}`;
  const first = localComponentExecutorId(nodeId, "thread");
  const second = localComponentExecutorId(nodeId, "thread");

  assert.equal(first, second);
  assert.notEqual(first.includes(nodeId), true);
  assert.equal(first.length <= 128, true);
  assert.equal(parseExecutorId(first), first);
  assert.notEqual(first, localComponentExecutorId(nodeId, "process"));
});

test("local task manifests without capabilities remain supported", () => {
  assert.doesNotThrow(() => assertLocalComponentManifestSupported(manifest()));
});

test("local task capability manifests pass the production host gate with complete definitions", () => {
  for (const candidate of [
    manifest({
      provides: [
        {
          name: parseCapabilityName("example.echo"),
          protocolVersion: "1.0.0",
          componentId: parseComponentId("component"),
          methods: ["echo"],
          requestSchema: true,
          responseSchema: true,
        },
      ],
    }),
    manifest({ requires: [{ name: "example.echo", protocolRange: "^1.0.0" }] }),
  ]) {
    assert.doesNotThrow(() => assertLocalComponentManifestSupported(candidate));
  }
});

test("local service components fail closed before lifecycle session activation", () => {
  assert.throws(
    () => assertLocalComponentManifestSupported(manifest({ kind: "service" })),
    (error: unknown) => diagnosticCode(error) === "LIFECYCLE_COMPONENT_KIND_UNSUPPORTED",
  );
});

test("durable manifest comparison ignores object key order but preserves JSON semantics", () => {
  assert.equal(
    canonicalJsonEqual(
      { nested: { alpha: 1, beta: true }, values: ["a", "b"] },
      { values: ["a", "b"], nested: { beta: true, alpha: 1 } },
    ),
    true,
  );
  assert.equal(canonicalJsonEqual({ values: ["a", "b"] }, { values: ["b", "a"] }), false);
});
