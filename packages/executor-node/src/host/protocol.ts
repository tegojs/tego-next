import {
  DiagnosticError,
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseCapabilityDefinition,
  parseComponentId,
  parseExecutionRequest,
  parsePermissionSet,
  parsePluginId,
  parseRuntimeDiagnostic,
  parseRuntimeId,
  parseTaskId,
  runtimeDiagnostic,
  type ArtifactDigest,
  type CapabilityDefinition,
  type ComponentId,
  type ExecutionRequest,
  type JsonObject,
  type JsonValue,
  type Permission,
  type RuntimeDiagnostic,
} from "@tegojs/contracts";

export const COMPONENT_HOST_PROTOCOL = "1.0" as const;
const COMMAND_TYPES = new Set([
  "prepare",
  "import",
  "start",
  "health",
  "run",
  "drain",
  "stop",
  "cancel",
] as const);
export const COMPONENT_HOST_WIRE_BYTE_LIMIT = 1024 * 1024;
export const COMPONENT_HOST_ATTACHMENT_COUNT_LIMIT = 64;
const MAX_WIRE_DEPTH = 64;
const MAX_WIRE_NODES = 1_000_000;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type ComponentHostState =
  | "new"
  | "prepared"
  | "imported"
  | "started"
  | "draining"
  | "failed"
  | "stopped";

export interface ComponentHostIdentity extends JsonObject {
  readonly runtimeId: string;
  readonly applicationId: string;
  readonly pluginId: string;
  readonly componentId: string;
  readonly instanceId: string;
}

export interface ComponentHostRuntimeInfo extends JsonObject {
  readonly executor: "process" | "remote" | "thread";
  readonly mode: "multi-main" | "single-main";
}

export interface PrepareComponentHostPayload extends JsonObject {
  readonly artifactDigest: ArtifactDigest;
  readonly componentId: ComponentId;
  readonly identity: ComponentHostIdentity;
  readonly configuration: JsonValue;
  readonly permissionGrants: readonly Permission[];
  readonly capabilityDefinitions: readonly CapabilityDefinition[];
  readonly runtime: ComponentHostRuntimeInfo;
}

interface CommandBase extends JsonObject {
  readonly protocol: typeof COMPONENT_HOST_PROTOCOL;
  readonly commandId: string;
  readonly deadline: string;
}

export interface PrepareComponentHostCommand extends CommandBase {
  readonly type: "prepare";
  readonly payload: PrepareComponentHostPayload;
}

export interface ImportComponentHostCommand extends CommandBase {
  readonly type: "import";
  readonly payload: { readonly artifactDigest: ArtifactDigest };
}

export interface ArtifactComponentHostCommand extends CommandBase {
  readonly type: "drain" | "health" | "start" | "stop";
  readonly payload: { readonly artifactDigest: ArtifactDigest };
}

export interface RunComponentHostCommand extends CommandBase {
  readonly type: "run";
  readonly payload: {
    readonly artifactDigest: ArtifactDigest;
    readonly execution: ExecutionRequest;
  };
}

export interface CancelComponentHostCommand extends CommandBase {
  readonly type: "cancel";
  readonly payload: {
    readonly taskId: string;
    readonly attemptId: string;
    readonly reason?: string;
  };
}

export type ComponentHostCommand =
  | ArtifactComponentHostCommand
  | CancelComponentHostCommand
  | ImportComponentHostCommand
  | PrepareComponentHostCommand
  | RunComponentHostCommand;

export interface ComponentHostResult extends JsonObject {
  readonly protocol: typeof COMPONENT_HOST_PROTOCOL;
  readonly commandId: string;
  readonly type: ComponentHostCommand["type"] | "invalid";
  readonly ok: boolean;
  readonly state: ComponentHostState;
  readonly value?: JsonValue;
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

interface CloneBudget {
  nodes: number;
}

function wireError(message: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_COMPONENT_HOST_COMMAND_INVALID",
      message,
      source: { kind: "protocol", id: "component-host" },
    }),
  );
}

function cloneWire(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
  budget: CloneBudget,
): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_WIRE_NODES || depth > MAX_WIRE_DEPTH) {
    throw wireError("Component host value exceeds the bounded wire depth or node limit");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) {
    throw wireError(`Component host value at ${path} must be finite acyclic JSON data`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw wireError(`Component host array at ${path} must use the standard prototype`);
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw wireError(`Component host value at ${path}/${index} must be a data property`);
        }
        result.push(cloneWire(descriptor.value, `${path}/${index}`, depth + 1, ancestors, budget));
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
        throw wireError(`Component host array at ${path} must not have extra properties`);
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw wireError(`Component host value at ${path} must be a plain object`);
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value).sort((left, right) =>
      String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
    )) {
      if (typeof key !== "string") {
        throw wireError(`Component host value at ${path} must not contain symbol properties`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw wireError(`Component host value at ${path}/${key} must be a data property`);
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneWire(descriptor.value, `${path}/${key}`, depth + 1, ancestors, budget),
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function cloneComponentHostValue(value: unknown): JsonValue {
  const result = cloneWire(value, "$", 0, new Set(), { nodes: 0 });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > COMPONENT_HOST_WIRE_BYTE_LIMIT) {
    throw wireError("Component host value exceeds the bounded wire size limit");
  }
  return result;
}

function objectValue(value: JsonValue, label: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw wireError(`${label} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function exactFields(
  value: Record<string, JsonValue>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw wireError("Component host command fields are invalid");
  }
}

function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw wireError(`${label} must be a string`);
  return value;
}

function parseDeadline(value: JsonValue | undefined): string {
  const deadline = text(value, "Component host deadline");
  if (!Number.isFinite(Date.parse(deadline)) || new Date(deadline).toISOString() !== deadline) {
    throw wireError("Component host deadline must be an ISO date-time");
  }
  return deadline;
}

function parsePreparePayload(value: JsonValue): PrepareComponentHostPayload {
  const payload = objectValue(value, "Prepare payload");
  exactFields(payload, [
    "artifactDigest",
    "capabilityDefinitions",
    "componentId",
    "configuration",
    "identity",
    "permissionGrants",
    "runtime",
  ]);
  const identity = objectValue(payload.identity ?? null, "Component identity");
  exactFields(identity, ["applicationId", "componentId", "instanceId", "pluginId", "runtimeId"]);
  const runtime = objectValue(payload.runtime ?? null, "Component runtime");
  exactFields(runtime, ["executor", "mode"]);
  if (!["process", "remote", "thread"].includes(text(runtime.executor, "Executor"))) {
    throw wireError("Component executor is invalid");
  }
  if (!["multi-main", "single-main"].includes(text(runtime.mode, "Runtime mode"))) {
    throw wireError("Component runtime mode is invalid");
  }
  if (!Array.isArray(payload.capabilityDefinitions)) {
    throw wireError("Capability definitions must be an array");
  }
  return {
    artifactDigest: parseArtifactDigest(payload.artifactDigest),
    componentId: parseComponentId(payload.componentId),
    identity: {
      runtimeId: parseRuntimeId(identity.runtimeId),
      applicationId: parseApplicationId(identity.applicationId),
      pluginId: parsePluginId(identity.pluginId),
      componentId: parseComponentId(identity.componentId),
      instanceId: text(identity.instanceId, "Component instance identity"),
    },
    configuration: payload.configuration ?? null,
    permissionGrants: parsePermissionSet(payload.permissionGrants),
    capabilityDefinitions: payload.capabilityDefinitions.map((definition) =>
      parseCapabilityDefinition(definition),
    ),
    runtime: {
      executor: runtime.executor as "process" | "remote" | "thread",
      mode: runtime.mode as "multi-main" | "single-main",
    },
  };
}

export function parseComponentHostCommand(input: unknown): ComponentHostCommand {
  const command = objectValue(cloneComponentHostValue(input), "Component host command");
  exactFields(command, ["commandId", "deadline", "payload", "protocol", "type"]);
  if (command.protocol !== COMPONENT_HOST_PROTOCOL) {
    throw wireError(`Component host protocol ${String(command.protocol)} is unsupported`);
  }
  const type = text(command.type, "Component host command type");
  if (!COMMAND_TYPES.has(type as ComponentHostCommand["type"])) {
    throw wireError("Component host command type is invalid");
  }
  const commandId = text(command.commandId, "Component host command identity");
  if (!COMMAND_ID.test(commandId)) throw wireError("Component host command identity is invalid");
  const deadline = parseDeadline(command.deadline);
  const payload = objectValue(command.payload ?? null, "Component host command payload");
  switch (type) {
    case "prepare":
      return {
        protocol: COMPONENT_HOST_PROTOCOL,
        commandId,
        deadline,
        type,
        payload: parsePreparePayload(payload),
      };
    case "import":
      exactFields(payload, ["artifactDigest"]);
      return {
        protocol: COMPONENT_HOST_PROTOCOL,
        commandId,
        deadline,
        type,
        payload: { artifactDigest: parseArtifactDigest(payload.artifactDigest) },
      };
    case "run":
      exactFields(payload, ["artifactDigest", "execution"]);
      return {
        protocol: COMPONENT_HOST_PROTOCOL,
        commandId,
        deadline,
        type,
        payload: {
          artifactDigest: parseArtifactDigest(payload.artifactDigest),
          execution: parseExecutionRequest(payload.execution),
        },
      };
    case "cancel":
      exactFields(payload, ["attemptId", "taskId"], ["reason"]);
      return {
        protocol: COMPONENT_HOST_PROTOCOL,
        commandId,
        deadline,
        type,
        payload: {
          taskId: parseTaskId(payload.taskId),
          attemptId: parseAttemptId(payload.attemptId),
          ...(payload.reason === undefined
            ? {}
            : { reason: text(payload.reason, "Cancellation reason") }),
        },
      };
    case "drain":
    case "health":
    case "start":
    case "stop":
      exactFields(payload, ["artifactDigest"]);
      return {
        protocol: COMPONENT_HOST_PROTOCOL,
        commandId,
        deadline,
        type,
        payload: { artifactDigest: parseArtifactDigest(payload.artifactDigest) },
      };
  }
  throw wireError("Component host command type is invalid");
}

export function parseComponentHostResult(input: unknown): ComponentHostResult {
  const result = objectValue(cloneComponentHostValue(input), "Component host result");
  exactFields(result, ["commandId", "diagnostics", "ok", "protocol", "state", "type"], ["value"]);
  if (result.protocol !== COMPONENT_HOST_PROTOCOL) {
    throw wireError("Component host result protocol is unsupported");
  }
  if (typeof result.ok !== "boolean") throw wireError("Component host result ok is invalid");
  if (
    typeof result.state !== "string" ||
    !["new", "prepared", "imported", "started", "draining", "failed", "stopped"].includes(
      result.state,
    )
  ) {
    throw wireError("Component host result state is invalid");
  }
  if (
    typeof result.type !== "string" ||
    (result.type !== "invalid" && !COMMAND_TYPES.has(result.type as ComponentHostCommand["type"]))
  ) {
    throw wireError("Component host result type is invalid");
  }
  if (!Array.isArray(result.diagnostics)) {
    throw wireError("Component host result diagnostics are invalid");
  }
  return {
    protocol: COMPONENT_HOST_PROTOCOL,
    commandId: text(result.commandId, "Component host result identity"),
    type: result.type as ComponentHostResult["type"],
    ok: result.ok,
    state: result.state as ComponentHostState,
    ...(result.value === undefined ? {} : { value: result.value }),
    diagnostics: result.diagnostics.map((diagnostic) => parseRuntimeDiagnostic(diagnostic)),
  };
}
