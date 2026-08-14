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
  const combined = Buffer.concat([first, second]);
  const decoder = new WindowsBrokerFrameDecoder();

  assert.deepEqual(decoder.push(combined.subarray(0, 5)), []);
  const frames = decoder.push(combined.subarray(5));
  combined.fill(0);
  decoder.finish();

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

function open(state: WindowsBrokerConnectionState, connectionId: bigint): void {
  state.accept({ type: "open", connectionId, payload: new Uint8Array() });
}

function close(state: WindowsBrokerConnectionState, connectionId: bigint): void {
  state.accept({ type: "close", connectionId, payload: new Uint8Array() });
}

test("Windows broker state accepts each nonzero connection ID only once and in increasing order", () => {
  const state = new WindowsBrokerConnectionState();

  open(state, 1n);
  close(state, 1n);
  open(state, 2n);

  assert.throws(() => open(state, 1n), PROTOCOL_ERROR);
  assert.throws(() => open(state, 2n), PROTOCOL_ERROR);
  assert.throws(() => open(state, 0n), PROTOCOL_ERROR);
});

test("Windows broker state rejects data outside an open nonterminal connection", () => {
  const state = new WindowsBrokerConnectionState();

  assert.throws(
    () => state.accept({ type: "data", connectionId: 1n, payload: Uint8Array.from([1]) }),
    PROTOCOL_ERROR,
  );
  open(state, 1n);
  state.accept({ type: "data", connectionId: 1n, payload: Uint8Array.from([1]) });
  close(state, 1n);

  assert.throws(
    () => state.accept({ type: "data", connectionId: 1n, payload: Uint8Array.from([2]) }),
    PROTOCOL_ERROR,
  );
  assert.throws(() => close(state, 1n), PROTOCOL_ERROR);
  assert.throws(
    () => state.accept({ type: "eof", connectionId: 1n, payload: new Uint8Array() }),
    PROTOCOL_ERROR,
  );
});

test("Windows broker state allows one EOF before close but rejects duplicate EOF", () => {
  const state = new WindowsBrokerConnectionState();
  open(state, 1n);

  state.accept({ type: "eof", connectionId: 1n, payload: new Uint8Array() });
  state.accept({ type: "data", connectionId: 1n, payload: Uint8Array.from([1]) });

  assert.throws(
    () => state.accept({ type: "eof", connectionId: 1n, payload: new Uint8Array() }),
    PROTOCOL_ERROR,
  );
});

test("Windows broker state permits only pause then resume backpressure transitions", () => {
  const state = new WindowsBrokerConnectionState();
  open(state, 1n);

  assert.throws(
    () => state.accept({ type: "resume", connectionId: 1n, payload: new Uint8Array() }),
    PROTOCOL_ERROR,
  );
  state.accept({ type: "pause", connectionId: 1n, payload: new Uint8Array() });
  assert.throws(
    () => state.accept({ type: "pause", connectionId: 1n, payload: new Uint8Array() }),
    PROTOCOL_ERROR,
  );
  state.accept({ type: "resume", connectionId: 1n, payload: new Uint8Array() });
});

test("Windows broker state permits one ready, fences after fatal, and pairs close-all acknowledgement", () => {
  const ready = new WindowsBrokerConnectionState();
  ready.accept({ type: "ready", connectionId: 0n, payload: new Uint8Array() });
  assert.throws(
    () => ready.accept({ type: "ready", connectionId: 0n, payload: new Uint8Array() }),
    PROTOCOL_ERROR,
  );

  const fatal = new WindowsBrokerConnectionState();
  fatal.accept({ type: "fatal", connectionId: 0n, payload: Uint8Array.from([1]) });
  assert.throws(() => open(fatal, 1n), PROTOCOL_ERROR);

  const closing = new WindowsBrokerConnectionState();
  closing.accept({ type: "close-all", connectionId: 0n, payload: new Uint8Array() });
  assert.throws(() => open(closing, 1n), PROTOCOL_ERROR);
  closing.accept({ type: "close-all-ack", connectionId: 0n, payload: new Uint8Array() });
  assert.throws(
    () => closing.accept({ type: "close-all-ack", connectionId: 0n, payload: new Uint8Array() }),
    PROTOCOL_ERROR,
  );
});

test("Windows broker state rejects data after close-all while permitting connection terminals", () => {
  const state = new WindowsBrokerConnectionState();
  open(state, 1n);
  state.accept({ type: "close-all", connectionId: 0n, payload: new Uint8Array() });

  assert.throws(
    () => state.accept({ type: "data", connectionId: 1n, payload: Uint8Array.from([1]) }),
    PROTOCOL_ERROR,
  );
  close(state, 1n);
  state.accept({ type: "close-all-ack", connectionId: 0n, payload: new Uint8Array() });
});

test("Windows broker state bounds queued bytes per connection and across connections", () => {
  const perConnection = new WindowsBrokerConnectionState({
    maxConnectionBytes: 3,
    maxTotalBytes: 8,
  });
  open(perConnection, 1n);
  perConnection.accept({ type: "data", connectionId: 1n, payload: Uint8Array.from([1, 2, 3]) });
  assert.throws(
    () => perConnection.accept({ type: "data", connectionId: 1n, payload: Uint8Array.from([4]) }),
    PROTOCOL_ERROR,
  );

  const total = new WindowsBrokerConnectionState({ maxConnectionBytes: 3, maxTotalBytes: 4 });
  open(total, 1n);
  open(total, 2n);
  total.accept({ type: "data", connectionId: 1n, payload: Uint8Array.from([1, 2, 3]) });
  assert.throws(
    () => total.accept({ type: "data", connectionId: 2n, payload: Uint8Array.from([4, 5]) }),
    PROTOCOL_ERROR,
  );
});

test("Windows broker state releases drained bytes back to both queue limits", () => {
  const state = new WindowsBrokerConnectionState({ maxConnectionBytes: 4, maxTotalBytes: 4 });
  open(state, 1n);
  open(state, 2n);
  state.accept({ type: "data", connectionId: 1n, payload: Uint8Array.from([1, 2, 3]) });

  assert.throws(
    () => state.accept({ type: "data", connectionId: 2n, payload: Uint8Array.from([4, 5]) }),
    PROTOCOL_ERROR,
  );
  state.drain(1n, 2);
  state.accept({ type: "data", connectionId: 2n, payload: Uint8Array.from([4, 5]) });

  assert.throws(() => state.drain(1n, 2), PROTOCOL_ERROR);
});
