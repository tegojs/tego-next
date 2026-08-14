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

export type WindowsBrokerFrameDirection = "broker-to-parent" | "parent-to-broker";

const directions = ["broker-to-parent", "parent-to-broker"] as const;

interface DirectionState {
  eof: boolean;
  queuedBytes: number;
}

interface ConnectionState {
  closed: boolean;
  readonly directions: Record<WindowsBrokerFrameDirection, DirectionState>;
  readonly pausedBy: Record<WindowsBrokerFrameDirection, boolean>;
}

function byteLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) throw protocolError();
  return limit;
}

function requireEmptyPayload(frame: WindowsBrokerFrame): void {
  if (frame.payload.byteLength !== 0) throw protocolError();
}

function assertDirection(direction: WindowsBrokerFrameDirection): void {
  if (direction !== "broker-to-parent" && direction !== "parent-to-broker") {
    throw protocolError();
  }
}

function oppositeDirection(direction: WindowsBrokerFrameDirection): WindowsBrokerFrameDirection {
  return direction === "broker-to-parent" ? "parent-to-broker" : "broker-to-parent";
}

function directionAllows(
  type: WindowsBrokerFrameType,
  direction: WindowsBrokerFrameDirection,
): boolean {
  if (direction === "broker-to-parent") {
    return ["ready", "open", "data", "eof", "close", "fatal", "close-all-ack"].includes(type);
  }
  return ["data", "close", "pause", "resume", "close-all"].includes(type);
}

function allowedAfterCloseAll(
  type: WindowsBrokerFrameType,
  direction: WindowsBrokerFrameDirection,
): boolean {
  return (
    direction === "broker-to-parent" && ["eof", "close", "fatal", "close-all-ack"].includes(type)
  );
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

  accept(frame: WindowsBrokerFrame, direction: WindowsBrokerFrameDirection): void {
    assertFrame(frame);
    assertDirection(direction);
    if (this.#fatal || this.#closeAllAcknowledged) throw protocolError();
    if (!directionAllows(frame.type, direction)) throw protocolError();
    if (this.#closeAllRequested && !allowedAfterCloseAll(frame.type, direction)) {
      throw protocolError();
    }
    switch (frame.type) {
      case "ready":
        if (direction !== "broker-to-parent" || this.#ready || this.#closeAllRequested) {
          throw protocolError();
        }
        this.#ready = true;
        return;
      case "fatal":
        if (direction !== "broker-to-parent") throw protocolError();
        this.#fatal = true;
        return;
      case "close-all":
        requireEmptyPayload(frame);
        if (direction !== "parent-to-broker" || !this.#ready || this.#closeAllRequested) {
          throw protocolError();
        }
        this.#closeAllRequested = true;
        return;
      case "close-all-ack":
        requireEmptyPayload(frame);
        if (
          direction !== "broker-to-parent" ||
          !this.#closeAllRequested ||
          ![...this.#connections.values()].every((connection) => connection.closed)
        ) {
          throw protocolError();
        }
        this.#closeAllAcknowledged = true;
        return;
      case "open":
        requireEmptyPayload(frame);
        if (
          direction !== "broker-to-parent" ||
          !this.#ready ||
          this.#closeAllRequested ||
          frame.connectionId <= this.#lastConnectionId ||
          this.#connections.has(frame.connectionId)
        ) {
          throw protocolError();
        }
        this.#lastConnectionId = frame.connectionId;
        this.#connections.set(frame.connectionId, {
          closed: false,
          directions: {
            "broker-to-parent": { eof: false, queuedBytes: 0 },
            "parent-to-broker": { eof: false, queuedBytes: 0 },
          },
          pausedBy: {
            "broker-to-parent": false,
            "parent-to-broker": false,
          },
        });
        return;
      case "data": {
        if (this.#closeAllRequested) throw protocolError();
        const connection = this.#activeConnection(frame.connectionId);
        const channel = connection.directions[direction];
        if (channel.eof || connection.pausedBy[oppositeDirection(direction)]) throw protocolError();
        const nextDirectionBytes = channel.queuedBytes + frame.payload.byteLength;
        const nextConnectionBytes =
          connection.directions["broker-to-parent"].queuedBytes +
          connection.directions["parent-to-broker"].queuedBytes +
          frame.payload.byteLength;
        const nextTotalBytes = this.#totalQueuedBytes + frame.payload.byteLength;
        if (
          !Number.isSafeInteger(nextConnectionBytes) ||
          !Number.isSafeInteger(nextTotalBytes) ||
          nextConnectionBytes > this.#maxConnectionBytes ||
          nextTotalBytes > this.#maxTotalBytes
        ) {
          throw protocolError();
        }
        channel.queuedBytes = nextDirectionBytes;
        this.#totalQueuedBytes = nextTotalBytes;
        return;
      }
      case "eof": {
        requireEmptyPayload(frame);
        const connection = this.#activeConnection(frame.connectionId);
        const channel = connection.directions[direction];
        if (channel.eof) throw protocolError();
        channel.eof = true;
        return;
      }
      case "close": {
        requireEmptyPayload(frame);
        const connection = this.#activeConnection(frame.connectionId);
        for (const currentDirection of directions) {
          this.#totalQueuedBytes -= connection.directions[currentDirection].queuedBytes;
          connection.directions[currentDirection].queuedBytes = 0;
        }
        connection.closed = true;
        return;
      }
      case "pause": {
        requireEmptyPayload(frame);
        const connection = this.#activeConnection(frame.connectionId);
        if (connection.pausedBy[direction]) throw protocolError();
        connection.pausedBy[direction] = true;
        return;
      }
      case "resume": {
        requireEmptyPayload(frame);
        const connection = this.#activeConnection(frame.connectionId);
        if (!connection.pausedBy[direction]) throw protocolError();
        connection.pausedBy[direction] = false;
        return;
      }
    }
  }

  drain(connectionId: bigint, direction: WindowsBrokerFrameDirection, bytes: number): void {
    if (typeof connectionId !== "bigint" || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw protocolError();
    }
    assertDirection(direction);
    const connection = this.#activeConnection(connectionId);
    const channel = connection.directions[direction];
    if (bytes > channel.queuedBytes) throw protocolError();
    channel.queuedBytes -= bytes;
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
