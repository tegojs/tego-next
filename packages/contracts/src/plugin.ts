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

export interface PluginComponent {
  readonly componentId: ComponentId;
  readonly kind: ComponentKind;
  readonly entrypoint: string;
  readonly executors: readonly ExecutorKind[];
}

export interface PluginCapabilitySet {
  readonly provides: readonly {
    readonly name: string;
    readonly protocolVersion: string;
  }[];
  readonly requires: readonly {
    readonly name: string;
    readonly protocolRange: string;
    readonly optional?: boolean;
    readonly lossPolicy?: "degrade" | "fail" | "suspend";
  }[];
}

export interface PluginManifest {
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

export interface PluginInstallation {
  readonly pluginId: PluginId;
  readonly version: string;
  readonly digest: ArtifactDigest;
  readonly manifest: PluginManifest;
  readonly installedAt: string;
  readonly signature?: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly verified: boolean;
  };
}

export type PluginDeploymentState = "active" | "disabled";

export interface PluginDeployment {
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
