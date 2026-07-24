import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { JsonValue } from "@tegojs/contracts";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlResponse,
  MAX_CONTROL_LINE_BYTES,
  parseControlResponse,
  type RuntimeOperationName,
} from "./protocol.js";

export interface ControlClientOptions {
  readonly endpoint: string;
  readonly operation: RuntimeOperationName;
  readonly input: JsonValue;
  readonly timeoutMs: number;
  readonly requestId?: string;
  readonly maxLineBytes?: number;
}

export async function requestControl(options: ControlClientOptions): Promise<ControlResponse> {
  if (options.endpoint.length === 0) throw new TypeError("endpoint must not be empty");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  const requestId = options.requestId ?? randomUUID();
  const maxLineBytes = options.maxLineBytes ?? MAX_CONTROL_LINE_BYTES;

  return await new Promise<ControlResponse>((resolve, reject) => {
    const socket = createConnection(options.endpoint);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (
      outcome: { readonly error: Error } | { readonly response: ControlResponse },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.response);
    };
    const timer = setTimeout(() => {
      finish({
        error: new Error(
          `PROTOCOL_CONTROL_TIMEOUT: no response within ${String(options.timeoutMs)}ms`,
        ),
      });
    }, options.timeoutMs);
    timer.unref();

    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          requestId,
          operation: options.operation,
          input: options.input,
        })}\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxLineBytes) {
        finish({ error: new Error("PROTOCOL_CONTROL_FRAME_TOO_LARGE: response exceeds limit") });
        return;
      }
      chunks.push(chunk);
      const frame = Buffer.concat(chunks);
      const newline = frame.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== frame.byteLength - 1) {
        finish({ error: new Error("PROTOCOL_CONTROL_FRAME_INVALID: trailing response data") });
        return;
      }
      try {
        const response = parseControlResponse(
          JSON.parse(frame.subarray(0, newline).toString("utf8")),
        );
        if (response.requestId !== requestId) {
          finish({ error: new Error("PROTOCOL_CONTROL_REQUEST_MISMATCH: request ID changed") });
          return;
        }
        finish({ response });
      } catch (error) {
        finish({
          error:
            error instanceof Error
              ? error
              : new Error("PROTOCOL_CONTROL_FRAME_INVALID: response could not be decoded"),
        });
      }
    });
    socket.on("error", (error) => finish({ error }));
    socket.on("close", () => {
      if (!settled) {
        finish({ error: new Error("PROTOCOL_CONTROL_CLOSED: response was not completed") });
      }
    });
  });
}
