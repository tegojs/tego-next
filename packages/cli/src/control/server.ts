import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, resolve } from "node:path";
import {
  type ArtifactDigest,
  DiagnosticError,
  type JsonObject,
  type JsonValue,
  parseTaskId,
  type Runtime,
  type RuntimeDiagnostic,
  type RuntimeOperations,
  serializeWireValue,
} from "@tego/contracts";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlRequest,
  type ControlResponse,
  DEFAULT_CONTROL_READ_TIMEOUT_MS,
  diagnosticResponse,
  extractControlRequestId,
  MAX_CONTROL_LINE_BYTES,
  MAX_CONTROL_OUTSTANDING_REQUESTS,
  parseControlRequest,
  protocolDiagnostic,
  sanitizeControlValue,
  UNKNOWN_CONTROL_REQUEST_ID,
} from "./protocol.js";
import {
  createWindowsControlBroker,
  type WindowsControlBroker,
  type WindowsControlBrokerOptions,
} from "./windows-broker.js";

export interface LocalArtifactIngress {
  putPath(artifactPath: string): Promise<ArtifactDigest>;
}

export interface ControlConnection extends NodeJS.ReadWriteStream {
  readonly destroyed: boolean;
  destroy(error?: Error): void;
}

export interface ControlRuntimeOperations {
  status(): ReturnType<Runtime["status"]>;
  stop(options?: Parameters<Runtime["stop"]>[0]): ReturnType<Runtime["stop"]>;
  readonly operations: RuntimeOperations;
}

export interface ControlServerOptions {
  readonly endpoint: string;
  readonly operations: ControlRuntimeOperations;
  readonly signal?: AbortSignal;
  readonly artifactIngress?: LocalArtifactIngress;
  readonly maxLineBytes?: number;
  readonly maxOutstandingRequests?: number;
  readonly readTimeoutMs?: number;
  readonly setEndpointPermissions?: (endpoint: string) => Promise<void>;
  readonly windowsBrokerArchitecture?: string;
  readonly windowsControlBrokerFactory?: (
    options: Pick<WindowsControlBrokerOptions, "endpoint" | "maxConnections" | "maxQueuedBytes">,
  ) => WindowsControlBroker;
  readonly onServerError?: (error: Error) => void;
}

export interface ControlServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export interface EndpointSecurityState {
  readonly ownerUid: number;
  readonly mode: 0o600;
}

interface EndpointIdentity {
  readonly device: number;
  readonly inode: number;
  readonly ownerUid: number;
  readonly socket: true;
}

interface EndpointParentIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly ownerUid: number;
}

const CONTROL_CLOSE_DRAIN_TIMEOUT_MS = 2_000;
const WINDOWS_BROKER_MAX_CONNECTIONS = 64;
const WINDOWS_BROKER_MAX_QUEUED_BYTES = 256 * 1024;

function controlInitializationAbortError(): DOMException {
  return new DOMException("Control server initialization aborted", "AbortError");
}

function assertControlInitializationActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw controlInitializationAbortError();
}

function windowsControlEndpointUnsafe(): DiagnosticError {
  return new DiagnosticError(
    protocolDiagnostic("PROTOCOL_CONTROL_ENDPOINT_UNSAFE", "PROTOCOL_CONTROL_ENDPOINT_UNSAFE"),
  );
}

async function awaitControlInitialization<T>(
  operation: () => T | PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  assertControlInitializationActive(signal);
  const operationPromise = Promise.resolve().then(() => {
    assertControlInitializationActive(signal);
    return operation();
  });
  if (signal === undefined) return await operationPromise;
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(controlInitializationAbortError());
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([operationPromise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function inputObject(input: JsonValue): JsonObject {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new DiagnosticError(
      protocolDiagnostic("PROTOCOL_OPERATION_INVALID", "Control operation input must be an object"),
    );
  }
  return input as JsonObject;
}

function requiredString(input: JsonValue, key: string): string {
  const value = inputObject(input)[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new DiagnosticError(
      protocolDiagnostic(
        "PROTOCOL_OPERATION_INVALID",
        `Control operation input ${key} must be a non-empty string`,
      ),
    );
  }
  return value;
}

function operationDiagnostic(error: unknown): RuntimeDiagnostic {
  if (error instanceof DiagnosticError) return error.diagnostic;
  return protocolDiagnostic("PROTOCOL_OPERATION_FAILED", "Control operation failed");
}

async function dispatch(
  request: ControlRequest,
  operations: ControlRuntimeOperations,
  artifactIngress: LocalArtifactIngress | undefined,
): Promise<JsonValue> {
  switch (request.operation) {
    case "runtime.status":
      return serializeWireValue(await operations.status());
    case "runtime.stop":
      await operations.stop();
      return { stopped: true };
    case "runtime.recovered-operations":
      return serializeWireValue(await operations.operations.recoveredOperations());
    case "runtime.snapshot":
      return serializeWireValue(
        await operations.operations.snapshot(
          request.input as Parameters<RuntimeOperations["snapshot"]>[0],
        ),
      );
    case "plugin.install":
      return serializeWireValue(
        await operations.operations.installPlugin(
          request.input as Parameters<RuntimeOperations["installPlugin"]>[0],
        ),
      );
    case "plugin.install-path": {
      if (artifactIngress === undefined) {
        throw new DiagnosticError(
          protocolDiagnostic(
            "PROTOCOL_OPERATION_UNAVAILABLE",
            "Local artifact path ingress is unavailable",
          ),
        );
      }
      const digest = await artifactIngress.putPath(requiredString(request.input, "artifactPath"));
      return serializeWireValue(await operations.operations.installPlugin({ digest }));
    }
    case "plugin.deploy":
      return serializeWireValue(
        await operations.operations.deployPlugin(
          request.input as Parameters<RuntimeOperations["deployPlugin"]>[0],
        ),
      );
    case "plugin.status":
      return serializeWireValue(
        await operations.operations.pluginStatus(
          request.input as Parameters<RuntimeOperations["pluginStatus"]>[0],
        ),
      );
    case "task.run":
      return serializeWireValue(
        await operations.operations.runTask(
          request.input as Parameters<RuntimeOperations["runTask"]>[0],
        ),
      );
    case "task.status": {
      const result = await operations.operations.taskStatus(
        parseTaskId(requiredString(request.input, "taskId")),
      );
      return result === undefined ? null : serializeWireValue(result);
    }
    case "task.wait":
      return serializeWireValue(
        await operations.operations.waitTask(parseTaskId(requiredString(request.input, "taskId"))),
      );
    case "task.cancel":
      return serializeWireValue(
        await operations.operations.cancelTask(
          parseTaskId(requiredString(request.input, "taskId")),
        ),
      );
  }
}

async function writeResponse(socket: ControlConnection, response: ControlResponse): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.off("close", finish);
      resolve();
    };
    socket.once("close", finish);
    socket.end(`${JSON.stringify(response)}\n`, finish);
  });
}

async function privateEndpointParentIdentity(endpoint: string): Promise<EndpointParentIdentity> {
  const parent = resolve(dirname(endpoint));
  const metadata = await lstat(parent);
  const userId = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    userId === undefined ||
    metadata.uid !== userId ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new DiagnosticError(
      protocolDiagnostic(
        "PROTOCOL_CONTROL_PARENT_NOT_PRIVATE",
        "PROTOCOL_CONTROL_PARENT_NOT_PRIVATE",
      ),
    );
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    ownerUid: metadata.uid,
  };
}

async function assertPrivateEndpointParent(
  endpoint: string,
  expected?: EndpointParentIdentity,
): Promise<void> {
  if (process.platform === "win32") return;
  const identity = await privateEndpointParentIdentity(endpoint);
  if (
    expected !== undefined &&
    (identity.device !== expected.device || identity.inode !== expected.inode)
  ) {
    throw new DiagnosticError(
      protocolDiagnostic(
        "PROTOCOL_CONTROL_PARENT_NOT_PRIVATE",
        "PROTOCOL_CONTROL_PARENT_NOT_PRIVATE",
      ),
    );
  }
}

async function controlEndpointIdentity(path: string): Promise<EndpointIdentity> {
  const metadata = await lstat(path);
  const userId = process.getuid?.();
  if (!metadata.isSocket() || userId === undefined || metadata.uid !== userId) {
    throw new DiagnosticError(
      protocolDiagnostic(
        "PROTOCOL_CONTROL_ENDPOINT_UNSAFE",
        "Control endpoint is not an owner-owned socket",
      ),
    );
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
    ownerUid: metadata.uid,
    socket: true,
  };
}

async function verifyUnixControlEndpointIdentity(
  path: string,
  expected?: EndpointIdentity,
): Promise<EndpointSecurityState> {
  const metadata = await lstat(path);
  const userId = process.getuid?.();
  if (
    !metadata.isSocket() ||
    userId === undefined ||
    metadata.uid !== userId ||
    (expected !== undefined &&
      (metadata.dev !== expected.device || metadata.ino !== expected.inode)) ||
    (metadata.mode & 0o7777) !== 0o600
  ) {
    throw new DiagnosticError(
      protocolDiagnostic(
        "PROTOCOL_CONTROL_ENDPOINT_UNSAFE",
        "Control endpoint is not an owner-only socket",
      ),
    );
  }
  return { mode: 0o600, ownerUid: metadata.uid };
}

export async function verifyUnixControlEndpoint(path: string): Promise<EndpointSecurityState> {
  return await verifyUnixControlEndpointIdentity(path);
}

function createControlDispatcher(
  options: ControlServerOptions,
  limits: {
    readonly maxLineBytes: number;
    readonly maxOutstanding: number;
    readonly readTimeoutMs: number;
  },
) {
  const connections = new Set<ControlConnection>();
  const activeDispatchConnections = new Set<ControlConnection>();
  const dispatches = new Set<Promise<void>>();
  let reservations = 0;
  let closing = false;

  const begin = (connection: ControlConnection) => {
    if (closing || reservations >= limits.maxOutstanding) {
      void writeResponse(
        connection,
        diagnosticResponse(
          UNKNOWN_CONTROL_REQUEST_ID,
          protocolDiagnostic(
            "PROTOCOL_CONTROL_CAPACITY_EXCEEDED",
            "Control request capacity is exhausted",
          ),
        ),
      );
      return;
    }

    reservations += 1;
    const frame = Buffer.allocUnsafe(limits.maxLineBytes);
    let bytes = 0;
    let handled = false;
    let reservationOwner: "dispatch" | "released" | "socket" = "socket";
    const releaseReservation = (owner: "dispatch" | "socket") => {
      if (reservationOwner !== owner) return;
      reservationOwner = "released";
      reservations -= 1;
    };
    const readTimer = setTimeout(() => {
      if (handled) return;
      handled = true;
      void writeResponse(
        connection,
        diagnosticResponse(
          UNKNOWN_CONTROL_REQUEST_ID,
          protocolDiagnostic(
            "PROTOCOL_CONTROL_READ_TIMEOUT",
            "Control request was not completed before its deadline",
          ),
        ),
      );
    }, limits.readTimeoutMs);
    readTimer.unref();
    connection.once("close", () => {
      clearTimeout(readTimer);
      releaseReservation("socket");
    });
    connection.on("data", (chunk: Buffer) => {
      if (handled || closing) return;
      const newline = chunk.indexOf(0x0a);
      const payloadBytes = newline === -1 ? chunk.byteLength : newline;
      if (bytes + payloadBytes > limits.maxLineBytes) {
        handled = true;
        void writeResponse(
          connection,
          diagnosticResponse(
            UNKNOWN_CONTROL_REQUEST_ID,
            protocolDiagnostic(
              "PROTOCOL_CONTROL_FRAME_TOO_LARGE",
              "Control request exceeds the line limit",
            ),
          ),
        );
        return;
      }
      chunk.copy(frame, bytes, 0, payloadBytes);
      bytes += payloadBytes;
      if (newline === -1) return;
      handled = true;
      clearTimeout(readTimer);
      if (newline !== chunk.byteLength - 1) {
        void writeResponse(
          connection,
          diagnosticResponse(
            UNKNOWN_CONTROL_REQUEST_ID,
            protocolDiagnostic(
              "PROTOCOL_CONTROL_FRAME_INVALID",
              "Control connection must contain exactly one request line",
            ),
          ),
        );
        return;
      }
      let requestId = UNKNOWN_CONTROL_REQUEST_ID;
      reservationOwner = "dispatch";
      activeDispatchConnections.add(connection);
      const dispatchPromise = (async () => {
        try {
          const decoded = JSON.parse(frame.subarray(0, bytes).toString("utf8"));
          requestId = extractControlRequestId(decoded);
          const request = parseControlRequest(decoded);
          const result = await dispatch(request, options.operations, options.artifactIngress);
          await writeResponse(connection, {
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            requestId,
            ok: true,
            result: sanitizeControlValue(result),
          });
        } catch (error) {
          const diagnostic =
            error instanceof SyntaxError
              ? protocolDiagnostic(
                  "PROTOCOL_CONTROL_FRAME_INVALID",
                  "Control request is not valid JSON",
                )
              : operationDiagnostic(error);
          await writeResponse(connection, diagnosticResponse(requestId, diagnostic));
        } finally {
          releaseReservation("dispatch");
        }
      })();
      dispatches.add(dispatchPromise);
      void dispatchPromise.then(
        () => {
          dispatches.delete(dispatchPromise);
          activeDispatchConnections.delete(connection);
        },
        () => {
          dispatches.delete(dispatchPromise);
          activeDispatchConnections.delete(connection);
        },
      );
    });
  };

  return {
    activeDispatchConnections,
    begin,
    connections,
    dispatches,
    async closeConnections(): Promise<void> {
      closing = true;
      for (const connection of connections) {
        if (!activeDispatchConnections.has(connection)) connection.destroy();
      }
      if (dispatches.size > 0) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...dispatches]),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, CONTROL_CLOSE_DRAIN_TIMEOUT_MS);
              timer.unref();
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      for (const connection of connections) connection.destroy();
    },
    markClosing(): void {
      closing = true;
    },
  };
}

async function startWindowsBrokerControlServer(
  options: ControlServerOptions,
  dispatcher: ReturnType<typeof createControlDispatcher>,
): Promise<ControlServer> {
  if ((options.windowsBrokerArchitecture ?? process.arch) !== "x64") {
    throw windowsControlEndpointUnsafe();
  }
  let broker: WindowsControlBroker;
  try {
    broker = (options.windowsControlBrokerFactory ?? createWindowsControlBroker)({
      endpoint: options.endpoint,
      maxConnections: WINDOWS_BROKER_MAX_CONNECTIONS,
      maxQueuedBytes: WINDOWS_BROKER_MAX_QUEUED_BYTES,
    });
  } catch {
    throw windowsControlEndpointUnsafe();
  }

  const pending = new Set<ControlConnection>();
  let ready = false;
  let terminalError: Error | undefined;
  broker.onConnection((connection) => {
    dispatcher.connections.add(connection);
    connection.on("error", () => undefined);
    connection.once("close", () => {
      pending.delete(connection);
      dispatcher.connections.delete(connection);
    });
    if (!ready) {
      pending.add(connection);
      return;
    }
    dispatcher.begin(connection);
    connection.resume();
  });
  broker.onError(() => {
    const error = windowsControlEndpointUnsafe();
    terminalError ??= error;
    try {
      options.onServerError?.(error);
    } catch (callbackError) {
      terminalError = new AggregateError(
        [terminalError, callbackError],
        "Control listener error reporting failed",
      );
    }
    for (const connection of dispatcher.connections) connection.destroy();
  });

  try {
    await broker.start(options.signal);
    assertControlInitializationActive(options.signal);
  } catch {
    for (const connection of dispatcher.connections) connection.destroy();
    const primary =
      options.signal?.aborted === true
        ? controlInitializationAbortError()
        : windowsControlEndpointUnsafe();
    try {
      await broker.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        "Windows control broker startup rollback failed",
      );
    }
    throw primary;
  }

  ready = true;
  for (const connection of pending) {
    pending.delete(connection);
    if (connection.destroyed) continue;
    dispatcher.begin(connection);
    connection.resume();
  }

  let closePromise: Promise<void> | undefined;
  return {
    endpoint: options.endpoint,
    close() {
      closePromise ??= (async () => {
        dispatcher.markClosing();
        await dispatcher.closeConnections();
        let brokerCloseError: unknown;
        try {
          await broker.close();
        } catch (error) {
          brokerCloseError = error;
        }
        if (brokerCloseError !== undefined && terminalError !== undefined) {
          throw new AggregateError(
            [brokerCloseError, terminalError],
            "Windows control broker close failed after an observed listener error",
          );
        }
        if (brokerCloseError !== undefined) throw brokerCloseError;
        if (terminalError !== undefined) throw terminalError;
      })();
      return closePromise;
    },
  };
}

async function closeListener(
  server: Server,
  sockets: ReadonlySet<ControlConnection>,
  activeDispatchSockets: ReadonlySet<ControlConnection> = new Set(),
  dispatches: ReadonlySet<Promise<void>> = new Set(),
): Promise<void> {
  for (const socket of sockets) {
    if (!activeDispatchSockets.has(socket)) socket.destroy();
  }
  const closed = server.listening
    ? new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      })
    : Promise.resolve();
  if (dispatches.size > 0) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...dispatches]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CONTROL_CLOSE_DRAIN_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  for (const socket of sockets) socket.destroy();
  await closed;
}

export async function removeOwnedControlEndpoint(endpoint: string): Promise<void> {
  if (process.platform === "win32") return;
  let initial: Awaited<ReturnType<typeof lstat>>;
  try {
    initial = await lstat(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await assertPrivateEndpointParent(endpoint);
  const metadata = await lstat(endpoint);
  const userId = process.getuid?.();
  if (
    !initial.isSocket() ||
    !metadata.isSocket() ||
    userId === undefined ||
    metadata.uid !== userId ||
    metadata.dev !== initial.dev ||
    metadata.ino !== initial.ino
  ) {
    throw new DiagnosticError(
      protocolDiagnostic(
        "PROTOCOL_CONTROL_ENDPOINT_UNSAFE",
        "Control endpoint is not an owner-owned socket",
      ),
    );
  }
  await unlink(endpoint);
}

export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  if (options.endpoint.length === 0) throw new TypeError("endpoint must not be empty");
  assertControlInitializationActive(options.signal);
  const maxLineBytes = options.maxLineBytes ?? MAX_CONTROL_LINE_BYTES;
  const maxOutstanding = options.maxOutstandingRequests ?? MAX_CONTROL_OUTSTANDING_REQUESTS;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_CONTROL_READ_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new RangeError("maxLineBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxOutstanding) || maxOutstanding < 1) {
    throw new RangeError("maxOutstandingRequests must be a positive safe integer");
  }
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1) {
    throw new RangeError("readTimeoutMs must be a positive safe integer");
  }

  const dispatcher = createControlDispatcher(options, {
    maxLineBytes,
    maxOutstanding,
    readTimeoutMs,
  });
  if (process.platform === "win32" || options.windowsControlBrokerFactory !== undefined) {
    return await startWindowsBrokerControlServer(options, dispatcher);
  }

  await assertPrivateEndpointParent(options.endpoint);
  assertControlInitializationActive(options.signal);
  const pendingConnections = new Set<ControlConnection>();
  let endpointReady = false;
  let terminalError: Error | undefined;
  const server: Server = createServer({ pauseOnConnect: true }, (connection) => {
    dispatcher.connections.add(connection);
    connection.on("close", () => {
      dispatcher.connections.delete(connection);
      pendingConnections.delete(connection);
    });
    connection.on("error", () => undefined);
    if (!endpointReady) {
      pendingConnections.add(connection);
      return;
    }
    dispatcher.begin(connection);
    connection.resume();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        options.signal?.removeEventListener("abort", onAbort);
        server.off("error", onError);
        server.off("listening", onListening);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = () => finish(controlInitializationAbortError());
      const onError = (error: Error) => finish(error);
      const onListening = () => finish();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      server.once("error", onError);
      server.once("listening", onListening);
      if (options.signal?.aborted === true) {
        onAbort();
        return;
      }
      server.listen({ exclusive: true, path: options.endpoint });
    });
    server.on("error", (error) => {
      terminalError ??= error;
      try {
        options.onServerError?.(error);
      } catch (callbackError) {
        terminalError = new AggregateError(
          [terminalError, callbackError],
          "Control listener error reporting failed",
        );
      }
      for (const connection of dispatcher.connections) connection.destroy();
    });

    const endpointIdentity = await awaitControlInitialization(
      () => controlEndpointIdentity(options.endpoint),
      options.signal,
    );
    const parentIdentity = await awaitControlInitialization(
      () => privateEndpointParentIdentity(options.endpoint),
      options.signal,
    );
    await awaitControlInitialization(
      () =>
        (options.setEndpointPermissions ?? ((endpoint) => chmod(endpoint, 0o600)))(
          options.endpoint,
        ),
      options.signal,
    );
    await awaitControlInitialization(
      () => assertPrivateEndpointParent(options.endpoint, parentIdentity),
      options.signal,
    );
    await awaitControlInitialization(
      () => verifyUnixControlEndpointIdentity(options.endpoint, endpointIdentity),
      options.signal,
    );
    assertControlInitializationActive(options.signal);
    endpointReady = true;
    for (const connection of pendingConnections) {
      pendingConnections.delete(connection);
      if (connection.destroyed) continue;
      dispatcher.begin(connection);
      connection.resume();
    }
  } catch (error) {
    dispatcher.markClosing();
    try {
      await closeListener(
        server,
        dispatcher.connections,
        dispatcher.activeDispatchConnections,
        dispatcher.dispatches,
      );
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Control listener permission initialization rollback failed",
      );
    }
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    endpoint: options.endpoint,
    close() {
      closePromise ??= (async () => {
        dispatcher.markClosing();
        await closeListener(
          server,
          dispatcher.connections,
          dispatcher.activeDispatchConnections,
          dispatcher.dispatches,
        );
        if (terminalError !== undefined) throw terminalError;
      })();
      return closePromise;
    },
  };
}
