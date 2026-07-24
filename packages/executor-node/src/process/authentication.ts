import { createHmac, timingSafeEqual } from "node:crypto";
import { DiagnosticError, runtimeDiagnostic } from "@tegojs/contracts";

const MAC_PATTERN = /^[0-9a-f]{64}$/u;
export type ProcessMessageDirection = "child-to-parent" | "parent-to-child";

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value !== "object") throw new Error("Authenticated frame must contain JSON data");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function unsigned(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Authenticated process message must be an object");
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key !== "mac" && key !== "sequence") result[key] = value;
  }
  return result;
}

function digest(
  key: Uint8Array,
  direction: ProcessMessageDirection,
  sequence: number,
  value: Record<string, unknown>,
): Buffer {
  return createHmac("sha256", key).update(canonical({ direction, sequence, value })).digest();
}

function authenticationError(): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_PROCESS_FRAME_AUTHENTICATION_FAILED",
      message: "Process broker frame authentication failed",
      source: { kind: "protocol", id: "process-executor" },
    }),
  );
}

export function signProcessMessage(
  key: Uint8Array,
  direction: ProcessMessageDirection,
  sequence: number,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const content = unsigned(value);
  return {
    ...content,
    sequence,
    mac: digest(key, direction, sequence, content).toString("hex"),
  };
}

export function authenticateProcessMessage(
  key: Uint8Array,
  direction: ProcessMessageDirection,
  expectedSequence: number,
  input: unknown,
): Record<string, unknown> {
  const content = unsigned(input);
  const record =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const mac = typeof record?.mac === "string" ? record.mac : undefined;
  const sequence = record?.sequence;
  if (
    mac === undefined ||
    !MAC_PATTERN.test(mac) ||
    !Number.isSafeInteger(sequence) ||
    sequence !== expectedSequence
  ) {
    throw authenticationError();
  }
  const actual = Buffer.from(mac, "hex");
  const expected = digest(key, direction, expectedSequence, content);
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw authenticationError();
  }
  return content;
}
