import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import {
  DiagnosticError,
  runtimeDiagnostic,
  type ArtifactDigest,
  type JsonObject,
  type JsonValue,
} from "@tegojs/contracts";
import { cloneComponentHostValue } from "./protocol.js";

const PREPARED_ARTIFACT = Symbol("tego.prepared-artifact");

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly type: "directory" | "file" | "other" | "symlink";
}

interface RootDigestBinding {
  readonly artifactDigest: ArtifactDigest;
  readonly lstat: FileIdentity;
  readonly stat: FileIdentity;
}

const ROOT_DIGEST_BINDINGS = new Map<string, RootDigestBinding>();
const PLUGIN_SDK_SPECIFIER = "@tegojs/plugin-sdk";
const PLUGIN_SDK_URL = import.meta.resolve(PLUGIN_SDK_SPECIFIER);
const SDK_RESOLUTION_STATE = Symbol.for("tego.executor-node.plugin-sdk-resolution");

interface SdkResolutionState {
  installed: boolean;
  readonly activeRoots: Map<string, number>;
}

const globals = globalThis as typeof globalThis & {
  [SDK_RESOLUTION_STATE]?: SdkResolutionState;
};
const sdkResolutionState =
  globals[SDK_RESOLUTION_STATE] ??
  (globals[SDK_RESOLUTION_STATE] = {
    installed: false,
    activeRoots: new Map<string, number>(),
  });

function isBoundArtifactParent(parentURL: string | undefined): boolean {
  if (parentURL === undefined || !parentURL.startsWith("file:")) {
    return false;
  }
  const parentPath = fileURLToPath(parentURL);
  for (const root of sdkResolutionState.activeRoots.keys()) {
    if (confined(root, parentPath)) {
      return true;
    }
  }
  return false;
}

function activateSdkResolution(root: string): () => void {
  sdkResolutionState.activeRoots.set(root, (sdkResolutionState.activeRoots.get(root) ?? 0) + 1);
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    const references = sdkResolutionState.activeRoots.get(root);
    if (references === undefined || references <= 1) {
      sdkResolutionState.activeRoots.delete(root);
      return;
    }
    sdkResolutionState.activeRoots.set(root, references - 1);
  };
}

if (!sdkResolutionState.installed) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === PLUGIN_SDK_SPECIFIER && isBoundArtifactParent(context.parentURL)) {
        return {
          shortCircuit: true,
          url: PLUGIN_SDK_URL,
        };
      }
      return nextResolve(specifier, context);
    },
  });
  sdkResolutionState.installed = true;
}

export interface PreparedArtifactBinding {
  readonly [PREPARED_ARTIFACT]: true;
  readonly artifactDigest: ArtifactDigest;
  readonly artifactRoot: string;
  readonly lstat: FileIdentity;
  readonly stat: FileIdentity;
}

export interface LoadedComponentDefinition {
  readonly protocol: "tego.component/1.0";
  readonly kind: "service" | "task";
  readonly metadata?: JsonObject;
  readonly start?: (context: unknown) => Promise<void> | void;
  readonly health?: (context: unknown) => Promise<unknown> | unknown;
  readonly run?: (context: unknown, input: unknown) => Promise<unknown> | unknown;
  readonly drain?: (context: unknown) => Promise<void> | void;
  readonly stop?: (context: unknown) => Promise<void> | void;
}

export interface LoadPreparedComponentInput {
  readonly prepared: PreparedArtifactBinding;
  readonly entrypoint: string;
  readonly expectedKind: "service" | "task";
}

function loaderError(
  code:
    | "ARTIFACT_ENTRY_OUTSIDE_ROOT"
    | "ARTIFACT_DIGEST_ROOT_CONFLICT"
    | "ARTIFACT_MODULE_FORMAT_INVALID"
    | "ARTIFACT_ROOT_IDENTITY_MISMATCH"
    | "EXECUTOR_COMPONENT_DEFINITION_INVALID",
  message: string,
): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "artifact", id: "component-entrypoint" },
    }),
  );
}

function confined(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !resolve(pathFromRoot).startsWith(`${sep}..${sep}`)
  );
}

function fileIdentity(value: Stats): FileIdentity {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    type: value.isSymbolicLink()
      ? "symlink"
      : value.isDirectory()
        ? "directory"
        : value.isFile()
          ? "file"
          : "other",
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.type === right.type;
}

export async function prepareArtifactBinding(
  artifactDigest: ArtifactDigest,
  artifactRoot: string,
): Promise<PreparedArtifactBinding> {
  const root = await realpath(artifactRoot);
  const rootLstat = fileIdentity(await lstat(artifactRoot));
  const rootStat = fileIdentity(await stat(artifactRoot));
  if (root !== artifactRoot || rootLstat.type !== "directory" || rootStat.type !== "directory") {
    throw loaderError(
      "ARTIFACT_ROOT_IDENTITY_MISMATCH",
      "Prepared artifact root must be a canonical non-symlink directory",
    );
  }
  const existing = ROOT_DIGEST_BINDINGS.get(root);
  if (existing !== undefined) {
    if (existing.artifactDigest !== artifactDigest) {
      throw loaderError(
        "ARTIFACT_DIGEST_ROOT_CONFLICT",
        "Prepared artifact root is already bound to another immutable digest",
      );
    }
    if (!sameIdentity(existing.lstat, rootLstat) || !sameIdentity(existing.stat, rootStat)) {
      throw loaderError(
        "ARTIFACT_ROOT_IDENTITY_MISMATCH",
        "Prepared artifact root filesystem identity changed",
      );
    }
  }
  ROOT_DIGEST_BINDINGS.set(root, {
    artifactDigest,
    lstat: rootLstat,
    stat: rootStat,
  });
  return Object.freeze({
    [PREPARED_ARTIFACT]: true as const,
    artifactDigest,
    artifactRoot: root,
    lstat: rootLstat,
    stat: rootStat,
  });
}

async function validatePreparedArtifact(
  binding: PreparedArtifactBinding,
): Promise<PreparedArtifactBinding> {
  if (binding[PREPARED_ARTIFACT] !== true) {
    throw loaderError(
      "ARTIFACT_ROOT_IDENTITY_MISMATCH",
      "Component import requires a host-prepared artifact binding",
    );
  }
  const root = await realpath(binding.artifactRoot);
  const rootLstat = fileIdentity(await lstat(binding.artifactRoot));
  const rootStat = fileIdentity(await stat(binding.artifactRoot));
  if (
    root !== binding.artifactRoot ||
    !sameIdentity(binding.lstat, rootLstat) ||
    !sameIdentity(binding.stat, rootStat)
  ) {
    throw loaderError(
      "ARTIFACT_ROOT_IDENTITY_MISMATCH",
      "Prepared artifact root filesystem identity changed before import",
    );
  }
  return binding;
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    if (typeof item === "object" && item !== null && !Object.isFrozen(item)) {
      freezeJson(item);
    }
  }
  return Object.freeze(value);
}

function validateDefinition(
  value: unknown,
  expectedKind: "service" | "task",
): LoadedComponentDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw loaderError(
      "EXECUTOR_COMPONENT_DEFINITION_INVALID",
      "Component module default export must be a functional definition",
    );
  }
  const allowed = new Set([
    "drain",
    "health",
    "kind",
    "metadata",
    "protocol",
    "run",
    "start",
    "stop",
  ]);
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw loaderError(
        "EXECUTOR_COMPONENT_DEFINITION_INVALID",
        "Component definition contains unsupported fields",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw loaderError(
        "EXECUTOR_COMPONENT_DEFINITION_INVALID",
        `Component definition ${key} must be an enumerable data property`,
      );
    }
    fields.set(key, descriptor.value);
  }
  if (fields.get("protocol") !== "tego.component/1.0") {
    throw loaderError(
      "EXECUTOR_COMPONENT_DEFINITION_INVALID",
      "Component definition protocol is unsupported",
    );
  }
  if (fields.get("kind") !== expectedKind) {
    throw loaderError(
      "EXECUTOR_COMPONENT_DEFINITION_INVALID",
      "Component definition kind does not match the manifest",
    );
  }
  for (const hook of ["drain", "health", "run", "start", "stop"] as const) {
    const candidate = fields.get(hook);
    if (candidate !== undefined && typeof candidate !== "function") {
      throw loaderError(
        "EXECUTOR_COMPONENT_DEFINITION_INVALID",
        `Component definition ${hook} must be a function`,
      );
    }
  }
  const metadataValue = fields.get("metadata");
  let metadata: JsonObject | undefined;
  if (metadataValue !== undefined) {
    const parsed = cloneComponentHostValue(metadataValue);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw loaderError(
        "EXECUTOR_COMPONENT_DEFINITION_INVALID",
        "Component definition metadata must be a JSON object",
      );
    }
    metadata = freezeJson(parsed) as JsonObject;
  }
  const definition: LoadedComponentDefinition = {
    protocol: "tego.component/1.0",
    kind: expectedKind,
    ...(metadata === undefined ? {} : { metadata }),
    ...(fields.get("start") === undefined
      ? {}
      : { start: fields.get("start") as NonNullable<LoadedComponentDefinition["start"]> }),
    ...(fields.get("health") === undefined
      ? {}
      : { health: fields.get("health") as NonNullable<LoadedComponentDefinition["health"]> }),
    ...(fields.get("run") === undefined
      ? {}
      : { run: fields.get("run") as NonNullable<LoadedComponentDefinition["run"]> }),
    ...(fields.get("drain") === undefined
      ? {}
      : { drain: fields.get("drain") as NonNullable<LoadedComponentDefinition["drain"]> }),
    ...(fields.get("stop") === undefined
      ? {}
      : { stop: fields.get("stop") as NonNullable<LoadedComponentDefinition["stop"]> }),
  };
  return Object.freeze(definition);
}

export async function loadPreparedComponent(
  input: LoadPreparedComponentInput,
): Promise<LoadedComponentDefinition> {
  if (![".js", ".mjs"].includes(extname(input.entrypoint))) {
    throw loaderError(
      "ARTIFACT_MODULE_FORMAT_INVALID",
      "Component entrypoint must be JavaScript ESM",
    );
  }
  const binding = await validatePreparedArtifact(input.prepared);
  const root = binding.artifactRoot;
  const candidate = resolve(root, input.entrypoint);
  if (!confined(root, candidate)) {
    throw loaderError(
      "ARTIFACT_ENTRY_OUTSIDE_ROOT",
      "Component entrypoint escapes the prepared artifact root",
    );
  }
  const entrypoint = await realpath(candidate);
  if (!confined(root, entrypoint)) {
    throw loaderError(
      "ARTIFACT_ENTRY_OUTSIDE_ROOT",
      "Component entrypoint resolves outside the prepared artifact root",
    );
  }
  const deactivateSdkResolution = activateSdkResolution(root);
  const namespace = (await import(pathToFileURL(entrypoint).href).finally(
    deactivateSdkResolution,
  )) as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(namespace, "default");
  if (descriptor === undefined || !("value" in descriptor)) {
    throw loaderError(
      "EXECUTOR_COMPONENT_DEFINITION_INVALID",
      "Component module must have a default data export",
    );
  }
  return validateDefinition(descriptor.value, input.expectedKind);
}
