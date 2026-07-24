import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
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
  diagnosticResponse,
  MAX_CONTROL_LINE_BYTES,
  MAX_CONTROL_OUTSTANDING_REQUESTS,
  parseControlRequest,
  protocolDiagnostic,
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
  readonly artifactIngress?: LocalArtifactIngress;
  readonly maxLineBytes?: number;
  readonly maxOutstandingRequests?: number;
}

export interface ControlServer {
  readonly endpoint: string;
  close(): Promise<void>;
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
  return protocolDiagnostic("PROTOCOL_OPERATION_FAILED", "Control operation failed", error);
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

function writeResponse(socket: Socket, response: ControlResponse): void {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  if (options.endpoint.length === 0) throw new TypeError("endpoint must not be empty");
  const maxLineBytes = options.maxLineBytes ?? MAX_CONTROL_LINE_BYTES;
  const maxOutstanding = options.maxOutstandingRequests ?? MAX_CONTROL_OUTSTANDING_REQUESTS;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new RangeError("maxLineBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxOutstanding) || maxOutstanding < 1) {
    throw new RangeError("maxOutstandingRequests must be a positive safe integer");
  }

  const clients = new Set<Socket>();
  let outstanding = 0;
  let closing = false;
  const server: Server = createServer((socket) => {
    clients.add(socket);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let handled = false;
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      if (handled || closing) return;
      bytes += chunk.byteLength;
      if (bytes > maxLineBytes) {
        handled = true;
        writeResponse(
          socket,
          diagnosticResponse(
            "",
            protocolDiagnostic(
              "PROTOCOL_CONTROL_FRAME_TOO_LARGE",
              "Control request exceeds the line limit",
            ),
          ),
        );
        return;
      }
      chunks.push(chunk);
      const frame = Buffer.concat(chunks);
      const newline = frame.indexOf(0x0a);
      if (newline === -1) return;
      handled = true;
      if (newline !== frame.byteLength - 1) {
        writeResponse(
          socket,
          diagnosticResponse(
            "",
            protocolDiagnostic(
              "PROTOCOL_CONTROL_FRAME_INVALID",
              "Control connection must contain exactly one request line",
            ),
          ),
        );
        return;
      }
      if (outstanding >= maxOutstanding) {
        writeResponse(
          socket,
          diagnosticResponse(
            "",
            protocolDiagnostic(
              "PROTOCOL_CONTROL_CAPACITY_EXCEEDED",
              "Control request capacity is exhausted",
            ),
          ),
        );
        return;
      }
      outstanding += 1;
      let requestId = "";
      void (async () => {
        try {
          const request = parseControlRequest(
            JSON.parse(frame.subarray(0, newline).toString("utf8")),
          );
          requestId = request.requestId;
          const result = await dispatch(request, options.operations, options.artifactIngress);
          writeResponse(socket, {
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            requestId,
            ok: true,
            result,
          });
        } catch (error) {
          writeResponse(socket, diagnosticResponse(requestId, operationDiagnostic(error)));
        } finally {
          outstanding -= 1;
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.endpoint);
  });
  server.on("error", () => undefined);

  if (process.platform !== "win32") {
    await chmod(options.endpoint, 0o600);
  }

  let closePromise: Promise<void> | undefined;
  return {
    endpoint: options.endpoint,
    close() {
      closePromise ??= (async () => {
        closing = true;
        for (const client of clients) client.destroy();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
        if (process.platform !== "win32") {
          await rm(options.endpoint, { force: true });
        }
      })();
      return closePromise;
    },
  };
}
