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
  size: number,
  afterYield?: Promise<void>,
  onYield?: () => void,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(size).fill(byte);
      onYield?.();
      await afterYield;
    },
  };
}

function diagnosticWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => diagnosticCode(error) === code;
}

async function withStore(
  factory: ArtifactStoreSuiteFactory,
  run: (store: ArtifactStore) => Promise<void>,
): Promise<void> {
  const fixture = await factory({ namespace: "artifact-store-conformance", limits: LIMITS });
  await fixture.store.open();
  try {
    await run(fixture.store);
  } finally {
    try {
      await fixture.store.close();
    } finally {
      await fixture.dispose();
    }
  }
}

export function defineArtifactStoreSuite(factory: ArtifactStoreSuiteFactory): void {
  describe("ArtifactStore quota conformance", () => {
    test("rejects an artifact larger than its configured per-artifact limit", async () => {
      await withStore(factory, async (store) => {
        await assert.rejects(
          store.put(digestFor(1, 5), chunks(1, 5)),
          diagnosticWithCode("ARTIFACT_SIZE_LIMIT_EXCEEDED"),
        );
      });
    });

    test("enforces the cumulative namespace quota while duplicate puts are free", async () => {
      await withStore(factory, async (store) => {
        const firstDigest = digestFor(2, 4);
        await store.put(firstDigest, chunks(2, 4));
        await assert.rejects(
          store.put(digestFor(3, 4), chunks(3, 4)),
          diagnosticWithCode("ARTIFACT_NAMESPACE_QUOTA_EXCEEDED"),
        );
        await store.put(firstDigest, chunks(2, 4));
      });
    });

    test("prevents concurrent writes from overcommitting namespace reservations", async () => {
      await withStore(factory, async (store) => {
        let releaseFirst!: () => void;
        let firstReserved!: () => void;
        const firstComplete = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const reserved = new Promise<void>((resolve) => {
          firstReserved = resolve;
        });
        const first = store.put(digestFor(4, 4), chunks(4, 4, firstComplete, firstReserved));
        await reserved;
        const second = store.put(digestFor(5, 4), chunks(5, 4));
        await assert.rejects(second, diagnosticWithCode("ARTIFACT_NAMESPACE_QUOTA_EXCEEDED"));
        releaseFirst();
        await first;
      });
    });

    test("releases a failed digest write reservation for a subsequent write", async () => {
      await withStore(factory, async (store) => {
        await assert.rejects(store.put(digestFor(6, 4), chunks(7, 4)));
        await store.put(digestFor(8, 4), chunks(8, 4));
      });
    });
  });
}
