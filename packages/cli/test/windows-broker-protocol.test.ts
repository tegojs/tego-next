import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeWindowsBrokerFrame,
  WINDOWS_BROKER_MAX_FRAME_BYTES,
  WINDOWS_BROKER_PROTOCOL_VERSION,
  WindowsBrokerConnectionState,
  WindowsBrokerFrameDecoder,
} from "../src/control/windows-broker-protocol.js";

const PROTOCOL_ERROR = /PROTOCOL_CONTROL_ENDPOINT_UNSAFE/u;

function dataFrame(payload: Uint8Array, connectionId = 7n) {
  return { type: "data" as const, connectionId, payload };
}

function decode(encoded: Uint8Array) {
  const decoder = new WindowsBrokerFrameDecoder();
  const frames = decoder.push(encoded);
  decoder.finish();
  return frames;
}

test("Windows broker frames use the fixed big-endian 24-byte header", () => {
  const payload = Uint8Array.from([0, 1, 2, 3]);
  const encoded = encodeWindowsBrokerFrame(dataFrame(payload, 0x0102_0304_0506_0708n));

  assert.equal(encoded.byteLength, 24 + payload.byteLength);
  assert.equal(encoded.subarray(0, 4).toString("ascii"), "TGBP");
  assert.equal(encoded.readUInt16BE(4), WINDOWS_BROKER_PROTOCOL_VERSION);
  assert.equal(encoded.readUInt16BE(6), 3);
  assert.equal(encoded.readBigUInt64BE(8), 0x0102_0304_0506_0708n);
  assert.equal(encoded.readUInt32BE(16), payload.byteLength);
  assert.deepEqual([...encoded.subarray(20, 24)], [0, 0, 0, 0]);
  assert.deepEqual(decode(encoded), [dataFrame(payload, 0x0102_0304_0506_0708n)]);
});

test("Windows broker decoder handles split and coalesced frames without sharing payload storage", () => {
  const first = encodeWindowsBrokerFrame(dataFrame(Uint8Array.from([1, 2])));
  const second = encodeWindowsBrokerFrame(dataFrame(Uint8Array.from([3]), 8n));
  const backing = new Uint8Array(first.byteLength + second.byteLength + 6);
  const input = new Uint8Array(backing.buffer, 3, first.byteLength + second.byteLength);
  input.set(first, 0);
  input.set(second, first.byteLength);
  const decoder = new WindowsBrokerFrameDecoder();

  assert.equal(Buffer.isBuffer(input), false);
  assert.deepEqual(decoder.push(input.subarray(0, 5)), []);
  const frames = decoder.push(input.subarray(5));
  backing.fill(0);
  decoder.finish();

  assert.notEqual(frames[0]?.payload.buffer, input.buffer);
  assert.equal(frames[0]?.payload.byteOffset, 0);
  assert.equal(frames[0]?.payload.buffer.byteLength, 2);
  assert.equal(frames[1]?.payload.buffer.byteLength, 1);
  assert.deepEqual(frames, [
    dataFrame(Uint8Array.from([1, 2])),
    dataFrame(Uint8Array.from([3]), 8n),
  ]);
});

test("Windows broker frames reject invalid magic, version, type, and connection ID classes", () => {
  const encoded = encodeWindowsBrokerFrame(dataFrame(Uint8Array.from([1])));

  for (const mutate of [
    (frame: Buffer) => frame.write("FAIL", 0, "ascii"),
    (frame: Buffer) => frame.writeUInt16BE(WINDOWS_BROKER_PROTOCOL_VERSION + 1, 4),
    (frame: Buffer) => frame.writeUInt16BE(0xffff, 6),
    (frame: Buffer) => frame.writeBigUInt64BE(0n, 8),
  ]) {
    const invalid = Buffer.from(encoded);
    mutate(invalid);
    assert.throws(() => decode(invalid), PROTOCOL_ERROR);
  }

  assert.throws(
    () => encodeWindowsBrokerFrame({ type: "ready", connectionId: 1n, payload: new Uint8Array() }),
    PROTOCOL_ERROR,
  );
  assert.throws(() => encodeWindowsBrokerFrame(dataFrame(new Uint8Array(), 0n)), PROTOCOL_ERROR);
});

test("Windows broker frames reject nonzero reserved bytes and malformed frame values", () => {
  const invalidHeader = encodeWindowsBrokerFrame(dataFrame(Uint8Array.from([1])));
  invalidHeader[20] = 1;

  assert.throws(() => decode(invalidHeader), PROTOCOL_ERROR);
  assert.throws(() => encodeWindowsBrokerFrame(null as never), PROTOCOL_ERROR);
});

test("Windows broker frames bound payloads and preserve unsigned 64-bit connection IDs", () => {
  const maximum = new Uint8Array(WINDOWS_BROKER_MAX_FRAME_BYTES);
  const encoded = encodeWindowsBrokerFrame(dataFrame(maximum, 0xffff_ffff_ffff_ffffn));

  assert.equal(decode(encoded)[0]?.connectionId, 0xffff_ffff_ffff_ffffn);
  assert.throws(
    () => encodeWindowsBrokerFrame(dataFrame(new Uint8Array(WINDOWS_BROKER_MAX_FRAME_BYTES + 1))),
    PROTOCOL_ERROR,
  );

  const oversized = Buffer.from(encoded);
  oversized.writeUInt32BE(WINDOWS_BROKER_MAX_FRAME_BYTES + 1, 16);
  assert.throws(() => decode(oversized.subarray(0, 24)), PROTOCOL_ERROR);
});

test("Windows broker decoder fails closed on truncated frames", () => {
  const encoded = encodeWindowsBrokerFrame(dataFrame(Uint8Array.from([1, 2, 3])));
  const decoder = new WindowsBrokerFrameDecoder();

  decoder.push(encoded.subarray(0, encoded.byteLength - 1));

  assert.throws(() => decoder.finish(), PROTOCOL_ERROR);
});

const brokerToParent = "broker-to-parent" as const;
const parentToBroker = "parent-to-broker" as const;

function accept(
  state: WindowsBrokerConnectionState,
  direction: typeof brokerToParent | typeof parentToBroker,
  type:
    | "close"
    | "close-all"
    | "close-all-ack"
    | "data"
    | "eof"
    | "fatal"
    | "open"
    | "pause"
    | "ready"
    | "resume",
  connectionId: bigint,
  payload = new Uint8Array(),
): void {
  state.accept({ type, connectionId, payload }, direction);
}

function readyAndOpen(state: WindowsBrokerConnectionState, connectionId = 1n): void {
  accept(state, brokerToParent, "ready", 0n);
  accept(state, brokerToParent, "open", connectionId);
}

test("Windows broker state limits global frames and opens to their owning directions", () => {
  const state = new WindowsBrokerConnectionState();
  assert.throws(() => accept(state, parentToBroker, "ready", 0n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, brokerToParent, "open", 1n), PROTOCOL_ERROR);
  accept(state, brokerToParent, "ready", 0n);
  assert.throws(() => accept(state, parentToBroker, "open", 1n), PROTOCOL_ERROR);
  accept(state, brokerToParent, "open", 1n);
  accept(state, brokerToParent, "close", 1n);
  accept(state, brokerToParent, "open", 2n);
  assert.throws(() => accept(state, brokerToParent, "open", 1n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, brokerToParent, "ready", 0n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, brokerToParent, "close-all", 0n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, parentToBroker, "close-all-ack", 0n), PROTOCOL_ERROR);
});

test("EOF only closes its own direction while CLOSE terminally closes both directions", () => {
  const state = new WindowsBrokerConnectionState();
  readyAndOpen(state);
  accept(state, brokerToParent, "data", 1n, Uint8Array.from([1]));
  accept(state, brokerToParent, "eof", 1n);
  assert.throws(
    () => accept(state, brokerToParent, "data", 1n, Uint8Array.from([2])),
    PROTOCOL_ERROR,
  );
  assert.throws(() => accept(state, brokerToParent, "eof", 1n), PROTOCOL_ERROR);
  accept(state, parentToBroker, "data", 1n, Uint8Array.from([3]));
  accept(state, brokerToParent, "close", 1n);
  assert.throws(
    () => accept(state, brokerToParent, "data", 1n, Uint8Array.from([4])),
    PROTOCOL_ERROR,
  );
  assert.throws(() => accept(state, brokerToParent, "close", 1n), PROTOCOL_ERROR);
});

test("PAUSE pauses only the opposite direction until its matching RESUME", () => {
  const state = new WindowsBrokerConnectionState();
  readyAndOpen(state);
  assert.throws(() => accept(state, parentToBroker, "resume", 1n), PROTOCOL_ERROR);
  accept(state, parentToBroker, "pause", 1n);
  assert.throws(
    () => accept(state, brokerToParent, "data", 1n, Uint8Array.from([1])),
    PROTOCOL_ERROR,
  );
  accept(state, parentToBroker, "data", 1n, Uint8Array.from([2]));
  assert.throws(() => accept(state, parentToBroker, "pause", 1n), PROTOCOL_ERROR);
  accept(state, parentToBroker, "resume", 1n);
  accept(state, brokerToParent, "data", 1n, Uint8Array.from([3]));
  assert.throws(() => accept(state, brokerToParent, "resume", 1n), PROTOCOL_ERROR);
});

test("the approved frame direction allowlist rejects inverted EOF and backpressure frames", () => {
  const state = new WindowsBrokerConnectionState();
  readyAndOpen(state);

  assert.throws(() => accept(state, parentToBroker, "eof", 1n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, brokerToParent, "pause", 1n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, brokerToParent, "resume", 1n), PROTOCOL_ERROR);
});

test("queue limits are direction-aware, drain requires the matching active direction, and CLOSE discards both", () => {
  const state = new WindowsBrokerConnectionState({ maxConnectionBytes: 3, maxTotalBytes: 4 });
  readyAndOpen(state);
  accept(state, brokerToParent, "data", 1n, Uint8Array.from([1, 2]));
  assert.throws(() => state.drain(1n, parentToBroker, 1), PROTOCOL_ERROR);
  accept(state, parentToBroker, "data", 1n, Uint8Array.from([3]));
  assert.throws(
    () => accept(state, brokerToParent, "data", 1n, Uint8Array.from([4, 5])),
    PROTOCOL_ERROR,
  );
  assert.throws(() => state.drain(1n, parentToBroker, 2), PROTOCOL_ERROR);
  state.drain(1n, brokerToParent, 1);
  state.drain(1n, parentToBroker, 1);
  accept(state, brokerToParent, "data", 1n, Uint8Array.from([4, 5]));
  accept(state, brokerToParent, "close", 1n);
  assert.throws(() => state.drain(1n, brokerToParent, 1), PROTOCOL_ERROR);
  accept(state, brokerToParent, "open", 2n);
  accept(state, brokerToParent, "data", 2n, Uint8Array.from([6, 7, 8]));
});

test("maxConnectionBytes caps the aggregate queue of both directions", () => {
  const state = new WindowsBrokerConnectionState({ maxConnectionBytes: 3, maxTotalBytes: 8 });
  readyAndOpen(state);
  accept(state, brokerToParent, "data", 1n, Uint8Array.from([1, 2]));

  assert.throws(
    () => accept(state, parentToBroker, "data", 1n, Uint8Array.from([3, 4])),
    PROTOCOL_ERROR,
  );
});

test("CLOSE_ALL requires parent ownership, drains all terminals before broker acknowledgement, then fences every frame", () => {
  const state = new WindowsBrokerConnectionState();
  readyAndOpen(state, 1n);
  accept(state, brokerToParent, "open", 2n);
  accept(state, parentToBroker, "close-all", 0n);
  assert.throws(() => accept(state, brokerToParent, "open", 3n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, parentToBroker, "close", 1n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, parentToBroker, "pause", 1n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, brokerToParent, "pause", 1n), PROTOCOL_ERROR);
  assert.throws(
    () => accept(state, parentToBroker, "data", 1n, Uint8Array.from([1])),
    PROTOCOL_ERROR,
  );
  assert.throws(() => accept(state, brokerToParent, "close-all-ack", 0n), PROTOCOL_ERROR);
  accept(state, brokerToParent, "eof", 1n);
  accept(state, brokerToParent, "close", 1n);
  accept(state, brokerToParent, "close", 2n);
  accept(state, brokerToParent, "close-all-ack", 0n);
  assert.throws(() => accept(state, brokerToParent, "fatal", 0n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, brokerToParent, "ready", 0n), PROTOCOL_ERROR);
});

test("FATAL belongs to the broker, can precede READY, and terminally fences the protocol", () => {
  const state = new WindowsBrokerConnectionState();
  assert.throws(() => accept(state, parentToBroker, "fatal", 0n), PROTOCOL_ERROR);
  accept(state, brokerToParent, "fatal", 0n, Uint8Array.from([1]));
  assert.throws(() => accept(state, brokerToParent, "fatal", 0n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, brokerToParent, "ready", 0n), PROTOCOL_ERROR);
  assert.throws(() => accept(state, parentToBroker, "close-all", 0n), PROTOCOL_ERROR);
});
