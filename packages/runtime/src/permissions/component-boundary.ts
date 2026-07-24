import type {
  ComponentBoundaries,
  ComponentCapabilityDecision,
  ComponentCapabilityIdentity,
  ComponentCapabilityInvocation,
  JsonValue,
} from "@tegojs/contracts";
import {
  CapabilitySchemaRegistry,
  gateCapabilityRequest,
  gateCapabilityResponse,
  gatePermission,
  type CapabilitySchemaGate,
} from "./gate.js";
import { validatePermissionGrant } from "./permission-set.js";

export interface CreateComponentBoundariesOptions {
  readonly invoke: (request: ComponentCapabilityInvocation) => Promise<unknown>;
}

function identityKey(identity: ComponentCapabilityIdentity): string {
  return JSON.stringify([identity.name, identity.protocolVersion]);
}

function missingGate(identity: ComponentCapabilityIdentity): ComponentCapabilityDecision {
  return {
    allowed: false,
    diagnostics: [
      {
        code: "CAPABILITY_PAYLOAD_INVALID",
        message: `Capability ${identity.name}@${identity.protocolVersion} is not registered`,
      },
    ],
  };
}

export function createComponentBoundaries(
  options: CreateComponentBoundariesOptions,
): ComponentBoundaries {
  const registry = new CapabilitySchemaRegistry();
  const gates = new Map<string, CapabilitySchemaGate>();
  return {
    permission: {
      validateGrant: (requested, granted) => validatePermissionGrant(requested, granted),
      authorize: (granted, attempt) => gatePermission(granted, attempt),
    },
    capability: {
      register(definitions) {
        for (const definition of definitions) {
          const registration = registry.register(definition);
          if (!registration.ok || registration.gate === undefined) {
            registry.clear();
            gates.clear();
            return {
              ok: false,
              diagnostics: registration.diagnostics,
            };
          }
          gates.set(identityKey(registration.gate.definition.identity), registration.gate);
        }
        return { ok: true, diagnostics: [] };
      },
      request(identity, input) {
        const gate = gates.get(identityKey(identity));
        return gate === undefined ? missingGate(identity) : gateCapabilityRequest(gate, input);
      },
      invoke: (request) => options.invoke(request),
      response(identity, input: JsonValue) {
        const gate = gates.get(identityKey(identity));
        return gate === undefined ? missingGate(identity) : gateCapabilityResponse(gate, input);
      },
      clear() {
        gates.clear();
        registry.clear();
      },
    },
  };
}
