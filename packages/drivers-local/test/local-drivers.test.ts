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
  createLocalDrivers,
  FilesystemArtifactStore,
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
