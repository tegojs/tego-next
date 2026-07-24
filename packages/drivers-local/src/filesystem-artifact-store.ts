import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DiagnosticError,
  parseArtifactDigest,
  runtimeDiagnostic,
  type ArtifactDigest,
  type ArtifactStore,
  type Clock,
  type DriverHealth,
  type JsonValue,
} from "@tegojs/contracts";

const systemClock: Clock = {
  now: () => new Date(),
  sleep: async (delayMs, signal) => {
    await delay(delayMs, undefined, signal === undefined ? undefined : { signal });
  },
};

export interface FilesystemArtifactStoreOptions {
  readonly rootDirectory: string;
  readonly clock?: Clock;
  readonly openReadHandle?: (path: string) => Promise<ArtifactReadHandle>;
  readonly platform?: NodeJS.Platform;
}

export interface AtomicPublishOptions {
  readonly platform: NodeJS.Platform;
  readonly temporaryPath: string;
  readonly targetPath: string;
  readonly rename: (temporaryPath: string, targetPath: string) => Promise<void>;
  readonly targetMatches: () => Promise<boolean>;
  readonly removeTemporary: () => Promise<void>;
}

export interface ArtifactPublishSyncDirectoriesOptions {
  readonly artifactDirectory: string;
  readonly shardDirectory: string;
  readonly shardCreated: boolean;
}

export function artifactPublishSyncDirectories(
  options: ArtifactPublishSyncDirectoriesOptions,
): readonly string[] {
  return [options.shardDirectory, options.artifactDirectory];
}

function publishCollision(error: unknown, platform: NodeJS.Platform): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return platform === "win32"
    ? code === "EACCES" || code === "EEXIST" || code === "EPERM"
    : code === "EEXIST" || code === "ENOTEMPTY";
}

export async function publishTempFileAtomically(options: AtomicPublishOptions): Promise<void> {
  try {
    await options.rename(options.temporaryPath, options.targetPath);
  } catch (error) {
    if (!publishCollision(error, options.platform) || !(await options.targetMatches())) {
      throw error;
    }
    await options.removeTemporary();
  }
}

function digestHex(digest: ArtifactDigest): string {
  return digest.slice("sha256:".length);
}

async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function removeIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      throw error;
    }
  }
}

async function writeChunk(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten === 0) {
      throw new Error("Artifact temporary file write made no progress");
    }
    offset += bytesWritten;
  }
}

export interface ArtifactRandomAccessReader {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
}

export interface ArtifactReadHandle extends ArtifactRandomAccessReader {
  close(): Promise<void>;
}

const ARTIFACT_READ_CHUNK_BYTES = 64 * 1024;

export async function hashArtifactHandle(
  reader: ArtifactRandomAccessReader,
  chunkBytes = ARTIFACT_READ_CHUNK_BYTES,
): Promise<ArtifactDigest> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError("chunkBytes must be a positive safe integer");
  }
  const buffer = Buffer.allocUnsafe(chunkBytes);
  const hash = createHash("sha256");
  let position = 0;
  while (true) {
    const { bytesRead } = await reader.read(buffer, 0, buffer.byteLength, position);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) {
      throw new Error("Artifact file read returned an invalid byte count");
    }
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return parseArtifactDigest(`sha256:${hash.digest("hex")}`);
}

export class FilesystemArtifactStore implements ArtifactStore {
  readonly scope = "local" as const;
  readonly #rootDirectory: string;
  readonly #artifactDirectory: string;
  readonly #clock: Clock;
  readonly #openReadHandle: (path: string) => Promise<ArtifactReadHandle>;
  readonly #platform: NodeJS.Platform;
  readonly #operations = new Set<Promise<unknown>>();
  readonly #readHandles = new Set<ArtifactReadHandle>();
  #openPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #lifecycle: "closed" | "closing" | "created" | "open" | "opening" = "created";

  constructor(options: FilesystemArtifactStoreOptions) {
    this.#rootDirectory = options.rootDirectory;
    this.#artifactDirectory = join(options.rootDirectory, "artifacts");
    this.#clock = options.clock ?? systemClock;
    this.#openReadHandle = options.openReadHandle ?? ((path) => open(path, "r"));
    this.#platform = options.platform ?? process.platform;
  }

  open(): Promise<void> {
    if (this.#lifecycle === "closed" || this.#lifecycle === "closing") {
      return Promise.reject(this.#closedError());
    }
    if (this.#lifecycle === "open") {
      return Promise.resolve();
    }
    if (this.#lifecycle === "opening") {
      return this.#openPromise ?? Promise.reject(this.#closedError());
    }
    this.#lifecycle = "opening";
    const opening = this.#openArtifactDirectory();
    this.#openPromise = opening;
    const clearOpening = () => {
      if (this.#openPromise === opening) this.#openPromise = undefined;
    };
    void opening.then(clearOpening, clearOpening);
    return opening;
  }

  async #openArtifactDirectory(): Promise<void> {
    try {
      const created = await mkdir(this.#artifactDirectory, { recursive: true });
      if (created !== undefined) {
        await this.#syncDirectory(this.#rootDirectory);
      }
      if (this.#lifecycle !== "opening") {
        throw this.#closedError();
      }
      this.#lifecycle = "open";
    } catch (error) {
      if (this.#lifecycle === "opening") {
        this.#lifecycle = "created";
      }
      throw error;
    }
  }

  pathFor(digest: ArtifactDigest): string {
    const parsed = parseArtifactDigest(digest);
    const hexadecimal = digestHex(parsed);
    return join(this.#artifactDirectory, hexadecimal.slice(0, 2), `${hexadecimal}.tego`);
  }

  async put(digest: ArtifactDigest, source: AsyncIterable<Uint8Array>): Promise<void> {
    this.#assertOpen();
    const operation = this.#put(parseArtifactDigest(digest), source);
    return this.#track(operation);
  }

  async *read(digest: ArtifactDigest): AsyncIterable<Uint8Array> {
    this.#assertOpen();
    const parsed = parseArtifactDigest(digest);
    const operation = this.#openVerified(parsed);
    this.#operations.add(operation);
    let handle: ArtifactReadHandle | undefined;
    try {
      handle = await operation;
    } finally {
      this.#operations.delete(operation);
    }
    try {
      try {
        const buffer = Buffer.allocUnsafe(ARTIFACT_READ_CHUNK_BYTES);
        let position = 0;
        while (true) {
          if (this.#lifecycle !== "open") return;
          let bytesRead: number;
          try {
            ({ bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position));
          } catch (error) {
            if (this.#lifecycle !== "open") return;
            throw error;
          }
          if (bytesRead === 0) break;
          if (this.#lifecycle !== "open") return;
          position += bytesRead;
          yield Buffer.from(buffer.subarray(0, bytesRead));
        }
      } catch (error) {
        if (handle !== undefined) {
          this.#readHandles.delete(handle);
          try {
            await handle.close();
          } catch {}
          handle = undefined;
        }
        throw error;
      }
    } finally {
      if (handle !== undefined) this.#readHandles.delete(handle);
      await handle?.close();
    }
  }

  async health(): Promise<DriverHealth> {
    this.#assertOpen();
    await access(this.#artifactDirectory);
    return {
      status: "healthy",
      checkedAt: this.#clock.now().toISOString(),
    };
  }

  close(): Promise<void> {
    if (this.#lifecycle === "closed") {
      return Promise.resolve();
    }
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    const closing = this.#closeStore();
    this.#closePromise = closing;
    const clearClosing = () => {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    };
    void closing.then(clearClosing, clearClosing);
    return closing;
  }

  async #closeStore(): Promise<void> {
    this.#lifecycle = "closing";
    await this.#openPromise?.catch(() => undefined);
    await Promise.allSettled([...this.#operations]);
    await Promise.allSettled([...this.#readHandles].map((handle) => handle.close()));
    this.#readHandles.clear();
    this.#lifecycle = "closed";
  }

  async #put(digest: ArtifactDigest, source: AsyncIterable<Uint8Array>): Promise<void> {
    const targetPath = this.pathFor(digest);
    const targetDirectory = join(this.#artifactDirectory, digestHex(digest).slice(0, 2));
    const shardCreated = (await mkdir(targetDirectory, { recursive: true })) !== undefined;
    const temporaryPath = join(targetDirectory, `.${digestHex(digest)}.${randomUUID()}.temporary`);
    const hash = createHash("sha256");
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) {
          throw this.#artifactError(
            "ARTIFACT_SOURCE_INVALID",
            "Artifact source yielded a value that is not bytes",
            { valueType: typeof chunk },
          );
        }
        const stableChunk = Buffer.from(chunk);
        hash.update(stableChunk);
        await writeChunk(handle, stableChunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;

      const actual = parseArtifactDigest(`sha256:${hash.digest("hex")}`);
      if (actual !== digest) {
        throw this.#digestMismatch(digest, actual);
      }

      await publishTempFileAtomically({
        platform: this.#platform,
        temporaryPath,
        targetPath,
        rename,
        targetMatches: async () => this.#fileMatches(targetPath, digest),
        removeTemporary: async () => removeIfPresent(temporaryPath),
      });
      for (const directory of artifactPublishSyncDirectories({
        artifactDirectory: this.#artifactDirectory,
        shardDirectory: targetDirectory,
        shardCreated,
      })) {
        await this.#syncDirectory(directory);
      }
    } finally {
      await handle?.close();
      await removeIfPresent(temporaryPath);
      await removeIfEmpty(targetDirectory);
    }
  }

  async #openVerified(digest: ArtifactDigest): Promise<ArtifactReadHandle> {
    const handle = await this.#openReadHandle(this.pathFor(digest));
    try {
      const actual = await hashArtifactHandle(handle);
      if (actual !== digest) {
        throw this.#digestMismatch(digest, actual);
      }
      this.#readHandles.add(handle);
      return handle;
    } catch (error) {
      try {
        await handle.close();
      } catch {}
      throw error;
    }
  }

  async #fileMatches(path: string, digest: ArtifactDigest): Promise<boolean> {
    try {
      const bytes = await readFile(path);
      return `sha256:${createHash("sha256").update(bytes).digest("hex")}` === digest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async #syncDirectory(directory: string): Promise<void> {
    if (this.#platform === "win32") {
      return;
    }
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #track<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    try {
      return await operation;
    } finally {
      this.#operations.delete(operation);
    }
  }

  #assertOpen(): void {
    if (this.#lifecycle !== "open") {
      throw this.#closedError();
    }
  }

  #digestMismatch(expected: ArtifactDigest, actual: ArtifactDigest): DiagnosticError {
    return this.#artifactError(
      "ARTIFACT_DIGEST_MISMATCH",
      "Artifact bytes do not match the expected digest",
      { expected, actual },
    );
  }

  #artifactError(code: `ARTIFACT_${string}`, message: string, details: JsonValue): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code,
        message,
        source: { kind: "artifact", id: "filesystem-artifact-store" },
        details,
        observedAt: this.#clock.now().toISOString(),
      }),
    );
  }

  #closedError(): DiagnosticError {
    return this.#artifactError("ARTIFACT_CLOSED", "Filesystem artifact store is closed", {
      lifecycle: this.#lifecycle,
      rootDirectory: this.#rootDirectory,
    });
  }
}
