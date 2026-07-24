import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  DiagnosticError,
  runtimeDiagnostic,
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

interface CacheEntry {
  readonly artifact: PreparedArtifact;
  references: number;
}

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

function digestPath(digest: ArtifactDigest): string {
  return digest.slice("sha256:".length);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
  } finally {
    await handle.close();
  }
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function directoryFiles(root: string, relative = ""): Promise<readonly string[]> {
  const directory = relative.length === 0 ? root : join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    const identity = await lstat(join(root, path));
    if (identity.isSymbolicLink() || (!identity.isDirectory() && !identity.isFile())) {
      throw cacheError(
        "ARTIFACT_CACHE_CONFLICT",
        "Prepared artifact cache contains an unsupported filesystem entry",
        { path },
      );
    }
    if (identity.isDirectory()) files.push(...(await directoryFiles(root, path)));
    else files.push(path);
  }
  return files;
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  const [leftFiles, rightFiles] = await Promise.all([directoryFiles(left), directoryFiles(right)]);
  if (
    leftFiles.length !== rightFiles.length ||
    leftFiles.some((path, index) => path !== rightFiles[index])
  ) {
    return false;
  }
  for (const path of leftFiles) {
    const [leftStat, rightStat] = await Promise.all([
      stat(join(left, path)),
      stat(join(right, path)),
    ]);
    if (
      leftStat.size !== rightStat.size ||
      (await fileDigest(join(left, path))) !== (await fileDigest(join(right, path)))
    ) {
      return false;
    }
  }
  return true;
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

function freezeManifest<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    freezeManifest(nested);
  }
  return Object.freeze(value);
}

export class PreparedArtifactCache {
  readonly #artifacts: ArtifactStore;
  readonly #root: string;
  readonly #limits: ArtifactReadLimits;
  readonly #entries = new Map<ArtifactDigest, CacheEntry>();
  readonly #preparing = new Map<ArtifactDigest, Promise<PreparedArtifact>>();
  #closed = false;

  constructor(options: PreparedArtifactCacheOptions) {
    this.#artifacts = options.artifacts;
    this.#root = resolve(options.root);
    this.#limits = options.limits ?? {};
  }

  async prepare(request: ValidateArtifactRequest): Promise<PreparedArtifact> {
    if (this.#closed) {
      throw cacheError("ARTIFACT_CACHE_CLOSED", "Prepared artifact cache is closed");
    }
    const existing = this.#entries.get(request.digest);
    if (existing !== undefined) {
      existing.references += 1;
      return existing.artifact;
    }

    let preparing = this.#preparing.get(request.digest);
    if (preparing === undefined) {
      preparing = this.#prepare(request).then((artifact) => {
        this.#entries.set(request.digest, { artifact, references: 0 });
        return artifact;
      });
      this.#preparing.set(request.digest, preparing);
      void preparing.finally(() => this.#preparing.delete(request.digest)).catch(() => undefined);
    }
    const artifact = await preparing;
    const entry = this.#entries.get(request.digest);
    if (entry === undefined) {
      throw cacheError("ARTIFACT_CACHE_CORRUPT", "Prepared artifact reference was not registered");
    }
    entry.references += 1;
    return artifact;
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(this.#preparing.values());
    this.#entries.clear();
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
    const target = join(canonicalRoot, digestPath(request.digest));
    try {
      const parsed = await readPluginArtifact(this.#artifacts.read(request.digest), this.#limits, {
        open: async ({ path }) => {
          const destination = resolve(temporary, ...path.split("/"));
          if (!destination.startsWith(`${temporary}${sep}`)) {
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
      await syncDirectory(temporary);
      try {
        await rename(temporary, target);
        await syncDirectory(canonicalRoot);
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        if (!(await sameDirectory(temporary, target))) {
          throw cacheError(
            "ARTIFACT_CACHE_CONFLICT",
            "Prepared artifact target contains different content",
            { digest: request.digest },
          );
        }
        await rm(temporary, { force: true, recursive: true });
      }
      return Object.freeze({
        digest: request.digest,
        root: target,
        manifest: freezeManifest(parsed.manifest),
      });
    } catch (error) {
      await rm(temporary, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }
}
