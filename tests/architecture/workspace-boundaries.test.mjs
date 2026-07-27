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
  const directory = await mkdtemp(
    new URL("tego-workspace-boundaries-", pathToFileURL(`${tmpdir()}/`)),
  );
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
          "await import(`@tegojs/executor-node`);",
          "await import(runtimeSpecifier);",
          `const message = \`${String.fromCharCode(36)}{await import("../../executor-node/dist/index.js")}\`;`,
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

test("@spec:plugin-deployment/pre-execution-deployment-gate/allows-only-one-direct-scoped-component-file-url-import", async (t) => {
  const workspaces = {
    "packages/contracts": { name: "@tegojs/contracts" },
    "packages/runtime": {
      name: "@tegojs/runtime",
      dependencies: { "@tegojs/contracts": "0.0.0" },
    },
    "packages/executor-node": {
      name: "@tegojs/executor-node",
      dependencies: { "@tegojs/contracts": "0.0.0" },
    },
  };
  const directLoader = [
    'import { pathToFileURL } from "node:url";',
    "export async function loadPreparedComponent(input) {",
    "  const entrypoint = input.entrypoint;",
    "  return import(pathToFileURL(entrypoint).href);",
    "}",
  ].join("\n");

  await t.test("accepts the unique direct expression in the target loader", async () => {
    await withWorkspace(workspaces, async (root) => {
      const loaderDirectory = new URL("packages/executor-node/dist/src/host/", root);
      await mkdir(loaderDirectory, { recursive: true });
      await writeFile(new URL("component-loader.js", loaderDirectory), directLoader);

      assert.deepEqual(await checkWorkspaceBoundaries(root), []);
    });
  });

  for (const [name, importLine] of [
    [
      "accepts pathToFileURL among multiple named imports",
      'import { fileURLToPath, pathToFileURL } from "node:url";',
    ],
    [
      "accepts pathToFileURL before another named import",
      'import { pathToFileURL, fileURLToPath } from "node:url";',
    ],
    [
      "accepts multiline spacing around named imports",
      ["import {", "  fileURLToPath,", "  pathToFileURL,", '} from "node:url";'].join("\n"),
    ],
  ]) {
    await t.test(name, async () => {
      await withWorkspace(workspaces, async (root) => {
        const loaderDirectory = new URL("packages/executor-node/dist/src/host/", root);
        await mkdir(loaderDirectory, { recursive: true });
        await writeFile(
          new URL("component-loader.js", loaderDirectory),
          directLoader.replace('import { pathToFileURL } from "node:url";', importLine),
        );

        assert.deepEqual(await checkWorkspaceBoundaries(root), []);
      });
    });
  }

  for (const [name, source] of [
    [
      "rejects a second computed import in the same loader",
      `${directLoader}\nconst url = pathToFileURL(entrypoint);\nawait import(url.href);`,
    ],
    [
      "rejects a shadowed pathToFileURL binding",
      [
        'import { pathToFileURL } from "node:url";',
        "export async function loadPreparedComponent(pathToFileURL) {",
        "  return import(pathToFileURL(entrypoint).href);",
        "}",
      ].join("\n"),
    ],
    [
      "rejects an aliased pathToFileURL binding",
      [
        'import { pathToFileURL as fileUrl } from "node:url";',
        "export async function loadPreparedComponent(input) {",
        "  const entrypoint = input.entrypoint;",
        "  return import(fileUrl(entrypoint).href);",
        "}",
      ].join("\n"),
    ],
    [
      "rejects the expression from a nested scope",
      [
        'import { pathToFileURL } from "node:url";',
        "export async function loadPreparedComponent(input) {",
        "  const entrypoint = input.entrypoint;",
        "  const nested = async () => {",
        "    return import(pathToFileURL(entrypoint).href);",
        "  };",
        "  return nested();",
        "}",
      ].join("\n"),
    ],
    [
      "rejects the expression from a sibling function",
      [
        'import { pathToFileURL } from "node:url";',
        "export async function loadPreparedComponent(input) {",
        "  return input;",
        "}",
        "async function replacementLoader(entrypoint) {",
        "  return import(pathToFileURL(entrypoint).href);",
        "}",
      ].join("\n"),
    ],
  ]) {
    await t.test(name, async () => {
      await withWorkspace(workspaces, async (root) => {
        const loaderDirectory = new URL("packages/executor-node/dist/src/host/", root);
        await mkdir(loaderDirectory, { recursive: true });
        await writeFile(new URL("component-loader.js", loaderDirectory), source);

        assert.deepEqual(await checkWorkspaceBoundaries(root), [
          "@tegojs/executor-node -> [unsupported import specifier]",
        ]);
      });
    });
  }

  await t.test("rejects the same direct expression outside the target loader", async () => {
    await withWorkspace(workspaces, async (root) => {
      const runtimeDirectory = new URL("packages/runtime/dist/", root);
      await mkdir(runtimeDirectory, { recursive: true });
      await writeFile(new URL("unsafe-loader.js", runtimeDirectory), directLoader);

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/runtime -> [unsupported import specifier]",
      ]);
    });
  });
});

test("@spec:worker-protocol/real-process-transport-acceptance/allows-only-one-static-http-import-in-network-adapter", async (t) => {
  const workspaces = {
    "packages/contracts": { name: "@tegojs/contracts" },
    "packages/transport-websocket": {
      name: "@tegojs/transport-websocket",
      dependencies: { "@tegojs/contracts": "0.0.0" },
    },
  };

  await t.test("accepts the unique static import in the emitted network adapter", async () => {
    await withWorkspace(workspaces, async (root) => {
      const outputDirectory = new URL("packages/transport-websocket/dist/src/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("network.js", outputDirectory),
        'import { createServer } from "node:http";',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), []);
    });
  });

  await t.test("rejects a second static import in the emitted network adapter", async () => {
    await withWorkspace(workspaces, async (root) => {
      const outputDirectory = new URL("packages/transport-websocket/dist/src/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("network.js", outputDirectory),
        ['import { createServer } from "node:http";', 'import { request } from "node:http";'].join(
          "\n",
        ),
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/transport-websocket -> node:http",
      ]);
    });
  });

  await t.test("rejects the same import from another emitted file", async () => {
    await withWorkspace(workspaces, async (root) => {
      const outputDirectory = new URL("packages/transport-websocket/dist/src/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("session.js", outputDirectory),
        'import { createServer } from "node:http";',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/transport-websocket -> node:http",
      ]);
    });
  });

  await t.test("rejects a dynamic import from the emitted network adapter", async () => {
    await withWorkspace(workspaces, async (root) => {
      const outputDirectory = new URL("packages/transport-websocket/dist/src/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(new URL("network.js", outputDirectory), 'await import("node:http");');

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/transport-websocket -> node:http",
      ]);
    });
  });
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

test("@spec:runtime-operations/layer-one-dependency-boundary/ignores-private-methods-named-import", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/executor-node": {
        name: "@tegojs/executor-node",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/executor-node/dist/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("component-host.js", outputDirectory),
        "class ComponentHost { async #import(command) { return command; } }",
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), []);
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

test("@spec:runtime-operations/layer-one-dependency-boundary/cache-specifier-resolution", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/runtime": {
        name: "@tegojs/runtime",
        dependencies: {
          "@tegojs/contracts": "0.0.0",
          "@vendor/cache": "1.0.0",
          "@tegojs/cache-driver": "0.0.0",
        },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/runtime/dist/src/artifacts/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("index.js", outputDirectory),
        [
          'export { PreparedArtifactCache } from "./prepared-artifact-cache.js";',
          'import "@tegojs/runtime/cache";',
          'import "@vendor/cache";',
          'import "@tegojs/cache-driver";',
        ].join("\n"),
      );
      await writeFile(
        new URL("prepared-artifact-cache.js", outputDirectory),
        "export class PreparedArtifactCache {}",
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/runtime -> @tegojs/cache-driver",
        "@tegojs/runtime -> @tegojs/runtime/cache",
        "@tegojs/runtime -> @vendor/cache",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/allows-testkit-conformance-edges", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/testkit": {
        name: "@tegojs/testkit",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tegojs/drivers-local",
        dependencies: { "@tegojs/contracts": "0.0.0" },
        devDependencies: { "@tegojs/testkit": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/drivers-local/dist/test/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("conformance.test.js", outputDirectory),
        'import { runStateStoreSuite } from "@tegojs/testkit";',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), []);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-production-dependency", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/testkit": {
        name: "@tegojs/testkit",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tegojs/drivers-local",
        dependencies: {
          "@tegojs/contracts": "0.0.0",
          "@tegojs/testkit": "0.0.0",
        },
      },
    },
    async (root) => {
      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/drivers-local -> @tegojs/testkit",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-production-import", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/testkit": {
        name: "@tegojs/testkit",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tegojs/drivers-local",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/drivers-local/dist/src/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("index.js", outputDirectory),
        'import { runStateStoreSuite } from "@tegojs/testkit";',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/drivers-local -> @tegojs/testkit",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-production-alias-import", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/testkit": {
        name: "@tegojs/testkit",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tegojs/drivers-local",
        dependencies: { "@tegojs/contracts": "0.0.0" },
        devDependencies: {
          "testkit-alias": "npm:@tegojs/testkit@0.0.0",
        },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/drivers-local/dist/src/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(new URL("index.js", outputDirectory), 'import "testkit-alias";');

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/drivers-local -> @tegojs/testkit",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-production-alias-subpath-import", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/testkit": {
        name: "@tegojs/testkit",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tegojs/drivers-local",
        dependencies: { "@tegojs/contracts": "0.0.0" },
        devDependencies: {
          "testkit-alias": "npm:@tegojs/testkit@0.0.0",
        },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/drivers-local/dist/src/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("index.js", outputDirectory),
        'import "testkit-alias/state-store-suite";',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/drivers-local -> @tegojs/testkit/state-store-suite",
      ]);
    },
  );
});

for (const field of ["optionalDependencies", "peerDependencies"]) {
  test(`@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-${field}`, async () => {
    await withWorkspace(
      {
        "packages/contracts": { name: "@tegojs/contracts" },
        "packages/testkit": {
          name: "@tegojs/testkit",
          dependencies: { "@tegojs/contracts": "0.0.0" },
        },
        "packages/drivers-local": {
          name: "@tegojs/drivers-local",
          dependencies: { "@tegojs/contracts": "0.0.0" },
          [field]: { "@tegojs/testkit": "0.0.0" },
        },
      },
      async (root) => {
        assert.deepEqual(await checkWorkspaceBoundaries(root), [
          "@tegojs/drivers-local -> @tegojs/testkit",
        ]);
      },
    );
  });
}

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-non-test-output", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/testkit": {
        name: "@tegojs/testkit",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tegojs/drivers-local",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/drivers-local/dist/integration/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("integration.test.js", outputDirectory),
        'import { runStateStoreSuite } from "@tegojs/testkit";',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/drivers-local -> @tegojs/testkit",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-contracts-testkit-dev-dependency", async () => {
  await withWorkspace(
    {
      "packages/contracts": {
        name: "@tegojs/contracts",
        devDependencies: { "@tegojs/testkit": "0.0.0" },
      },
      "packages/testkit": {
        name: "@tegojs/testkit",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
    },
    async (root) => {
      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/contracts -> @tegojs/testkit",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-contracts-testkit-test-import", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tegojs/contracts" },
      "packages/testkit": {
        name: "@tegojs/testkit",
        dependencies: { "@tegojs/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/contracts/dist/test/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("contracts.test.js", outputDirectory),
        'import { runStateStoreSuite } from "@tegojs/testkit";',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tegojs/contracts -> @tegojs/testkit",
      ]);
    },
  );
});
