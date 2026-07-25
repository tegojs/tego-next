import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnosticCode,
  parseExecutorId,
  parsePluginManifest,
  type JsonValue,
  type PluginManifest,
} from "@tegojs/contracts";
import * as localHost from "../src/runtime/local-component-session-host.js";

type LocalComponentExecutorId = (nodeId: string, executor: "process" | "thread") => string;
type AssertLocalManifestSupported = (manifest: PluginManifest) => void;
type CanonicalJsonEqual = (left: JsonValue, right: JsonValue) => boolean;

function helper<Name extends keyof typeof localHost>(name: Name): (typeof localHost)[Name] {
  const value = localHost[name];
  assert.equal(typeof value, "function", `local session host must export ${name}`);
  return value;
}

function manifest(
  input: {
    readonly kind?: "service" | "task";
    readonly provides?: readonly { readonly name: string; readonly protocolVersion: string }[];
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
  const executorId = helper(
    "localComponentExecutorId" as keyof typeof localHost,
  ) as unknown as LocalComponentExecutorId;
  const nodeId = `n${"x".repeat(127)}`;
  const first = executorId(nodeId, "thread");
  const second = executorId(nodeId, "thread");

  assert.equal(first, second);
  assert.notEqual(first.includes(nodeId), true);
  assert.equal(first.length <= 128, true);
  assert.equal(parseExecutorId(first), first);
  assert.notEqual(first, executorId(nodeId, "process"));
});

test("local task manifests without capabilities remain supported", () => {
  const assertSupported = helper(
    "assertLocalComponentManifestSupported" as keyof typeof localHost,
  ) as unknown as AssertLocalManifestSupported;
  assert.doesNotThrow(() => assertSupported(manifest()));
});

test("local capability-bearing manifests fail closed without real schema definitions", () => {
  const assertSupported = helper(
    "assertLocalComponentManifestSupported" as keyof typeof localHost,
  ) as unknown as AssertLocalManifestSupported;
  for (const candidate of [
    manifest({ provides: [{ name: "example.echo", protocolVersion: "1.0.0" }] }),
    manifest({ requires: [{ name: "example.echo", protocolRange: "^1.0.0" }] }),
  ]) {
    assert.throws(
      () => assertSupported(candidate),
      (error: unknown) => diagnosticCode(error) === "CAPABILITY_DEFINITION_UNAVAILABLE",
    );
  }
});

test("local service components fail closed before lifecycle session activation", () => {
  const assertSupported = helper(
    "assertLocalComponentManifestSupported" as keyof typeof localHost,
  ) as unknown as AssertLocalManifestSupported;
  assert.throws(
    () => assertSupported(manifest({ kind: "service" })),
    (error: unknown) => diagnosticCode(error) === "LIFECYCLE_COMPONENT_KIND_UNSUPPORTED",
  );
});

test("durable manifest comparison ignores object key order but preserves JSON semantics", () => {
  const equal = helper(
    "canonicalJsonEqual" as keyof typeof localHost,
  ) as unknown as CanonicalJsonEqual;

  assert.equal(
    equal(
      { nested: { alpha: 1, beta: true }, values: ["a", "b"] },
      { values: ["a", "b"], nested: { beta: true, alpha: 1 } },
    ),
    true,
  );
  assert.equal(equal({ values: ["a", "b"] }, { values: ["b", "a"] }), false);
});
