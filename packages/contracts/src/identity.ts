import { DiagnosticError, runtimeDiagnostic } from "./diagnostic.js";

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type RuntimeId = Brand<string, "RuntimeId">;
export type ApplicationId = Brand<string, "ApplicationId">;
export type NodeId = Brand<string, "NodeId">;
export type PluginId = Brand<string, "PluginId">;
export type ComponentId = Brand<string, "ComponentId">;
export type OperationId = Brand<string, "OperationId">;
export type TaskId = Brand<string, "TaskId">;
export type AttemptId = Brand<string, "AttemptId">;
export type WorkerId = Brand<string, "WorkerId">;
export type SessionId = Brand<string, "SessionId">;
export type MessageId = Brand<string, "MessageId">;
export type CapabilityName = Brand<string, "CapabilityName">;
export type ArtifactDigest = Brand<string, "ArtifactDigest">;
export type Revision = Brand<string, "Revision">;
export type Generation = Brand<string, "Generation">;
export type Sequence = Brand<string, "Sequence">;
export type FencingEpoch = Brand<string, "FencingEpoch">;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function invalidIdentity(name: string, value: unknown): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_IDENTITY_INVALID",
      message: `${name} must be a non-empty portable identifier`,
      source: { kind: "protocol", id: name },
      details: { name, value: typeof value === "string" ? value : typeof value },
    }),
  );
}

function parseIdentity<Name extends string>(value: unknown, name: Name): Brand<string, Name> {
  if (typeof value !== "string" || !IDENTITY_PATTERN.test(value)) {
    throw invalidIdentity(name, value);
  }
  return value as Brand<string, Name>;
}

function parseDecimalIdentity<Name extends string>(
  value: unknown,
  name: Name,
): Brand<string, Name> {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw invalidIdentity(name, value);
  }
  return value as Brand<string, Name>;
}

export function parseRuntimeId(value: unknown): RuntimeId {
  return parseIdentity(value, "RuntimeId");
}

export function parseApplicationId(value: unknown): ApplicationId {
  return parseIdentity(value, "ApplicationId");
}

export function parseNodeId(value: unknown): NodeId {
  return parseIdentity(value, "NodeId");
}

export function parsePluginId(value: unknown): PluginId {
  return parseIdentity(value, "PluginId");
}

export function parseComponentId(value: unknown): ComponentId {
  return parseIdentity(value, "ComponentId");
}

export function parseOperationId(value: unknown): OperationId {
  return parseIdentity(value, "OperationId");
}

export function parseTaskId(value: unknown): TaskId {
  return parseIdentity(value, "TaskId");
}

export function parseAttemptId(value: unknown): AttemptId {
  return parseIdentity(value, "AttemptId");
}

export function parseWorkerId(value: unknown): WorkerId {
  return parseIdentity(value, "WorkerId");
}

export function parseSessionId(value: unknown): SessionId {
  return parseIdentity(value, "SessionId");
}

export function parseMessageId(value: unknown): MessageId {
  return parseIdentity(value, "MessageId");
}

export function parseCapabilityName(value: unknown): CapabilityName {
  return parseIdentity(value, "CapabilityName");
}

export function parseArtifactDigest(value: unknown): ArtifactDigest {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalidIdentity("ArtifactDigest", value);
  }
  return value as ArtifactDigest;
}

export function parseRevision(value: unknown): Revision {
  return parseDecimalIdentity(value, "Revision");
}

export function parseGeneration(value: unknown): Generation {
  return parseDecimalIdentity(value, "Generation");
}

export function parseSequence(value: unknown): Sequence {
  return parseDecimalIdentity(value, "Sequence");
}

export function parseFencingEpoch(value: unknown): FencingEpoch {
  return parseDecimalIdentity(value, "FencingEpoch");
}
