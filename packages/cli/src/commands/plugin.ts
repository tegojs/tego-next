import { createReadStream } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type JsonValue,
  parsePluginDeployment,
  parsePluginDeploymentStatus,
  parsePluginInstallation,
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
    case "plugin.deploy":
      return parsePluginDeployment(result);
    case "plugin.install":
      return parsePluginInstallation(result);
    case "plugin.status":
      return parsePluginDeploymentStatus(result);
  }
}
