import { createHash, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { DiagnosticError, parseArtifactDigest, runtimeDiagnostic } from "@tegojs/contracts";
import { canonicalJsonBytes, type ArtifactSignatureEnvelope } from "@tegojs/runtime";

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface SignArtifactOptions {
  readonly artifactPath: string;
  readonly keyId: string;
  readonly privateKey: string;
  readonly signaturePath?: string;
}

export async function signArtifact(
  options: SignArtifactOptions,
): Promise<ArtifactSignatureEnvelope> {
  if (!KEY_ID_PATTERN.test(options.keyId)) {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "ARTIFACT_SIGNATURE_KEY_INVALID",
        message: "Artifact signature key ID is not a portable identifier",
        source: { kind: "artifact", id: "signature" },
      }),
    );
  }
  const bytes = await readFile(options.artifactPath);
  const digest = parseArtifactDigest(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  let signature: string;
  try {
    signature = sign(
      null,
      Buffer.from(digest.slice("sha256:".length), "hex"),
      options.privateKey,
    ).toString("base64");
  } catch (error) {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "ARTIFACT_SIGNATURE_KEY_INVALID",
        message: "Artifact signing key is not a valid Ed25519 private key",
        source: { kind: "artifact", id: "signature" },
        cause:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: "UnknownCause", message: String(error) },
      }),
    );
  }
  const envelope: ArtifactSignatureEnvelope = {
    algorithm: "Ed25519",
    digest,
    keyId: options.keyId,
    signature,
  };
  if (options.signaturePath !== undefined) {
    await writeFile(options.signaturePath, canonicalJsonBytes(envelope));
  }
  return envelope;
}
