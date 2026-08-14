export const WINDOWS_BROKER_PROTOCOL_VERSION = 1;
export const WINDOWS_BROKER_MAX_FRAME_BYTES = 64 * 1024;
export const WINDOWS_BROKER_MAX_CONNECTION_BYTES = 256 * 1024;

const WINDOWS_BROKER_HEADER_BYTES = 24;
const WINDOWS_BROKER_MAGIC = "TGBP";
const MAX_CONNECTION_ID = 0xffff_ffff_ffff_ffffn;

const frameTypeCodes = {
  ready: 1,
  open: 2,
  data: 3,
  eof: 4,
  close: 5,
  fatal: 6,
  pause: 7,
  resume: 8,
  "close-all": 9,
  "close-all-ack": 10,
} as const;

export type WindowsBrokerFrameType = keyof typeof frameTypeCodes;

export interface WindowsBrokerFrame {
  readonly type: WindowsBrokerFrameType;
  readonly connectionId: bigint;
  readonly payload: Uint8Array;
}

const frameTypesByCode = new Map<number, WindowsBrokerFrameType>(
  Object.entries(frameTypeCodes).map(([type, code]) => [code, type as WindowsBrokerFrameType]),
);

function protocolError(): Error {
  return new Error("PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
}

function connectionScoped(type: WindowsBrokerFrameType): boolean {
  return !["ready", "fatal", "close-all", "close-all-ack"].includes(type);
}

function assertConnectionId(connectionId: bigint, type: WindowsBrokerFrameType): void {
  if (
    typeof connectionId !== "bigint" ||
    connectionId < 0n ||
    connectionId > MAX_CONNECTION_ID ||
    (connectionScoped(type) ? connectionId === 0n : connectionId !== 0n)
  ) {
    throw protocolError();
  }
}

function assertFrame(frame: WindowsBrokerFrame): void {
  const value = frame as unknown;
  if (typeof value !== "object" || value === null) throw protocolError();
  const { connectionId, payload, type } = value as {
    readonly connectionId?: unknown;
    readonly payload?: unknown;
    readonly type?: unknown;
  };
  if (
    typeof type !== "string" ||
    !Object.hasOwn(frameTypeCodes, type) ||
    !(payload instanceof Uint8Array) ||
    payload.byteLength > WINDOWS_BROKER_MAX_FRAME_BYTES
  ) {
    throw protocolError();
  }
  assertConnectionId(connectionId as bigint, type as WindowsBrokerFrameType);
}

export function encodeWindowsBrokerFrame(frame: WindowsBrokerFrame): Buffer {
  assertFrame(frame);
  const encoded = Buffer.allocUnsafe(WINDOWS_BROKER_HEADER_BYTES + frame.payload.byteLength);
  encoded.write(WINDOWS_BROKER_MAGIC, 0, "ascii");
  encoded.writeUInt16BE(WINDOWS_BROKER_PROTOCOL_VERSION, 4);
  encoded.writeUInt16BE(frameTypeCodes[frame.type], 6);
  encoded.writeBigUInt64BE(frame.connectionId, 8);
  encoded.writeUInt32BE(frame.payload.byteLength, 16);
  encoded.fill(0, 20, WINDOWS_BROKER_HEADER_BYTES);
  encoded.set(frame.payload, WINDOWS_BROKER_HEADER_BYTES);
  return encoded;
}

function decodeHeader(encoded: Buffer): {
  readonly frame: Omit<WindowsBrokerFrame, "payload">;
  readonly length: number;
} {
  if (
    encoded.toString("ascii", 0, 4) !== WINDOWS_BROKER_MAGIC ||
    encoded.readUInt16BE(4) !== WINDOWS_BROKER_PROTOCOL_VERSION ||
    encoded.subarray(20, WINDOWS_BROKER_HEADER_BYTES).some((byte) => byte !== 0)
  ) {
    throw protocolError();
  }
  const type = frameTypesByCode.get(encoded.readUInt16BE(6));
  if (type === undefined) throw protocolError();
  const connectionId = encoded.readBigUInt64BE(8);
  const length = encoded.readUInt32BE(16);
  if (length > WINDOWS_BROKER_MAX_FRAME_BYTES) throw protocolError();
  assertConnectionId(connectionId, type);
  return { frame: { connectionId, type }, length };
}

export class WindowsBrokerFrameDecoder {
  #finished = false;
  #pending = Buffer.alloc(0);

  push(chunk: Uint8Array): readonly WindowsBrokerFrame[] {
    if (this.#finished || !(chunk instanceof Uint8Array)) throw protocolError();
    const encoded = Buffer.concat([this.#pending, Buffer.from(chunk)]);
    const frames: WindowsBrokerFrame[] = [];
    let offset = 0;

    while (encoded.byteLength - offset >= WINDOWS_BROKER_HEADER_BYTES) {
      const header = decodeHeader(encoded.subarray(offset, offset + WINDOWS_BROKER_HEADER_BYTES));
      const frameLength = WINDOWS_BROKER_HEADER_BYTES + header.length;
      if (encoded.byteLength - offset < frameLength) break;
      frames.push({
        ...header.frame,
        payload: Uint8Array.from(
          encoded.subarray(offset + WINDOWS_BROKER_HEADER_BYTES, offset + frameLength),
        ),
      });
      offset += frameLength;
    }

    this.#pending = Buffer.from(encoded.subarray(offset));
    return frames;
  }

  finish(): void {
    this.#finished = true;
    if (this.#pending.byteLength !== 0) throw protocolError();
  }
}

interface WindowsBrokerConnectionStateOptions {
  readonly maxConnectionBytes?: number;
  readonly maxTotalBytes?: number;
}

interface ConnectionState {
  eof: boolean;
  paused: boolean;
  queuedBytes: number;
  closed: boolean;
}

function byteLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) throw protocolError();
  return limit;
}

function requireEmptyPayload(frame: WindowsBrokerFrame): void {
  if (frame.payload.byteLength !== 0) throw protocolError();
}

export class WindowsBrokerConnectionState {
  #closeAllAcknowledged = false;
  #closeAllRequested = false;
  #fatal = false;
  #lastConnectionId = 0n;
  #ready = false;
  #totalQueuedBytes = 0;
  readonly #connections = new Map<bigint, ConnectionState>();
  readonly #maxConnectionBytes: number;
  readonly #maxTotalBytes: number;

  constructor(options: WindowsBrokerConnectionStateOptions = {}) {
    this.#maxConnectionBytes = byteLimit(
      options.maxConnectionBytes,
      WINDOWS_BROKER_MAX_CONNECTION_BYTES,
    );
    this.#maxTotalBytes = byteLimit(options.maxTotalBytes, WINDOWS_BROKER_MAX_CONNECTION_BYTES);
  }

  accept(frame: WindowsBrokerFrame): void {
    assertFrame(frame);
    switch (frame.type) {
      case "ready":
        if (this.#ready || this.#fatal || this.#closeAllRequested) throw protocolError();
        this.#ready = true;
        return;
      case "fatal":
        if (this.#fatal) throw protocolError();
        this.#fatal = true;
        return;
      case "close-all":
        requireEmptyPayload(frame);
        if (this.#closeAllRequested || this.#fatal) throw protocolError();
        this.#closeAllRequested = true;
        return;
      case "close-all-ack":
        requireEmptyPayload(frame);
        if (!this.#closeAllRequested || this.#closeAllAcknowledged || this.#fatal) {
          throw protocolError();
        }
        this.#closeAllAcknowledged = true;
        return;
      case "open":
        requireEmptyPayload(frame);
        if (
          this.#fatal ||
          this.#closeAllRequested ||
          this.#closeAllAcknowledged ||
          frame.connectionId <= this.#lastConnectionId ||
          this.#connections.has(frame.connectionId)
        ) {
          throw protocolError();
        }
        this.#lastConnectionId = frame.connectionId;
        this.#connections.set(frame.connectionId, {
          closed: false,
          eof: false,
          paused: false,
          queuedBytes: 0,
        });
        return;
      case "data": {
        if (this.#closeAllRequested) throw protocolError();
        const connection = this.#activeConnection(frame.connectionId);
        const nextConnectionBytes = connection.queuedBytes + frame.payload.byteLength;
        const nextTotalBytes = this.#totalQueuedBytes + frame.payload.byteLength;
        if (
          nextConnectionBytes > this.#maxConnectionBytes ||
          nextTotalBytes > this.#maxTotalBytes
        ) {
          throw protocolError();
        }
        connection.queuedBytes = nextConnectionBytes;
        this.#totalQueuedBytes = nextTotalBytes;
        return;
      }
      case "eof": {
        requireEmptyPayload(frame);
        const connection = this.#activeConnection(frame.connectionId);
        if (connection.eof) throw protocolError();
        connection.eof = true;
        return;
      }
      case "close": {
        requireEmptyPayload(frame);
        const connection = this.#activeConnection(frame.connectionId);
        connection.closed = true;
        return;
      }
      case "pause": {
        requireEmptyPayload(frame);
        const connection = this.#activeConnection(frame.connectionId);
        if (connection.paused) throw protocolError();
        connection.paused = true;
        return;
      }
      case "resume": {
        requireEmptyPayload(frame);
        const connection = this.#activeConnection(frame.connectionId);
        if (!connection.paused) throw protocolError();
        connection.paused = false;
        return;
      }
    }
  }

  drain(connectionId: bigint, bytes: number): void {
    if (typeof connectionId !== "bigint" || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw protocolError();
    }
    const connection = this.#connections.get(connectionId);
    if (connection === undefined || bytes > connection.queuedBytes) throw protocolError();
    connection.queuedBytes -= bytes;
    this.#totalQueuedBytes -= bytes;
  }

  #activeConnection(connectionId: bigint): ConnectionState {
    const connection = this.#connections.get(connectionId);
    if (
      connection === undefined ||
      connection.closed ||
      this.#fatal ||
      this.#closeAllAcknowledged
    ) {
      throw protocolError();
    }
    return connection;
  }
}
