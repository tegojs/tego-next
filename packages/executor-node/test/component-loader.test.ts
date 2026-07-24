import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parseArtifactDigest } from "@tegojs/contracts";
import * as publicApi from "../src/index.js";
import { loadPreparedComponent, prepareArtifactBinding } from "../src/host/component-loader.js";

const digestA = parseArtifactDigest(`sha256:${"1".repeat(64)}`);
const digestB = parseArtifactDigest(`sha256:${"2".repeat(64)}`);

test("raw artifact binding and loading helpers are not public package API", () => {
  assert.equal("bindPreparedArtifactRoot" in publicApi, false);
  assert.equal("prepareArtifactBinding" in publicApi, false);
  assert.equal("loadPreparedComponent" in publicApi, false);
});

async function artifactRoot(
  t: TestContext,
  entrypointSource: string,
  helperSource?: string,
): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".tego-component-loader-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "components"), { recursive: true });
  await writeFile(join(root, "components/component.js"), entrypointSource);
  if (helperSource !== undefined) {
    await writeFile(join(root, "components/helper.js"), helperSource);
  }
  return root;
}

test("one physical artifact root cannot be rebound to another digest", async (t) => {
  const root = await artifactRoot(
    t,
    'export default { protocol: "tego.component/1.0", kind: "task", run: async () => "v1" };',
  );

  const prepared = await prepareArtifactBinding(digestA, root);
  await loadPreparedComponent({
    prepared,
    entrypoint: "components/component.js",
    expectedKind: "task",
  });

  await assert.rejects(
    prepareArtifactBinding(digestB, root),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "diagnostic" in error &&
      (error as { readonly diagnostic?: { readonly code?: string } }).diagnostic?.code ===
        "ARTIFACT_DIGEST_ROOT_CONFLICT",
  );
});

test("different digest roots isolate the complete static module graph", async (t) => {
  const entrypoint = `
    import { version } from "./helper.js";
    export default {
      protocol: "tego.component/1.0",
      kind: "task",
      run: async () => version
    };
  `;
  const firstRoot = await artifactRoot(t, entrypoint, 'export const version = "v1";');
  const secondRoot = await artifactRoot(t, entrypoint, 'export const version = "v2";');

  const first = await loadPreparedComponent({
    prepared: await prepareArtifactBinding(digestA, firstRoot),
    entrypoint: "components/component.js",
    expectedKind: "task",
  });
  const second = await loadPreparedComponent({
    prepared: await prepareArtifactBinding(digestB, secondRoot),
    entrypoint: "components/component.js",
    expectedKind: "task",
  });

  assert.equal(await first.run?.({}, null), "v1");
  assert.equal(await second.run?.({}, null), "v2");
});

test("loader captures hooks and snapshots metadata without retaining the plugin export object", async (t) => {
  const root = await artifactRoot(
    t,
    `
      const definition = {
        protocol: "tego.component/1.0",
        kind: "task",
        metadata: { nested: { version: "original" } },
        run: async () => "original"
      };
      setTimeout(() => {
        definition.metadata.nested.version = "mutated";
        definition.run = async () => "mutated";
      }, 0);
      export default definition;
    `,
  );

  const loaded = await loadPreparedComponent({
    prepared: await prepareArtifactBinding(digestA, root),
    entrypoint: "components/component.js",
    expectedKind: "task",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(await loaded.run?.({}, null), "original");
  assert.deepEqual(loaded.metadata, { nested: { version: "original" } });
  assert.ok(Object.isFrozen(loaded));
  assert.ok(Object.isFrozen(loaded.metadata));
  assert.ok(Object.isFrozen(loaded.metadata?.nested));
});
