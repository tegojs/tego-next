import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { diagnosticCode, parseArtifactDigest } from "@tegojs/contracts";
import { Pool } from "pg";
import {
  POSTGRES_ARTIFACT_MAX_BYTES,
  PostgresArtifactStore,
} from "../src/postgres-artifact-store.js";

const connectionString =
  process.env.TEGO_POSTGRES_URL ??
  "postgresql://tego_test:tego_test@127.0.0.1:55432/tego_next_test";

function namespace(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function digest(content: Uint8Array) {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(content).digest("hex")}`);
}

test("an oversized source chunk is rejected before its bytes are copied", async () => {
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: namespace("artifact_source_limit"),
  });
  const oversized = new Proxy(new Uint8Array(1), {
    get(target, property) {
      if (property === "byteLength") return POSTGRES_ARTIFACT_MAX_BYTES + 1;
      throw new Error(`Oversized chunk bytes were accessed through ${String(property)}`);
    },
  }) as Uint8Array;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      let emitted = false;
      return {
        next: () => {
          if (emitted) return Promise.resolve({ done: true, value: undefined });
          emitted = true;
          return Promise.resolve({ done: false, value: oversized });
        },
      };
    },
  };
  await store.open();
  try {
    await assert.rejects(
      store.put(digest(new Uint8Array()), source),
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_SIZE_EXCEEDED",
    );
  } finally {
    await store.close();
  }
});

test("an oversized at-rest artifact is rejected before yielding bytes", async () => {
  const storeNamespace = namespace("artifact_stored_limit");
  const content = Buffer.alloc(POSTGRES_ARTIFACT_MAX_BYTES + 1, 0x61);
  const artifactDigest = digest(content);
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
  });
  const pool = new Pool({ connectionString });
  await store.open();
  try {
    await pool.query(
      `INSERT INTO tego_artifacts(driver_namespace, digest, content, size_bytes)
       VALUES ($1, $2, $3, 1)`,
      [storeNamespace, artifactDigest, content],
    );
    const iterator = store.read(artifactDigest)[Symbol.asyncIterator]();
    await assert.rejects(
      iterator.next(),
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_SIZE_EXCEEDED",
    );
  } finally {
    await Promise.all([store.close(), pool.end()]);
  }
});

test("artifact reads reject inconsistent stored size metadata", async () => {
  const storeNamespace = namespace("artifact_size_metadata");
  const content = Buffer.from("metadata-bound-artifact");
  const artifactDigest = digest(content);
  const store = new PostgresArtifactStore({
    connectionString,
    namespace: storeNamespace,
  });
  const pool = new Pool({ connectionString });
  await store.open();
  try {
    await pool.query(
      `INSERT INTO tego_artifacts(driver_namespace, digest, content, size_bytes)
       VALUES ($1, $2, $3, $4)`,
      [storeNamespace, artifactDigest, content, content.byteLength + 1],
    );
    const iterator = store.read(artifactDigest)[Symbol.asyncIterator]();
    await assert.rejects(
      iterator.next(),
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_DIGEST_MISMATCH",
    );
  } finally {
    await Promise.all([store.close(), pool.end()]);
  }
});
