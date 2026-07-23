import type { ExecutorKind } from "./plugin.js";
import type { JsonObject } from "./json.js";

export type CapabilityMethod = string;
export type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
export type FilesystemAccess = "read" | "write";

export interface CapabilityPermissionEntry extends JsonObject {
  readonly name: string;
  readonly methods: readonly CapabilityMethod[];
}

export interface CapabilityPermission extends JsonObject {
  readonly kind: "capability";
  readonly capabilities: readonly CapabilityPermissionEntry[];
}

export interface ExecutorPermission extends JsonObject {
  readonly kind: "executor";
  readonly executors: readonly ExecutorKind[];
}

export interface NetworkPermission extends JsonObject {
  readonly kind: "network";
  readonly hosts: readonly string[];
  readonly ports: readonly number[];
  readonly methods: readonly HttpMethod[];
}

export interface FilesystemRootPermission extends JsonObject {
  readonly path: string;
  readonly access: readonly FilesystemAccess[];
}

export interface FilesystemPermission extends JsonObject {
  readonly kind: "filesystem";
  readonly roots: readonly FilesystemRootPermission[];
}

export interface SecretPermission extends JsonObject {
  readonly kind: "secret";
  readonly names: readonly string[];
}

export interface EnvironmentPermission extends JsonObject {
  readonly kind: "environment";
  readonly names: readonly string[];
}

export interface WorkerResourceCeilings extends JsonObject {
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly storageBytes: number;
}

export interface WorkerPermission extends JsonObject {
  readonly kind: "worker";
  readonly labels: Readonly<Record<string, string>>;
  readonly resources: WorkerResourceCeilings;
}

export type Permission =
  | CapabilityPermission
  | EnvironmentPermission
  | ExecutorPermission
  | FilesystemPermission
  | NetworkPermission
  | SecretPermission
  | WorkerPermission;
