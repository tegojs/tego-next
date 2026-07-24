import type { CapabilityDefinition } from "./capability.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { Permission } from "./permission.js";

export interface ComponentPermissionDiagnostic extends JsonObject {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface ComponentPermissionDecision {
  readonly allowed: boolean;
  readonly diagnostics: readonly ComponentPermissionDiagnostic[];
  readonly granted?: readonly Permission[];
}

export interface ComponentPermissionAttempt extends JsonObject {
  readonly kind: string;
  readonly name?: string;
  readonly method?: string;
}

export interface ComponentPermissionBoundary {
  validateGrant(
    requested: readonly Permission[],
    granted: readonly Permission[],
  ): ComponentPermissionDecision;
  authorize(
    granted: readonly Permission[],
    attempt: ComponentPermissionAttempt,
  ): ComponentPermissionDecision;
}

export interface ComponentCapabilityDiagnostic extends JsonObject {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
}

export interface ComponentCapabilityDecision {
  readonly allowed: boolean;
  readonly diagnostics: readonly ComponentCapabilityDiagnostic[];
  readonly value?: JsonValue;
}

export interface ComponentCapabilityRegistration {
  readonly ok: boolean;
  readonly diagnostics: readonly ComponentCapabilityDiagnostic[];
}

export interface ComponentCapabilityIdentity extends JsonObject {
  readonly name: string;
  readonly protocolVersion: string;
}

export interface ComponentCapabilityInvocation extends JsonObject {
  readonly identity: ComponentCapabilityIdentity;
  readonly method: string;
  readonly input: JsonValue;
}

export interface ComponentCapabilityBoundary {
  register(definitions: readonly CapabilityDefinition[]): ComponentCapabilityRegistration;
  request(identity: ComponentCapabilityIdentity, input: JsonValue): ComponentCapabilityDecision;
  invoke(request: ComponentCapabilityInvocation): Promise<unknown>;
  response(identity: ComponentCapabilityIdentity, input: JsonValue): ComponentCapabilityDecision;
  clear(): void;
}

export interface ComponentBoundaries {
  readonly permission: ComponentPermissionBoundary;
  readonly capability: ComponentCapabilityBoundary;
}
