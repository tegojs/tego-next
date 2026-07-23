import { realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DiagnosticError,
  runtimeDiagnostic,
  type ArtifactDigest,
  type JsonObject,
} from "@tegojs/contracts";
import { cloneComponentHostValue } from "./protocol.js";

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
  readonly artifactDigest: ArtifactDigest;
  readonly artifactRoot: string;
  readonly entrypoint: string;
  readonly expectedKind: "service" | "task";
}

function loaderError(
  code:
    | "ARTIFACT_ENTRY_OUTSIDE_ROOT"
    | "ARTIFACT_MODULE_FORMAT_INVALID"
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
  const metadata = fields.get("metadata");
  if (metadata !== undefined) {
    const parsed = cloneComponentHostValue(metadata);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw loaderError(
        "EXECUTOR_COMPONENT_DEFINITION_INVALID",
        "Component definition metadata must be a JSON object",
      );
    }
  }
  return value as LoadedComponentDefinition;
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
  const root = await realpath(input.artifactRoot);
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
  const url = pathToFileURL(entrypoint);
  url.searchParams.set("tego-artifact", input.artifactDigest);
  const namespace = (await import(url.href)) as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(namespace, "default");
  if (descriptor === undefined || !("value" in descriptor)) {
    throw loaderError(
      "EXECUTOR_COMPONENT_DEFINITION_INVALID",
      "Component module must have a default data export",
    );
  }
  return validateDefinition(descriptor.value, input.expectedKind);
}
