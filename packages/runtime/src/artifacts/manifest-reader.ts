import { createHash } from "node:crypto";
import {
  DiagnosticError,
  parseArtifactDigest,
  parsePluginManifest,
  runtimeDiagnostic,
  type ArtifactDigest,
  type JsonObject,
  type PluginManifest,
} from "@tegojs/contracts";
import { assertPortableArtifactPath } from "./archive-codec.js";

const TAR_BLOCK_SIZE = 512;
const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1_024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ArtifactReadLimits {
  readonly maxArchiveBytes?: number;
  readonly maxEntries?: number;
  readonly maxEntryBytes?: number;
}

export interface ArtifactFileRecord extends JsonObject {
  readonly path: string;
  readonly sha256: ArtifactDigest;
  readonly size: number;
}

export interface ArtifactFilesMetadata extends JsonObject {
  readonly schemaVersion: "1.0";
  readonly files: readonly ArtifactFileRecord[];
}

export interface ReadPluginArtifact {
  readonly manifest: PluginManifest;
  readonly files: ArtifactFilesMetadata;
}

function artifactError(code: `ARTIFACT_${string}`, message: string, details?: JsonObject) {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "artifact", id: "archive" },
      ...(details === undefined ? {} : { details }),
    }),
  );
}

function boundedPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return selected;
}

class BoundedStreamReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  readonly #maxBytes: number;
  #chunk: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #offset = 0;
  #ended = false;
  #consumed = 0;

  constructor(source: AsyncIterable<Uint8Array>, maxBytes: number) {
    this.#iterator = source[Symbol.asyncIterator]();
    this.#maxBytes = maxBytes;
  }

  async readExact(length: number, eofAllowed = false): Promise<Uint8Array | undefined> {
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (this.#offset === this.#chunk.byteLength) {
        if (this.#ended) {
          if (written === 0 && eofAllowed) return undefined;
          throw artifactError("ARTIFACT_ARCHIVE_TRUNCATED", "Plugin archive is truncated");
        }
        const next = await this.#iterator.next();
        if (next.done === true) {
          this.#ended = true;
          continue;
        }
        if (!(next.value instanceof Uint8Array)) {
          throw artifactError(
            "ARTIFACT_ARCHIVE_MALFORMED",
            "Plugin archive yielded a non-byte chunk",
          );
        }
        if (next.value.byteLength === 0) continue;
        this.#chunk = next.value;
        this.#offset = 0;
      }

      const count = Math.min(length - written, this.#chunk.byteLength - this.#offset);
      output.set(this.#chunk.subarray(this.#offset, this.#offset + count), written);
      this.#offset += count;
      written += count;
      this.#consumed += count;
      if (this.#consumed > this.#maxBytes) {
        throw artifactError(
          "ARTIFACT_ARCHIVE_TOO_LARGE",
          "Plugin archive exceeds the configured byte limit",
          { maxArchiveBytes: this.#maxBytes },
        );
      }
    }
    return output;
  }

  async assertZeroRemainder(): Promise<void> {
    while (true) {
      const block = await this.readExact(TAR_BLOCK_SIZE, true);
      if (block === undefined) return;
      if (!isZeroBlock(block)) {
        throw artifactError(
          "ARTIFACT_ARCHIVE_MALFORMED",
          "Plugin archive contains data after its end marker",
        );
      }
    }
  }
}

function isZeroBlock(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function decodeNullTerminated(bytes: Uint8Array, fieldName: string): string {
  const nullIndex = bytes.indexOf(0);
  const end = nullIndex < 0 ? bytes.byteLength : nullIndex;
  if (nullIndex >= 0 && bytes.subarray(nullIndex).some((byte) => byte !== 0)) {
    throw artifactError(
      "ARTIFACT_ARCHIVE_MALFORMED",
      `Tar ${fieldName} contains bytes after its terminator`,
    );
  }
  try {
    return decoder.decode(bytes.subarray(0, end));
  } catch {
    throw artifactError("ARTIFACT_ARCHIVE_MALFORMED", `Tar ${fieldName} is not valid UTF-8`);
  }
}

function parseOctal(bytes: Uint8Array, fieldName: string): number {
  const text = decodeNullTerminated(bytes, fieldName).trim();
  if (!/^[0-7]+$/u.test(text)) {
    throw artifactError(
      "ARTIFACT_ARCHIVE_MALFORMED",
      `Tar ${fieldName} is not a canonical octal number`,
    );
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw artifactError(
      "ARTIFACT_ARCHIVE_MALFORMED",
      `Tar ${fieldName} exceeds the safe integer range`,
    );
  }
  return value;
}

function readChecksum(header: Uint8Array): number {
  const text = String.fromCharCode(...header.subarray(148, 156))
    .replaceAll("\0", "")
    .trim();
  if (!/^[0-7]+$/u.test(text)) {
    throw artifactError(
      "ARTIFACT_ARCHIVE_MALFORMED",
      "Tar checksum is not a canonical octal number",
    );
  }
  return Number.parseInt(text, 8);
}

function validateChecksum(header: Uint8Array): void {
  const expected = readChecksum(header);
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) {
    throw artifactError("ARTIFACT_HEADER_CHECKSUM_INVALID", "Tar header checksum does not match", {
      actual,
      expected,
    });
  }
}

interface ParsedHeader {
  readonly path: string;
  readonly size: number;
}

function parseHeader(header: Uint8Array): ParsedHeader {
  validateChecksum(header);
  const type = header[156];
  if (type !== 0 && type !== "0".charCodeAt(0)) {
    throw artifactError(
      "ARTIFACT_ENTRY_TYPE_UNSUPPORTED",
      "Only regular file entries are supported",
      { type: String.fromCharCode(type ?? 0) },
    );
  }
  if (
    decodeNullTerminated(header.subarray(257, 263), "magic") !== "ustar" ||
    decodeNullTerminated(header.subarray(263, 265), "version") !== "00"
  ) {
    throw artifactError(
      "ARTIFACT_ARCHIVE_MALFORMED",
      "Plugin archive must use the POSIX ustar format",
    );
  }

  const name = decodeNullTerminated(header.subarray(0, 100), "name");
  const prefix = decodeNullTerminated(header.subarray(345, 500), "prefix");
  const path = prefix.length === 0 ? name : `${prefix}/${name}`;
  assertPortableArtifactPath(path);
  const size = parseOctal(header.subarray(124, 136), "size");
  return { path, size };
}

async function readEntry(
  reader: BoundedStreamReader,
  size: number,
  captureLimit: number | undefined,
): Promise<{ readonly bytes?: Uint8Array; readonly digest: ArtifactDigest }> {
  const capture = captureLimit === undefined ? undefined : new Uint8Array(size);
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < size) {
    const length = Math.min(64 * 1024, size - offset);
    const chunk = await reader.readExact(length);
    if (chunk === undefined) {
      throw artifactError("ARTIFACT_ARCHIVE_TRUNCATED", "Plugin archive is truncated");
    }
    hash.update(chunk);
    capture?.set(chunk, offset);
    offset += length;
  }
  const padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
  if (padding > 0) {
    const bytes = await reader.readExact(padding);
    if (bytes === undefined || !isZeroBlock(bytes)) {
      throw artifactError(
        "ARTIFACT_ARCHIVE_MALFORMED",
        "Tar entry padding must contain only zero bytes",
      );
    }
  }
  return {
    ...(capture === undefined ? {} : { bytes: capture }),
    digest: parseArtifactDigest(`sha256:${hash.digest("hex")}`),
  };
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw artifactError("ARTIFACT_METADATA_INVALID", `${path} is not valid JSON`, { path });
  }
}

function parseFilesMetadata(input: unknown): ArtifactFilesMetadata {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).some((key) => typeof key !== "string") ||
    (input as { schemaVersion?: unknown }).schemaVersion !== "1.0" ||
    !Array.isArray((input as { files?: unknown }).files)
  ) {
    throw artifactError("ARTIFACT_METADATA_INVALID", "metadata/files.json has an invalid shape");
  }
  const records: ArtifactFileRecord[] = [];
  const seen = new Set<string>();
  for (const value of (input as { files: unknown[] }).files) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { path?: unknown }).path !== "string" ||
      typeof (value as { sha256?: unknown }).sha256 !== "string" ||
      !Number.isSafeInteger((value as { size?: unknown }).size) ||
      (value as { size: number }).size < 0
    ) {
      throw artifactError(
        "ARTIFACT_METADATA_INVALID",
        "metadata/files.json contains an invalid file record",
      );
    }
    const path = (value as { path: string }).path;
    assertPortableArtifactPath(path);
    if (path === "metadata/files.json" || seen.has(path)) {
      throw artifactError(
        "ARTIFACT_METADATA_INVALID",
        "metadata/files.json contains a duplicate or self declaration",
        { path },
      );
    }
    seen.add(path);
    records.push({
      path,
      sha256: parseArtifactDigest((value as { sha256: string }).sha256),
      size: (value as { size: number }).size,
    });
  }
  return { files: records, schemaVersion: "1.0" };
}

export async function readPluginArtifact(
  source: AsyncIterable<Uint8Array>,
  limits: ArtifactReadLimits = {},
): Promise<ReadPluginArtifact> {
  const maxArchiveBytes = boundedPositiveInteger(
    limits.maxArchiveBytes,
    DEFAULT_MAX_ARCHIVE_BYTES,
    "maxArchiveBytes",
  );
  const maxEntryBytes = boundedPositiveInteger(
    limits.maxEntryBytes,
    DEFAULT_MAX_ENTRY_BYTES,
    "maxEntryBytes",
  );
  const maxEntries = boundedPositiveInteger(limits.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
  const reader = new BoundedStreamReader(source, maxArchiveBytes);
  const entries = new Map<string, { readonly digest: ArtifactDigest; readonly size: number }>();
  let manifestBytes: Uint8Array | undefined;
  let filesBytes: Uint8Array | undefined;
  let zeroBlocks = 0;

  while (zeroBlocks < 2) {
    const header = await reader.readExact(TAR_BLOCK_SIZE, true);
    if (header === undefined) {
      throw artifactError(
        "ARTIFACT_ARCHIVE_TRUNCATED",
        "Plugin archive has no complete end marker",
      );
    }
    if (isZeroBlock(header)) {
      zeroBlocks += 1;
      continue;
    }
    if (zeroBlocks !== 0) {
      throw artifactError(
        "ARTIFACT_ARCHIVE_MALFORMED",
        "Tar end marker contains only one zero block",
      );
    }

    const parsed = parseHeader(header);
    if (entries.has(parsed.path)) {
      throw artifactError("ARTIFACT_ENTRY_DUPLICATE", "Artifact contains a duplicate entry", {
        path: parsed.path,
      });
    }
    if (entries.size >= maxEntries) {
      throw artifactError("ARTIFACT_ENTRY_COUNT_EXCEEDED", "Artifact contains too many entries", {
        maxEntries,
      });
    }
    if (parsed.size > maxEntryBytes) {
      throw artifactError(
        "ARTIFACT_ENTRY_TOO_LARGE",
        "Artifact entry exceeds the configured byte limit",
        { maxEntryBytes, path: parsed.path, size: parsed.size },
      );
    }

    const captureLimit =
      parsed.path === "manifest.json"
        ? MAX_MANIFEST_BYTES
        : parsed.path === "metadata/files.json"
          ? MAX_METADATA_BYTES
          : undefined;
    if (captureLimit !== undefined && parsed.size > captureLimit) {
      throw artifactError(
        "ARTIFACT_ENTRY_TOO_LARGE",
        "Artifact metadata entry exceeds its byte limit",
        { maxEntryBytes: captureLimit, path: parsed.path, size: parsed.size },
      );
    }
    const contents = await readEntry(reader, parsed.size, captureLimit);
    entries.set(parsed.path, { digest: contents.digest, size: parsed.size });
    if (parsed.path === "manifest.json") manifestBytes = contents.bytes;
    if (parsed.path === "metadata/files.json") filesBytes = contents.bytes;
  }
  await reader.assertZeroRemainder();

  if (manifestBytes === undefined || filesBytes === undefined) {
    throw artifactError(
      "ARTIFACT_REQUIRED_FILE_MISSING",
      "Artifact must contain one manifest.json and one metadata/files.json",
    );
  }
  const manifest = parsePluginManifest(parseJson(manifestBytes, "manifest.json"));
  const files = parseFilesMetadata(parseJson(filesBytes, "metadata/files.json"));
  const declared = new Map(files.files.map((file) => [file.path, file]));

  for (const [path, actual] of entries) {
    if (path === "metadata/files.json") continue;
    const declaration = declared.get(path);
    if (declaration === undefined) {
      throw artifactError("ARTIFACT_FILE_UNDECLARED", "Artifact contains an undeclared file", {
        path,
      });
    }
    if (declaration.size !== actual.size || declaration.sha256 !== actual.digest) {
      throw artifactError(
        "ARTIFACT_FILE_DIGEST_MISMATCH",
        "Artifact file does not match metadata/files.json",
        { path },
      );
    }
  }
  for (const path of declared.keys()) {
    if (!entries.has(path)) {
      throw artifactError("ARTIFACT_FILE_MISSING", "A declared artifact file is missing", {
        path,
      });
    }
  }
  if (!entries.has("metadata/sbom.json")) {
    throw artifactError(
      "ARTIFACT_REQUIRED_FILE_MISSING",
      "Artifact must contain metadata/sbom.json",
    );
  }
  for (const component of manifest.components) {
    assertPortableArtifactPath(component.entrypoint);
    if (!entries.has(component.entrypoint)) {
      throw artifactError(
        "ARTIFACT_ENTRYPOINT_MISSING",
        "A component entrypoint is missing from the artifact",
        { componentId: component.componentId, entrypoint: component.entrypoint },
      );
    }
  }
  return { files, manifest };
}
