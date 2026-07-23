import { domainToASCII } from "node:url";
import type {
  CapabilityPermission,
  EnvironmentPermission,
  ExecutorPermission,
  FilesystemAccess,
  FilesystemPermission,
  FilesystemRootPermission,
  HttpMethod,
  JsonObject,
  NetworkPermission,
  Permission,
  SecretPermission,
  WorkerPermission,
  WorkerResourceCeilings,
} from "@tegojs/contracts";

export type PermissionDecisionCode =
  | "PERMISSION_ENVELOPE_INVALID"
  | "PERMISSION_GRANT_EXCEEDS_REQUEST";

export interface PermissionDecisionDiagnostic extends JsonObject {
  readonly code: PermissionDecisionCode;
  readonly message: string;
  readonly path: string;
}

export interface PermissionDecision extends JsonObject {
  readonly allowed: boolean;
  readonly diagnostics: readonly PermissionDecisionDiagnostic[];
  readonly requested?: readonly Permission[];
  readonly granted?: readonly Permission[];
}

class PermissionInputError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

const PORTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HTTP_METHODS = new Set<HttpMethod>([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);
const EXECUTOR_KINDS = new Set(["process", "remote", "thread"] as const);
const ACCESS_MODES = new Set<FilesystemAccess>(["read", "write"]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function clonePermissionBoundaryValue(
  value: unknown,
  path = "$",
  ancestors = new Set<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new PermissionInputError(path, "value must be finite acyclic JSON data");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new PermissionInputError(path, "array must have the standard array prototype");
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new PermissionInputError(`${path}/${index}`, "array must contain data properties");
        }
        result.push(clonePermissionBoundaryValue(descriptor.value, `${path}/${index}`, ancestors));
      }
      if (
        Reflect.ownKeys(value).some(
          (key) =>
            key !== "length" &&
            !(
              typeof key === "string" &&
              /^(?:0|[1-9]\d*)$/u.test(key) &&
              Number(key) < value.length
            ),
        )
      ) {
        throw new PermissionInputError(path, "extended arrays are not supported");
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PermissionInputError(path, "object must have a plain or null prototype");
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value).sort((left, right) =>
      compareText(String(left), String(right)),
    )) {
      if (typeof key !== "string") {
        throw new PermissionInputError(path, "symbol properties are not supported");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new PermissionInputError(`${path}/${key}`, "object must contain data properties");
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: clonePermissionBoundaryValue(descriptor.value, `${path}/${key}`, ancestors),
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PermissionInputError(path, "value must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PermissionInputError(path, `object fields must be ${expected.join(", ")}`);
  }
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new PermissionInputError(path, "value must be an array");
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") throw new PermissionInputError(path, "value must be a string");
  return value;
}

function sortedUnique<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
): readonly T[] {
  const sorted = [...values].sort(compare);
  return sorted.filter(
    (value, index) => index === 0 || compare(sorted[index - 1] as T, value) !== 0,
  );
}

function portableName(value: unknown, path: string): string {
  const name = stringAt(value, path);
  if (!PORTABLE_NAME.test(name)) {
    throw new PermissionInputError(path, "value must be a portable name");
  }
  return name;
}

function environmentName(value: unknown, path: string): string {
  const name = stringAt(value, path);
  if (!ENVIRONMENT_NAME.test(name)) {
    throw new PermissionInputError(path, "value must be a portable environment name");
  }
  return name;
}

function canonicalHost(value: unknown, path: string): string {
  const source = stringAt(value, path);
  if (source.includes("*") || source.includes("\0") || source.length === 0) {
    throw new PermissionInputError(path, "network host must be an exact DNS name");
  }
  const withoutDot = source.endsWith(".") ? source.slice(0, -1) : source;
  if (withoutDot.endsWith(".") || withoutDot.length === 0) {
    throw new PermissionInputError(path, "network host has an invalid trailing dot");
  }
  const ascii = domainToASCII(withoutDot).toLowerCase();
  if (
    ascii.length === 0 ||
    ascii.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(
      ascii,
    )
  ) {
    throw new PermissionInputError(path, "network host is not a valid exact DNS name");
  }
  return ascii;
}

function canonicalRoot(value: unknown, path: string): string {
  const source = stringAt(value, path);
  if (
    !source.startsWith("/") ||
    source.includes("\\") ||
    source.includes("\0") ||
    source.includes("//")
  ) {
    throw new PermissionInputError(path, "filesystem root must be an absolute POSIX logical path");
  }
  const segments = source.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    if (source !== "/") {
      throw new PermissionInputError(path, "filesystem root contains an invalid path segment");
    }
  }
  return source.length > 1 && source.endsWith("/") ? source.slice(0, -1) : source;
}

function canonicalMethods(value: unknown, path: string): readonly HttpMethod[] {
  const methods = arrayAt(value, path).map((item, index) => {
    const method = stringAt(item, `${path}/${index}`).toUpperCase() as HttpMethod;
    if (!HTTP_METHODS.has(method)) {
      throw new PermissionInputError(`${path}/${index}`, "HTTP method is not allowed");
    }
    return method;
  });
  return sortedUnique(methods, compareText);
}

function canonicalCapability(value: Record<string, unknown>, path: string): CapabilityPermission {
  exactKeys(value, ["capabilities", "kind"], path);
  const seen = new Set<string>();
  const capabilities = arrayAt(value.capabilities, `${path}/capabilities`)
    .map((item, index) => {
      const itemPath = `${path}/capabilities/${index}`;
      const entry = objectAt(item, itemPath);
      exactKeys(entry, ["methods", "name"], itemPath);
      const name = portableName(entry.name, `${itemPath}/name`);
      if (seen.has(name)) {
        throw new PermissionInputError(itemPath, "capability permission is duplicated");
      }
      seen.add(name);
      return {
        name,
        methods: sortedUnique(
          arrayAt(entry.methods, `${itemPath}/methods`).map((method, methodIndex) =>
            portableName(method, `${itemPath}/methods/${methodIndex}`),
          ),
          compareText,
        ),
      };
    })
    .sort((left, right) => compareText(left.name, right.name));
  return { kind: "capability", capabilities };
}

function canonicalExecutor(value: Record<string, unknown>, path: string): ExecutorPermission {
  exactKeys(value, ["executors", "kind"], path);
  const executors = arrayAt(value.executors, `${path}/executors`).map((item, index) => {
    if (typeof item !== "string" || !EXECUTOR_KINDS.has(item as "process")) {
      throw new PermissionInputError(`${path}/executors/${index}`, "executor kind is invalid");
    }
    return item as "process" | "remote" | "thread";
  });
  return { kind: "executor", executors: sortedUnique(executors, compareText) };
}

function canonicalNetwork(value: Record<string, unknown>, path: string): NetworkPermission {
  exactKeys(value, ["hosts", "kind", "methods", "ports"], path);
  const hosts = arrayAt(value.hosts, `${path}/hosts`).map((host, index) =>
    canonicalHost(host, `${path}/hosts/${index}`),
  );
  const ports = arrayAt(value.ports, `${path}/ports`).map((port, index) => {
    if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
      throw new PermissionInputError(`${path}/ports/${index}`, "port must be between 1 and 65535");
    }
    return port as number;
  });
  return {
    kind: "network",
    hosts: sortedUnique(hosts, compareText),
    methods: canonicalMethods(value.methods, `${path}/methods`),
    ports: sortedUnique(ports, (left, right) => left - right),
  };
}

function canonicalFilesystem(value: Record<string, unknown>, path: string): FilesystemPermission {
  exactKeys(value, ["kind", "roots"], path);
  const seen = new Set<string>();
  const roots = arrayAt(value.roots, `${path}/roots`)
    .map((item, index): FilesystemRootPermission => {
      const itemPath = `${path}/roots/${index}`;
      const entry = objectAt(item, itemPath);
      exactKeys(entry, ["access", "path"], itemPath);
      const root = canonicalRoot(entry.path, `${itemPath}/path`);
      if (seen.has(root)) throw new PermissionInputError(itemPath, "filesystem root is duplicated");
      seen.add(root);
      const access = arrayAt(entry.access, `${itemPath}/access`).map((mode, modeIndex) => {
        if (typeof mode !== "string" || !ACCESS_MODES.has(mode as FilesystemAccess)) {
          throw new PermissionInputError(
            `${itemPath}/access/${modeIndex}`,
            "access mode is invalid",
          );
        }
        return mode as FilesystemAccess;
      });
      return { path: root, access: sortedUnique(access, compareText) };
    })
    .sort((left, right) => compareText(left.path, right.path));
  return { kind: "filesystem", roots };
}

function canonicalNames(
  value: Record<string, unknown>,
  path: string,
  kind: "environment" | "secret",
): EnvironmentPermission | SecretPermission {
  exactKeys(value, ["kind", "names"], path);
  const parseName = kind === "environment" ? environmentName : portableName;
  const names = arrayAt(value.names, `${path}/names`).map((name, index) =>
    parseName(name, `${path}/names/${index}`),
  );
  return { kind, names: sortedUnique(names, compareText) };
}

function resource(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PermissionInputError(path, "resource ceiling must be a nonnegative safe integer");
  }
  return value as number;
}

function canonicalWorker(value: Record<string, unknown>, path: string): WorkerPermission {
  exactKeys(value, ["kind", "labels", "resources"], path);
  const sourceLabels = objectAt(value.labels, `${path}/labels`);
  const labels: Record<string, string> = {};
  for (const name of Object.keys(sourceLabels).sort(compareText)) {
    Object.defineProperty(labels, portableName(name, `${path}/labels/${name}`), {
      configurable: true,
      enumerable: true,
      value: portableName(sourceLabels[name], `${path}/labels/${name}`),
      writable: true,
    });
  }
  const resources = objectAt(value.resources, `${path}/resources`);
  exactKeys(resources, ["cpuMillis", "memoryBytes", "storageBytes"], `${path}/resources`);
  const ceilings: WorkerResourceCeilings = {
    cpuMillis: resource(resources.cpuMillis, `${path}/resources/cpuMillis`),
    memoryBytes: resource(resources.memoryBytes, `${path}/resources/memoryBytes`),
    storageBytes: resource(resources.storageBytes, `${path}/resources/storageBytes`),
  };
  return { kind: "worker", labels, resources: ceilings };
}

export function canonicalizePermissionSet(input: unknown): readonly Permission[] {
  const stable = clonePermissionBoundaryValue(input);
  const entries = arrayAt(stable, "$");
  const seen = new Set<string>();
  return entries
    .map((item, index): Permission => {
      const path = `$/${index}`;
      const entry = objectAt(item, path);
      const kind = stringAt(entry.kind, `${path}/kind`);
      if (seen.has(kind)) {
        throw new PermissionInputError(path, `permission kind ${kind} is duplicated`);
      }
      seen.add(kind);
      switch (kind) {
        case "capability":
          return canonicalCapability(entry, path);
        case "environment":
        case "secret":
          return canonicalNames(entry, path, kind);
        case "executor":
          return canonicalExecutor(entry, path);
        case "filesystem":
          return canonicalFilesystem(entry, path);
        case "network":
          return canonicalNetwork(entry, path);
        case "worker":
          return canonicalWorker(entry, path);
        default:
          throw new PermissionInputError(`${path}/kind`, "permission kind is invalid");
      }
    })
    .sort((left, right) => compareText(left.kind, right.kind));
}

function containsAll<T>(requested: readonly T[], granted: readonly T[]): boolean {
  return granted.every((value) => requested.includes(value));
}

export function containsLogicalPath(root: string, target: string): boolean {
  return root === "/" || target === root || target.startsWith(`${root}/`);
}

function categorySubset(requested: Permission, granted: Permission): boolean {
  if (requested.kind !== granted.kind) return false;
  switch (granted.kind) {
    case "capability": {
      const maximum = requested as CapabilityPermission;
      return granted.capabilities.every((capability) => {
        const requestedCapability = maximum.capabilities.find(
          (candidate) => candidate.name === capability.name,
        );
        return (
          requestedCapability !== undefined &&
          containsAll(requestedCapability.methods, capability.methods)
        );
      });
    }
    case "environment":
      return containsAll((requested as EnvironmentPermission).names, granted.names);
    case "executor":
      return containsAll((requested as ExecutorPermission).executors, granted.executors);
    case "filesystem": {
      const maximum = requested as FilesystemPermission;
      return granted.roots.every((root) =>
        maximum.roots.some(
          (requestedRoot) =>
            containsLogicalPath(requestedRoot.path, root.path) &&
            containsAll(requestedRoot.access, root.access),
        ),
      );
    }
    case "network": {
      const maximum = requested as NetworkPermission;
      return (
        containsAll(maximum.hosts, granted.hosts) &&
        containsAll(maximum.ports, granted.ports) &&
        containsAll(maximum.methods, granted.methods)
      );
    }
    case "secret":
      return containsAll((requested as SecretPermission).names, granted.names);
    case "worker": {
      const maximum = requested as WorkerPermission;
      return (
        JSON.stringify(maximum.labels) === JSON.stringify(granted.labels) &&
        granted.resources.cpuMillis <= maximum.resources.cpuMillis &&
        granted.resources.memoryBytes <= maximum.resources.memoryBytes &&
        granted.resources.storageBytes <= maximum.resources.storageBytes
      );
    }
  }
}

export function validatePermissionGrant(
  requestedInput: unknown,
  grantedInput: unknown,
): PermissionDecision {
  let requested: readonly Permission[];
  let granted: readonly Permission[];
  try {
    requested = canonicalizePermissionSet(requestedInput);
    granted = canonicalizePermissionSet(grantedInput);
  } catch (error) {
    const invalid =
      error instanceof PermissionInputError
        ? error
        : new PermissionInputError("$", "permission envelope is invalid");
    return {
      allowed: false,
      diagnostics: [
        {
          code: "PERMISSION_ENVELOPE_INVALID",
          message: invalid.message,
          path: invalid.path,
        },
      ],
    };
  }

  for (const permission of granted) {
    const maximum = requested.find((candidate) => candidate.kind === permission.kind);
    if (maximum === undefined || !categorySubset(maximum, permission)) {
      return {
        allowed: false,
        diagnostics: [
          {
            code: "PERMISSION_GRANT_EXCEEDS_REQUEST",
            message: `Granted ${permission.kind} permission exceeds the manifest request`,
            path: `$/granted/${permission.kind}`,
          },
        ],
        requested,
        granted,
      };
    }
  }
  return { allowed: true, diagnostics: [], requested, granted };
}
