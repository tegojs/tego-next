import { createHash } from "node:crypto";
import {
  type ArtifactDigest,
  type ArtifactStore,
  type DriverHealth,
  parseArtifactDigest,
} from "@tegojs/contracts";
import type { Pool } from "pg";
import { createPool, openPool, type PostgresConnectionOptions, postgresError } from "./shared.js";

export const POSTGRES_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export class PostgresArtifactStore implements ArtifactStore {
  readonly scope = "shared" as const;
  readonly #namespace: string;
  readonly #pool: Pool;
  #lifecycle: "closed" | "created" | "open" | "opening" = "created";
  #openPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: PostgresConnectionOptions) {
    this.#namespace = options.namespace;
    this.#pool = createPool(options, "artifacts");
  }

  open(): Promise<void> {
    if (this.#lifecycle === "closed") return Promise.reject(this.#closedError());
    if (this.#lifecycle === "open") return Promise.resolve();
    if (this.#openPromise !== undefined) return this.#openPromise;
    this.#lifecycle = "opening";
    const opening = openPool(this.#pool).then(
      () => {
        if (this.#lifecycle === "closed") throw this.#closedError();
        this.#lifecycle = "open";
      },
      (error: unknown) => {
        if (this.#lifecycle === "opening") this.#lifecycle = "created";
        throw error;
      },
    );
    this.#openPromise = opening;
    const clearOpening = () => {
      if (this.#openPromise === opening) this.#openPromise = undefined;
    };
    void opening.then(clearOpening, clearOpening);
    return opening;
  }

  async put(digest: ArtifactDigest, source: AsyncIterable<Uint8Array>): Promise<void> {
    this.#assertOpen();
    const parsed = parseArtifactDigest(digest);
    const chunks: Buffer[] = [];
    let size = 0;
    const hash = createHash("sha256");
    for await (const chunk of source) {
      const copy = Buffer.from(chunk);
      size += copy.byteLength;
      if (size > POSTGRES_ARTIFACT_MAX_BYTES) {
        throw postgresError(
          "ARTIFACT_SIZE_EXCEEDED",
          "Artifact exceeds the PostgreSQL storage limit",
          "artifact",
          { digest: parsed, maximumBytes: POSTGRES_ARTIFACT_MAX_BYTES },
        );
      }
      chunks.push(copy);
      hash.update(copy);
    }
    const actual = parseArtifactDigest(`sha256:${hash.digest("hex")}`);
    if (actual !== parsed) {
      throw postgresError(
        "ARTIFACT_DIGEST_MISMATCH",
        "Artifact bytes do not match the requested digest",
        "artifact",
        { actual, expected: parsed },
      );
    }
    const content = Buffer.concat(chunks, size);
    await this.#pool.query(
      `
        INSERT INTO tego_artifacts(driver_namespace, digest, content, size_bytes)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(driver_namespace, digest) DO NOTHING
      `,
      [this.#namespace, parsed, content, size.toString()],
    );
    const existing = await this.#pool.query<{ content: Buffer; size_bytes: string }>(
      `
        SELECT content, size_bytes::text
        FROM tego_artifacts
        WHERE driver_namespace = $1 AND digest = $2
      `,
      [this.#namespace, parsed],
    );
    const row = existing.rows[0];
    if (
      row === undefined ||
      row.size_bytes !== size.toString() ||
      !Buffer.from(row.content).equals(content)
    ) {
      throw postgresError(
        "ARTIFACT_DIGEST_MISMATCH",
        "Artifact digest is already bound to different bytes",
        "artifact",
        { digest: parsed },
      );
    }
  }

  async *read(digest: ArtifactDigest): AsyncIterable<Uint8Array> {
    this.#assertOpen();
    const parsed = parseArtifactDigest(digest);
    const result = await this.#pool.query<{ content: Buffer }>(
      `
        SELECT content
        FROM tego_artifacts
        WHERE driver_namespace = $1 AND digest = $2
      `,
      [this.#namespace, parsed],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw postgresError("ARTIFACT_NOT_FOUND", "Artifact does not exist", "artifact", {
        digest: parsed,
      });
    }
    const content = Buffer.from(row.content);
    const actual = parseArtifactDigest(
      `sha256:${createHash("sha256").update(content).digest("hex")}`,
    );
    if (actual !== parsed) {
      throw postgresError(
        "ARTIFACT_DIGEST_MISMATCH",
        "Stored artifact failed digest verification",
        "artifact",
        { actual, expected: parsed },
      );
    }
    for (let offset = 0; offset < content.byteLength; offset += READ_CHUNK_BYTES) {
      this.#assertOpen();
      yield Buffer.from(content.subarray(offset, offset + READ_CHUNK_BYTES));
    }
  }

  async health(): Promise<DriverHealth> {
    this.#assertOpen();
    const result = await this.#pool.query<{ checked_at: Date }>(
      "SELECT clock_timestamp() AS checked_at",
    );
    return {
      status: "healthy",
      checkedAt: (result.rows[0]?.checked_at ?? new Date()).toISOString(),
    };
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#lifecycle === "closed") return Promise.resolve();
    this.#lifecycle = "closed";
    const closing = (async () => {
      await this.#openPromise?.catch(() => undefined);
      await this.#pool.end();
    })();
    this.#closePromise = closing;
    return closing;
  }

  #assertOpen(): void {
    if (this.#lifecycle !== "open") throw this.#closedError();
  }

  #closedError() {
    return postgresError(
      "ARTIFACT_STORE_CLOSED",
      "PostgreSQL artifact store is closed",
      "artifact",
    );
  }
}
