import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, readlink, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  DiagnosticError,
  type JsonValue,
  parsePluginDeployment,
  parsePluginDeploymentStatus,
  parsePluginInstallation,
  runtimeDiagnostic,
} from "@tegojs/contracts";
import { readPluginArtifact } from "@tegojs/runtime";
import type {
  PluginDeployCommand,
  PluginInspectCommand,
  PluginInstallCommand,
  PluginPackCommand,
  PluginStatusCommand,
  PluginValidateCommand,
} from "../parse-command.js";
import { packPlugin } from "../plugin/pack-plugin.js";
import { signArtifact } from "../plugin/sign-plugin.js";

export type LocalPluginCommand = PluginInspectCommand | PluginPackCommand | PluginValidateCommand;

export type ControlledPluginCommand =
  | PluginDeployCommand
  | PluginInstallCommand
  | PluginStatusCommand;

export interface PluginControlRequest {
  readonly input: JsonValue;
  readonly operation: "plugin.deploy" | "plugin.install-path" | "plugin.status";
}

interface PathIdentity {
  readonly canonicalPath: string;
  readonly device?: bigint;
  readonly inode?: bigint;
}

function artifactPathConflict(): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "ARTIFACT_OUTPUT_PATH_CONFLICT",
      message: "Artifact output, signature output, and private key paths must be distinct",
      source: { kind: "artifact", id: "cli-pack" },
    }),
  );
}

async function canonicalPotentialPath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) {
          const target = resolve(dirname(current), await readlink(current));
          return join(await canonicalPotentialPath(target), ...missing.reverse());
        }
      } catch (metadataError) {
        if (
          typeof metadataError !== "object" ||
          metadataError === null ||
          !("code" in metadataError) ||
          metadataError.code !== "ENOENT"
        ) {
          throw metadataError;
        }
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

async function pathIdentity(path: string): Promise<PathIdentity> {
  const canonicalPath = await canonicalPotentialPath(path);
  try {
    const metadata = await stat(path, { bigint: true });
    return {
      canonicalPath,
      device: metadata.dev,
      inode: metadata.ino,
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { canonicalPath };
    }
    throw error;
  }
}

async function assertPackPathsDistinct(command: PluginPackCommand): Promise<void> {
  if (command.keyId === undefined || command.privateKeyPath === undefined) return;
  const paths = [
    command.artifactPath,
    command.privateKeyPath,
    command.signaturePath ?? `${command.artifactPath}.sig`,
  ];
  const identities = await Promise.all(paths.map((path) => pathIdentity(path)));
  for (const [index, first] of identities.entries()) {
    for (const second of identities.slice(index + 1)) {
      if (
        first.canonicalPath === second.canonicalPath ||
        (first.device !== undefined &&
          first.inode !== undefined &&
          first.device === second.device &&
          first.inode === second.inode)
      ) {
        throw artifactPathConflict();
      }
    }
  }
}

export async function executeLocalPluginCommand(command: LocalPluginCommand): Promise<JsonValue> {
  if (command.kind === "plugin.inspect") {
    const artifact = await readPluginArtifact(createReadStream(command.artifactPath));
    return {
      digest: artifact.archiveDigest,
      files: artifact.files,
      manifest: artifact.manifest,
    };
  }
  if (command.kind === "plugin.pack") {
    await assertPackPathsDistinct(command);
    const packed = await packPlugin({
      artifactPath: command.artifactPath,
      build: command.build,
      pluginDirectory: command.pluginDirectory,
    });
    if (command.keyId === undefined || command.privateKeyPath === undefined) {
      return {
        artifactPath: packed.artifactPath,
        digest: packed.digest,
        manifest: packed.manifest,
      };
    }
    const signature = await signArtifact({
      artifactPath: command.artifactPath,
      keyId: command.keyId,
      privateKey: await readFile(command.privateKeyPath, "utf8"),
      signaturePath: command.signaturePath ?? `${command.artifactPath}.sig`,
    });
    return {
      artifactPath: packed.artifactPath,
      digest: packed.digest,
      manifest: packed.manifest,
      signature,
    };
  }

  const directory = await mkdtemp(join(tmpdir(), "tego-plugin-validation-"));
  try {
    const packed = await packPlugin({
      artifactPath: join(directory, "validation.tego"),
      pluginDirectory: command.pluginDirectory,
    });
    return {
      digest: packed.digest,
      manifest: packed.manifest,
      valid: true,
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function pluginControlRequest(
  command: ControlledPluginCommand,
): Promise<PluginControlRequest> {
  if (command.kind === "plugin.install") {
    return {
      input: { artifactPath: await realpath(command.artifactPath) },
      operation: "plugin.install-path",
    };
  }
  return {
    input: command.input,
    operation: command.kind,
  };
}

export function parsePluginControlResult(
  command: ControlledPluginCommand,
  result: JsonValue,
): JsonValue {
  switch (command.kind) {
    case "plugin.deploy": {
      const deployment = parsePluginDeployment(result);
      if (
        deployment.applicationId !== command.input.applicationId ||
        deployment.pluginId !== command.input.pluginId ||
        deployment.artifactDigest !== command.input.artifactDigest
      ) {
        throw new DiagnosticError(
          runtimeDiagnostic({
            code: "PROTOCOL_CONTROL_REQUEST_MISMATCH",
            message: "Plugin deployment response identity does not match the request",
            source: { kind: "protocol", id: "cli" },
          }),
        );
      }
      return deployment;
    }
    case "plugin.install":
      return parsePluginInstallation(result);
    case "plugin.status": {
      const status = parsePluginDeploymentStatus(result);
      if (
        status.identity.applicationId !== command.input.applicationId ||
        status.identity.pluginId !== command.input.pluginId ||
        (status.desired !== undefined &&
          (status.desired.applicationId !== status.identity.applicationId ||
            status.desired.pluginId !== status.identity.pluginId))
      ) {
        throw new DiagnosticError(
          runtimeDiagnostic({
            code: "PROTOCOL_CONTROL_REQUEST_MISMATCH",
            message: "Plugin status response identity does not match the request",
            source: { kind: "protocol", id: "cli" },
          }),
        );
      }
      return status;
    }
  }
}
