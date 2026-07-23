import type { JsonValue } from "./json.js";

export const DIAGNOSTIC_GROUPS = [
  "BOOTSTRAP",
  "ARTIFACT",
  "DEPLOYMENT",
  "CAPABILITY",
  "PERMISSION",
  "LIFECYCLE",
  "EXECUTOR",
  "WORKER",
  "COORDINATION",
  "STATE",
  "PROTOCOL",
] as const;

export type DiagnosticGroup = (typeof DIAGNOSTIC_GROUPS)[number];
export type DiagnosticCode = `${DiagnosticGroup}_${string}`;
export type DiagnosticSeverity = "error" | "info" | "warning";

export interface DiagnosticSource {
  readonly kind:
    | "artifact"
    | "capability"
    | "coordination"
    | "deployment"
    | "executor"
    | "plugin"
    | "protocol"
    | "runtime"
    | "schema"
    | "state"
    | "worker";
  readonly id?: string;
}

export interface SerializedCause {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
}

export interface RuntimeDiagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source: DiagnosticSource;
  readonly retryable: boolean;
  readonly details?: JsonValue;
  readonly cause?: SerializedCause;
  readonly observedAt: string;
}

export interface RuntimeDiagnosticInput {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly source: DiagnosticSource;
  readonly severity?: DiagnosticSeverity;
  readonly retryable?: boolean;
  readonly details?: JsonValue;
  readonly cause?: SerializedCause;
  readonly observedAt?: string;
}

export function runtimeDiagnostic(input: RuntimeDiagnosticInput): RuntimeDiagnostic {
  return {
    code: input.code,
    severity: input.severity ?? "error",
    message: input.message,
    source: input.source,
    retryable: input.retryable ?? false,
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
}

export class DiagnosticError extends Error {
  readonly diagnostic: RuntimeDiagnostic;

  constructor(diagnostic: RuntimeDiagnostic) {
    super(diagnostic.message);
    this.name = "DiagnosticError";
    this.diagnostic = diagnostic;
  }
}

export function diagnosticCode(error: unknown): DiagnosticCode | undefined {
  if (error instanceof DiagnosticError) {
    return error.diagnostic.code;
  }
  return undefined;
}

export function serializeCause(error: unknown): SerializedCause {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { name: "UnknownCause", message: String(error) };
}
