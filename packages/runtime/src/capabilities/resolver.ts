import type {
  CapabilityName,
  Generation,
  JsonObject,
  PluginCapabilityProvision,
  PluginCapabilityRequirement,
  PluginDeploymentIdentity,
} from "@tegojs/contracts";
import type { Activation } from "../reconcile/plan.js";
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
  readonly previousBindings?: readonly PreviousCapabilityBinding[];
}

export type CapabilityResolutionDiagnosticCode =
  | "CAPABILITY_AMBIGUOUS"
  | "CAPABILITY_BINDING_MAP_INVALID"
  | "CAPABILITY_BINDING_UNKNOWN"
  | "CAPABILITY_DUPLICATE_DEPLOYMENT"
  | "CAPABILITY_DUPLICATE_PROVIDER"
  | "CAPABILITY_DUPLICATE_PREVIOUS_BINDING"
  | "CAPABILITY_DUPLICATE_REQUIREMENT"
  | "CAPABILITY_EXPLICIT_PROVIDER_INCOMPATIBLE"
  | "CAPABILITY_EXPLICIT_PROVIDER_MISSING"
  | "CAPABILITY_EXPLICIT_PROVIDER_UNREADY"
  | "CAPABILITY_INPUT_INVALID"
  | "CAPABILITY_PROTOCOL_RANGE_INVALID"
  | "CAPABILITY_PROTOCOL_VERSION_INVALID"
  | "CAPABILITY_REQUIRED_CYCLE"
  | "CAPABILITY_REQUIRED_MISSING"
  | "CAPABILITY_REQUIRED_UNAVAILABLE";

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

export interface PreviousCapabilityBinding extends JsonObject {
  readonly consumer: PluginDeploymentIdentity;
  readonly capability: CapabilityName;
  readonly provider: PluginDeploymentIdentity;
}

export interface ProviderLossDecision extends JsonObject {
  readonly action: "degrade" | "fail" | "suspend";
  readonly capability: CapabilityName;
  readonly consumer: PluginDeploymentIdentity;
  readonly provider: PluginDeploymentIdentity;
}

export type ProviderLossAction = ProviderLossDecision["action"];

export interface ProviderRecoveryBindingPrerequisite extends JsonObject {
  readonly capability: CapabilityName;
  readonly provider: PluginDeploymentIdentity;
  readonly providerGeneration: Generation;
}

export interface PersistedProviderLoss extends JsonObject {
  readonly consumer: PluginDeploymentIdentity;
  readonly deploymentGeneration: Generation;
  readonly action: ProviderLossAction;
  readonly capabilities: readonly CapabilityName[];
  readonly providers: readonly PluginDeploymentIdentity[];
  readonly bindingPrerequisites?: readonly ProviderRecoveryBindingPrerequisite[];
  readonly recoveryActivations?: Readonly<Record<string, Activation>>;
  readonly updatedAt: string;
}

const providerLossRank: Readonly<Record<ProviderLossAction, number>> = {
  degrade: 1,
  suspend: 2,
  fail: 3,
};

export function strongestProviderLoss(
  actions: readonly ProviderLossDecision[],
): ProviderLossAction | undefined {
  return actions.reduce<ProviderLossAction | undefined>(
    (strongest, decision) =>
      strongest === undefined || providerLossRank[decision.action] > providerLossRank[strongest]
        ? decision.action
        : strongest,
    undefined,
  );
}

export interface ResolutionResult extends JsonObject {
  readonly ok: boolean;
  readonly diagnostics: readonly CapabilityResolutionDiagnostic[];
  readonly providerLossActions: readonly ProviderLossDecision[];
  readonly bindings?: readonly ResolvedCapabilityBinding[];
  readonly order?: readonly PluginDeploymentIdentity[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class ResolutionInputError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

function cloneResolutionBoundary(
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
    throw new ResolutionInputError(path, "Capability resolution input must be finite JSON data");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new ResolutionInputError(path, "Capability resolution arrays must be ordinary");
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new ResolutionInputError(
            `${path}/${index}`,
            "Array element must be a data property",
          );
        }
        result.push(cloneResolutionBoundary(descriptor.value, `${path}/${index}`, ancestors));
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
        throw new ResolutionInputError(path, "Extended arrays are not supported");
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ResolutionInputError(path, "Capability resolution objects must be plain");
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value).sort((left, right) =>
      compareText(String(left), String(right)),
    )) {
      if (typeof key !== "string") {
        throw new ResolutionInputError(path, "Symbol properties are not supported");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new ResolutionInputError(`${path}/${key}`, "Object field must be a data property");
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneResolutionBoundary(descriptor.value, `${path}/${key}`, ancestors),
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function ownBinding(
  bindings: Readonly<Record<string, PluginDeploymentIdentity>>,
  name: string,
): PluginDeploymentIdentity | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(bindings, name);
  if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
  return descriptor.value;
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
  previousBindings: readonly PreviousCapabilityBinding[],
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
    } else {
      seenDeployments.add(key);
    }

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
  const seenPrevious = new Set<string>();
  for (const binding of previousBindings) {
    const key = `${identityKey(binding.consumer)}/${binding.capability}`;
    if (seenPrevious.has(key)) {
      diagnostics.push(
        diagnostic(
          "CAPABILITY_DUPLICATE_PREVIOUS_BINDING",
          "Capability resolution input contains a duplicate previous binding",
          binding.consumer,
          binding.capability,
          [binding.provider],
        ),
      );
    }
    seenPrevious.add(key);
  }
  return diagnostics.sort(compareDiagnostic);
}

function compatibleProvisions(
  deployment: CapabilityResolutionDeployment,
  requirement: NormalizedCapabilityRequirement,
): readonly PluginCapabilityProvision[] {
  return deployment.provides
    .filter(
      (provided) =>
        provided.name === requirement.name &&
        satisfiesVersionRange(provided.protocolVersion, requirement.protocolRange),
    )
    .sort((left, right) => compareText(left.protocolVersion, right.protocolVersion));
}

function providerLossDecisions(
  previousBindings: readonly PreviousCapabilityBinding[],
  byIdentity: ReadonlyMap<string, CapabilityResolutionDeployment>,
): readonly ProviderLossDecision[] {
  const actions: ProviderLossDecision[] = [];
  for (const previous of previousBindings) {
    const consumer = byIdentity.get(identityKey(previous.consumer));
    const requirementSource = consumer?.requires.find(
      (candidate) => candidate.name === previous.capability,
    );
    if (consumer?.ready !== true || requirementSource === undefined) continue;
    const explicit = ownBinding(consumer.bindings, previous.capability);
    if (explicit !== undefined && identityKey(explicit) !== identityKey(previous.provider)) {
      continue;
    }
    const requirement = normalizeRequirement(requirementSource);
    const provider = byIdentity.get(identityKey(previous.provider));
    const available =
      provider?.ready === true && compatibleProvisions(provider, requirement).length > 0;
    if (!available) {
      actions.push({
        action: requirement.lossPolicy,
        capability: requirement.name,
        consumer: consumer.identity,
        provider: previous.provider,
      });
    }
  }
  return actions.sort(
    (left, right) =>
      compareIdentity(left.consumer, right.consumer) ||
      compareText(left.capability, right.capability) ||
      compareIdentity(left.provider, right.provider) ||
      compareText(left.action, right.action),
  );
}

export function resolveCapabilities(input: CapabilityResolutionInput): ResolutionResult {
  let stableInput: CapabilityResolutionInput;
  try {
    stableInput = cloneResolutionBoundary(input) as CapabilityResolutionInput;
  } catch (error) {
    const invalid =
      error instanceof ResolutionInputError
        ? error
        : new ResolutionInputError("$", "Capability resolution input is invalid");
    const bindingFailure = invalid.path.includes("/bindings");
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          bindingFailure ? "CAPABILITY_BINDING_MAP_INVALID" : "CAPABILITY_INPUT_INVALID",
          invalid.message,
        ),
      ],
      providerLossActions: [],
    };
  }
  const deployments = [...stableInput.deployments].sort((left, right) =>
    compareIdentity(left.identity, right.identity),
  );
  const previousBindings = [...(stableInput.previousBindings ?? [])];
  const diagnostics = inputDiagnostics(deployments, previousBindings);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics, providerLossActions: [] };
  }

  const byIdentity = new Map(
    deployments.map((deployment) => [identityKey(deployment.identity), deployment]),
  );
  const previousByRequirement = new Map(
    previousBindings.map((binding) => [
      `${identityKey(binding.consumer)}/${binding.capability}`,
      binding,
    ]),
  );
  const bindings: ResolvedCapabilityBinding[] = [];
  const requiredOutgoing = new Map<string, Set<string>>(
    deployments.map((deployment) => [identityKey(deployment.identity), new Set<string>()]),
  );
  const optionalEdges: Array<readonly [string, string]> = [];
  const providerLossActions = providerLossDecisions(previousBindings, byIdentity);

  for (const consumer of deployments) {
    for (const sourceRequirement of [...consumer.requires].sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      const requirement = normalizeRequirement(sourceRequirement);
      const persisted = previousByRequirement.get(
        `${identityKey(consumer.identity)}/${requirement.name}`,
      );
      const explicit = ownBinding(consumer.bindings, requirement.name);
      const selectedIdentity = explicit ?? persisted?.provider;
      let provider: CapabilityResolutionDeployment | undefined;

      if (selectedIdentity !== undefined) {
        provider = byIdentity.get(identityKey(selectedIdentity));
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
              [selectedIdentity],
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
        if (compatibleProvisions(provider, requirement).length === 0) {
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
          if (explicit === undefined && persisted !== undefined) {
            bindings.push({ consumer: consumer.identity, requirement, provider: null });
            if (!requirement.optional) {
              requiredOutgoing
                .get(identityKey(provider.identity))
                ?.add(identityKey(consumer.identity));
            }
            continue;
          }
          diagnostics.push(
            diagnostic(
              "CAPABILITY_EXPLICIT_PROVIDER_UNREADY",
              "Explicit capability provider is not ready",
              consumer.identity,
              requirement.name,
              [provider.identity],
            ),
          );
        }
      } else {
        const compatible = deployments.filter(
          (provider) =>
            provider.identity.applicationId === consumer.identity.applicationId &&
            compatibleProvisions(provider, requirement).length > 0,
        );
        if (compatible.length === 0) {
          if (requirement.optional) {
            bindings.push({ consumer: consumer.identity, requirement, provider: null });
          } else {
            diagnostics.push(
              diagnostic(
                "CAPABILITY_REQUIRED_MISSING",
                "No compatible provider satisfies the required capability",
                consumer.identity,
                requirement.name,
              ),
            );
          }
          continue;
        }
        const ready = compatible.filter((candidate) => candidate.ready);
        if (ready.length > 1) {
          diagnostics.push(
            diagnostic(
              "CAPABILITY_AMBIGUOUS",
              "Multiple ready compatible providers satisfy the capability",
              consumer.identity,
              requirement.name,
              ready.map((candidate) => candidate.identity),
            ),
          );
          continue;
        }
        if (ready.length === 1) {
          provider = ready[0];
        } else if (compatible.length === 1) {
          provider = compatible[0];
          if (!requirement.optional) {
            diagnostics.push(
              diagnostic(
                "CAPABILITY_REQUIRED_UNAVAILABLE",
                "Compatible providers exist but none are ready",
                consumer.identity,
                requirement.name,
                compatible.map((candidate) => candidate.identity),
              ),
            );
          }
        } else {
          if (!requirement.optional) {
            diagnostics.push(
              diagnostic(
                "CAPABILITY_REQUIRED_UNAVAILABLE",
                "Compatible providers exist but none are ready",
                consumer.identity,
                requirement.name,
                compatible.map((candidate) => candidate.identity),
              ),
            );
          }
          bindings.push({ consumer: consumer.identity, requirement, provider: null });
          continue;
        }
      }

      if (provider === undefined) continue;
      const provision = compatibleProvisions(provider, requirement)[0];
      if (provision === undefined) continue;
      if (provider.ready) {
        bindings.push({
          consumer: consumer.identity,
          requirement,
          provider: { deployment: provider.identity, capability: provision },
        });
      } else if (requirement.optional) {
        bindings.push({ consumer: consumer.identity, requirement, provider: null });
      }
      if (!requirement.optional) {
        requiredOutgoing.get(identityKey(provider.identity))?.add(identityKey(consumer.identity));
      } else if (provider.ready) {
        optionalEdges.push([identityKey(provider.identity), identityKey(consumer.identity)]);
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
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics, providerLossActions };
  }

  const reachable = (start: string, target: string): boolean => {
    const pending = [start];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(requiredOutgoing.get(current) ?? []));
    }
    return false;
  };
  for (const [provider, consumer] of optionalEdges.sort(
    (left, right) => compareText(left[0], right[0]) || compareText(left[1], right[1]),
  )) {
    if (provider !== consumer && !reachable(consumer, provider)) {
      requiredOutgoing.get(provider)?.add(consumer);
    }
  }

  const order = topologicalOrder(graph, compareText);
  if (order === undefined) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("CAPABILITY_REQUIRED_CYCLE", "Required capability dependencies form a cycle"),
      ],
      providerLossActions,
    };
  }
  return {
    ok: true,
    diagnostics: [],
    bindings,
    order: order
      .map((key) => byIdentity.get(key)?.identity)
      .filter((identity): identity is PluginDeploymentIdentity => identity !== undefined),
    providerLossActions,
  };
}
