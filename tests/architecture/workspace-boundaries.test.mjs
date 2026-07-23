import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { checkWorkspaceBoundaries } from "../../scripts/check-boundaries.mjs";

test("@spec:runtime-operations/layer-one-dependency-boundary/architecture-dependency-check", async () => {
  const violations = await checkWorkspaceBoundaries(new URL("../../", import.meta.url));
  assert.deepEqual(violations, []);
});

async function withWorkspace(manifests, run) {
  const directory = await mkdtemp(new URL("tego-workspace-boundaries-", pathToFileURL(`${tmpdir()}/`)));
  const root = pathToFileURL(`${directory}/`);

  try {
    for (const [workspace, manifest] of Object.entries(manifests)) {
      const packageDirectory = new URL(`${workspace}/`, root);
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(new URL("package.json", packageDirectory), JSON.stringify(manifest));
    }

    await run(root);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-outward-workspace-edges", async () => {
  await withWorkspace(
    {
      "packages/contracts": {
        name: "@tegojs/contracts",
        dependencies: { "@tegojs/runtime": "0.0.0" },
      },
      "packages/runtime": {
        name: "@tegojs/runtime",
        dependencies: {
          "@tegojs/contracts": "0.0.0",
          "@tegojs/executor-node": "0.0.0",
          "@tegojs/echo-plugin": "0.0.0",
        },
      },
      "packages/drivers-local": {
        name: "@tegojs/drivers-local",
        dependencies: { "@tegojs/runtime": "0.0.0" },
      },
      "packages/executor-node": {
        name: "@tegojs/executor-node",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
      "packages/plugin-sdk": {
        name: "@tegojs/plugin-sdk",
        dependencies: { "@tegojs/testkit": "0.0.0" },
      },
      "packages/testkit": {
        name: "@tegojs/testkit",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
      "packages/cli": {
        name: "@tegojs/cli",
        dependencies: {
          "@tegojs/echo-plugin": "0.0.0",
          "@tegojs/runtime": "0.0.0",
        },
      },
      "examples/echo-plugin": {
        name: "@tegojs/echo-plugin",
        dependencies: { "@tegojs/plugin-sdk": "0.0.0" },
      },
    },
    async (root) => {
      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/cli -> @tegojs/echo-plugin",
        "@tegojs/contracts -> @tegojs/runtime",
        "@tegojs/drivers-local -> @tegojs/runtime",
        "@tegojs/plugin-sdk -> @tegojs/testkit",
        "@tegojs/runtime -> @tegojs/echo-plugin",
        "@tegojs/runtime -> @tegojs/executor-node",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-forbidden-emitted-imports", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/runtime": {
        name: "@tegojs/runtime",
        dependencies: {
          "@tegojs/contracts": "0.0.0",
          "executor-local": "file:../executor-node",
          "transport-escape": "npm:@tegojs/transport-websocket@0.0.0",
        },
      },
      "packages/executor-node": {
        name: "@tegojs/executor-node",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
      "packages/transport-websocket": {
        name: "@tegojs/transport-websocket",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
      "packages/testkit": {
        name: "@tegojs/testkit",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/runtime/dist/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("index.js", outputDirectory),
        [
          'export { execute } from "@tegojs/executor-node";',
          'import runtime from "legacy/tego/runtime";',
          'await import("../../transport-websocket/dist/index.js", { with: { type: "json" } });',
          'await import(`@tegojs/executor-node`);',
          "await import(runtimeSpecifier);",
          'const message = `${await import("../../executor-node/dist/index.js")}`;',
          String.raw`import "@tegojs/\u0072untime";`,
          'const pattern = /import\\s+from\\s+"@tegojs/testkit"/;',
          "export default runtime;",
        ].join("\n"),
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/runtime -> ../../executor-node/dist/index.js",
        "@tegojs/runtime -> ../../transport-websocket/dist/index.js",
        "@tegojs/runtime -> ../executor-node",
        "@tegojs/runtime -> @tegojs/executor-node",
        "@tegojs/runtime -> @tegojs/transport-websocket",
        "@tegojs/runtime -> [unsupported import specifier]",
        "@tegojs/runtime -> legacy/tego/runtime",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-computed-dynamic-imports", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/runtime": {
        name: "@tegojs/runtime",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
      "packages/executor-node": {
        name: "@tegojs/executor-node",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/runtime/dist/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("index.js", outputDirectory),
        'await import("@tegojs/" + "executor-node");',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/runtime -> [unsupported import specifier]",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-computed-import-after-postfix-division", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/runtime": {
        name: "@tegojs/runtime",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/runtime/dist/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("index.js", outputDirectory),
        "x++ / (await import(runtimeSpecifier)) / y;",
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/runtime -> [unsupported import specifier]",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-contracts-self-dependency", async () => {
  await withWorkspace(
    {
      "packages/contracts": {
        name: "@tegojs/contracts",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
    },
    async (root) => {
      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/contracts -> @tegojs/contracts",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/preserves-duplicate-dependency-section-entries", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/runtime": {
        name: "@tegojs/runtime",
        dependencies: {
          "shared-alias": "npm:@tegojs/executor-node@0.0.0",
        },
        devDependencies: {
          "shared-alias": "npm:@tegojs/contracts@0.0.0",
        },
      },
      "packages/executor-node": {
        name: "@tegojs/executor-node",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
    },
    async (root) => {
      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/runtime -> @tegojs/executor-node",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/allows-internal-relative-imports", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/runtime": {
        name: "@tegojs/runtime",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/contracts/dist/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(new URL("internal.js", outputDirectory), "export const internal = true;");
      await writeFile(
        new URL("index.js", outputDirectory),
        [
          'export { internal } from "./internal.js";',
          'export { runtime } from "../../runtime/dist/index.js";',
        ].join("\n"),
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/contracts -> ../../runtime/dist/index.js",
      ]);
    },
  );
});
