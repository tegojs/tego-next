import type {
  ApplicationId,
  ArtifactDigest,
  ComponentId,
  Generation,
  PluginId,
} from "./identity.js";
import type { JsonObject, JsonValue } from "./json.js";

export type PluginModuleFormat = "esm";
export type ComponentKind = "service" | "task";
export type ExecutorKind = "process" | "remote" | "thread";

export interface PluginComponent extends JsonObject {
  readonly componentId: ComponentId;
  readonly kind: ComponentKind;
  readonly entrypoint: string;
  readonly executors: readonly ExecutorKind[];
}

export interface PluginCapabilityProvision extends JsonObject {
  readonly name: string;
  readonly protocolVersion: string;
}

export interface PluginCapabilityRequirement extends JsonObject {
  readonly name: string;
  readonly protocolRange: string;
  readonly optional?: boolean;
  readonly lossPolicy?: "degrade" | "fail" | "suspend";
}

export interface PluginCapabilitySet extends JsonObject {
  readonly provides: readonly PluginCapabilityProvision[];
  readonly requires: readonly PluginCapabilityRequirement[];
}

export interface PluginManifest extends JsonObject {
  readonly schemaVersion: "1.0";
  readonly pluginId: PluginId;
  readonly version: string;
  readonly contractRange: string;
  readonly nodeRange: string;
  readonly moduleFormat: PluginModuleFormat;
  readonly architectures?: readonly string[];
  readonly components: readonly PluginComponent[];
  readonly permissions: readonly string[];
  readonly capabilities: PluginCapabilitySet;
  readonly metadata?: JsonObject;
}

export interface PluginSignature extends JsonObject {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly verified: boolean;
}

export interface PluginInstallation extends JsonObject {
  readonly pluginId: PluginId;
  readonly version: string;
  readonly digest: ArtifactDigest;
  readonly manifest: PluginManifest;
  readonly installedAt: string;
  readonly signature?: PluginSignature;
}

export type PluginDeploymentState = "active" | "disabled";

export interface PluginDeployment extends JsonObject {
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly version: string;
  readonly artifactDigest: ArtifactDigest;
  readonly generation: Generation;
  readonly state: PluginDeploymentState;
  readonly essential: boolean;
  readonly configuration: JsonValue;
  readonly permissionGrants: readonly string[];
  readonly capabilityBindings: Readonly<Record<string, PluginId>>;
}
