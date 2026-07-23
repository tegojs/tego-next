import type {
  CapabilityName,
  JsonObject,
  PluginCapabilityProvision,
  PluginCapabilityRequirement,
  PluginDeploymentIdentity,
} from "@tegojs/contracts";
import { stronglyConnectedComponents, topologicalOrder } from "./graph.js";
import { isValidVersion, isValidVersionRange, satisfiesVersionRange } from "./version.js";

export interface CapabilityResolutionDeployment extends JsonObject {
  readonly identity: PluginDeploymentIdentity;
  readonly ready: boolean;
  readonly provides: readonly PluginCapabilityProvision[];
  readonly requires: readonly PluginCapabilityRequirement[];
  readonly bindings: Readonly<Record<string, PluginDeploymentIdentity>>;
}

export interface CapabilityResolutionInput {
  readonly deployments: readonly CapabilityResolutionDeployment[];
}

export type CapabilityResolutionDiagnosticCode =
  | "CAPABILITY_AMBIGUOUS"
  | "CAPABILITY_BINDING_UNKNOWN"
  | "CAPABILITY_DUPLICATE_DEPLOYMENT"
  | "CAPABILITY_DUPLICATE_PROVIDER"
  | "CAPABILITY_DUPLICATE_REQUIREMENT"
  | "CAPABILITY_EXPLICIT_PROVIDER_INCOMPATIBLE"
  | "CAPABILITY_EXPLICIT_PROVIDER_MISSING"
  | "CAPABILITY_EXPLICIT_PROVIDER_UNREADY"
  | "CAPABILITY_PROTOCOL_RANGE_INVALID"
  | "CAPABILITY_PROTOCOL_VERSION_INVALID"
  | "CAPABILITY_REQUIRED_CYCLE"
  | "CAPABILITY_REQUIRED_MISSING";

export interface CapabilityResolutionDiagnostic extends JsonObject {
  readonly code: CapabilityResolutionDiagnosticCode;
  readonly message: string;
  readonly consumer: PluginDeploymentIdentity | null;
  readonly capability: CapabilityName | null;
  readonly candidates: readonly PluginDeploymentIdentity[];
}

export interface ResolvedCapabilityProvider extends JsonObject {
  readonly deployment: PluginDeploymentIdentity;
  readonly capability: PluginCapabilityProvision;
}

export interface NormalizedCapabilityRequirement extends JsonObject {
  readonly name: CapabilityName;
  readonly protocolRange: string;
  readonly optional: boolean;
  readonly lossPolicy: "degrade" | "fail" | "suspend";
}

export interface ResolvedCapabilityBinding extends JsonObject {
  readonly consumer: PluginDeploymentIdentity;
  readonly requirement: NormalizedCapabilityRequirement;
  readonly provider: ResolvedCapabilityProvider | null;
}

export interface ResolutionResult extends JsonObject {
  readonly ok: boolean;
  readonly diagnostics: readonly CapabilityResolutionDiagnostic[];
  readonly bindings?: readonly ResolvedCapabilityBinding[];
  readonly order?: readonly PluginDeploymentIdentity[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identityKey(identity: PluginDeploymentIdentity): string {
  return `${identity.applicationId}/${identity.pluginId}`;
}

function compareIdentity(left: PluginDeploymentIdentity, right: PluginDeploymentIdentity): number {
  return (
    compareText(left.applicationId, right.applicationId) ||
    compareText(left.pluginId, right.pluginId)
  );
}

function sameIdentity(left: PluginDeploymentIdentity, right: PluginDeploymentIdentity): boolean {
  return left.applicationId === right.applicationId && left.pluginId === right.pluginId;
}

function diagnostic(
  code: CapabilityResolutionDiagnosticCode,
  message: string,
  consumer: PluginDeploymentIdentity | null = null,
  capability: CapabilityName | null = null,
  candidates: readonly PluginDeploymentIdentity[] = [],
): CapabilityResolutionDiagnostic {
  return {
    code,
    message,
    consumer,
    capability,
    candidates: [...candidates].sort(compareIdentity),
  };
}

function compareDiagnostic(
  left: CapabilityResolutionDiagnostic,
  right: CapabilityResolutionDiagnostic,
): number {
  return (
    compareText(left.code, right.code) ||
    compareText(
      left.consumer === null ? "" : identityKey(left.consumer),
      right.consumer === null ? "" : identityKey(right.consumer),
    ) ||
    compareText(left.capability ?? "", right.capability ?? "")
  );
}

function normalizeRequirement(
  requirement: PluginCapabilityRequirement,
): NormalizedCapabilityRequirement {
  return {
    name: requirement.name as CapabilityName,
    protocolRange: requirement.protocolRange,
    optional: requirement.optional ?? false,
    lossPolicy: requirement.lossPolicy ?? "fail",
  };
}

function inputDiagnostics(
  deployments: readonly CapabilityResolutionDeployment[],
): CapabilityResolutionDiagnostic[] {
  const diagnostics: CapabilityResolutionDiagnostic[] = [];
  const seenDeployments = new Set<string>();
  for (const deployment of [...deployments].sort((left, right) =>
    compareIdentity(left.identity, right.identity),
  )) {
    const key = identityKey(deployment.identity);
    if (seenDeployments.has(key)) {
      diagnostics.push(
        diagnostic(
          "CAPABILITY_DUPLICATE_DEPLOYMENT",
          "Capability resolution input contains a duplicate deployment",
          deployment.identity,
        ),
      );
      continue;
    }
    seenDeployments.add(key);

    const providers = new Set<string>();
    for (const provider of deployment.provides) {
      const providerKey = `${provider.name}@${provider.protocolVersion}`;
      if (providers.has(providerKey)) {
        diagnostics.push(
          diagnostic(
            "CAPABILITY_DUPLICATE_PROVIDER",
            "Deployment contains a duplicate capability provider",
            deployment.identity,
            provider.name as CapabilityName,
          ),
        );
      }
      providers.add(providerKey);
      if (!isValidVersion(provider.protocolVersion)) {
        diagnostics.push(
          diagnostic(
            "CAPABILITY_PROTOCOL_VERSION_INVALID",
            "Capability provider protocol version is invalid",
            deployment.identity,
            provider.name as CapabilityName,
          ),
        );
      }
    }

    const requirements = new Set<string>();
    for (const requirement of deployment.requires) {
      if (requirements.has(requirement.name)) {
        diagnostics.push(
          diagnostic(
            "CAPABILITY_DUPLICATE_REQUIREMENT",
            "Deployment contains a duplicate capability requirement",
            deployment.identity,
            requirement.name as CapabilityName,
          ),
        );
      }
      requirements.add(requirement.name);
      if (!isValidVersionRange(requirement.protocolRange)) {
        diagnostics.push(
          diagnostic(
            "CAPABILITY_PROTOCOL_RANGE_INVALID",
            "Capability requirement protocol range is invalid",
            deployment.identity,
            requirement.name as CapabilityName,
          ),
        );
      }
    }
    for (const bindingName of Object.keys(deployment.bindings)) {
      if (!requirements.has(bindingName)) {
        diagnostics.push(
          diagnostic(
            "CAPABILITY_BINDING_UNKNOWN",
            "Explicit capability binding has no matching requirement",
            deployment.identity,
            bindingName as CapabilityName,
          ),
        );
      }
    }
  }
  return diagnostics.sort(compareDiagnostic);
}

export function resolveCapabilities(input: CapabilityResolutionInput): ResolutionResult {
  const deployments = [...input.deployments].sort((left, right) =>
    compareIdentity(left.identity, right.identity),
  );
  const diagnostics = inputDiagnostics(deployments);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const byIdentity = new Map(
    deployments.map((deployment) => [identityKey(deployment.identity), deployment]),
  );
  const bindings: ResolvedCapabilityBinding[] = [];
  const requiredOutgoing = new Map<string, Set<string>>(
    deployments.map((deployment) => [identityKey(deployment.identity), new Set<string>()]),
  );

  for (const consumer of deployments) {
    for (const sourceRequirement of [...consumer.requires].sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      const requirement = normalizeRequirement(sourceRequirement);
      const explicit = consumer.bindings[requirement.name];
      let candidates: CapabilityResolutionDeployment[] = [];

      if (explicit !== undefined) {
        const provider = byIdentity.get(identityKey(explicit));
        if (
          provider === undefined ||
          provider.identity.applicationId !== consumer.identity.applicationId
        ) {
          diagnostics.push(
            diagnostic(
              "CAPABILITY_EXPLICIT_PROVIDER_MISSING",
              "Explicit capability provider does not exist in the consumer application",
              consumer.identity,
              requirement.name,
              [explicit],
            ),
          );
          continue;
        }
        const matching = provider.provides.filter((provided) => provided.name === requirement.name);
        if (matching.length === 0) {
          diagnostics.push(
            diagnostic(
              "CAPABILITY_EXPLICIT_PROVIDER_MISSING",
              "Explicit deployment does not provide the required capability",
              consumer.identity,
              requirement.name,
              [provider.identity],
            ),
          );
          continue;
        }
        if (
          !matching.some((provided) =>
            satisfiesVersionRange(provided.protocolVersion, requirement.protocolRange),
          )
        ) {
          diagnostics.push(
            diagnostic(
              "CAPABILITY_EXPLICIT_PROVIDER_INCOMPATIBLE",
              "Explicit capability provider has no compatible protocol version",
              consumer.identity,
              requirement.name,
              [provider.identity],
            ),
          );
          continue;
        }
        if (!provider.ready) {
          diagnostics.push(
            diagnostic(
              "CAPABILITY_EXPLICIT_PROVIDER_UNREADY",
              "Explicit capability provider is not ready",
              consumer.identity,
              requirement.name,
              [provider.identity],
            ),
          );
          continue;
        }
        candidates = [provider];
      } else {
        candidates = deployments.filter(
          (provider) =>
            provider.identity.applicationId === consumer.identity.applicationId &&
            provider.ready &&
            provider.provides.some(
              (provided) =>
                provided.name === requirement.name &&
                satisfiesVersionRange(provided.protocolVersion, requirement.protocolRange),
            ),
        );
      }

      if (candidates.length === 0) {
        if (requirement.optional) {
          bindings.push({ consumer: consumer.identity, requirement, provider: null });
        } else {
          diagnostics.push(
            diagnostic(
              "CAPABILITY_REQUIRED_MISSING",
              "No ready compatible provider satisfies the required capability",
              consumer.identity,
              requirement.name,
            ),
          );
        }
        continue;
      }
      if (candidates.length > 1) {
        diagnostics.push(
          diagnostic(
            "CAPABILITY_AMBIGUOUS",
            "Multiple ready compatible providers satisfy the capability",
            consumer.identity,
            requirement.name,
            candidates.map((candidate) => candidate.identity),
          ),
        );
        continue;
      }

      const provider = candidates[0];
      if (provider === undefined) continue;
      const provision = provider.provides
        .filter(
          (provided) =>
            provided.name === requirement.name &&
            satisfiesVersionRange(provided.protocolVersion, requirement.protocolRange),
        )
        .sort((left, right) => compareText(left.protocolVersion, right.protocolVersion))[0];
      if (provision === undefined) continue;
      bindings.push({
        consumer: consumer.identity,
        requirement,
        provider: { deployment: provider.identity, capability: provision },
      });
      if (!requirement.optional) {
        requiredOutgoing.get(identityKey(provider.identity))?.add(identityKey(consumer.identity));
      }
    }
  }

  const keys = deployments.map((deployment) => identityKey(deployment.identity));
  const graph = { nodes: keys, outgoing: requiredOutgoing };
  const cycles = stronglyConnectedComponents(graph, compareText).filter((component) => {
    if (component.length > 1) return true;
    const only = component[0];
    return only !== undefined && requiredOutgoing.get(only)?.has(only) === true;
  });
  for (const cycle of cycles) {
    diagnostics.push(
      diagnostic(
        "CAPABILITY_REQUIRED_CYCLE",
        "Required capability dependencies form a cycle",
        null,
        null,
        cycle
          .map((key) => byIdentity.get(key)?.identity)
          .filter((identity): identity is PluginDeploymentIdentity => identity !== undefined),
      ),
    );
  }

  diagnostics.sort(compareDiagnostic);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const order = topologicalOrder(graph, compareText);
  if (order === undefined) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("CAPABILITY_REQUIRED_CYCLE", "Required capability dependencies form a cycle"),
      ],
    };
  }
  return {
    ok: true,
    diagnostics: [],
    bindings,
    order: order
      .map((key) => byIdentity.get(key)?.identity)
      .filter((identity): identity is PluginDeploymentIdentity => identity !== undefined),
  };
}

export function providerLossAction(
  policy: PluginCapabilityRequirement["lossPolicy"],
): "degrade" | "fail" | "suspend" {
  return policy ?? "fail";
}
