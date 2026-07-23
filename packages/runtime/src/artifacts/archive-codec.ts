import {
  DiagnosticError,
  runtimeDiagnostic,
  type JsonObject,
  type JsonValue,
} from "@tegojs/contracts";

const TAR_BLOCK_SIZE = 512;
const encoder = new TextEncoder();
const PORTABLE_DRIVE_PATH = /^[A-Za-z]:/u;
const WINDOWS_DEVICE_SEGMENT = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\.|$)/iu;

export interface DeterministicArchiveEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

function artifactError(code: `ARTIFACT_${string}`, message: string, path?: string) {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "artifact", id: "archive" },
      ...(path === undefined ? {} : { details: { path } }),
    }),
  );
}

export function assertPortableArtifactPath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    PORTABLE_DRIVE_PATH.test(path) ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_DEVICE_SEGMENT.test(segment),
    )
  ) {
    throw artifactError("ARTIFACT_PATH_UNSAFE", "Artifact entry path is not portable", path);
  }
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const output = Object.create(null) as Record<string, JsonValue>;
  const object = value as JsonObject;
  for (const key of Object.keys(object).sort()) {
    const nested = object[key];
    if (nested !== undefined) output[key] = canonicalize(nested);
  }
  return output;
}

export function canonicalJsonBytes(value: JsonValue): Uint8Array {
  return encoder.encode(`${JSON.stringify(canonicalize(value))}\n`);
}

function writeText(target: Uint8Array, offset: number, length: number, text: string): void {
  const bytes = encoder.encode(text);
  if (bytes.byteLength > length) {
    throw artifactError(
      "ARTIFACT_PATH_TOO_LONG",
      "Artifact path cannot be represented by the POSIX ustar format",
      text,
    );
  }
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8);
  if (text.length > length - 1) {
    throw artifactError(
      "ARTIFACT_ENTRY_TOO_LARGE",
      "Artifact entry metadata cannot be represented by POSIX ustar",
    );
  }
  writeText(target, offset, length - 1, text.padStart(length - 1, "0"));
}

function splitUstarPath(path: string): { readonly name: string; readonly prefix: string } {
  if (encoder.encode(path).byteLength <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (encoder.encode(prefix).byteLength <= 155 && encoder.encode(name).byteLength <= 100) {
      return { name, prefix };
    }
  }
  throw artifactError(
    "ARTIFACT_PATH_TOO_LONG",
    "Artifact path cannot be represented by the POSIX ustar format",
    path,
  );
}

function createHeader(path: string, size: number): Uint8Array {
  const { name, prefix } = splitUstarPath(path);
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeText(header, 156, 1, "0");
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, 6, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function createDeterministicArchive(
  input: readonly DeterministicArchiveEntry[],
): Uint8Array {
  const entries = [...input].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const chunks: Uint8Array[] = [];
  let previous: string | undefined;
  for (const entry of entries) {
    assertPortableArtifactPath(entry.path);
    if (entry.path === previous) {
      throw artifactError(
        "ARTIFACT_ENTRY_DUPLICATE",
        "Artifact contains a duplicate entry",
        entry.path,
      );
    }
    previous = entry.path;
    const stableBytes = Buffer.from(entry.bytes);
    chunks.push(createHeader(entry.path, stableBytes.byteLength), stableBytes);
    const padding = (TAR_BLOCK_SIZE - (stableBytes.byteLength % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}
