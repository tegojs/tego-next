import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
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
} from "@tegojs/contracts";
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

export interface LocalArtifactIngress {
  putPath(artifactPath: string): Promise<ArtifactDigest>;
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

const CONTROL_CLOSE_DRAIN_TIMEOUT_MS = 2_000;

function controlInitializationAbortError(): DOMException {
  return new DOMException("Control server initialization aborted", "AbortError");
}

function assertControlInitializationActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw controlInitializationAbortError();
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

async function writeResponse(socket: Socket, response: ControlResponse): Promise<void> {
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

async function assertPrivateEndpointParent(endpoint: string): Promise<void> {
  if (process.platform === "win32") return;
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
}

export async function verifyUnixControlEndpoint(path: string): Promise<EndpointSecurityState> {
  const metadata = await lstat(path);
  const userId = process.getuid?.();
  if (
    !metadata.isSocket() ||
    userId === undefined ||
    metadata.uid !== userId ||
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

async function closeListener(
  server: Server,
  sockets: ReadonlySet<Socket>,
  activeDispatchSockets: ReadonlySet<Socket> = new Set(),
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
  await assertPrivateEndpointParent(options.endpoint);
  assertControlInitializationActive(options.signal);

  const sockets = new Set<Socket>();
  const activeDispatchSockets = new Set<Socket>();
  const dispatches = new Set<Promise<void>>();
  const pendingAdmissionSockets = new Set<Socket>();
  let reservations = 0;
  let closing = false;
  let endpointReady = process.platform === "win32";
  let terminalError: Error | undefined;
  const beginControlConnection = (socket: Socket) => {
    if (closing || reservations >= maxOutstanding) {
      void writeResponse(
        socket,
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
    const frame = Buffer.allocUnsafe(maxLineBytes);
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
        socket,
        diagnosticResponse(
          UNKNOWN_CONTROL_REQUEST_ID,
          protocolDiagnostic(
            "PROTOCOL_CONTROL_READ_TIMEOUT",
            "Control request was not completed before its deadline",
          ),
        ),
      );
    }, readTimeoutMs);
    readTimer.unref();
    socket.once("close", () => {
      clearTimeout(readTimer);
      releaseReservation("socket");
    });
    socket.on("data", (chunk: Buffer) => {
      if (handled || closing) return;
      const newline = chunk.indexOf(0x0a);
      const payloadBytes = newline === -1 ? chunk.byteLength : newline;
      if (bytes + payloadBytes > maxLineBytes) {
        handled = true;
        void writeResponse(
          socket,
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
          socket,
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
      activeDispatchSockets.add(socket);
      const dispatchPromise = (async () => {
        try {
          const decoded = JSON.parse(frame.subarray(0, bytes).toString("utf8"));
          requestId = extractControlRequestId(decoded);
          const request = parseControlRequest(decoded);
          const result = await dispatch(request, options.operations, options.artifactIngress);
          await writeResponse(socket, {
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
          await writeResponse(socket, diagnosticResponse(requestId, diagnostic));
        } finally {
          releaseReservation("dispatch");
        }
      })();
      dispatches.add(dispatchPromise);
      void dispatchPromise.then(
        () => {
          dispatches.delete(dispatchPromise);
          activeDispatchSockets.delete(socket);
        },
        () => {
          dispatches.delete(dispatchPromise);
          activeDispatchSockets.delete(socket);
        },
      );
    });
  };
  const server: Server = createServer(
    { pauseOnConnect: process.platform !== "win32" },
    (socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
        pendingAdmissionSockets.delete(socket);
      });
      socket.on("error", () => undefined);
      if (!endpointReady) {
        pendingAdmissionSockets.add(socket);
        return;
      }
      beginControlConnection(socket);
      socket.resume();
    },
  );

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
      server.listen(options.endpoint);
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
      for (const socket of sockets) socket.destroy();
    });

    if (process.platform !== "win32") {
      await awaitControlInitialization(
        () =>
          (options.setEndpointPermissions ?? ((endpoint) => chmod(endpoint, 0o600)))(
            options.endpoint,
          ),
        options.signal,
      );
      await awaitControlInitialization(
        () => verifyUnixControlEndpoint(options.endpoint),
        options.signal,
      );
    }
    assertControlInitializationActive(options.signal);
    endpointReady = true;
    for (const socket of pendingAdmissionSockets) {
      pendingAdmissionSockets.delete(socket);
      if (socket.destroyed) continue;
      beginControlConnection(socket);
      socket.resume();
    }
  } catch (error) {
    try {
      await closeListener(server, sockets, activeDispatchSockets, dispatches);
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
        closing = true;
        await closeListener(server, sockets, activeDispatchSockets, dispatches);
        if (terminalError !== undefined) throw terminalError;
      })();
      return closePromise;
    },
  };
}
