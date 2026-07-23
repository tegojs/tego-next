import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { after, test } from "node:test";
import {
  diagnosticCode,
  parseArtifactDigest,
  parseFencingEpoch,
  type ArtifactDigest,
} from "@tegojs/contracts";
import { FakeClock } from "@tegojs/testkit";
import {
  artifactPublishSyncDirectories,
  createLocalDrivers,
  FilesystemArtifactStore,
  hashArtifactHandle,
  LocalCoordinationProvider,
  publishTempFileAtomically,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `tego-local-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function digest(bytes: Uint8Array): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

async function* bytesSource(...chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* chunks;
}

test("@spec:coordination-provider/single-main-authority/local-authority-is-immediate", async () => {
  const clock = new FakeClock(new Date("2026-07-23T10:00:00.000Z"));
  const coordination = new LocalCoordinationProvider({ clock });
  await coordination.open();

  assert.deepEqual(await coordination.campaign({ resource: "runtime" }), {
    resource: "runtime",
    epoch: parseFencingEpoch("1"),
  });
  assert.equal(await coordination.nextEpoch("runtime"), parseFencingEpoch("1"));

  const lease = await coordination.acquireLease({
    resource: "task/example",
    owner: "worker-1",
    durationMs: 2_500,
  });
  assert.deepEqual(lease, {
    resource: "task/example",
    owner: "worker-1",
    epoch: parseFencingEpoch("1"),
    acquiredAt: "2026-07-23T10:00:00.000Z",
    expiresAt: "2026-07-23T10:00:02.500Z",
  });
  await coordination.close();
});

test("artifact digest mismatch removes the staged file", async () => {
  const rootDirectory = await temporaryDirectory("digest-mismatch");
  const store = new FilesystemArtifactStore({ rootDirectory });
  await store.open();

  const expected = digest(Buffer.from("expected"));
  await assert.rejects(
    store.put(expected, bytesSource(Buffer.from("different"))),
    (error: unknown) => diagnosticCode(error) === "ARTIFACT_DIGEST_MISMATCH",
  );

  const artifactDirectory = join(rootDirectory, "artifacts");
  const entries = await readdir(artifactDirectory, { recursive: true });
  assert.deepEqual(entries, []);
  await store.close();
});

test("artifact publish is invisible until the complete file is durable", async () => {
  const rootDirectory = await temporaryDirectory("atomic");
  const store = new FilesystemArtifactStore({ rootDirectory });
  await store.open();
  const firstChunk = Buffer.from("first-");
  const secondChunk = Buffer.from("second");
  const expected = digest(Buffer.concat([firstChunk, secondChunk]));
  const release = Promise.withResolvers<void>();
  const firstChunkWritten = Promise.withResolvers<void>();

  async function* source(): AsyncIterable<Uint8Array> {
    yield firstChunk;
    firstChunkWritten.resolve();
    await release.promise;
    yield secondChunk;
  }

  const publishing = store.put(expected, source());
  await firstChunkWritten.promise;
  await assert.rejects(access(store.pathFor(expected)));
  release.resolve();
  await publishing;

  assert.deepEqual(
    await readFile(store.pathFor(expected)),
    Buffer.concat([firstChunk, secondChunk]),
  );
  await store.close();
});

test("artifact reads verify all bytes before yielding any content", async () => {
  const rootDirectory = await temporaryDirectory("read-verification");
  const store = new FilesystemArtifactStore({ rootDirectory });
  await store.open();
  const content = Buffer.from("verified");
  const expected = digest(content);
  await store.put(expected, bytesSource(content));
  await writeFile(store.pathFor(expected), "tampered");

  const yielded: Uint8Array[] = [];
  await assert.rejects(
    (async () => {
      for await (const chunk of store.read(expected)) {
        yielded.push(chunk);
      }
    })(),
    (error: unknown) => diagnosticCode(error) === "ARTIFACT_DIGEST_MISMATCH",
  );
  assert.deepEqual(yielded, []);
  await store.close();
});

test("closing the store reclaims suspended verified reads", async () => {
  const rootDirectory = await temporaryDirectory("active-read-close");
  const store = new FilesystemArtifactStore({ rootDirectory });
  await store.open();
  const content = Buffer.alloc(128 * 1024, 0x61);
  const expected = digest(content);
  await store.put(expected, bytesSource(content));

  const iterator = store.read(expected)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);

  await store.close();
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("closing during verification terminates the read before its first yield", async () => {
  const rootDirectory = await temporaryDirectory("verify-yield-close");
  const store = new FilesystemArtifactStore({ rootDirectory });
  await store.open();
  const content = Buffer.alloc(128 * 1024, 0x61);
  const expected = digest(content);
  await store.put(expected, bytesSource(content));

  const iterator = store.read(expected)[Symbol.asyncIterator]();
  const reading = iterator.next();
  const closing = store.close();

  const [first] = await Promise.all([reading, closing]);
  assert.equal(first.done, true);
});

test("artifact read handle cleanup preserves primary errors", async (context) => {
  await context.test("verification error wins over close error", async () => {
    const rootDirectory = await temporaryDirectory("verify-close-error");
    const verificationError = new Error("verification failed");
    const closeError = new Error("verification handle close failed");
    let closeCalls = 0;
    const store = new FilesystemArtifactStore({
      rootDirectory,
      openReadHandle: async () => ({
        async read() {
          throw verificationError;
        },
        async close() {
          closeCalls += 1;
          throw closeError;
        },
      }),
    } as never);
    await store.open();

    const iterator = store.read(digest(Buffer.from("expected")))[Symbol.asyncIterator]();
    await assert.rejects(iterator.next(), (error: unknown) => error === verificationError);
    assert.equal(closeCalls, 1);
    await store.close();
  });

  await context.test("stream read error wins over close error", async () => {
    const rootDirectory = await temporaryDirectory("read-close-error");
    const content = Buffer.from("verified");
    const readError = new Error("stream read failed");
    const closeError = new Error("stream handle close failed");
    let verificationComplete = false;
    let closeCalls = 0;
    const store = new FilesystemArtifactStore({
      rootDirectory,
      openReadHandle: async () => ({
        async read(buffer: Uint8Array, offset: number, length: number, position: number) {
          if (verificationComplete) throw readError;
          if (position >= content.byteLength) {
            verificationComplete = true;
            return { bytesRead: 0 };
          }
          const bytesRead = Math.min(length, content.byteLength - position);
          buffer.set(content.subarray(position, position + bytesRead), offset);
          return { bytesRead };
        },
        async close() {
          closeCalls += 1;
          throw closeError;
        },
      }),
    } as never);
    await store.open();

    const iterator = store.read(digest(content))[Symbol.asyncIterator]();
    await assert.rejects(iterator.next(), (error: unknown) => error === readError);
    assert.equal(closeCalls, 1);
    await store.close();
  });

  await context.test("close error surfaces when reading otherwise succeeds", async () => {
    const rootDirectory = await temporaryDirectory("close-only-error");
    const content = Buffer.from("verified");
    const closeError = new Error("stream handle close failed");
    let pass = 0;
    let closeCalls = 0;
    const store = new FilesystemArtifactStore({
      rootDirectory,
      openReadHandle: async () => ({
        async read(buffer: Uint8Array, offset: number, length: number, position: number) {
          if (position >= content.byteLength) {
            pass += 1;
            return { bytesRead: 0 };
          }
          const bytesRead = Math.min(length, content.byteLength - position);
          buffer.set(content.subarray(position, position + bytesRead), offset);
          return { bytesRead };
        },
        async close() {
          closeCalls += 1;
          throw closeError;
        },
      }),
    } as never);
    await store.open();

    const iterator = store.read(digest(content))[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal(pass, 1);
    await assert.rejects(iterator.next(), (error: unknown) => error === closeError);
    assert.equal(closeCalls, 1);
    await store.close();
  });
});

test("artifact verification uses a bounded reusable buffer and streams bounded chunks", async () => {
  const size = 8 * 1024 * 1024;
  const content = Buffer.alloc(size, 0x61);
  let largestRead = 0;
  const reader = {
    async read(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
      largestRead = Math.max(largestRead, buffer.byteLength, length);
      const bytesRead = Math.min(length, size - position);
      if (bytesRead > 0) buffer.fill(0x61, offset, offset + bytesRead);
      return { buffer, bytesRead };
    },
  };
  assert.equal(await hashArtifactHandle(reader), digest(content));
  assert.ok(largestRead <= 64 * 1024);

  const rootDirectory = await temporaryDirectory("bounded-read");
  const store = new FilesystemArtifactStore({ rootDirectory });
  await store.open();
  const expected = digest(content);
  await store.put(expected, bytesSource(content));
  let total = 0;
  for await (const chunk of store.read(expected)) {
    assert.ok(chunk.byteLength <= 64 * 1024);
    total += chunk.byteLength;
  }
  assert.equal(total, size);
  await store.close();
});

test("artifact publish cannot accept bytes mutated during an asynchronous write", async () => {
  const rootDirectory = await temporaryDirectory("mutable-source");
  const store = new FilesystemArtifactStore({ rootDirectory });
  await store.open();
  const mutableChunk = Buffer.alloc(64 * 1024 * 1024, 0x61);
  const expected = digest(mutableChunk);
  const mutationFinished = Promise.withResolvers<void>();

  async function* source(): AsyncIterable<Uint8Array> {
    setImmediate(() => {
      mutableChunk.fill(0x62);
      mutationFinished.resolve();
    });
    yield mutableChunk;
  }

  await store.put(expected, source());
  await mutationFinished.promise;
  assert.equal(digest(await readFile(store.pathFor(expected))), expected);
  await store.close();
});

test("Windows publish collision handling preserves a completed target deterministically", async () => {
  const calls: string[] = [];
  await publishTempFileAtomically({
    platform: "win32",
    temporaryPath: "artifact.tmp",
    targetPath: "artifact.tego",
    rename: async () => {
      calls.push("rename");
      const error = new Error("target is busy") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    },
    targetMatches: async () => {
      calls.push("verify-target");
      return true;
    },
    removeTemporary: async () => {
      calls.push("remove-temporary");
    },
  });
  assert.deepEqual(calls, ["rename", "verify-target", "remove-temporary"]);
});

test("POSIX publish errors other than a target collision are not hidden", async () => {
  const error = new Error("permission denied") as NodeJS.ErrnoException;
  error.code = "EPERM";
  await assert.rejects(
    publishTempFileAtomically({
      platform: "darwin",
      temporaryPath: "artifact.tmp",
      targetPath: "artifact.tego",
      rename: async () => {
        throw error;
      },
      targetMatches: async () => true,
      removeTemporary: async () => {
        assert.fail("temporary file cleanup belongs to the caller on hard failure");
      },
    }),
    (actual: unknown) => actual === error,
  );
});

test("every artifact publication durably syncs both the shard and its parent", () => {
  assert.deepEqual(
    artifactPublishSyncDirectories({
      artifactDirectory: "/data/artifacts",
      shardDirectory: "/data/artifacts/ab",
      shardCreated: true,
    }),
    ["/data/artifacts/ab", "/data/artifacts"],
  );
  assert.deepEqual(
    artifactPublishSyncDirectories({
      artifactDirectory: "/data/artifacts",
      shardDirectory: "/data/artifacts/ab",
      shardCreated: false,
    }),
    ["/data/artifacts/ab", "/data/artifacts"],
  );
});

test("a concurrent same-shard writer cannot acknowledge before the parent is durable", async () => {
  const artifactDirectory = "/data/artifacts";
  const shardDirectory = "/data/artifacts/ab";
  const firstParentSyncStarted = Promise.withResolvers<void>();
  const releaseFirstParentSync = Promise.withResolvers<void>();
  const completedSyncs: string[] = [];

  async function executePlan(writer: string, shardCreated: boolean): Promise<void> {
    for (const directory of artifactPublishSyncDirectories({
      artifactDirectory,
      shardDirectory,
      shardCreated,
    })) {
      if (writer === "first" && directory === artifactDirectory) {
        firstParentSyncStarted.resolve();
        await releaseFirstParentSync.promise;
      }
      completedSyncs.push(`${writer}:${directory}`);
    }
  }

  const firstPublish = executePlan("first", true);
  await firstParentSyncStarted.promise;
  await executePlan("second", false);
  const secondSyncedParent = completedSyncs.includes(`second:${artifactDirectory}`);
  releaseFirstParentSync.resolve();
  await firstPublish;

  assert.equal(secondSyncedParent, true);
});

test("retry after a transient parent fsync failure still syncs the parent", async () => {
  const artifactDirectory = "/data/artifacts";
  const shardDirectory = "/data/artifacts/ab";
  let failParentSync = true;

  async function executePlan(shardCreated: boolean): Promise<readonly string[]> {
    const completed: string[] = [];
    for (const directory of artifactPublishSyncDirectories({
      artifactDirectory,
      shardDirectory,
      shardCreated,
    })) {
      if (directory === artifactDirectory && failParentSync) {
        failParentSync = false;
        throw new Error("transient parent fsync failure");
      }
      completed.push(directory);
    }
    return completed;
  }

  await assert.rejects(executePlan(true), /transient parent fsync failure/u);
  assert.deepEqual(await executePlan(false), [shardDirectory, artifactDirectory]);
});

test("createLocalDrivers composes durable state, local authority, and filesystem artifacts", async () => {
  const dataDirectory = await temporaryDirectory("factory");
  const clock = new FakeClock(new Date("2026-07-23T12:00:00.000Z"));
  const drivers = await createLocalDrivers({ dataDirectory, clock });

  assert.equal(drivers.clock, clock);
  assert.ok(drivers.state instanceof Object);
  assert.ok(drivers.coordination instanceof LocalCoordinationProvider);
  assert.ok(drivers.artifacts instanceof FilesystemArtifactStore);

  await drivers.state.open();
  await drivers.coordination.open();
  await drivers.artifacts.open();
  assert.deepEqual(await drivers.state.health(), {
    status: "healthy",
    checkedAt: "2026-07-23T12:00:00.000Z",
  });
  assert.deepEqual(await drivers.coordination.health(), {
    status: "healthy",
    checkedAt: "2026-07-23T12:00:00.000Z",
  });
  assert.deepEqual(await drivers.artifacts.health(), {
    status: "healthy",
    checkedAt: "2026-07-23T12:00:00.000Z",
  });

  await drivers.artifacts.close();
  await drivers.coordination.close();
  await drivers.state.close();
});

test("close racing with open cannot resurrect filesystem artifact access", async () => {
  const rootDirectory = await temporaryDirectory("artifact-open-close-race");
  const store = new FilesystemArtifactStore({ rootDirectory });

  const opening = store.open();
  const closing = store.close();
  await Promise.allSettled([opening, closing]);

  await assert.rejects(
    store.health(),
    (error: unknown) => diagnosticCode(error) === "ARTIFACT_CLOSED",
  );
});
