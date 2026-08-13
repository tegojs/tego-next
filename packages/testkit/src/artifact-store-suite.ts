import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
  type ArtifactDigest,
  type ArtifactStore,
  type ArtifactStoreOptions,
  diagnosticCode,
  parseArtifactDigest,
} from "@tego/contracts";

export interface ArtifactStoreSuiteFixture {
  readonly store: ArtifactStore;
  dispose(): Promise<void> | void;
}

export type ArtifactStoreSuiteFactory = (
  options: ArtifactStoreOptions,
) => ArtifactStoreSuiteFixture | Promise<ArtifactStoreSuiteFixture>;

const LIMITS = { maxArtifactBytes: 4, maxNamespaceBytes: 6 };

function digestFor(byte: number, size: number): ArtifactDigest {
  return parseArtifactDigest(
    `sha256:${createHash("sha256").update(new Uint8Array(size).fill(byte)).digest("hex")}`,
  );
}

function chunks(
  byte: number,
  sizes: readonly number[],
  afterYield?: Promise<void>,
  onYield?: () => void,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const size of sizes) {
        yield new Uint8Array(size).fill(byte);
        onYield?.();
      }
      await afterYield;
    },
  };
}

function diagnosticWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => diagnosticCode(error) === code;
}

export async function withArtifactStoreFixture(
  factory: ArtifactStoreSuiteFactory,
  run: (store: ArtifactStore) => Promise<void>,
): Promise<void> {
  const fixture = await factory({ namespace: "artifact-store-conformance", limits: LIMITS });
  let opened = false;
  let primaryError: unknown;
  let operationFailed = false;
  try {
    await fixture.store.open();
    opened = true;
    await run(fixture.store);
  } catch (error) {
    primaryError = error;
    operationFailed = true;
  }

  const cleanupErrors: unknown[] = [];
  if (opened) {
    try {
      await fixture.store.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await fixture.dispose();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (operationFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Artifact store fixture operation and cleanup failed",
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Artifact store fixture cleanup failed");
  }
}

export function defineArtifactStoreSuite(factory: ArtifactStoreSuiteFactory): void {
  describe("ArtifactStore quota conformance", () => {
    test("rejects an artifact larger than its configured per-artifact limit", async () => {
      await withArtifactStoreFixture(factory, async (store) => {
        await assert.rejects(
          store.put(digestFor(1, 5), chunks(1, [3, 2])),
          diagnosticWithCode("ARTIFACT_SIZE_LIMIT_EXCEEDED"),
        );
      });
    });

    test("enforces the cumulative namespace quota while duplicate puts are free", async () => {
      await withArtifactStoreFixture(factory, async (store) => {
        const firstDigest = digestFor(2, 4);
        await store.put(firstDigest, chunks(2, [4]));
        await assert.rejects(
          store.put(digestFor(3, 4), chunks(3, [4])),
          diagnosticWithCode("ARTIFACT_NAMESPACE_QUOTA_EXCEEDED"),
        );
        await store.put(firstDigest, chunks(2, [4]));
      });
    });

    test("prevents concurrent writes from overcommitting namespace reservations", async () => {
      await withArtifactStoreFixture(factory, async (store) => {
        let releaseFirst!: () => void;
        let firstReserved!: () => void;
        const firstComplete = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const reserved = new Promise<void>((resolve) => {
          firstReserved = resolve;
        });
        const first = store.put(digestFor(4, 4), chunks(4, [4], firstComplete, firstReserved));
        await reserved;
        const second = store.put(digestFor(5, 4), chunks(5, [4]));
        await assert.rejects(second, diagnosticWithCode("ARTIFACT_NAMESPACE_QUOTA_EXCEEDED"));
        releaseFirst();
        await first;
      });
    });

    test("releases a failed digest write reservation for a subsequent write", async () => {
      await withArtifactStoreFixture(factory, async (store) => {
        await assert.rejects(store.put(digestFor(6, 4), chunks(7, [4])));
        await store.put(digestFor(8, 4), chunks(8, [4]));
      });
    });
  });
}
