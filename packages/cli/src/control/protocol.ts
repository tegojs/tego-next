import {
  DiagnosticError,
  type JsonObject,
  type JsonValue,
  parseRuntimeDiagnostic,
  type RuntimeDiagnostic,
  runtimeDiagnostic,
  serializeCause,
  serializeWireValue,
} from "@tegojs/contracts";

export const CONTROL_PROTOCOL_VERSION = "1.0";
export const MAX_CONTROL_LINE_BYTES = 1_048_576;
export const MAX_CONTROL_OUTSTANDING_REQUESTS = 32;
export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;

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

function protocolError(
  code: `PROTOCOL_${string}`,
  message: string,
  cause?: unknown,
): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "protocol", id: "local-control" },
      ...(cause === undefined ? {} : { cause: serializeCause(cause) }),
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
  if (typeof object.requestId !== "string" || object.requestId.length === 0) {
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
    object.diagnostic === undefined ? undefined : parseRuntimeDiagnostic(object.diagnostic);
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
    ...(object.result === undefined ? {} : { result: serializeWireValue(object.result) }),
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
    diagnostic: parseRuntimeDiagnostic(diagnostic),
  };
}

export function protocolDiagnostic(
  code: `PROTOCOL_${string}`,
  message: string,
  cause?: unknown,
): RuntimeDiagnostic {
  return runtimeDiagnostic({
    code,
    message,
    source: { kind: "protocol", id: "local-control" },
    ...(cause === undefined ? {} : { cause: serializeCause(cause) }),
  });
}
