import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DiagnosticError,
  parseArtifactDigest,
  parsePluginManifest,
  runtimeDiagnostic,
  type ArtifactDigest,
  type JsonValue,
  type PluginManifest,
} from "@tegojs/contracts";
import {
  assertPortableArtifactPath,
  canonicalJsonBytes,
  createDeterministicArchive,
  portableArtifactCollisionKey,
  type DeterministicArchiveEntry,
  type DeterministicArchiveLimits,
} from "@tegojs/runtime";
import { buildPlugin, type BuiltPlugin } from "./build-plugin.js";
import { auditJavaScriptModules } from "./module-audit.js";

export interface PackPluginOptions {
  readonly artifactPath: string;
  readonly build?: boolean;
  readonly buildDirectory?: string;
  readonly limits?: DeterministicArchiveLimits;
  readonly pluginDirectory: string;
}

export interface PackedPluginArtifact {
  readonly artifactPath: string;
  readonly digest: ArtifactDigest;
  readonly manifest: PluginManifest;
}

const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function artifactError(code: `ARTIFACT_${string}`, message: string, path?: string) {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "artifact", id: "pack" },
      ...(path === undefined ? {} : { details: { path } }),
    }),
  );
}

function digest(bytes: Uint8Array): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

async function assertPathHasNoSymlinkAncestor(root: string, candidate: string): Promise<void> {
  const path = relative(root, candidate);
  if (!isContained(root, candidate)) {
    throw artifactError(
      "ARTIFACT_BUILD_PATH_UNSAFE",
      "Build path escapes the plugin directory",
      candidate,
    );
  }
  let current = root;
  for (const segment of path.split(sep).filter((value) => value.length > 0)) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw artifactError(
        "ARTIFACT_BUILD_PATH_UNSAFE",
        "Build path cannot contain symbolic links",
        current,
      );
    }
  }
}

async function resolvePluginRoot(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw artifactError("ARTIFACT_BUILD_PATH_UNSAFE", "Plugin root must be a real directory", path);
  }
  return realpath(path);
}

async function resolveBuildRoot(pluginRoot: string, path: string): Promise<string> {
  const absolute = resolve(path);
  await assertPathHasNoSymlinkAncestor(pluginRoot, absolute);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw artifactError(
      "ARTIFACT_BUILD_PATH_UNSAFE",
      "Build root must be a real directory",
      absolute,
    );
  }
  const canonical = await realpath(absolute);
  if (canonical === pluginRoot || !isContained(pluginRoot, canonical)) {
    throw artifactError(
      "ARTIFACT_BUILD_PATH_UNSAFE",
      "Build root must be a child of the plugin directory",
      absolute,
    );
  }
  return canonical;
}

async function listFiles(root: string, directory = root): Promise<readonly string[]> {
  const output: string[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw artifactError(
        "ARTIFACT_BUILD_PATH_UNSAFE",
        "Plugin build output cannot contain symbolic links",
        relative(root, path),
      );
    }
    const canonical = await realpath(path);
    if (!isContained(root, canonical)) {
      throw artifactError(
        "ARTIFACT_BUILD_PATH_UNSAFE",
        "Plugin build output resolves outside its private root",
        relative(root, path),
      );
    }
    if (metadata.isDirectory()) {
      output.push(...(await listFiles(root, canonical)));
    } else if (metadata.isFile()) {
      output.push(relative(root, canonical).split(sep).join("/"));
    } else {
      throw artifactError(
        "ARTIFACT_BUILD_PATH_UNSAFE",
        "Plugin build output contains an unsupported filesystem entry",
        relative(root, path),
      );
    }
  }
  return output.sort();
}

async function readSecureFile(
  root: string,
  portablePath: string,
  maxBytes: number,
): Promise<Buffer> {
  assertPortableArtifactPath(portablePath);
  const path = resolve(root, ...portablePath.split("/"));
  if (!isContained(root, path)) {
    throw artifactError("ARTIFACT_BUILD_PATH_UNSAFE", "File escapes its controlled root", path);
  }
  await assertPathHasNoSymlinkAncestor(root, path);
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw artifactError("ARTIFACT_BUILD_PATH_UNSAFE", "Artifact input must be a real file", path);
  }
  if (before.size > maxBytes) {
    throw artifactError(
      "ARTIFACT_ENTRY_TOO_LARGE",
      "Artifact entry exceeds the configured byte limit",
      portablePath,
    );
  }
  const canonical = await realpath(path);
  if (!isContained(root, canonical)) {
    throw artifactError(
      "ARTIFACT_BUILD_PATH_UNSAFE",
      "Artifact input resolves outside its controlled root",
      path,
    );
  }

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw artifactError(
        "ARTIFACT_BUILD_PATH_UNSAFE",
        "Artifact input changed while it was being opened",
        path,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== opened.size || bytes.byteLength > maxBytes) {
      throw artifactError(
        "ARTIFACT_BUILD_PATH_UNSAFE",
        "Artifact input changed while it was being read",
        path,
      );
    }
    const after = await lstat(path);
    const afterCanonical = await realpath(path);
    if (
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      !isContained(root, afterCanonical)
    ) {
      throw artifactError(
        "ARTIFACT_BUILD_PATH_UNSAFE",
        "Artifact input changed while it was being read",
        path,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function decodeJavaScript(bytes: Uint8Array, path: string): string {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw artifactError(
      "ARTIFACT_MODULE_FORMAT_UNSUPPORTED",
      "Plugin build output must be valid UTF-8 JavaScript",
      path,
    );
  }
  return source;
}

function assertNoPortableCollisions(paths: readonly string[]): void {
  const collisionKeys = new Map<string, string>();
  for (const path of paths) {
    const key = portableArtifactCollisionKey(path);
    const previous = collisionKeys.get(key);
    if (previous !== undefined) {
      throw artifactError(
        previous === path ? "ARTIFACT_ENTRY_DUPLICATE" : "ARTIFACT_ENTRY_COLLISION",
        previous === path
          ? "Artifact contains a duplicate entry"
          : "Artifact entries collide on a portable filesystem",
        path,
      );
    }
    collisionKeys.set(key, path);
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return selected;
}

export async function packPlugin(options: PackPluginOptions): Promise<PackedPluginArtifact> {
  const pluginRoot = await resolvePluginRoot(options.pluginDirectory);
  const maxEntryBytes = positiveLimit(
    options.limits?.maxEntryBytes,
    DEFAULT_MAX_ENTRY_BYTES,
    "maxEntryBytes",
  );
  const manifestBytes = await readSecureFile(
    pluginRoot,
    "manifest.json",
    Math.min(maxEntryBytes, MAX_MANIFEST_BYTES),
  );
  let manifestInput: unknown;
  try {
    manifestInput = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw artifactError("ARTIFACT_MANIFEST_INVALID", "Plugin manifest is not valid JSON");
  }
  const manifest = parsePluginManifest(manifestInput);
  let built: BuiltPlugin | undefined;

  try {
    let buildDirectory: string;
    if (options.build === false) {
      buildDirectory = await resolveBuildRoot(
        pluginRoot,
        options.buildDirectory ?? join(pluginRoot, "build"),
      );
    } else {
      built = await buildPlugin({
        pluginDirectory: pluginRoot,
        tsconfigPath: join(pluginRoot, "tsconfig.json"),
      });
      buildDirectory = await resolveBuildRoot(pluginRoot, built.outputDirectory);
    }

    const actualOutput = await listFiles(buildDirectory);
    const declaredOutput = [
      ...new Set(manifest.components.map((component) => component.entrypoint)),
    ].sort();
    assertNoPortableCollisions(declaredOutput);
    assertNoPortableCollisions(actualOutput);
    for (const path of actualOutput) {
      if (!declaredOutput.includes(path)) {
        throw artifactError(
          "ARTIFACT_BUILD_OUTPUT_UNDECLARED",
          "Plugin build produced an undeclared file",
          path,
        );
      }
    }
    for (const path of declaredOutput) {
      if (!actualOutput.includes(path)) {
        throw artifactError(
          "ARTIFACT_BUILD_OUTPUT_MISSING",
          "Plugin build did not produce a declared component entrypoint",
          path,
        );
      }
    }

    const entries: DeterministicArchiveEntry[] = [];
    const runtimeImports = new Set<string>();
    for (const path of declaredOutput) {
      if (!path.endsWith(".js")) {
        throw artifactError(
          "ARTIFACT_BUILD_OUTPUT_UNDECLARED",
          "Only declared JavaScript ESM output can be packaged",
          path,
        );
      }
      const bytes = await readSecureFile(buildDirectory, path, maxEntryBytes);
      const source = decodeJavaScript(bytes, path);
      for (const specifier of auditJavaScriptModules(source).runtimeImports) {
        runtimeImports.add(specifier);
      }
      entries.push({ bytes, path });
    }
    entries.push({
      bytes: canonicalJsonBytes(manifest),
      path: "manifest.json",
    });
    entries.push({
      bytes: canonicalJsonBytes({
        packages: [],
        runtimeImports: [...runtimeImports].sort(),
        schemaVersion: "1.0",
      }),
      path: "metadata/sbom.json",
    });

    const files = entries
      .map((entry) => ({
        path: entry.path,
        sha256: digest(entry.bytes),
        size: entry.bytes.byteLength,
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    entries.push({
      bytes: canonicalJsonBytes({ files, schemaVersion: "1.0" } as JsonValue),
      path: "metadata/files.json",
    });
    const archive = createDeterministicArchive(entries, options.limits);
    await writeFile(options.artifactPath, archive);
    return {
      artifactPath: options.artifactPath,
      digest: digest(archive),
      manifest,
    };
  } finally {
    await built?.cleanup();
  }
}
