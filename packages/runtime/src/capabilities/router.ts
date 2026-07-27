import { createHash } from "node:crypto";
import {
  type ApplicationId,
  type CapabilityBinding,
  type CapabilityDefinition,
  type CapabilityIdentity,
  type ComponentCapabilityIdentity,
  type ComponentId,
  DiagnosticError,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type OperationId,
  type Permission,
  type PluginId,
  parseCapabilityName,
  parseComponentId,
  parseOperationId,
  type RuntimeDiagnostic,
  runtimeDiagnostic,
  type StateKey,
  type StateStore,
  serializeWireValue,
  type TaskExecutionTarget,
} from "@tegojs/contracts";
import {
  type CapabilitySchemaGate,
  CapabilitySchemaRegistry,
  gateCapabilityRequest,
  gateCapabilityResponse,
  gatePermission,
} from "../permissions/gate.js";
import type { Activation } from "../reconcile/plan.js";

export interface ComponentInstanceIdentity extends JsonObject {
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly componentId: ComponentId;
  readonly activation: Activation;
  readonly target: TaskExecutionTarget;
  readonly bindingFingerprint: string;
}

export interface RoutedCapabilityInvocation extends JsonObject {
  readonly invocationId: OperationId | string;
  readonly identity: ComponentCapabilityIdentity;
  readonly method: string;
  readonly input: JsonValue;
}

export interface CapabilityProvisionRoute extends JsonObject {
  readonly identity: CapabilityIdentity;
  readonly componentId: ComponentId;
  readonly methods: readonly string[];
  readonly requestSchema: JsonSchema;
  readonly responseSchema: JsonSchema;
}

export interface CapabilityProviderRoute extends JsonObject {
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly componentId: ComponentId;
  readonly target: TaskExecutionTarget;
  readonly activation: Activation;
  readonly bindingFingerprint: string;
}

export interface CapabilityRoute extends JsonObject {
  readonly consumer: ComponentInstanceIdentity;
  readonly consumerBindingFingerprint: string;
  readonly permissionGrants: readonly Permission[];
  readonly binding: CapabilityBinding;
  readonly provision: CapabilityProvisionRoute;
  readonly provider: CapabilityProviderRoute;
  /**
   * Opaque durable revision/fingerprint covering the consumer binding and exact provider
   * activation. It is revalidated immediately before provider dispatch.
   */
  readonly routeRevision: string;
}

export interface CapabilityRouterOptions {
  readonly state: StateStore;
  readonly resolve: (
    consumer: ComponentInstanceIdentity,
    call: RoutedCapabilityInvocation,
  ) => Promise<CapabilityRoute>;
  readonly revalidate: (route: CapabilityRoute) => Promise<boolean>;
  readonly dispatch: (
    route: CapabilityRoute,
    call: RoutedCapabilityInvocation,
  ) => Promise<JsonValue>;
  readonly maxInvocations?: number;
  readonly maxSchemaGates?: number;
}

interface InvocationEntry {
  readonly fingerprint: string;
  readonly result: Promise<JsonValue>;
  settled: boolean;
}

interface DurableInvocationRecord extends JsonObject {
  readonly operationId: OperationId;
  readonly fingerprint: string;
  readonly status: "completed" | "executing" | "failed";
  readonly result?: JsonValue;
  readonly diagnostic?: RuntimeDiagnostic;
}

interface SchemaEntry {
  readonly registry: CapabilitySchemaRegistry;
  readonly gate: CapabilitySchemaGate;
}

const DEFAULT_MAX_INVOCATIONS = 256;
const DEFAULT_MAX_SCHEMA_GATES = 128;

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key] as JsonValue)}`)
    .join(",")}}`;
}

function fingerprint(value: JsonValue): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function sameTarget(left: TaskExecutionTarget, right: TaskExecutionTarget): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.deploymentGeneration === right.deploymentGeneration &&
    left.artifactDigest === right.artifactDigest &&
    left.executor.id === right.executor.id &&
    left.executor.type === right.executor.type &&
    left.executor.workerId === right.executor.workerId
  );
}

function sameConsumer(left: ComponentInstanceIdentity, right: ComponentInstanceIdentity): boolean {
  return (
    left.applicationId === right.applicationId &&
    left.pluginId === right.pluginId &&
    left.componentId === right.componentId &&
    left.activation === right.activation &&
    left.bindingFingerprint === right.bindingFingerprint &&
    sameTarget(left.target, right.target)
  );
}

function error(
  code: `CAPABILITY_${string}` | `PERMISSION_${string}` | "PROTOCOL_IDEMPOTENCY_CONFLICT",
  message: string,
) {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "runtime", id: "capability-router" },
    }),
  );
}

function positiveBound(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 4_096) {
    throw new RangeError(`${name} must be a positive safe integer no greater than 4096`);
  }
  return result;
}

function invocationKey(consumer: ComponentInstanceIdentity, invocationId: OperationId): string {
  return canonical({
    applicationId: consumer.applicationId,
    pluginId: consumer.pluginId,
    componentId: consumer.componentId,
    activation: consumer.activation,
    target: consumer.target,
    bindingFingerprint: consumer.bindingFingerprint,
    invocationId,
  });
}

function durableInvocationKey(key: string): StateKey<DurableInvocationRecord> {
  const operationId = parseOperationId(`capability-${fingerprint(key)}`);
  return {
    namespace: "tego",
    collection: "capability-invocations",
    id: operationId,
  };
}

function normalizeCall(input: RoutedCapabilityInvocation): RoutedCapabilityInvocation {
  const value = serializeWireValue(input);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw error("CAPABILITY_REQUEST_INVALID", "Capability invocation must be a JSON object");
  }
  const object = value as JsonObject;
  const keys = Object.keys(object).sort().join(",");
  if (
    keys !== "identity,input,invocationId,method" ||
    typeof object.identity !== "object" ||
    object.identity === null ||
    Array.isArray(object.identity) ||
    typeof object.method !== "string"
  ) {
    throw error("CAPABILITY_REQUEST_INVALID", "Capability invocation fields are invalid");
  }
  const identity = object.identity as JsonObject;
  if (
    Object.keys(identity).sort().join(",") !== "name,protocolVersion" ||
    typeof identity.protocolVersion !== "string"
  ) {
    throw error("CAPABILITY_REQUEST_INVALID", "Capability identity is invalid");
  }
  return Object.freeze({
    invocationId: parseOperationId(object.invocationId),
    identity: Object.freeze({
      name: parseCapabilityName(identity.name),
      protocolVersion: identity.protocolVersion,
    }),
    method: object.method,
    input: object.input as JsonValue,
  });
}

export class CapabilityRouter {
  readonly #options: CapabilityRouterOptions;
  readonly #maxInvocations: number;
  readonly #maxSchemaGates: number;
  readonly #invocations = new Map<string, InvocationEntry>();
  readonly #schemas = new Map<string, SchemaEntry>();

  constructor(options: CapabilityRouterOptions) {
    this.#options = options;
    this.#maxInvocations = positiveBound(
      options.maxInvocations,
      DEFAULT_MAX_INVOCATIONS,
      "maxInvocations",
    );
    this.#maxSchemaGates = positiveBound(
      options.maxSchemaGates,
      DEFAULT_MAX_SCHEMA_GATES,
      "maxSchemaGates",
    );
  }

  invoke(
    consumer: ComponentInstanceIdentity,
    input: RoutedCapabilityInvocation,
  ): Promise<JsonValue> {
    const call = normalizeCall(input);
    const key = invocationKey(consumer, call.invocationId as OperationId);
    const callFingerprint = fingerprint({ consumer, call });
    const existing = this.#invocations.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== callFingerprint) {
        return Promise.reject(
          error(
            "PROTOCOL_IDEMPOTENCY_CONFLICT",
            "Capability invocation identity was reused with a different fingerprint",
          ),
        );
      }
      this.#touchInvocation(key, existing);
      return existing.result;
    }
    this.#pruneInvocations();
    if (this.#invocations.size >= this.#maxInvocations) {
      return Promise.reject(
        error("CAPABILITY_INVOCATION_CAPACITY_EXHAUSTED", "Capability invocation capacity is full"),
      );
    }
    const entry: InvocationEntry = {
      fingerprint: callFingerprint,
      result: Promise.resolve().then(async () =>
        this.#executeDurable(consumer, call, key, callFingerprint),
      ),
      settled: false,
    };
    this.#invocations.set(key, entry);
    void entry.result.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      },
    );
    return entry.result;
  }

  clear(): void {
    this.#invocations.clear();
    for (const entry of this.#schemas.values()) entry.registry.clear();
    this.#schemas.clear();
  }

  async #execute(
    consumer: ComponentInstanceIdentity,
    call: RoutedCapabilityInvocation,
  ): Promise<JsonValue> {
    const route = await this.#options.resolve(consumer, call);
    if (!sameConsumer(route.consumer, consumer)) {
      throw error(
        "CAPABILITY_CONSUMER_IDENTITY_MISMATCH",
        "Resolved capability route does not match its exact consumer activation",
      );
    }
    if (
      route.binding.capability.name !== call.identity.name ||
      route.binding.capability.protocolVersion !== call.identity.protocolVersion ||
      route.provision.identity.name !== call.identity.name ||
      route.provision.identity.protocolVersion !== call.identity.protocolVersion ||
      route.provider.applicationId !== route.binding.providerDeployment.applicationId ||
      route.provider.pluginId !== route.binding.providerDeployment.pluginId ||
      route.provider.componentId !== route.provision.componentId
    ) {
      throw error(
        "CAPABILITY_BINDING_STALE",
        "Durable capability binding does not match the requested exact provider",
      );
    }
    if (!route.provision.methods.includes(call.method)) {
      throw error(
        "CAPABILITY_METHOD_UNAVAILABLE",
        `Capability method ${call.method} is not declared by the provider`,
      );
    }
    const permission = gatePermission(route.permissionGrants, {
      kind: "capability",
      name: call.identity.name,
      method: call.method,
    });
    if (!permission.allowed) {
      throw error(
        "PERMISSION_CAPABILITY_DENIED",
        permission.diagnostics[0]?.message ?? "Capability invocation is not granted",
      );
    }
    const gate = this.#schemaGate(route.provision);
    const request = gateCapabilityRequest(gate, call.input);
    if (!request.allowed || request.value === undefined) {
      throw error(
        "CAPABILITY_REQUEST_INVALID",
        request.diagnostics[0]?.message ?? "Capability request is invalid",
      );
    }
    if (!(await this.#options.revalidate(route))) {
      throw error(
        "CAPABILITY_BINDING_STALE",
        "Capability binding changed before exact provider dispatch",
      );
    }
    const response = await this.#options.dispatch(route, { ...call, input: request.value });
    const decision = gateCapabilityResponse(gate, response);
    if (!decision.allowed || decision.value === undefined) {
      throw error(
        "CAPABILITY_RESPONSE_INVALID",
        decision.diagnostics[0]?.message ?? "Capability response is invalid",
      );
    }
    return serializeWireValue(decision.value);
  }

  async #executeDurable(
    consumer: ComponentInstanceIdentity,
    call: RoutedCapabilityInvocation,
    invocationIdentity: string,
    callFingerprint: string,
  ): Promise<JsonValue> {
    const key = durableInvocationKey(invocationIdentity);
    const admission = await this.#options.state.transact({}, async (transaction) => {
      const existing = await transaction.get(key);
      if (existing !== undefined) {
        if (existing.value.fingerprint !== callFingerprint) {
          throw error(
            "PROTOCOL_IDEMPOTENCY_CONFLICT",
            "Capability invocation identity was reused with a different fingerprint",
          );
        }
        return { claimed: false, record: existing.value };
      }
      const record: DurableInvocationRecord = {
        operationId: parseOperationId(key.id),
        fingerprint: callFingerprint,
        status: "executing",
      };
      await transaction.put(key, record, { expectedRevision: "absent" });
      return { claimed: true, record };
    });
    const admitted = admission.record;
    if (admitted.status === "completed") {
      return serializeWireValue(admitted.result);
    }
    if (admitted.status === "failed") {
      if (admitted.diagnostic === undefined) {
        throw error(
          "CAPABILITY_INVOCATION_INDETERMINATE",
          "Durable capability failure evidence is incomplete",
        );
      }
      throw new DiagnosticError(admitted.diagnostic);
    }
    if (!admission.claimed) {
      throw error(
        "CAPABILITY_INVOCATION_INDETERMINATE",
        "Capability invocation is already executing under another runtime authority",
      );
    }
    let result: JsonValue;
    try {
      result = await this.#execute(consumer, call);
    } catch (cause) {
      const diagnostic =
        cause instanceof DiagnosticError
          ? cause.diagnostic
          : runtimeDiagnostic({
              code: "CAPABILITY_INVOCATION_FAILED",
              message: cause instanceof Error ? cause.message : "Capability invocation failed",
              source: { kind: "runtime", id: "capability-router" },
            });
      await this.#completeInvocation(key, callFingerprint, {
        operationId: admitted.operationId,
        fingerprint: callFingerprint,
        status: "failed",
        diagnostic,
      });
      throw new DiagnosticError(diagnostic);
    }
    try {
      const terminal = await this.#completeInvocation(key, callFingerprint, {
        operationId: admitted.operationId,
        fingerprint: callFingerprint,
        status: "completed",
        result,
      });
      return this.#successfulInvocationResult(terminal);
    } catch {
      return this.#reloadSuccessfulInvocation(key, callFingerprint);
    }
  }

  async #completeInvocation(
    key: StateKey<DurableInvocationRecord>,
    callFingerprint: string,
    terminal: DurableInvocationRecord,
  ): Promise<DurableInvocationRecord> {
    return this.#options.state.transact({}, async (transaction) => {
      const current = await transaction.get(key);
      if (current === undefined || current.value.fingerprint !== callFingerprint) {
        throw error(
          "PROTOCOL_IDEMPOTENCY_CONFLICT",
          "Durable capability invocation identity changed before completion",
        );
      }
      if (current.value.status !== "executing") {
        return current.value;
      }
      await transaction.put(key, terminal, { expectedRevision: current.revision });
      return terminal;
    });
  }

  async #reloadSuccessfulInvocation(
    key: StateKey<DurableInvocationRecord>,
    callFingerprint: string,
  ): Promise<JsonValue> {
    let current:
      | {
          readonly value: DurableInvocationRecord;
        }
      | undefined;
    try {
      current = await this.#options.state.read(key);
    } catch {
      throw error(
        "CAPABILITY_INVOCATION_INDETERMINATE",
        "Provider completed but durable completion evidence could not be read",
      );
    }
    if (current === undefined) {
      throw error(
        "CAPABILITY_INVOCATION_INDETERMINATE",
        "Provider completed but durable completion evidence is missing",
      );
    }
    if (current.value.fingerprint !== callFingerprint) {
      throw error(
        "PROTOCOL_IDEMPOTENCY_CONFLICT",
        "Durable capability invocation identity changed before completion",
      );
    }
    return this.#successfulInvocationResult(current.value);
  }

  #successfulInvocationResult(record: DurableInvocationRecord): JsonValue {
    if (record.status !== "completed" || !Object.hasOwn(record, "result")) {
      throw error(
        "CAPABILITY_INVOCATION_INDETERMINATE",
        "Provider completed but durable terminal success is unresolved",
      );
    }
    return serializeWireValue(record.result);
  }

  #schemaGate(provision: CapabilityProvisionRoute): CapabilitySchemaGate {
    const definition: CapabilityDefinition = {
      identity: provision.identity,
      methods: provision.methods,
      requestSchema: provision.requestSchema,
      responseSchema: provision.responseSchema,
    };
    const key = fingerprint({
      componentId: parseComponentId(provision.componentId),
      definition,
    });
    const existing = this.#schemas.get(key);
    if (existing !== undefined) {
      this.#schemas.delete(key);
      this.#schemas.set(key, existing);
      return existing.gate;
    }
    while (this.#schemas.size >= this.#maxSchemaGates) {
      const oldest = this.#schemas.entries().next().value as [string, SchemaEntry] | undefined;
      if (oldest === undefined) break;
      oldest[1].registry.clear();
      this.#schemas.delete(oldest[0]);
    }
    const registry = new CapabilitySchemaRegistry();
    const registration = registry.register(definition);
    if (!registration.ok || registration.gate === undefined) {
      registry.clear();
      throw error(
        "CAPABILITY_SCHEMA_INVALID",
        registration.diagnostics[0]?.message ?? "Capability schema is invalid",
      );
    }
    const entry = { registry, gate: registration.gate };
    this.#schemas.set(key, entry);
    return entry.gate;
  }

  #touchInvocation(key: string, entry: InvocationEntry): void {
    this.#invocations.delete(key);
    this.#invocations.set(key, entry);
  }

  #pruneInvocations(): void {
    while (this.#invocations.size >= this.#maxInvocations) {
      const settled = [...this.#invocations].find(([, entry]) => entry.settled);
      if (settled === undefined) return;
      this.#invocations.delete(settled[0]);
    }
  }
}
