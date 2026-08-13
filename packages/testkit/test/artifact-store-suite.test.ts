import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactStore, ArtifactStoreOptions, DriverHealth } from "@tego/contracts";
import { withArtifactStoreFixture } from "../src/artifact-store-suite.js";

class OpenRejectingArtifactStore implements ArtifactStore {
  readonly scope = "local" as const;
  closeCalls = 0;

  async open(): Promise<void> {
    throw new Error("open failed");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  async health(): Promise<DriverHealth> {
    return { status: "healthy", checkedAt: "2026-08-13T00:00:00.000Z" };
  }

  async put(): Promise<void> {}

  async *read(): AsyncIterable<Uint8Array> {}
}

test("artifact store fixture disposal runs when opening fails without closing an unopened store", async () => {
  const store = new OpenRejectingArtifactStore();
  let disposeCalls = 0;

  await assert.rejects(
    withArtifactStoreFixture(
      async (_options: ArtifactStoreOptions) => ({
        store,
        dispose: () => {
          disposeCalls += 1;
        },
      }),
      async () => {},
    ),
    /open failed/u,
  );

  assert.equal(store.closeCalls, 0);
  assert.equal(disposeCalls, 1);
});
