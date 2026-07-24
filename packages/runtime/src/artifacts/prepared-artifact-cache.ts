import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  DiagnosticError,
  runtimeDiagnostic,
  serializeCause,
  type ArtifactDigest,
  type ArtifactStore,
  type JsonObject,
  type PluginManifest,
} from "@tegojs/contracts";
import type { ValidateArtifactRequest } from "./artifact-service.js";
import {
  readPluginArtifact,
  type ArtifactEntryWriter,
  type ArtifactReadLimits,
} from "./manifest-reader.js";

export interface PreparedArtifact {
  readonly digest: ArtifactDigest;
  readonly root: string;
  readonly manifest: PluginManifest;
}

export interface PreparedArtifactCacheOptions {
  readonly artifacts: ArtifactStore;
  readonly root: string;
  readonly limits?: ArtifactReadLimits;
}

interface FileSnapshot {
  readonly path: string;
  readonly type: "file";
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly sha256: string;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly type: "directory";
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

type TreeSnapshotEntry = DirectorySnapshot | FileSnapshot;
type TreeSnapshot = readonly TreeSnapshotEntry[];

interface CacheEntry {
  readonly artifact: PreparedArtifact;
  readonly snapshot: TreeSnapshot;
  references: number;
}

type CacheState = "closed" | "closing" | "open";

function cacheError(code: `ARTIFACT_${string}`, message: string, details?: JsonObject) {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "artifact", id: "prepared-cache" },
      ...(details === undefined ? {} : { details }),
    }),
  );
}

function cleanupError(primary: unknown, cleanup: readonly unknown[]): DiagnosticError {
  return cacheError(
    "ARTIFACT_PREPARATION_CLEANUP_FAILED",
    "Artifact preparation failed and cleanup did not complete",
    {
      primary: serializeCause(primary),
      cleanup: cleanup.map((error) => serializeCause(error)),
    },
  );
}

function digestPath(digest: ArtifactDigest): string {
  return digest.slice("sha256:".length);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function freezeManifest<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    freezeManifest(nested);
  }
  return Object.freeze(value);
}

function compareSnapshot(
  actual: TreeSnapshot,
  expected: TreeSnapshot,
  includeIdentity: boolean,
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((entry, index) => {
    const other = expected[index];
    if (
      other === undefined ||
      entry.path !== other.path ||
      entry.type !== other.type ||
      (includeIdentity && entry.mode !== other.mode) ||
      (includeIdentity && (entry.dev !== other.dev || entry.ino !== other.ino))
    ) {
      return false;
    }
    return (
      entry.type === "directory" ||
      (other.type === "file" && entry.size === other.size && entry.sha256 === other.sha256)
    );
  });
}

function isReadOnlySnapshot(snapshot: TreeSnapshot): boolean {
  return snapshot.every((entry) => (entry.mode & 0o222) === 0);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } catch (error) {
    if (errorCode(error) !== "EINVAL" && errorCode(error) !== "ENOTSUP") throw error;
  } finally {
    await handle.close();
  }
}

async function snapshotFile(path: string, relative: string): Promise<FileSnapshot> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw cacheError(
      "ARTIFACT_CACHE_CONFLICT",
      "Prepared artifact file cannot be opened without following links",
      { path: relative, cause: serializeCause(error) },
    );
  }
  try {
    const identity = await handle.stat();
    if (!identity.isFile()) {
      throw cacheError("ARTIFACT_CACHE_CONFLICT", "Prepared artifact contains a non-file entry", {
        path: relative,
      });
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return {
      path: relative,
      type: "file",
      dev: identity.dev,
      ino: identity.ino,
      mode: identity.mode & 0o777,
      size: identity.size,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function snapshotDirectory(
  root: string,
  relative = "",
  expectedIdentity?: Pick<DirectorySnapshot, "dev" | "ino">,
): Promise<TreeSnapshotEntry[]> {
  const path = relative.length === 0 ? root : join(root, relative);
  const pathIdentity = await lstat(path);
  if (pathIdentity.isSymbolicLink() || !pathIdentity.isDirectory()) {
    throw cacheError("ARTIFACT_CACHE_CONFLICT", "Prepared artifact directory identity is invalid", {
      path: relative,
    });
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
  );
  let identity: Awaited<ReturnType<typeof lstat>>;
  try {
    identity = await handle.stat();
  } finally {
    await handle.close();
  }
  if (
    !identity.isDirectory() ||
    identity.dev !== pathIdentity.dev ||
    identity.ino !== pathIdentity.ino ||
    (expectedIdentity !== undefined &&
      (identity.dev !== expectedIdentity.dev || identity.ino !== expectedIdentity.ino))
  ) {
    throw cacheError(
      "ARTIFACT_CACHE_CONFLICT",
      "Prepared artifact directory changed while it was being verified",
      { path: relative },
    );
  }
  const records: TreeSnapshotEntry[] = [
    {
      path: relative,
      type: "directory",
      dev: identity.dev,
      ino: identity.ino,
      mode: identity.mode & 0o777,
    },
  ];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    const childPath = join(root, child);
    if (entry.isDirectory()) {
      const childIdentity = await lstat(childPath);
      records.push(
        ...(await snapshotDirectory(root, child, {
          dev: childIdentity.dev,
          ino: childIdentity.ino,
        })),
      );
    } else {
      records.push(await snapshotFile(childPath, child));
    }
  }
  return records.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

async function syncNestedDirectories(root: string, snapshot: TreeSnapshot): Promise<void> {
  const directories = snapshot
    .filter((entry): entry is DirectorySnapshot => entry.type === "directory")
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  for (const directory of directories) {
    await syncDirectory(directory.path.length === 0 ? root : join(root, directory.path));
  }
}

async function makeTreeReadOnly(root: string, snapshot: TreeSnapshot): Promise<void> {
  const files = snapshot.filter((entry): entry is FileSnapshot => entry.type === "file");
  const directories = snapshot
    .filter((entry): entry is DirectorySnapshot => entry.type === "directory")
    .filter((entry) => entry.path.length > 0)
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  for (const file of files) await chmod(join(root, file.path), 0o444);
  for (const directory of directories) {
    await chmod(directory.path.length === 0 ? root : join(root, directory.path), 0o555);
  }
}

async function makeTreeRemovable(root: string): Promise<void> {
  let identity: Awaited<ReturnType<typeof lstat>>;
  try {
    identity = await lstat(root);
  } catch {
    return;
  }
  if (identity.isSymbolicLink() || !identity.isDirectory()) return;
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeTreeRemovable(join(root, entry.name));
  }
}

async function removeTree(root: string): Promise<void> {
  await makeTreeRemovable(root);
  await rm(root, { force: true, recursive: true });
}

class ExclusiveFileWriter implements ArtifactEntryWriter {
  readonly #handle;
  #closed = false;
  #position = 0;

  private constructor(handle: Awaited<ReturnType<typeof open>>) {
    this.#handle = handle;
  }

  static async create(path: string): Promise<ExclusiveFileWriter> {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    return new ExclusiveFileWriter(await open(path, "wx", 0o600));
  }

  async write(chunk: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.#handle.write(
        chunk,
        offset,
        chunk.byteLength - offset,
        this.#position,
      );
      if (bytesWritten <= 0) throw new Error("artifact extraction made no write progress");
      offset += bytesWritten;
      this.#position += bytesWritten;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#handle.sync();
    } finally {
      this.#closed = true;
      await this.#handle.close();
    }
  }

  async abort(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }
}

export class PreparedArtifactCache {
  readonly #artifacts: ArtifactStore;
  readonly #root: string;
  readonly #limits: ArtifactReadLimits;
  readonly #entries = new Map<ArtifactDigest, CacheEntry>();
  readonly #preparing = new Map<ArtifactDigest, Promise<PreparedArtifact>>();
  readonly #acquisitions = new Set<Promise<PreparedArtifact>>();
  #state: CacheState = "open";
  #closePromise: Promise<void> | undefined;

  constructor(options: PreparedArtifactCacheOptions) {
    this.#artifacts = options.artifacts;
    this.#root = resolve(options.root);
    this.#limits = options.limits ?? {};
  }

  prepare(request: ValidateArtifactRequest): Promise<PreparedArtifact> {
    if (this.#state !== "open") {
      return Promise.reject(
        cacheError("ARTIFACT_CACHE_CLOSED", "Prepared artifact cache is closed"),
      );
    }
    const acquisition = this.#acquire(request);
    this.#acquisitions.add(acquisition);
    void acquisition.finally(() => this.#acquisitions.delete(acquisition)).catch(() => undefined);
    return acquisition;
  }

  async release(digest: ArtifactDigest): Promise<void> {
    const entry = this.#entries.get(digest);
    if (entry === undefined || entry.references === 0) {
      throw cacheError(
        "ARTIFACT_REFERENCE_INVALID",
        "Prepared artifact has no acquired reference",
        { digest },
      );
    }
    entry.references -= 1;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = "closing";
    const preparations = [...this.#preparing.values()];
    const acquisitions = [...this.#acquisitions];
    this.#closePromise = (async () => {
      await Promise.allSettled(preparations);
      await Promise.allSettled(acquisitions);
      this.#state = "closed";
    })();
    return this.#closePromise;
  }

  async #acquire(request: ValidateArtifactRequest): Promise<PreparedArtifact> {
    const existing = this.#entries.get(request.digest);
    if (existing !== undefined) {
      await this.#assertSnapshot(existing);
      this.#assertOpen();
      existing.references += 1;
      return existing.artifact;
    }

    let preparing = this.#preparing.get(request.digest);
    if (preparing === undefined) {
      preparing = this.#prepare(request);
      this.#preparing.set(request.digest, preparing);
      void preparing.finally(() => this.#preparing.delete(request.digest)).catch(() => undefined);
    }
    const artifact = await preparing;
    this.#assertOpen();
    const entry = this.#entries.get(request.digest);
    if (entry === undefined) {
      throw cacheError("ARTIFACT_CACHE_CORRUPT", "Prepared artifact reference was not registered");
    }
    entry.references += 1;
    return artifact;
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw cacheError(
        "ARTIFACT_CACHE_CLOSED",
        "Prepared artifact cache closed before reference acquisition completed",
      );
    }
  }

  async #assertSnapshot(entry: CacheEntry): Promise<void> {
    let actual: TreeSnapshot;
    try {
      actual = await snapshotDirectory(entry.artifact.root);
    } catch (error) {
      if (error instanceof DiagnosticError) throw error;
      throw cacheError(
        "ARTIFACT_CACHE_CONFLICT",
        "Prepared artifact cache could not be revalidated",
        { digest: entry.artifact.digest, cause: serializeCause(error) },
      );
    }
    if (!compareSnapshot(actual, entry.snapshot, true)) {
      throw cacheError(
        "ARTIFACT_CACHE_CONFLICT",
        "Prepared artifact cache changed after publication",
        { digest: entry.artifact.digest },
      );
    }
  }

  async #prepare(request: ValidateArtifactRequest): Promise<PreparedArtifact> {
    await mkdir(this.#root, { mode: 0o700, recursive: true });
    const canonicalRoot = await realpath(this.#root);
    const rootIdentity = await lstat(this.#root);
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) {
      throw cacheError(
        "ARTIFACT_CACHE_ROOT_INVALID",
        "Prepared artifact cache root must be a non-symlink directory",
      );
    }
    const temporary = await mkdtemp(join(canonicalRoot, ".tmp-"));
    const staging = join(temporary, "artifact");
    await mkdir(staging, { mode: 0o700 });
    const target = join(canonicalRoot, digestPath(request.digest));
    let primary: unknown;
    let failed = false;
    let result: PreparedArtifact | undefined;
    const cleanupFailures: unknown[] = [];
    try {
      const parsed = await readPluginArtifact(this.#artifacts.read(request.digest), this.#limits, {
        open: async ({ path }) => {
          const destination = resolve(staging, ...path.split("/"));
          if (!destination.startsWith(`${staging}${sep}`)) {
            throw cacheError("ARTIFACT_PATH_UNSAFE", "Artifact entry escapes preparation root", {
              path,
            });
          }
          return await ExclusiveFileWriter.create(destination);
        },
      });
      if (parsed.archiveDigest !== request.digest) {
        throw cacheError(
          "ARTIFACT_DIGEST_MISMATCH",
          "ArtifactStore bytes do not match the requested digest",
          { actual: parsed.archiveDigest, expected: request.digest },
        );
      }

      const writableSnapshot = await snapshotDirectory(staging);
      await syncNestedDirectories(staging, writableSnapshot);
      await makeTreeReadOnly(staging, writableSnapshot);
      const preparedSnapshot = await snapshotDirectory(staging);
      await syncNestedDirectories(staging, preparedSnapshot);
      await syncDirectory(temporary);

      let targetExists = true;
      try {
        await lstat(target);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        targetExists = false;
      }

      let publishedSnapshot: TreeSnapshot;
      if (targetExists) {
        const existingSnapshot = await snapshotDirectory(target);
        if (
          !isReadOnlySnapshot(existingSnapshot) ||
          !compareSnapshot(existingSnapshot, preparedSnapshot, false)
        ) {
          throw cacheError(
            "ARTIFACT_CACHE_CONFLICT",
            "Prepared artifact target contains different content",
            { digest: request.digest },
          );
        }
        publishedSnapshot = existingSnapshot;
      } else {
        try {
          await rename(staging, target);
          await chmod(target, 0o555);
          await syncDirectory(canonicalRoot);
          publishedSnapshot = await snapshotDirectory(target);
          await syncNestedDirectories(target, publishedSnapshot);
        } catch (error) {
          if (
            errorCode(error) !== "EEXIST" &&
            errorCode(error) !== "ENOTEMPTY" &&
            errorCode(error) !== "EACCES"
          ) {
            throw error;
          }
          let existingSnapshot: TreeSnapshot;
          try {
            existingSnapshot = await snapshotDirectory(target);
          } catch {
            throw error;
          }
          if (
            !isReadOnlySnapshot(existingSnapshot) ||
            !compareSnapshot(existingSnapshot, preparedSnapshot, false)
          ) {
            throw cacheError(
              "ARTIFACT_CACHE_CONFLICT",
              "Prepared artifact target contains different content",
              { digest: request.digest },
            );
          }
          publishedSnapshot = existingSnapshot;
        }
      }

      const artifact = Object.freeze({
        digest: request.digest,
        root: target,
        manifest: freezeManifest(parsed.manifest),
      });
      this.#entries.set(request.digest, {
        artifact,
        snapshot: publishedSnapshot,
        references: 0,
      });
      result = artifact;
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      try {
        await removeTree(temporary);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0) {
      throw cleanupError(primary, cleanupFailures);
    }
    if (failed) {
      throw primary;
    }
    if (result === undefined) {
      throw cacheError(
        "ARTIFACT_CACHE_PREPARATION_FAILED",
        "Prepared artifact cache did not produce an artifact",
        { digest: request.digest },
      );
    }
    return result;
  }
}
