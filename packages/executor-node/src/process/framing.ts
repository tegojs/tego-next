import { DiagnosticError, runtimeDiagnostic, type DiagnosticCode } from "@tegojs/contracts";

export const PROCESS_EXECUTOR_MAX_FRAME_BYTES = 1024 * 1024;
export const PROCESS_EXECUTOR_MAX_BUFFERED_BYTES = PROCESS_EXECUTOR_MAX_FRAME_BYTES + 4;
export const PROCESS_EXECUTOR_MAX_FRAME_DEPTH = 64;
export const PROCESS_EXECUTOR_MAX_FRAME_NODES = 100_000;

function framingError(code: DiagnosticCode, message: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "protocol", id: "process-executor" },
    }),
  );
}

function validateComplexity(value: unknown): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (
      nodes > PROCESS_EXECUTOR_MAX_FRAME_NODES ||
      current.depth > PROCESS_EXECUTOR_MAX_FRAME_DEPTH
    ) {
      throw framingError(
        "PROTOCOL_PROCESS_FRAME_COMPLEXITY_EXCEEDED",
        "Process frame exceeds the configured depth or node limit",
      );
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const child of Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

export function encodeProcessFrame(
  value: unknown,
  oversizedCode: DiagnosticCode = "EXECUTOR_INPUT_LIMIT_EXCEEDED",
): Uint8Array {
  let payload: Uint8Array;
  try {
    payload = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw framingError("PROTOCOL_PROCESS_FRAME_INVALID", "Process frame is not JSON-safe");
  }
  if (payload.byteLength === 0 || payload.byteLength > PROCESS_EXECUTOR_MAX_FRAME_BYTES) {
    throw framingError(oversizedCode, "Process frame exceeds the configured wire limit");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  frame.set(payload, 4);
  return frame;
}

export class ProcessFrameDecoder {
  #buffer = Buffer.alloc(0);
  #expectedLength: number | undefined;

  push(chunk: Uint8Array): readonly unknown[] {
    if (!(chunk instanceof Uint8Array)) {
      throw framingError("PROTOCOL_PROCESS_FRAME_INVALID", "Process frame chunk must be binary");
    }
    const values: unknown[] = [];
    const input = Buffer.from(chunk);
    let offset = 0;
    while (offset < input.byteLength) {
      if (this.#expectedLength === undefined) {
        const headerBytes = Math.min(4 - this.#buffer.byteLength, input.byteLength - offset);
        this.#buffer = Buffer.concat([this.#buffer, input.subarray(offset, offset + headerBytes)]);
        offset += headerBytes;
        if (this.#buffer.byteLength < 4) continue;
        const length = this.#buffer.readUInt32BE(0);
        this.#buffer = Buffer.alloc(0);
        // This check intentionally precedes buffering payload, decoding, and JSON.parse.
        if (length === 0 || length > PROCESS_EXECUTOR_MAX_FRAME_BYTES) {
          throw framingError(
            "PROTOCOL_PROCESS_FRAME_LENGTH_INVALID",
            "Process frame length exceeds the configured limit",
          );
        }
        this.#expectedLength = length;
      }
      const expectedLength = this.#expectedLength;
      const payloadBytes = Math.min(
        expectedLength - this.#buffer.byteLength,
        input.byteLength - offset,
      );
      this.#buffer = Buffer.concat([this.#buffer, input.subarray(offset, offset + payloadBytes)]);
      offset += payloadBytes;
      if (this.#buffer.byteLength < expectedLength) continue;
      const payload = this.#buffer;
      this.#buffer = Buffer.alloc(0);
      this.#expectedLength = undefined;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      } catch {
        throw framingError("PROTOCOL_PROCESS_FRAME_INVALID", "Process frame is not valid UTF-8");
      }
      try {
        const value: unknown = JSON.parse(text);
        validateComplexity(value);
        values.push(value);
      } catch (error) {
        if (error instanceof DiagnosticError) throw error;
        throw framingError("PROTOCOL_PROCESS_FRAME_INVALID", "Process frame is not valid JSON");
      }
    }
    return values;
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0 || this.#expectedLength !== undefined) {
      throw framingError(
        "PROTOCOL_PROCESS_FRAME_TRUNCATED",
        "Process frame ended before completion",
      );
    }
  }
}
