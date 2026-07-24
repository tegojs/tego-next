import {
  DiagnosticError,
  parseMessageId,
  parseSequence,
  parseSessionId,
  runtimeDiagnostic,
  serializeWireValue,
  type JsonValue,
} from "@tegojs/contracts";

const CONTROL_FIELDS = new Set([
  "protocol",
  "messageId",
  "sessionId",
  "sequence",
  "correlationId",
  "type",
  "sentAt",
  "payload",
  "binaryBytes",
  "binaryChunks",
]);
const BINARY_HEADER_BYTES = 16;
const BINARY_MAGIC = 0x54;
const BINARY_VERSION = 1;
const MESSAGE_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface WorkerProtocolLimits {
  readonly maxFrameBytes: number;
  readonly maxBinaryBytes: number;
  readonly maxBinaryChunks: number;
  readonly maxPendingCorrelations: number;
  readonly maxInflightMessages: number;
  readonly maxSequenceGap: number;
  readonly replayRetention: number;
}

export const DEFAULT_WORKER_PROTOCOL_LIMITS: WorkerProtocolLimits = {
  maxFrameBytes: 64 * 1024,
  maxBinaryBytes: 8 * 1024 * 1024,
  maxBinaryChunks: 256,
  maxPendingCorrelations: 32,
  maxInflightMessages: 128,
  maxSequenceGap: 32,
  replayRetention: 1_024,
};

export type WorkerProtocolLimitOverrides = Partial<WorkerProtocolLimits>;

export interface WorkerControlEnvelope {
  readonly protocol: string;
  readonly messageId: string;
  readonly sessionId: string;
  readonly sequence: string;
  readonly correlationId?: string;
  readonly type: string;
  readonly sentAt: string;
  readonly payload: JsonValue;
  readonly binaryBytes?: number;
  readonly binaryChunks?: number;
}

export interface WorkerBinaryChunk {
  readonly correlationId: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly payload: Uint8Array;
}

function protocolError(
  code: `PROTOCOL_${string}`,
  message: string,
  details?: JsonValue,
): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "protocol", id: "worker-websocket" },
      ...(details === undefined ? {} : { details }),
    }),
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function normalizeLimits(overrides: WorkerProtocolLimitOverrides = {}): WorkerProtocolLimits {
  return {
    maxFrameBytes: positiveInteger(
      overrides.maxFrameBytes ?? DEFAULT_WORKER_PROTOCOL_LIMITS.maxFrameBytes,
      "maxFrameBytes",
    ),
    maxBinaryBytes: positiveInteger(
      overrides.maxBinaryBytes ?? DEFAULT_WORKER_PROTOCOL_LIMITS.maxBinaryBytes,
      "maxBinaryBytes",
    ),
    maxBinaryChunks: positiveInteger(
      overrides.maxBinaryChunks ?? DEFAULT_WORKER_PROTOCOL_LIMITS.maxBinaryChunks,
      "maxBinaryChunks",
    ),
    maxPendingCorrelations: positiveInteger(
      overrides.maxPendingCorrelations ?? DEFAULT_WORKER_PROTOCOL_LIMITS.maxPendingCorrelations,
      "maxPendingCorrelations",
    ),
    maxInflightMessages: positiveInteger(
      overrides.maxInflightMessages ?? DEFAULT_WORKER_PROTOCOL_LIMITS.maxInflightMessages,
      "maxInflightMessages",
    ),
    maxSequenceGap: positiveInteger(
      overrides.maxSequenceGap ?? DEFAULT_WORKER_PROTOCOL_LIMITS.maxSequenceGap,
      "maxSequenceGap",
    ),
    replayRetention: positiveInteger(
      overrides.replayRetention ?? DEFAULT_WORKER_PROTOCOL_LIMITS.replayRetention,
      "replayRetention",
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError("PROTOCOL_ENVELOPE_INVALID", "Worker envelope must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function exactFields(record: Record<string, unknown>): void {
  for (const field of Object.keys(record)) {
    if (!CONTROL_FIELDS.has(field)) {
      throw protocolError(
        "PROTOCOL_ENVELOPE_INVALID",
        "Worker envelope contains an unsupported field",
        { field },
      );
    }
  }
}

function finiteNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolError("PROTOCOL_ENVELOPE_INVALID", `${name} must be a non-negative integer`);
  }
  return value as number;
}

export interface WorkerCodec {
  readonly limits: WorkerProtocolLimits;
  encodeControl(envelope: WorkerControlEnvelope): string;
  decodeControl(frame: string): WorkerControlEnvelope;
  encodeBinary(chunk: WorkerBinaryChunk): Uint8Array;
  decodeBinary(frame: Uint8Array): WorkerBinaryChunk;
}

export function createWorkerCodec(
  overrides: WorkerProtocolLimitOverrides = {},
  supportedProtocol = "1.0",
): WorkerCodec {
  const limits = normalizeLimits(overrides);

  function validateControl(value: unknown): WorkerControlEnvelope {
    const record = asRecord(value);
    exactFields(record);
    if (record.protocol !== supportedProtocol) {
      throw protocolError(
        "PROTOCOL_VERSION_UNSUPPORTED",
        "Worker protocol version is not supported",
        {
          received: typeof record.protocol === "string" ? record.protocol : typeof record.protocol,
          supported: supportedProtocol,
        },
      );
    }
    if (typeof record.messageId !== "string") {
      throw protocolError("PROTOCOL_ENVELOPE_INVALID", "messageId must be a string");
    }
    if (typeof record.sessionId !== "string") {
      throw protocolError("PROTOCOL_ENVELOPE_INVALID", "sessionId must be a string");
    }
    if (typeof record.sequence !== "string") {
      throw protocolError("PROTOCOL_ENVELOPE_INVALID", "sequence must be a decimal string");
    }
    if (
      typeof record.type !== "string" ||
      record.type.length > 128 ||
      !MESSAGE_TYPE_PATTERN.test(record.type)
    ) {
      throw protocolError("PROTOCOL_ENVELOPE_INVALID", "type must be a protocol message type");
    }
    if (
      typeof record.sentAt !== "string" ||
      !Number.isFinite(Date.parse(record.sentAt)) ||
      new Date(record.sentAt).toISOString() !== record.sentAt
    ) {
      throw protocolError("PROTOCOL_ENVELOPE_INVALID", "sentAt must be an ISO timestamp");
    }
    parseMessageId(record.messageId);
    parseSessionId(record.sessionId);
    parseSequence(record.sequence);
    if (record.correlationId !== undefined) {
      parseMessageId(record.correlationId);
    }
    const payload = serializeWireValue(record.payload);
    const binaryBytes = finiteNonNegativeInteger(record.binaryBytes, "binaryBytes");
    const binaryChunks = finiteNonNegativeInteger(record.binaryChunks, "binaryChunks");
    if ((binaryBytes === undefined) !== (binaryChunks === undefined)) {
      throw protocolError(
        "PROTOCOL_ENVELOPE_INVALID",
        "binaryBytes and binaryChunks must be provided together",
      );
    }
    if (
      binaryBytes !== undefined &&
      (binaryBytes > limits.maxBinaryBytes ||
        binaryChunks === undefined ||
        binaryChunks === 0 ||
        binaryChunks > limits.maxBinaryChunks)
    ) {
      throw protocolError(
        "PROTOCOL_BINARY_LIMIT_EXCEEDED",
        "Worker binary payload exceeds configured limits",
      );
    }
    return {
      protocol: record.protocol,
      messageId: record.messageId,
      sessionId: record.sessionId,
      sequence: record.sequence,
      ...(record.correlationId === undefined
        ? {}
        : { correlationId: record.correlationId as string }),
      type: record.type,
      sentAt: record.sentAt,
      payload,
      ...(binaryBytes === undefined ? {} : { binaryBytes }),
      ...(binaryChunks === undefined ? {} : { binaryChunks }),
    };
  }

  return {
    limits,
    encodeControl(envelope): string {
      const encoded = JSON.stringify(validateControl(envelope));
      if (Buffer.byteLength(encoded, "utf8") > limits.maxFrameBytes) {
        throw protocolError(
          "PROTOCOL_FRAME_TOO_LARGE",
          "Worker control frame exceeds the configured byte limit",
        );
      }
      return encoded;
    },
    decodeControl(frame): WorkerControlEnvelope {
      if (Buffer.byteLength(frame, "utf8") > limits.maxFrameBytes) {
        throw protocolError(
          "PROTOCOL_FRAME_TOO_LARGE",
          "Worker control frame exceeds the configured byte limit",
        );
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(frame);
      } catch {
        throw protocolError("PROTOCOL_JSON_INVALID", "Worker control frame is not valid JSON");
      }
      return validateControl(decoded);
    },
    encodeBinary(chunk): Uint8Array {
      const correlation = textEncoder.encode(chunk.correlationId);
      parseMessageId(chunk.correlationId);
      if (
        correlation.byteLength === 0 ||
        correlation.byteLength > 0xffff ||
        !Number.isSafeInteger(chunk.chunkIndex) ||
        chunk.chunkIndex < 0 ||
        !Number.isSafeInteger(chunk.totalChunks) ||
        chunk.totalChunks <= 0 ||
        chunk.totalChunks > limits.maxBinaryChunks ||
        chunk.chunkIndex >= chunk.totalChunks ||
        chunk.payload.byteLength > limits.maxBinaryBytes
      ) {
        throw protocolError("PROTOCOL_BINARY_INVALID", "Worker binary chunk metadata is invalid");
      }
      const size = BINARY_HEADER_BYTES + correlation.byteLength + chunk.payload.byteLength;
      if (size > limits.maxFrameBytes) {
        throw protocolError(
          "PROTOCOL_FRAME_TOO_LARGE",
          "Worker binary frame exceeds the configured byte limit",
        );
      }
      const frame = new Uint8Array(size);
      const view = new DataView(frame.buffer);
      frame[0] = BINARY_MAGIC;
      frame[1] = BINARY_VERSION;
      view.setUint16(2, correlation.byteLength);
      view.setUint32(4, chunk.chunkIndex);
      view.setUint32(8, chunk.totalChunks);
      view.setUint32(12, chunk.payload.byteLength);
      frame.set(correlation, BINARY_HEADER_BYTES);
      frame.set(chunk.payload, BINARY_HEADER_BYTES + correlation.byteLength);
      return frame;
    },
    decodeBinary(frame): WorkerBinaryChunk {
      if (frame.byteLength > limits.maxFrameBytes) {
        throw protocolError(
          "PROTOCOL_FRAME_TOO_LARGE",
          "Worker binary frame exceeds the configured byte limit",
        );
      }
      if (frame.byteLength < BINARY_HEADER_BYTES) {
        throw protocolError("PROTOCOL_BINARY_INVALID", "Worker binary frame is truncated");
      }
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      if (frame[0] !== BINARY_MAGIC || frame[1] !== BINARY_VERSION) {
        throw protocolError("PROTOCOL_BINARY_INVALID", "Worker binary frame header is invalid");
      }
      const correlationBytes = view.getUint16(2);
      const chunkIndex = view.getUint32(4);
      const totalChunks = view.getUint32(8);
      const payloadBytes = view.getUint32(12);
      const expectedSize = BINARY_HEADER_BYTES + correlationBytes + payloadBytes;
      if (
        correlationBytes === 0 ||
        totalChunks === 0 ||
        totalChunks > limits.maxBinaryChunks ||
        chunkIndex >= totalChunks ||
        payloadBytes > limits.maxBinaryBytes ||
        expectedSize !== frame.byteLength
      ) {
        throw protocolError("PROTOCOL_BINARY_INVALID", "Worker binary frame lengths are invalid");
      }
      let correlationId: string;
      try {
        correlationId = textDecoder.decode(
          frame.subarray(BINARY_HEADER_BYTES, BINARY_HEADER_BYTES + correlationBytes),
        );
      } catch {
        throw protocolError(
          "PROTOCOL_BINARY_INVALID",
          "Worker binary correlation identity is not UTF-8",
        );
      }
      parseMessageId(correlationId);
      return {
        correlationId,
        chunkIndex,
        totalChunks,
        payload: frame.slice(BINARY_HEADER_BYTES + correlationBytes),
      };
    },
  };
}
