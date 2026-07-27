import type { CapabilityName } from "./identity.js";
import type { JsonObject } from "./json.js";
import type { PluginDeploymentIdentity } from "./plugin.js";
import type { JsonSchema } from "./schema.js";

export interface CapabilityIdentity extends JsonObject {
  readonly name: CapabilityName;
  readonly protocolVersion: string;
}

export interface CapabilityDefinition extends JsonObject {
  readonly identity: CapabilityIdentity;
  readonly methods: readonly string[];
  readonly requestSchema: JsonSchema;
  readonly responseSchema: JsonSchema;
}

export interface CapabilityBinding extends JsonObject {
  readonly capability: CapabilityIdentity;
  readonly providerDeployment: PluginDeploymentIdentity;
}
