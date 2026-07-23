import {
  compileSchemaValidator,
  DiagnosticError,
  parseCapabilityDefinition,
  type CapabilityDefinition,
  type FilesystemAccess,
  type JsonObject,
  type JsonValue,
  type Permission,
  type SchemaValidator,
  type WorkerResourceCeilings,
} from "@tegojs/contracts";
import {
  canonicalizePermissionSet,
  clonePermissionBoundaryValue,
  containsLogicalPath,
  type PermissionDecisionDiagnostic,
} from "./permission-set.js";

export type PermissionCallAttempt =
  | {
      readonly kind: "capability";
      readonly name: string;
      readonly method: string;
    }
  | {
      readonly kind: "environment";
      readonly name: string;
    }
  | {
      readonly kind: "executor";
      readonly executor: "process" | "remote" | "thread";
    }
  | {
      readonly kind: "filesystem";
      readonly path: string;
      readonly access: FilesystemAccess;
    }
  | {
      readonly kind: "network";
      readonly host: string;
      readonly port: number;
      readonly method: string;
    }
  | {
      readonly kind: "secret";
      readonly name: string;
    }
  | {
      readonly kind: "worker";
      readonly labels: Readonly<Record<string, string>>;
      readonly resources: WorkerResourceCeilings;
    };

export interface PermissionGateDecision extends JsonObject {
  readonly allowed: boolean;
  readonly diagnostics: readonly PermissionDecisionDiagnostic[];
}

export interface CapabilityPayloadDiagnostic extends JsonObject {
  readonly code:
    | "CAPABILITY_PAYLOAD_INVALID"
    | "CAPABILITY_REQUEST_INVALID"
    | "CAPABILITY_RESPONSE_INVALID"
    | "CAPABILITY_SCHEMA_ID_CONFLICT"
    | "CAPABILITY_SCHEMA_INVALID";
  readonly message: string;
  readonly details?: JsonValue;
}

export interface CapabilityPayloadDecision extends JsonObject {
  readonly allowed: boolean;
  readonly diagnostics: readonly CapabilityPayloadDiagnostic[];
  readonly value?: JsonValue;
}

export interface CapabilitySchemaRegistration {
  readonly ok: boolean;
  readonly diagnostics: readonly CapabilityPayloadDiagnostic[];
  readonly gate?: CapabilitySchemaGate;
}

interface RegisteredSchema {
  readonly canonical: string;
  readonly validator: SchemaValidator<JsonValue>;
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreezeJson(descriptor.value as JsonValue);
    }
  }
  return Object.freeze(value);
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(value);
}

function schemaId(schema: CapabilityDefinition["requestSchema"]): string | undefined {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(schema, "$id");
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

export class CapabilitySchemaGate {
  readonly definition: CapabilityDefinition;
  readonly #request: SchemaValidator<JsonValue>;
  readonly #response: SchemaValidator<JsonValue>;

  constructor(
    definition: CapabilityDefinition,
    request: SchemaValidator<JsonValue>,
    response: SchemaValidator<JsonValue>,
  ) {
    this.definition = definition;
    this.#request = request;
    this.#response = response;
  }

  validate(direction: "request" | "response", input: JsonValue): JsonValue {
    return direction === "request" ? this.#request.parse(input) : this.#response.parse(input);
  }
}

/**
 * Registration is explicitly scoped to a runtime/component-host lifecycle. `clear()` releases
 * registry references; callers must also release any gates they retained.
 */
export class CapabilitySchemaRegistry {
  readonly #gates = new Map<string, CapabilitySchemaGate>();
  readonly #schemas = new Map<string, RegisteredSchema>();

  register(definitionInput: CapabilityDefinition): CapabilitySchemaRegistration {
    let definition: CapabilityDefinition;
    try {
      definition = deepFreezeJson(
        parseCapabilityDefinition(clonePayload(definitionInput)),
      ) as CapabilityDefinition;
    } catch (error) {
      return registrationFailure("CAPABILITY_SCHEMA_INVALID", error);
    }

    const definitionKey = canonicalJson(definition);
    const existingGate = this.#gates.get(definitionKey);
    if (existingGate !== undefined) {
      return { ok: true, diagnostics: [], gate: existingGate };
    }

    const pending = new Map<string, RegisteredSchema>();
    const request = this.#prepare(definition.requestSchema, pending);
    if ("diagnostic" in request) return { ok: false, diagnostics: [request.diagnostic] };
    const response = this.#prepare(definition.responseSchema, pending);
    if ("diagnostic" in response) return { ok: false, diagnostics: [response.diagnostic] };

    for (const [key, registered] of pending) this.#schemas.set(key, registered);
    const gate = new CapabilitySchemaGate(definition, request.validator, response.validator);
    this.#gates.set(definitionKey, gate);
    return { ok: true, diagnostics: [], gate };
  }

  clear(): void {
    this.#gates.clear();
    this.#schemas.clear();
  }

  #prepare(
    schema: CapabilityDefinition["requestSchema"],
    pending: Map<string, RegisteredSchema>,
  ):
    | { readonly validator: SchemaValidator<JsonValue> }
    | { readonly diagnostic: CapabilityPayloadDiagnostic } {
    const canonical = canonicalJson(schema);
    const id = schemaId(schema);
    const key = id === undefined ? `anonymous:${canonical}` : `id:${id}`;
    const existing = pending.get(key) ?? this.#schemas.get(key);
    if (existing !== undefined) {
      if (existing.canonical !== canonical) {
        return {
          diagnostic: {
            code: "CAPABILITY_SCHEMA_ID_CONFLICT",
            message: `Capability schema identifier ${id ?? key} is already registered differently`,
          },
        };
      }
      return { validator: existing.validator };
    }
    try {
      const registered = {
        canonical,
        validator: compileSchemaValidator<JsonValue>(schema),
      };
      pending.set(key, registered);
      return { validator: registered.validator };
    } catch (error) {
      return {
        diagnostic: registrationDiagnostic("CAPABILITY_SCHEMA_INVALID", error),
      };
    }
  }
}

function registrationDiagnostic(
  code: "CAPABILITY_SCHEMA_ID_CONFLICT" | "CAPABILITY_SCHEMA_INVALID",
  error: unknown,
): CapabilityPayloadDiagnostic {
  const details = error instanceof DiagnosticError ? error.diagnostic.details : undefined;
  return {
    code,
    message: error instanceof Error ? error.message : "Capability schema is invalid",
    ...(details === undefined ? {} : { details }),
  };
}

function registrationFailure(
  code: "CAPABILITY_SCHEMA_ID_CONFLICT" | "CAPABILITY_SCHEMA_INVALID",
  error: unknown,
): CapabilitySchemaRegistration {
  return { ok: false, diagnostics: [registrationDiagnostic(code, error)] };
}

function denied(message: string, path = "$/attempt"): PermissionGateDecision {
  return {
    allowed: false,
    diagnostics: [{ code: "PERMISSION_GRANT_EXCEEDS_REQUEST", message, path }],
  };
}

function invalidPermission(error: unknown): PermissionGateDecision {
  return {
    allowed: false,
    diagnostics: [
      {
        code: "PERMISSION_ENVELOPE_INVALID",
        message: error instanceof Error ? error.message : "Permission call is invalid",
        path: "$/attempt",
      },
    ],
  };
}

function normalizeCall(input: unknown): PermissionCallAttempt {
  const stable = clonePermissionBoundaryValue(input);
  if (typeof stable !== "object" || stable === null || Array.isArray(stable)) {
    throw new Error("Permission call must be an object");
  }
  const call = stable as Record<string, unknown>;
  if (typeof call.kind !== "string") throw new Error("Permission call kind is invalid");
  const expectedFields: Readonly<Record<string, readonly string[]>> = {
    capability: ["kind", "method", "name"],
    environment: ["kind", "name"],
    executor: ["executor", "kind"],
    filesystem: ["access", "kind", "path"],
    network: ["host", "kind", "method", "port"],
    secret: ["kind", "name"],
    worker: ["kind", "labels", "resources"],
  };
  const expected = expectedFields[call.kind];
  const actual = Object.keys(call).sort();
  if (
    expected === undefined ||
    actual.length !== expected.length ||
    actual.some((field, index) => field !== [...expected].sort()[index])
  ) {
    throw new Error("Permission call fields are invalid");
  }
  const holder =
    call.kind === "network"
      ? canonicalizePermissionSet([
          {
            kind: "network",
            hosts: [call.host],
            ports: [call.port],
            methods: [call.method],
          },
        ])[0]
      : call.kind === "filesystem"
        ? canonicalizePermissionSet([
            { kind: "filesystem", roots: [{ path: call.path, access: [call.access] }] },
          ])[0]
        : call.kind === "worker"
          ? canonicalizePermissionSet([
              { kind: "worker", labels: call.labels, resources: call.resources },
            ])[0]
          : call.kind === "capability"
            ? canonicalizePermissionSet([
                {
                  kind: "capability",
                  capabilities: [{ name: call.name, methods: [call.method] }],
                },
              ])[0]
            : call.kind === "executor"
              ? canonicalizePermissionSet([{ kind: "executor", executors: [call.executor] }])[0]
              : canonicalizePermissionSet([{ kind: call.kind, names: [call.name] }])[0];

  if (holder === undefined) throw new Error("Permission call could not be normalized");
  switch (holder.kind) {
    case "capability": {
      const entry = holder.capabilities[0];
      if (entry === undefined) throw new Error("Capability call is empty");
      return { kind: "capability", name: entry.name, method: entry.methods[0] ?? "" };
    }
    case "environment":
    case "secret":
      return { kind: holder.kind, name: holder.names[0] ?? "" };
    case "executor":
      return { kind: "executor", executor: holder.executors[0] ?? "process" };
    case "filesystem": {
      const root = holder.roots[0];
      if (root === undefined) throw new Error("Filesystem call is empty");
      return { kind: "filesystem", path: root.path, access: root.access[0] ?? "read" };
    }
    case "network":
      return {
        kind: "network",
        host: holder.hosts[0] ?? "",
        port: holder.ports[0] ?? 0,
        method: holder.methods[0] ?? "",
      };
    case "worker":
      return { kind: "worker", labels: holder.labels, resources: holder.resources };
  }
}

export function gatePermission(
  grantedInput: unknown,
  attemptInput: unknown,
): PermissionGateDecision {
  let granted: readonly Permission[];
  let attempt: PermissionCallAttempt;
  try {
    granted = canonicalizePermissionSet(grantedInput);
    attempt = normalizeCall(attemptInput);
  } catch (error) {
    return invalidPermission(error);
  }
  const permission = granted.find((candidate) => candidate.kind === attempt.kind);
  if (permission === undefined) return denied(`No ${attempt.kind} permission was granted`);

  switch (attempt.kind) {
    case "capability":
      if (
        permission.kind === "capability" &&
        permission.capabilities.some(
          (entry) => entry.name === attempt.name && entry.methods.includes(attempt.method),
        )
      ) {
        return { allowed: true, diagnostics: [] };
      }
      break;
    case "environment":
    case "secret":
      if (permission.kind === attempt.kind && permission.names.includes(attempt.name)) {
        return { allowed: true, diagnostics: [] };
      }
      break;
    case "executor":
      if (permission.kind === "executor" && permission.executors.includes(attempt.executor)) {
        return { allowed: true, diagnostics: [] };
      }
      break;
    case "filesystem":
      if (
        permission.kind === "filesystem" &&
        permission.roots.some(
          (root) =>
            containsLogicalPath(root.path, attempt.path) && root.access.includes(attempt.access),
        )
      ) {
        return { allowed: true, diagnostics: [] };
      }
      break;
    case "network":
      if (
        permission.kind === "network" &&
        permission.hosts.includes(attempt.host) &&
        permission.ports.includes(attempt.port) &&
        permission.methods.includes(attempt.method as never)
      ) {
        return { allowed: true, diagnostics: [] };
      }
      break;
    case "worker":
      if (
        permission.kind === "worker" &&
        Object.entries(permission.labels).every(
          ([name, value]) => attempt.labels[name] === value,
        ) &&
        attempt.resources.cpuMillis <= permission.resources.cpuMillis &&
        attempt.resources.memoryBytes <= permission.resources.memoryBytes &&
        attempt.resources.storageBytes <= permission.resources.storageBytes
      ) {
        return { allowed: true, diagnostics: [] };
      }
      break;
  }
  return denied(`${attempt.kind} call is outside the granted permission envelope`);
}

function clonePayload(value: unknown, path = "$", ancestors = new Set<object>()): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new Error(`Value at ${path} must be finite acyclic JSON data`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`Value at ${path} must have the standard array prototype`);
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error(`Value at ${path}/${index} must be a data property`);
        }
        result.push(clonePayload(descriptor.value, `${path}/${index}`, ancestors));
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
        throw new Error(`Value at ${path} must not extend an array`);
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Value at ${path} must be a plain object`);
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value).sort((left, right) =>
      String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
    )) {
      if (typeof key !== "string") throw new Error(`Value at ${path} has a symbol property`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`Value at ${path}/${key} must be a data property`);
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: clonePayload(descriptor.value, `${path}/${key}`, ancestors),
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function payloadGate(
  gate: CapabilitySchemaGate,
  input: unknown,
  direction: "request" | "response",
): CapabilityPayloadDecision {
  try {
    const value = clonePayload(input);
    gate.validate(direction, value);
    return { allowed: true, diagnostics: [], value };
  } catch (error) {
    const schemaInvalid =
      error instanceof DiagnosticError && error.diagnostic.code === "PROTOCOL_SCHEMA_INVALID";
    const validationInvalid =
      error instanceof DiagnosticError &&
      error.diagnostic.code === "PROTOCOL_SCHEMA_VALIDATION_FAILED";
    const code = schemaInvalid
      ? "CAPABILITY_SCHEMA_INVALID"
      : validationInvalid
        ? direction === "request"
          ? "CAPABILITY_REQUEST_INVALID"
          : "CAPABILITY_RESPONSE_INVALID"
        : "CAPABILITY_PAYLOAD_INVALID";
    const details = error instanceof DiagnosticError ? error.diagnostic.details : undefined;
    return {
      allowed: false,
      diagnostics: [
        {
          code,
          message: error instanceof Error ? error.message : "Capability payload is invalid",
          ...(details === undefined ? {} : { details }),
        },
      ],
    };
  }
}

export function gateCapabilityRequest(
  gate: CapabilitySchemaGate,
  input: unknown,
): CapabilityPayloadDecision {
  return payloadGate(gate, input, "request");
}

export function gateCapabilityResponse(
  gate: CapabilitySchemaGate,
  input: unknown,
): CapabilityPayloadDecision {
  return payloadGate(gate, input, "response");
}
