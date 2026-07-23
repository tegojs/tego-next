import type { CapabilityName, PluginId } from "./identity.js";
import type { JsonSchema } from "./schema.js";

export interface CapabilityIdentity {
  readonly name: CapabilityName;
  readonly protocolVersion: string;
}

export interface CapabilityDefinition {
  readonly identity: CapabilityIdentity;
  readonly requestSchema: JsonSchema;
  readonly responseSchema: JsonSchema;
}

export interface CapabilityBinding {
  readonly capability: CapabilityIdentity;
  readonly providerPluginId: PluginId;
}
