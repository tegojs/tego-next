import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { checkWorkspaceBoundaries } from "../../scripts/check-boundaries.mjs";

const RELEASE_VERSION = "2.0.0-alpha.1";
const PUBLIC_PACKAGES = new Set([
  "@tego/cli",
  "@tego/contracts",
  "@tego/drivers-local",
  "@tego/drivers-postgres",
  "@tego/executor-node",
  "@tego/plugin-sdk",
  "@tego/runtime",
  "@tego/testkit",
  "@tego/transport-websocket",
]);
const IMMUTABLE_SDD_ARTIFACTS = new Set([
  "integration-task-6-report.md",
  "integration-task-7-report.md",
  "integration-task-8-report.md",
  "phase1-contract-task-1-report.md",
  "phase1-contract-task-2-fix-report.md",
  "phase1-docs-report.md",
  "phase1-task-1-fix-report.md",
  "phase1-task-1-report.md",
  "phase1-task-12-fix-report.md",
  "phase1-task-12-fix2-report.md",
  "phase1-task-12-report.md",
  "phase1-task-13-fault-fix-report.md",
  "phase1-task-13-fault-report.md",
  "phase1-task-9-report.md",
  "progress.md",
  "review-7b909e3..9417d8b.diff",
  "single-main-cleanup-fix-report.md",
  "task-1-brief.md",
  "task-1-report.md",
  "task-4-report.md",
  "task-5-report.md",
  "task-6-report.md",
  "task-7-report.md",
  "task-8-brief.md",
  "task-8-report.md",
]);

async function activeFiles(directory, relativePath = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const nextRelativePath = `${relativePath}${entry.name}`;
    if (entry.isDirectory()) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      files.push(...(await activeFiles(new URL(`${entry.name}/`, directory), `${nextRelativePath}/`)));
    } else if (entry.isFile()) {
      if (relativePath === ".superpowers/sdd/" && IMMUTABLE_SDD_ARTIFACTS.has(entry.name)) {
        continue;
      }
      files.push(new URL(entry.name, directory));
    }
  }

  return files;
}

test("public workspace namespace and alpha release metadata are exact", async () => {
  const root = new URL("../../", import.meta.url);
  const rootManifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const echoManifest = JSON.parse(
    await readFile(new URL("examples/echo-plugin/package.json", root), "utf8"),
  );
  const packageDirectories = await readdir(new URL("packages/", root), { withFileTypes: true });
  const manifests = await Promise.all(
    packageDirectories
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        JSON.parse(await readFile(new URL(`${entry.name}/package.json`, new URL("packages/", root)), "utf8")),
      ),
  );

  assert.equal(rootManifest.name, "@tego/root");
  assert.deepEqual(new Set(manifests.map(({ name }) => name)), PUBLIC_PACKAGES);
  for (const manifest of manifests) {
    assert.equal(manifest.version, RELEASE_VERSION);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (PUBLIC_PACKAGES.has(name)) assert.equal(version, RELEASE_VERSION);
      }
    }
  }
  assert.deepEqual(rootManifest.volta, { node: "26.5.0", npm: "11.13.0" });
  assert.equal(echoManifest.name, "@tego/echo-plugin");
  assert.equal(echoManifest.version, "1.0.0");
  assert.deepEqual(echoManifest.dependencies, { "@tego/plugin-sdk": RELEASE_VERSION });

  const legacyScope = "@tego" + "js/";
  const legacyReferences = [];
  for (const file of await activeFiles(root)) {
    if ((await readFile(file, "utf8")).includes(legacyScope)) legacyReferences.push(file.pathname);
  }
  assert.deepEqual(legacyReferences, []);
});

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
        name: "@tego/contracts",
        dependencies: { "@tego/runtime": "0.0.0" },
      },
      "packages/runtime": {
        name: "@tego/runtime",
        dependencies: {
          "@tego/contracts": "0.0.0",
          "@tego/executor-node": "0.0.0",
          "@tego/echo-plugin": "0.0.0",
        },
      },
      "packages/drivers-local": {
        name: "@tego/drivers-local",
        dependencies: { "@tego/runtime": "0.0.0" },
      },
      "packages/executor-node": {
        name: "@tego/executor-node",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
      "packages/plugin-sdk": {
        name: "@tego/plugin-sdk",
        dependencies: { "@tego/testkit": "0.0.0" },
      },
      "packages/testkit": {
        name: "@tego/testkit",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
      "packages/cli": {
        name: "@tego/cli",
        dependencies: {
          "@tego/echo-plugin": "0.0.0",
          "@tego/runtime": "0.0.0",
        },
      },
      "examples/echo-plugin": {
        name: "@tego/echo-plugin",
        dependencies: { "@tego/plugin-sdk": "0.0.0" },
      },
    },
    async (root) => {
      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/cli -> @tego/echo-plugin",
        "@tego/contracts -> @tego/runtime",
        "@tego/drivers-local -> @tego/runtime",
        "@tego/plugin-sdk -> @tego/testkit",
        "@tego/runtime -> @tego/echo-plugin",
        "@tego/runtime -> @tego/executor-node",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-forbidden-emitted-imports", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/runtime": {
        name: "@tego/runtime",
        dependencies: {
          "@tego/contracts": "0.0.0",
          "executor-local": "file:../executor-node",
          "transport-escape": "npm:@tego/transport-websocket@0.0.0",
        },
      },
      "packages/executor-node": {
        name: "@tego/executor-node",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
      "packages/transport-websocket": {
        name: "@tego/transport-websocket",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
      "packages/testkit": {
        name: "@tego/testkit",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/runtime/dist/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("index.js", outputDirectory),
        [
          'export { execute } from "@tego/executor-node";',
          'import runtime from "legacy/tego/runtime";',
          'await import("../../transport-websocket/dist/index.js", { with: { type: "json" } });',
          "await import(`@tego/executor-node`);",
          "await import(runtimeSpecifier);",
          `const message = \`${String.fromCharCode(36)}{await import("../../executor-node/dist/index.js")}\`;`,
          String.raw`import "@tego/\u0072untime";`,
          'const pattern = /import\\s+from\\s+"@tego/testkit"/;',
          "export default runtime;",
        ].join("\n"),
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/runtime -> ../../executor-node/dist/index.js",
        "@tego/runtime -> ../../transport-websocket/dist/index.js",
        "@tego/runtime -> ../executor-node",
        "@tego/runtime -> @tego/executor-node",
        "@tego/runtime -> @tego/transport-websocket",
        "@tego/runtime -> [unsupported import specifier]",
        "@tego/runtime -> legacy/tego/runtime",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-computed-dynamic-imports", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/runtime": {
        name: "@tego/runtime",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
      "packages/executor-node": {
        name: "@tego/executor-node",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/runtime/dist/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("index.js", outputDirectory),
        'await import("@tego/" + "executor-node");',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/runtime -> [unsupported import specifier]",
      ]);
    },
  );
});

test("@spec:plugin-deployment/pre-execution-deployment-gate/allows-only-one-direct-scoped-component-file-url-import", async (t) => {
  const workspaces = {
    "packages/contracts": { name: "@tego/contracts" },
    "packages/runtime": {
      name: "@tego/runtime",
      dependencies: { "@tego/contracts": "0.0.0" },
    },
    "packages/executor-node": {
      name: "@tego/executor-node",
      dependencies: { "@tego/contracts": "0.0.0" },
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
          "@tego/executor-node -> [unsupported import specifier]",
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
        "@tego/runtime -> [unsupported import specifier]",
      ]);
    });
  });
});

test("@spec:worker-protocol/real-process-transport-acceptance/allows-only-one-static-http-import-in-network-adapter", async (t) => {
  const workspaces = {
    "packages/contracts": { name: "@tego/contracts" },
    "packages/transport-websocket": {
      name: "@tego/transport-websocket",
      dependencies: { "@tego/contracts": "0.0.0" },
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
        "@tego/transport-websocket -> node:http",
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
        "@tego/transport-websocket -> node:http",
      ]);
    });
  });

  await t.test("rejects a dynamic import from the emitted network adapter", async () => {
    await withWorkspace(workspaces, async (root) => {
      const outputDirectory = new URL("packages/transport-websocket/dist/src/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(new URL("network.js", outputDirectory), 'await import("node:http");');

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/transport-websocket -> node:http",
      ]);
    });
  });
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-computed-import-after-postfix-division", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/runtime": {
        name: "@tego/runtime",
        dependencies: { "@tego/contracts": "0.0.0" },
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
        "@tego/runtime -> [unsupported import specifier]",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/ignores-private-methods-named-import", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/executor-node": {
        name: "@tego/executor-node",
        dependencies: { "@tego/contracts": "0.0.0" },
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
        name: "@tego/contracts",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
    },
    async (root) => {
      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/contracts -> @tego/contracts",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/preserves-duplicate-dependency-section-entries", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/runtime": {
        name: "@tego/runtime",
        dependencies: {
          "shared-alias": "npm:@tego/executor-node@0.0.0",
        },
        devDependencies: {
          "shared-alias": "npm:@tego/contracts@0.0.0",
        },
      },
      "packages/executor-node": {
        name: "@tego/executor-node",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
    },
    async (root) => {
      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/runtime -> @tego/executor-node",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/allows-internal-relative-imports", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/runtime": {
        name: "@tego/runtime",
        dependencies: { "@tego/contracts": "0.0.0" },
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
        "@tego/contracts -> ../../runtime/dist/index.js",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/cache-specifier-resolution", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/runtime": {
        name: "@tego/runtime",
        dependencies: {
          "@tego/contracts": "0.0.0",
          "@vendor/cache": "1.0.0",
          "@tego/cache-driver": "0.0.0",
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
          'import "@tego/runtime/cache";',
          'import "@vendor/cache";',
          'import "@tego/cache-driver";',
        ].join("\n"),
      );
      await writeFile(
        new URL("prepared-artifact-cache.js", outputDirectory),
        "export class PreparedArtifactCache {}",
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/runtime -> @tego/cache-driver",
        "@tego/runtime -> @tego/runtime/cache",
        "@tego/runtime -> @vendor/cache",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/allows-testkit-conformance-edges", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/testkit": {
        name: "@tego/testkit",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tego/drivers-local",
        dependencies: { "@tego/contracts": "0.0.0" },
        devDependencies: { "@tego/testkit": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/drivers-local/dist/test/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("conformance.test.js", outputDirectory),
        'import { runStateStoreSuite } from "@tego/testkit";',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), []);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-production-dependency", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/testkit": {
        name: "@tego/testkit",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tego/drivers-local",
        dependencies: {
          "@tego/contracts": "0.0.0",
          "@tego/testkit": "0.0.0",
        },
      },
    },
    async (root) => {
      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/drivers-local -> @tego/testkit",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-production-import", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/testkit": {
        name: "@tego/testkit",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tego/drivers-local",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/drivers-local/dist/src/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("index.js", outputDirectory),
        'import { runStateStoreSuite } from "@tego/testkit";',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/drivers-local -> @tego/testkit",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-production-alias-import", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/testkit": {
        name: "@tego/testkit",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tego/drivers-local",
        dependencies: { "@tego/contracts": "0.0.0" },
        devDependencies: {
          "testkit-alias": "npm:@tego/testkit@0.0.0",
        },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/drivers-local/dist/src/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(new URL("index.js", outputDirectory), 'import "testkit-alias";');

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/drivers-local -> @tego/testkit",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-production-alias-subpath-import", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/testkit": {
        name: "@tego/testkit",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tego/drivers-local",
        dependencies: { "@tego/contracts": "0.0.0" },
        devDependencies: {
          "testkit-alias": "npm:@tego/testkit@0.0.0",
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
        "@tego/drivers-local -> @tego/testkit/state-store-suite",
      ]);
    },
  );
});

for (const field of ["optionalDependencies", "peerDependencies"]) {
  test(`@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-${field}`, async () => {
    await withWorkspace(
      {
        "packages/contracts": { name: "@tego/contracts" },
        "packages/testkit": {
          name: "@tego/testkit",
          dependencies: { "@tego/contracts": "0.0.0" },
        },
        "packages/drivers-local": {
          name: "@tego/drivers-local",
          dependencies: { "@tego/contracts": "0.0.0" },
          [field]: { "@tego/testkit": "0.0.0" },
        },
      },
      async (root) => {
        assert.deepEqual(await checkWorkspaceBoundaries(root), [
          "@tego/drivers-local -> @tego/testkit",
        ]);
      },
    );
  });
}

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-testkit-non-test-output", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/testkit": {
        name: "@tego/testkit",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
      "packages/drivers-local": {
        name: "@tego/drivers-local",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/drivers-local/dist/integration/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("integration.test.js", outputDirectory),
        'import { runStateStoreSuite } from "@tego/testkit";',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/drivers-local -> @tego/testkit",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-contracts-testkit-dev-dependency", async () => {
  await withWorkspace(
    {
      "packages/contracts": {
        name: "@tego/contracts",
        devDependencies: { "@tego/testkit": "0.0.0" },
      },
      "packages/testkit": {
        name: "@tego/testkit",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
    },
    async (root) => {
      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/contracts -> @tego/testkit",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-contracts-testkit-test-import", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/testkit": {
        name: "@tego/testkit",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/contracts/dist/test/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("contracts.test.js", outputDirectory),
        'import { runStateStoreSuite } from "@tego/testkit";',
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/contracts -> @tego/testkit",
      ]);
    },
  );
});

test("@spec:runtime-operations/layer-one-dependency-boundary/rejects-export-only-layer-two-apis", async () => {
  await withWorkspace(
    {
      "packages/contracts": { name: "@tego/contracts" },
      "packages/runtime": {
        name: "@tego/runtime",
        dependencies: { "@tego/contracts": "0.0.0" },
      },
    },
    async (root) => {
      const outputDirectory = new URL("packages/runtime/dist/src/", root);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        new URL("index.d.ts", outputDirectory),
        [
          "export interface WorkflowEngine {}",
          "declare class InternalScheduler {}",
          "export { InternalScheduler as BusinessDomainScheduler };",
          "export interface RuntimeKernel {}",
        ].join("\n"),
      );

      assert.deepEqual(await checkWorkspaceBoundaries(root), [
        "@tego/runtime -> [forbidden public export BusinessDomainScheduler]",
        "@tego/runtime -> [forbidden public export WorkflowEngine]",
      ]);
    },
  );
});
