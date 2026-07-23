import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
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
  type DeterministicArchiveEntry,
} from "@tegojs/runtime";
import { buildPlugin } from "./build-plugin.js";

export interface PackPluginOptions {
  readonly artifactPath: string;
  readonly build?: boolean;
  readonly buildDirectory?: string;
  readonly pluginDirectory: string;
}

export interface PackedPluginArtifact {
  readonly artifactPath: string;
  readonly digest: ArtifactDigest;
  readonly manifest: PluginManifest;
}

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

async function listFiles(root: string, directory = root): Promise<readonly string[]> {
  const output: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw artifactError(
        "ARTIFACT_BUILD_OUTPUT_UNDECLARED",
        "Plugin build output cannot contain symbolic links",
        relative(root, path),
      );
    }
    if (entry.isDirectory()) {
      output.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      output.push(relative(root, path).split(sep).join("/"));
    } else {
      throw artifactError(
        "ARTIFACT_BUILD_OUTPUT_UNDECLARED",
        "Plugin build output contains an unsupported filesystem entry",
        relative(root, path),
      );
    }
  }
  return output.sort();
}

function assertEsm(bytes: Uint8Array, path: string): void {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    /\brequire\s*\(/u.test(source) ||
    /\bmodule\s*\.\s*exports\b/u.test(source) ||
    /\bexports\s*\./u.test(source)
  ) {
    throw artifactError(
      "ARTIFACT_MODULE_FORMAT_UNSUPPORTED",
      "Plugin build output contains CommonJS syntax",
      path,
    );
  }
}

export async function packPlugin(options: PackPluginOptions): Promise<PackedPluginArtifact> {
  const manifestPath = join(options.pluginDirectory, "manifest.json");
  const manifest = parsePluginManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  if (options.build !== false) {
    await buildPlugin({ pluginDirectory: options.pluginDirectory });
  }

  const buildDirectory = options.buildDirectory ?? join(options.pluginDirectory, "build");
  const actualOutput = await listFiles(buildDirectory);
  const declaredOutput = [...new Set(manifest.components.map((component) => component.entrypoint))]
    .sort();
  for (const path of declaredOutput) assertPortableArtifactPath(path);
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
  for (const path of declaredOutput) {
    const bytes = await readFile(join(buildDirectory, ...path.split("/")));
    if (!path.endsWith(".js")) {
      throw artifactError(
        "ARTIFACT_BUILD_OUTPUT_UNDECLARED",
        "Only declared JavaScript ESM output can be packaged",
        path,
      );
    }
    assertEsm(bytes, path);
    entries.push({ bytes, path });
  }
  entries.push({
    bytes: canonicalJsonBytes(manifest),
    path: "manifest.json",
  });
  entries.push({
    bytes: canonicalJsonBytes({ packages: [], schemaVersion: "1.0" }),
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
  const archive = createDeterministicArchive(entries);
  await writeFile(options.artifactPath, archive);
  return {
    artifactPath: options.artifactPath,
    digest: digest(archive),
    manifest,
  };
}
