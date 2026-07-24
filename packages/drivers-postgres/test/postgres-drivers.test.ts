import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseArtifactDigest, type ArtifactDigest } from "@tegojs/contracts";
import { coordinationConformance, stateStoreConformance } from "@tegojs/testkit";
import {
  PostgresArtifactStore,
  PostgresCoordinationProvider,
  PostgresStateStore,
} from "../src/index.js";

const connectionString = process.env.TEGO_POSTGRES_URL;
if (connectionString === undefined) {
  throw new Error("TEGO_POSTGRES_URL is required");
}

function namespace(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

stateStoreConformance(
  () =>
    new PostgresStateStore({
      connectionString,
      namespace: namespace("state"),
    }),
  { name: "PostgreSQL StateStore conformance" },
);

coordinationConformance(
  (requestedNamespace) =>
    new PostgresCoordinationProvider({
      connectionString,
      namespace: `coordination_${requestedNamespace ?? "default"}`,
    }),
  { name: "PostgreSQL CoordinationProvider conformance" },
);

function digest(bytes: Uint8Array): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

async function* source(...chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* chunks;
}

test("PostgreSQL ArtifactStore verifies digest, uniqueness, size, and restart reads", async () => {
  const content = Buffer.from("shared PostgreSQL artifact");
  const artifactDigest = digest(content);
  const storeNamespace = namespace("artifacts");
  const first = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
  });
  await first.open();
  await Promise.all([
    first.put(artifactDigest, source(content)),
    first.put(artifactDigest, source(Buffer.from(content))),
  ]);
  await first.close();

  const reopened = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
  });
  await reopened.open();
  const chunks: Uint8Array[] = [];
  for await (const chunk of reopened.read(artifactDigest)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), content);
  await reopened.close();
});

test("createPostgresDrivers creates one shared driver namespace", async () => {
  const { createPostgresDrivers } = await import("../src/index.js");
  const drivers = createPostgresDrivers({
    connectionString,
    namespace: namespace("bundle"),
  });
  assert.equal(drivers.state.scope, "shared");
  assert.equal(drivers.coordination.scope, "distributed");
  assert.equal(drivers.artifacts.scope, "shared");
});
