import { DiagnosticError, runtimeDiagnostic } from "./diagnostic.js";

export interface ArtifactStorageLimits {
  readonly maxArtifactBytes: number;
  readonly maxNamespaceBytes: number;
}

export const DEFAULT_ARTIFACT_STORAGE_LIMITS: ArtifactStorageLimits = Object.freeze({
  maxArtifactBytes: 256 * 1024 * 1024,
  maxNamespaceBytes: 4 * 1024 * 1024 * 1024,
});

function limitsError(message: string, details: Record<string, string>): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "ARTIFACT_STORAGE_LIMITS_INVALID",
      message,
      source: { kind: "artifact", id: "artifact-storage-limits" },
      details,
    }),
  );
}

function parseLimit(name: keyof ArtifactStorageLimits, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw limitsError(`${name} must be a finite positive safe integer`, {
      limit: name,
      value: String(value),
    });
  }
  if (value <= 0) {
    throw limitsError(`${name} must be a finite positive safe integer`, {
      limit: name,
      value: String(value),
    });
  }
  return value;
}

export function parseArtifactStorageLimits(
  input: Partial<ArtifactStorageLimits> = {},
): ArtifactStorageLimits {
  const maxArtifactBytes = parseLimit(
    "maxArtifactBytes",
    input.maxArtifactBytes ?? DEFAULT_ARTIFACT_STORAGE_LIMITS.maxArtifactBytes,
  );
  const maxNamespaceBytes = parseLimit(
    "maxNamespaceBytes",
    input.maxNamespaceBytes ?? DEFAULT_ARTIFACT_STORAGE_LIMITS.maxNamespaceBytes,
  );
  if (maxNamespaceBytes < maxArtifactBytes) {
    throw limitsError("maxNamespaceBytes must be greater than or equal to maxArtifactBytes", {
      maxArtifactBytes: String(maxArtifactBytes),
      maxNamespaceBytes: String(maxNamespaceBytes),
    });
  }
  if (
    maxArtifactBytes === DEFAULT_ARTIFACT_STORAGE_LIMITS.maxArtifactBytes &&
    maxNamespaceBytes === DEFAULT_ARTIFACT_STORAGE_LIMITS.maxNamespaceBytes
  ) {
    return DEFAULT_ARTIFACT_STORAGE_LIMITS;
  }
  return Object.freeze({ maxArtifactBytes, maxNamespaceBytes });
}
