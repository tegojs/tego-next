import {
  DiagnosticError,
  type JsonObject,
  type JsonValue,
  parseRuntimeDiagnostic,
  type RuntimeDiagnostic,
  runtimeDiagnostic,
  serializeWireValue,
} from "@tegojs/contracts";

export const CONTROL_PROTOCOL_VERSION = "1.0";
export const MAX_CONTROL_LINE_BYTES = 1_048_576;
export const MAX_CONTROL_OUTSTANDING_REQUESTS = 32;
export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;
export const DEFAULT_CONTROL_READ_TIMEOUT_MS = 5_000;
export const UNKNOWN_CONTROL_REQUEST_ID = "unknown";

export type RuntimeOperationName =
  | "plugin.deploy"
  | "plugin.install"
  | "plugin.install-path"
  | "plugin.status"
  | "runtime.recovered-operations"
  | "runtime.status"
  | "runtime.stop"
  | "task.cancel"
  | "task.run"
  | "task.status"
  | "task.wait";

export interface ControlRequest extends JsonObject {
  readonly protocolVersion: "1.0";
  readonly requestId: string;
  readonly operation: RuntimeOperationName;
  readonly input: JsonValue;
}

export interface ControlResponse extends JsonObject {
  readonly protocolVersion: "1.0";
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: JsonValue;
  readonly diagnostic?: RuntimeDiagnostic;
}

const operationNames = new Set<RuntimeOperationName>([
  "plugin.deploy",
  "plugin.install",
  "plugin.install-path",
  "plugin.status",
  "runtime.recovered-operations",
  "runtime.status",
  "runtime.stop",
  "task.cancel",
  "task.run",
  "task.status",
  "task.wait",
]);

const safeDiagnosticMessages: Readonly<Record<string, string>> = {
  PROTOCOL_CLI_FAILED: "CLI operation failed",
  PROTOCOL_COMMAND_INVALID: "Command is invalid",
  PROTOCOL_CONTROL_CAPACITY_EXCEEDED: "Control request capacity is exhausted",
  PROTOCOL_CONTROL_CLOSED: "Control connection closed before completion",
  PROTOCOL_CONTROL_FRAME_INVALID: "Control frame is invalid",
  PROTOCOL_CONTROL_FRAME_TOO_LARGE: "Control frame exceeds the size limit",
  PROTOCOL_CONTROL_PARENT_NOT_PRIVATE: "Control endpoint parent directory is not owner-private",
  PROTOCOL_CONTROL_READ_TIMEOUT: "Control request was not completed before its deadline",
  PROTOCOL_CONTROL_REQUEST_MISMATCH: "Control response request ID does not match",
  PROTOCOL_CONTROL_TIMEOUT: "Control response deadline expired",
  PROTOCOL_CONTROL_VERSION_UNSUPPORTED: "Control protocol version is unsupported",
  PROTOCOL_OPERATION_FAILED: "Runtime operation failed",
  PROTOCOL_OPERATION_INVALID: "Runtime operation is invalid",
  PROTOCOL_OPERATION_UNAVAILABLE: "Runtime operation is unavailable",
};

function diagnosticMessage(code: string): string {
  const known = safeDiagnosticMessages[code];
  if (known !== undefined) return known;
  const group = code.slice(0, code.indexOf("_"));
  switch (group) {
    case "ARTIFACT":
      return "Artifact operation failed";
    case "BOOTSTRAP":
      return "Runtime bootstrap failed";
    case "CAPABILITY":
      return "Capability operation failed";
    case "COORDINATION":
      return "Coordination operation failed";
    case "DEPLOYMENT":
      return "Deployment operation failed";
    case "EXECUTOR":
      return "Executor operation failed";
    case "LIFECYCLE":
      return "Runtime lifecycle operation failed";
    case "PERMISSION":
      return "Permission operation failed";
    case "STATE":
      return "State operation failed";
    case "WORKER":
      return "Worker operation failed";
    default:
      return "Runtime operation failed";
  }
}

export function sanitizeControlDiagnostic(diagnostic: RuntimeDiagnostic): RuntimeDiagnostic {
  const parsed = parseRuntimeDiagnostic(diagnostic);
  return runtimeDiagnostic({
    code: parsed.code,
    message: diagnosticMessage(parsed.code),
    source: { kind: parsed.source.kind },
    severity: parsed.severity,
    retryable: parsed.retryable,
    observedAt: parsed.observedAt,
  });
}

export function sanitizeControlValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeControlValue(entry));
  const object = value as JsonObject;
  if (
    typeof object.code === "string" &&
    typeof object.message === "string" &&
    typeof object.severity === "string" &&
    typeof object.retryable === "boolean" &&
    typeof object.observedAt === "string" &&
    typeof object.source === "object" &&
    object.source !== null
  ) {
    try {
      return sanitizeControlDiagnostic(parseRuntimeDiagnostic(object));
    } catch {}
  }
  const sanitized: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(object)) {
    sanitized[key] = sanitizeControlValue(entry);
  }
  return sanitized;
}

function protocolError(code: `PROTOCOL_${string}`, message: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "protocol", id: "local-control" },
    }),
  );
}

function plainObject(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw protocolError("PROTOCOL_CONTROL_FRAME_INVALID", "Control frame must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw protocolError(
      "PROTOCOL_CONTROL_FRAME_INVALID",
      "Control frame fields do not match the protocol",
    );
  }
}

export function parseControlRequest(value: unknown): ControlRequest {
  const object = plainObject(value);
  exactKeys(object, ["protocolVersion", "requestId", "operation", "input"]);
  if (object.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
    throw protocolError(
      "PROTOCOL_CONTROL_VERSION_UNSUPPORTED",
      "Control protocol version is unsupported",
    );
  }
  if (
    typeof object.requestId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(object.requestId)
  ) {
    throw protocolError(
      "PROTOCOL_CONTROL_FRAME_INVALID",
      "Control request ID must be a non-empty string",
    );
  }
  if (
    typeof object.operation !== "string" ||
    !operationNames.has(object.operation as RuntimeOperationName)
  ) {
    throw protocolError("PROTOCOL_OPERATION_INVALID", "Control operation is invalid");
  }
  return {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    requestId: object.requestId,
    operation: object.operation as RuntimeOperationName,
    input: serializeWireValue(object.input),
  };
}

export function extractControlRequestId(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "requestId")
  ) {
    return UNKNOWN_CONTROL_REQUEST_ID;
  }
  const requestId = (value as { readonly requestId?: unknown }).requestId;
  return typeof requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId)
    ? requestId
    : UNKNOWN_CONTROL_REQUEST_ID;
}

export function parseControlResponse(value: unknown): ControlResponse {
  const object = plainObject(value);
  exactKeys(object, ["protocolVersion", "requestId", "ok"], ["result", "diagnostic"]);
  if (
    object.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
    typeof object.requestId !== "string" ||
    typeof object.ok !== "boolean"
  ) {
    throw protocolError("PROTOCOL_CONTROL_FRAME_INVALID", "Control response header is invalid");
  }
  const diagnostic =
    object.diagnostic === undefined
      ? undefined
      : sanitizeControlDiagnostic(parseRuntimeDiagnostic(object.diagnostic));
  if (
    (object.ok && diagnostic !== undefined) ||
    (!object.ok && diagnostic === undefined) ||
    (object.result !== undefined && !object.ok)
  ) {
    throw protocolError("PROTOCOL_CONTROL_FRAME_INVALID", "Control response outcome is invalid");
  }
  return {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    requestId: object.requestId,
    ok: object.ok,
    ...(object.result === undefined
      ? {}
      : { result: sanitizeControlValue(serializeWireValue(object.result)) }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

export function diagnosticResponse(
  requestId: string,
  diagnostic: RuntimeDiagnostic,
): ControlResponse {
  return {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    requestId,
    ok: false,
    diagnostic: sanitizeControlDiagnostic(diagnostic),
  };
}

export function protocolDiagnostic(code: `PROTOCOL_${string}`, message: string): RuntimeDiagnostic {
  return runtimeDiagnostic({
    code,
    message,
    source: { kind: "protocol", id: "local-control" },
  });
}
