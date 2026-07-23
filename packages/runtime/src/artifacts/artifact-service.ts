import { verify } from "node:crypto";
import {
  DiagnosticError,
  diagnosticCode,
  parsePluginInstallation,
  runtimeDiagnostic,
  type ArtifactDigest,
  type ArtifactStore,
  type Clock,
  type JsonObject,
  type PluginManifest,
  type PluginInstallation,
  type PluginSignature,
  type StateKey,
  type StateStore,
} from "@tegojs/contracts";
import {
  readPluginArtifact,
  type ArtifactFilesMetadata,
  type ArtifactReadLimits,
} from "./manifest-reader.js";

export interface ArtifactSignatureEnvelope extends JsonObject {
  readonly algorithm: "Ed25519";
  readonly digest: ArtifactDigest;
  readonly keyId: string;
  readonly signature: string;
}

export interface ArtifactTrustKey {
  readonly keyId: string;
  readonly publicKey: string;
}

export interface ArtifactTrustConfiguration {
  readonly mode: "optional" | "required";
  readonly keys: readonly ArtifactTrustKey[];
}

export interface ArtifactCompatibility {
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly tegoContractVersion: string;
}

export interface ArtifactServiceOptions {
  readonly artifacts: ArtifactStore;
  readonly state: StateStore;
  readonly clock: Clock;
  readonly compatibility: ArtifactCompatibility;
  readonly trust?: ArtifactTrustConfiguration;
  readonly limits?: ArtifactReadLimits;
}

export interface ValidateArtifactRequest {
  readonly digest: ArtifactDigest;
  readonly signature?: ArtifactSignatureEnvelope;
}

export interface ValidatedPluginArtifact {
  readonly digest: ArtifactDigest;
  readonly files: ArtifactFilesMetadata;
  readonly manifest: PluginManifest;
  readonly signature?: PluginSignature;
}

export type InstallArtifactRequest = ValidateArtifactRequest;

interface InstalledVersionIndex extends JsonObject {
  readonly digest: ArtifactDigest;
  readonly pluginId: PluginManifest["pluginId"];
  readonly version: string;
}

function artifactError(code: `ARTIFACT_${string}`, message: string, details?: JsonObject) {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "artifact", id: "validation" },
      ...(details === undefined ? {} : { details }),
    }),
  );
}

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(value: string): Version | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/u.exec(value);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersion(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function satisfiesComparator(version: Version, comparator: string): boolean {
  if (comparator === "*" || comparator === "") return true;
  if (comparator.startsWith("^")) {
    const minimum = parseVersion(comparator.slice(1));
    return (
      minimum !== undefined &&
      compareVersion(version, minimum) >= 0 &&
      version.major === minimum.major
    );
  }
  const match = /^(>=|<=|>|<|=)?(.+)$/u.exec(comparator);
  const target = match === null ? undefined : parseVersion(match[2] ?? "");
  if (match === null || target === undefined) return false;
  const order = compareVersion(version, target);
  switch (match[1] ?? "=") {
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    default:
      return order === 0;
  }
}

function satisfiesRange(value: string, range: string): boolean {
  const version = parseVersion(value);
  if (version === undefined) return false;
  const alternatives = range.split("||").map((part) => part.trim());
  return alternatives.some((alternative) =>
    alternative
      .split(/\s+/u)
      .filter((part) => part.length > 0)
      .every((comparator) => satisfiesComparator(version, comparator)),
  );
}

export class ArtifactService {
  readonly #artifacts: ArtifactStore;
  readonly #clock: Clock;
  readonly #compatibility: ArtifactCompatibility;
  readonly #limits: ArtifactReadLimits;
  readonly #state: StateStore;
  readonly #trust: ArtifactTrustConfiguration;

  constructor(options: ArtifactServiceOptions) {
    this.#artifacts = options.artifacts;
    this.#clock = options.clock;
    this.#compatibility = options.compatibility;
    this.#limits = options.limits ?? {};
    this.#state = options.state;
    this.#trust = options.trust ?? { keys: [], mode: "optional" };
  }

  async validate(request: ValidateArtifactRequest): Promise<ValidatedPluginArtifact> {
    const signature = this.#verifySignature(request);
    const { files, manifest } = await readPluginArtifact(
      this.#artifacts.read(request.digest),
      this.#limits,
    );
    this.#validateCompatibility(manifest);
    return {
      digest: request.digest,
      files,
      manifest,
      ...(signature === undefined ? {} : { signature }),
    };
  }

  async install(request: InstallArtifactRequest): Promise<PluginInstallation> {
    const validated = await this.validate(request);
    const candidate: PluginInstallation = {
      pluginId: validated.manifest.pluginId,
      version: validated.manifest.version,
      digest: validated.digest,
      manifest: validated.manifest,
      installedAt: this.#clock.now().toISOString(),
      ...(validated.signature === undefined ? {} : { signature: validated.signature }),
    };
    const installationKey = this.#installationKey(candidate);
    const versionKey = this.#versionKey(candidate);

    try {
      return await this.#state.transact({}, async (transaction) => {
        const indexed = await transaction.get(versionKey);
        if (indexed !== undefined) {
          const existingDigest = this.#parseVersionIndex(indexed.value, candidate);
          if (existingDigest !== candidate.digest) {
            throw this.#installationConflict(existingDigest, candidate);
          }
          const stored = await transaction.get(installationKey);
          if (stored === undefined) {
            throw artifactError(
              "ARTIFACT_INSTALLATION_CORRUPT",
              "Plugin version index refers to a missing installation record",
              { digest: candidate.digest, pluginId: candidate.pluginId, version: candidate.version },
            );
          }
          return parsePluginInstallation(stored.value);
        }
        const versionIndex: InstalledVersionIndex = {
          digest: candidate.digest,
          pluginId: candidate.pluginId,
          version: candidate.version,
        };
        await transaction.put(versionKey, versionIndex, { expectedRevision: "absent" });
        await transaction.put(installationKey, candidate, { expectedRevision: "absent" });
        return candidate;
      });
    } catch (error) {
      if (diagnosticCode(error) !== "STATE_REVISION_CONFLICT") throw error;
      const indexed = await this.#state.read(versionKey);
      if (indexed === undefined) throw error;
      const existingDigest = this.#parseVersionIndex(indexed.value, candidate);
      if (existingDigest !== candidate.digest) {
        throw this.#installationConflict(existingDigest, candidate);
      }
      const stored = await this.#state.read(installationKey);
      if (stored === undefined) throw error;
      return parsePluginInstallation(stored.value);
    }
  }

  #installationKey(installation: PluginInstallation): StateKey<PluginInstallation> {
    return {
      namespace: "tego",
      collection: "installations",
      id: `${installation.pluginId}@${installation.version}@${installation.digest}`,
    };
  }

  #versionKey(installation: PluginInstallation): StateKey<InstalledVersionIndex> {
    return {
      namespace: "tego",
      collection: "installation-versions",
      id: `${installation.pluginId}@${installation.version}`,
    };
  }

  #parseVersionIndex(
    value: JsonObject,
    candidate: PluginInstallation,
  ): ArtifactDigest {
    if (
      value.pluginId !== candidate.pluginId ||
      value.version !== candidate.version ||
      typeof value.digest !== "string"
    ) {
      throw artifactError(
        "ARTIFACT_INSTALLATION_CORRUPT",
        "Plugin version index is invalid",
        { pluginId: candidate.pluginId, version: candidate.version },
      );
    }
    return value.digest as ArtifactDigest;
  }

  #installationConflict(
    existingDigest: ArtifactDigest,
    candidate: PluginInstallation,
  ): DiagnosticError {
    return artifactError(
      "ARTIFACT_INSTALLATION_CONFLICT",
      "A different artifact digest is already installed for this plugin version",
      {
        existingDigest,
        pluginId: candidate.pluginId,
        requestedDigest: candidate.digest,
        version: candidate.version,
      },
    );
  }

  #verifySignature(request: ValidateArtifactRequest): PluginSignature | undefined {
    if (request.signature === undefined) {
      if (this.#trust.mode === "required") {
        throw artifactError(
          "ARTIFACT_SIGNATURE_REQUIRED",
          "Artifact signature is required by trust policy",
        );
      }
      return undefined;
    }
    const envelope = request.signature;
    if (envelope.algorithm !== "Ed25519" || envelope.digest !== request.digest) {
      throw artifactError(
        "ARTIFACT_SIGNATURE_INVALID",
        "Artifact signature envelope does not match the artifact digest",
      );
    }
    const trustKey = this.#trust.keys.find((key) => key.keyId === envelope.keyId);
    if (trustKey === undefined) {
      throw artifactError(
        "ARTIFACT_SIGNATURE_KEY_UNKNOWN",
        "Artifact signature key is not trusted",
        { keyId: envelope.keyId },
      );
    }

    let signature: Buffer;
    try {
      signature = Buffer.from(envelope.signature, "base64");
      if (
        signature.byteLength !== 64 ||
        signature.toString("base64").replaceAll("=", "") !== envelope.signature.replaceAll("=", "")
      ) {
        throw new Error("non-canonical Ed25519 signature");
      }
    } catch {
      throw artifactError(
        "ARTIFACT_SIGNATURE_INVALID",
        "Artifact signature is not valid canonical base64",
      );
    }
    const digestBytes = Buffer.from(request.digest.slice("sha256:".length), "hex");
    let verified = false;
    try {
      verified = verify(null, digestBytes, trustKey.publicKey, signature);
    } catch {
      verified = false;
    }
    if (!verified) {
      throw artifactError("ARTIFACT_SIGNATURE_INVALID", "Artifact signature verification failed", {
        keyId: envelope.keyId,
      });
    }
    return { algorithm: "Ed25519", keyId: envelope.keyId, verified: true };
  }

  #validateCompatibility(manifest: PluginManifest): void {
    if (!satisfiesRange(this.#compatibility.nodeVersion, manifest.nodeRange)) {
      throw artifactError(
        "ARTIFACT_NODE_INCOMPATIBLE",
        "Plugin does not support the configured Node.js version",
        { actual: this.#compatibility.nodeVersion, required: manifest.nodeRange },
      );
    }
    if (!satisfiesRange(this.#compatibility.tegoContractVersion, manifest.contractRange)) {
      throw artifactError(
        "ARTIFACT_CONTRACT_INCOMPATIBLE",
        "Plugin does not support the configured Tego contract version",
        { actual: this.#compatibility.tegoContractVersion, required: manifest.contractRange },
      );
    }
    const target = `${this.#compatibility.platform}-${this.#compatibility.architecture}`;
    if (
      manifest.architectures !== undefined &&
      !manifest.architectures.includes(target) &&
      !manifest.architectures.includes(this.#compatibility.architecture)
    ) {
      throw artifactError(
        "ARTIFACT_PLATFORM_INCOMPATIBLE",
        "Plugin does not support the configured platform and architecture",
        { actual: target, required: manifest.architectures },
      );
    }
  }
}
