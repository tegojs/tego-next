import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { MainEndpoint } from "./main-endpoint.js";
import type { WorkerSession } from "./session.js";
import type { WorkerEndpoint } from "./worker-endpoint.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_PATH = "/worker";

interface WebSocketNetworkLimits {
  readonly handshakeTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxConnections?: number;
  readonly maxPayloadBytes?: number;
}

interface WebSocketListenerOptions extends WebSocketNetworkLimits {
  readonly host: string;
  readonly onError?: (error: Error) => void;
  readonly path?: string;
  readonly port: number;
  readonly signal?: AbortSignal;
}

interface WebSocketConnectOptions extends WebSocketNetworkLimits {
  readonly signal?: AbortSignal;
  readonly url: URL;
}

export interface MainWebSocketListenerOptions extends WebSocketListenerOptions {
  readonly endpoint: MainEndpoint;
  readonly onSession?: (session: WorkerSession) => Promise<void> | void;
}

export interface WorkerWebSocketConnectOptions extends WebSocketConnectOptions {
  readonly endpoint: WorkerEndpoint;
}

export interface WorkerWebSocketListenerOptions extends WebSocketListenerOptions {
  readonly endpoint: WorkerEndpoint;
  readonly onSession?: (session: WorkerSession) => Promise<void> | void;
}

export interface MainWebSocketConnectOptions extends WebSocketConnectOptions {
  readonly endpoint: MainEndpoint;
}

export interface WebSocketListener {
  readonly url: URL;
  close(): Promise<void>;
}

interface NormalizedLimits {
  readonly handshakeTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly maxConnections: number;
  readonly maxPayloadBytes: number;
}

interface AttachableEndpoint {
  attach(socket: unknown): WorkerSession;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return result;
}

function normalizeLimits(options: WebSocketNetworkLimits): NormalizedLimits {
  return {
    handshakeTimeoutMs: positiveInteger(
      options.handshakeTimeoutMs,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      "handshakeTimeoutMs",
    ),
    heartbeatIntervalMs: positiveInteger(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    ),
    maxConnections: positiveInteger(
      options.maxConnections,
      DEFAULT_MAX_CONNECTIONS,
      "maxConnections",
    ),
    maxPayloadBytes: positiveInteger(
      options.maxPayloadBytes,
      DEFAULT_MAX_PAYLOAD_BYTES,
      "maxPayloadBytes",
    ),
  };
}

function normalizePath(path: string | undefined): string {
  const value = path ?? DEFAULT_PATH;
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new TypeError("WebSocket path must be an absolute URL path");
  }
  return value;
}

function normalizeUrl(url: URL): URL {
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("WebSocket URL protocol must be ws: or wss:");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("WebSocket URL must not contain credentials");
  }
  return new URL(url);
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("WebSocket operation was aborted", { cause: signal?.reason });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function connect(
  endpoint: AttachableEndpoint,
  options: WebSocketConnectOptions,
): Promise<WorkerSession> {
  const limits = normalizeLimits(options);
  const url = normalizeUrl(options.url);
  if (isAborted(options.signal)) throw abortError(options.signal);

  const socket = new WebSocket(url, {
    handshakeTimeout: limits.handshakeTimeoutMs,
    maxPayload: limits.maxPayloadBytes,
    perMessageDeflate: false,
  });
  return await new Promise<WorkerSession>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { readonly error: unknown } | { readonly session: WorkerSession }) => {
      if (settled) return;
      settled = true;
      socket.off("open", opened);
      socket.off("error", failed);
      socket.off("close", closed);
      options.signal?.removeEventListener("abort", aborted);
      if ("session" in outcome) {
        resolve(outcome.session);
      } else {
        socket.once("error", () => undefined);
        socket.terminate();
        reject(outcome.error);
      }
    };
    const opened = (): void => {
      try {
        finish({ session: endpoint.attach(socket) });
      } catch (error) {
        finish({ error });
      }
    };
    const failed = (error: Error): void => finish({ error });
    const closed = (code: number): void =>
      finish({ error: new Error(`WebSocket closed during handshake with code ${code}`) });
    const aborted = (): void => finish({ error: abortError(options.signal as AbortSignal) });
    socket.once("open", opened);
    socket.once("error", failed);
    socket.once("close", closed);
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (isAborted(options.signal)) aborted();
  });
}

async function listen(
  endpoint: AttachableEndpoint,
  options: WebSocketListenerOptions & {
    readonly onSession?: (session: WorkerSession) => Promise<void> | void;
  },
): Promise<WebSocketListener> {
  const limits = normalizeLimits(options);
  const path = normalizePath(options.path);
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }
  if (options.host.length === 0) throw new TypeError("host must not be empty");
  if (isAborted(options.signal)) throw abortError(options.signal);

  const server = new WebSocketServer({
    clientTracking: false,
    host: options.host,
    maxPayload: limits.maxPayloadBytes,
    path,
    perMessageDeflate: false,
    port: options.port,
  });
  const sockets = new Set<WebSocket>();
  const sessions = new Set<WorkerSession>();
  const alive = new WeakMap<WebSocket, boolean>();
  let closing: Promise<void> | undefined;
  let startupComplete = false;
  let startupSettled = false;

  const reportError = (error: Error): void => {
    try {
      options.onError?.(error);
    } catch {
      // A diagnostic sink cannot become a second transport failure.
    }
  };

  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      options.signal?.removeEventListener("abort", abortListener);
      clearInterval(heartbeat);
      await Promise.allSettled([...sessions].map(async (session) => session.close()));
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (
            error === undefined ||
            (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
          ) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      sockets.clear();
      sessions.clear();
    })();
    return closing;
  };
  const abortListener = (): void => {
    void close().catch(() => undefined);
  };
  const serverError = (error: Error): void => {
    reportError(error);
    if (startupComplete) void close().catch(reportError);
  };
  server.on("error", serverError);

  server.on("connection", (socket) => {
    if (closing !== undefined || sockets.size >= limits.maxConnections) {
      socket.close(1013, "WORKER_CONNECTION_LIMIT");
      return;
    }
    sockets.add(socket);
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));
    socket.once("close", () => sockets.delete(socket));
    let session: WorkerSession;
    try {
      session = endpoint.attach(socket);
      sessions.add(session);
      const remove = session.onStateChange((state) => {
        if (state === "closed" || state === "unavailable") {
          remove();
          sessions.delete(session);
        }
      });
      void session.ready
        .then(async () => options.onSession?.(session))
        .catch(() => session.close());
    } catch {
      socket.close(1011, "WORKER_ENDPOINT_REJECTED");
    }
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN || alive.get(socket) !== true) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, limits.heartbeatIntervalMs);
  heartbeat.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown): void => {
        if (startupSettled) return;
        startupSettled = true;
        server.off("listening", listening);
        server.off("error", failed);
        server.off("close", closed);
        options.signal?.removeEventListener("abort", aborted);
        if (error === undefined) resolve();
        else reject(error);
      };
      const listening = (): void => {
        startupComplete = true;
        finish();
      };
      const failed = (error: Error): void => finish(error);
      const closed = (): void =>
        finish(new Error("WebSocket listener closed before becoming ready"));
      const aborted = (): void => finish(abortError(options.signal as AbortSignal));
      server.once("listening", listening);
      server.once("error", failed);
      server.once("close", closed);
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (isAborted(options.signal)) aborted();
    });
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await close();
    throw new Error("WebSocket listener did not bind a TCP address");
  }
  const hostname = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = new URL(path, `ws://${hostname}:${String((address as AddressInfo).port)}`);
  options.signal?.addEventListener("abort", abortListener, { once: true });
  if (isAborted(options.signal)) {
    await close();
    throw abortError(options.signal);
  }
  return { url, close };
}

export function listenForMain(options: MainWebSocketListenerOptions): Promise<WebSocketListener> {
  return listen(options.endpoint, options);
}

export function connectWorker(options: WorkerWebSocketConnectOptions): Promise<WorkerSession> {
  return connect(options.endpoint, options);
}

export function listenForWorker(
  options: WorkerWebSocketListenerOptions,
): Promise<WebSocketListener> {
  return listen(options.endpoint, options);
}

export function connectMain(options: MainWebSocketConnectOptions): Promise<WorkerSession> {
  return connect(options.endpoint, options);
}
