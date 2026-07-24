import assert from "node:assert/strict";
import { test } from "node:test";
import { workerSessionConformance } from "@tegojs/testkit";
import {
  createMainEndpoint,
  createWorkerCodec,
  createWorkerEndpoint,
  type WorkerControlEnvelope,
} from "../src/index.js";

workerSessionConformance(createMainEndpoint, createWorkerEndpoint);

const ENVELOPE: WorkerControlEnvelope = {
  protocol: "1.0",
  messageId: "message-1",
  sessionId: "session-1",
  sequence: "0",
  type: "heartbeat",
  sentAt: new Date(0).toISOString(),
  payload: {},
};

test("codec rejects oversized control frames before JSON parsing", () => {
  const codec = createWorkerCodec({ maxFrameBytes: 64 });
  assert.throws(
    () => codec.decodeControl(`{"${"x".repeat(128)}":`),
    (error: unknown) =>
      error instanceof Error &&
      "diagnostic" in error &&
      (error as { diagnostic: { code: string } }).diagnostic.code === "PROTOCOL_FRAME_TOO_LARGE",
  );
});

test("codec accepts only exact JSON data fields and decimal sequence values", () => {
  const codec = createWorkerCodec();
  assert.deepEqual(codec.decodeControl(codec.encodeControl(ENVELOPE)), ENVELOPE);
  assert.throws(() =>
    codec.decodeControl(
      JSON.stringify({
        ...ENVELOPE,
        sequence: 1,
      }),
    ),
  );
  assert.throws(() =>
    codec.decodeControl(
      JSON.stringify({
        ...ENVELOPE,
        unexpected: true,
      }),
    ),
  );
});

test("binary codec rejects partial, oversized, and inconsistent frames", () => {
  const codec = createWorkerCodec({ maxFrameBytes: 128, maxBinaryBytes: 64 });
  const frame = codec.encodeBinary({
    correlationId: "message-1",
    chunkIndex: 0,
    totalChunks: 1,
    payload: Uint8Array.of(1, 2, 3),
  });
  assert.deepEqual(codec.decodeBinary(frame), {
    correlationId: "message-1",
    chunkIndex: 0,
    totalChunks: 1,
    payload: Uint8Array.of(1, 2, 3),
  });
  assert.throws(() => codec.decodeBinary(frame.subarray(0, frame.length - 1)));
  assert.throws(() => codec.decodeBinary(new Uint8Array(129)));
});
