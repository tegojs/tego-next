import { MessagePort, parentPort } from "node:worker_threads";
import {
  compileSchemaValidator,
  parseArtifactDigest,
  parsePluginManifest,
  validatePermissionGrant,
  type CapabilityDefinition,
  type ComponentCapabilityBoundary,
  type ComponentCapabilityIdentity,
  type ComponentPermissionBoundary,
  type JsonValue,
  type SecretProvider,
} from "@tegojs/contracts";
import { ComponentHost, type ComponentHostClock } from "../host/component-host.js";

interface BootstrapMessage {
  readonly kind: "bootstrap";
  readonly id: string;
  readonly now: string;
  readonly artifact: {
    readonly artifactDigest: string;
    readonly artifactRoot: string;
    readonly manifest: unknown;
  };
}

interface CommandMessage {
  readonly kind: "command";
  readonly id: string;
  readonly command: unknown;
  readonly attachments?: readonly ArrayBuffer[];
}

interface RpcResponseMessage {
  readonly kind: "rpc-response";
  readonly id: string;
  readonly ok: boolean;
  readonly value?: JsonValue;
  readonly message?: string;
}

interface AckMessage {
  readonly kind: "ack";
  readonly id: string;
  readonly ok: boolean;
  readonly message?: string;
}

type ParentMessage = AckMessage | BootstrapMessage | CommandMessage | RpcResponseMessage;

const MAX_OUTBOUND_PENDING = 64;
const MAX_OUTBOUND_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_MESSAGE_DEPTH = 64;
const MAX_MESSAGE_NODES = 100_000;
let host: ComponentHost | undefined;
let broker: MessagePort | undefined;
let brokerClose: (() => void) | undefined;
let brokerSend: ((value: Record<string, unknown>) => void) | undefined;
let nextRpcId = 0;
let pendingOutboundBytes = 0;
const pendingOutbound = new Map<
  string,
  {
    readonly bytes: number;
    readonly resolve: (value: JsonValue | undefined) => void;
    readonly reject: (error: Error) => void;
  }
>();

function validateMessage(value: unknown): number {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > MAX_MESSAGE_NODES || current.depth > MAX_MESSAGE_DEPTH) {
      throw new Error("Thread message exceeds the configured complexity limit");
    }
    const item = current.value;
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8");
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      bytes += 8;
    } else if (item instanceof ArrayBuffer) {
      bytes += item.byteLength;
    } else if (typeof item === "object" && item !== null) {
      if (ancestors.has(item)) throw new Error("Thread message must not contain cycles");
      ancestors.add(item);
      const values = Array.isArray(item) ? item : Object.values(item as Record<string, unknown>);
      for (const child of values) pending.push({ value: child, depth: current.depth + 1 });
    } else {
      throw new Error("Thread message contains an unsupported value");
    }
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new Error("Thread message exceeds the configured wire limit");
    }
  }
  return bytes;
}

function send(value: Record<string, unknown>): void {
  if (brokerSend === undefined) throw new Error("Thread broker is unavailable");
  validateMessage(value);
  brokerSend(value);
}

function respond(id: string, result: unknown): void {
  try {
    send({ kind: "response", id, result });
  } catch {
    send({
      kind: "response-error",
      id,
      code: "EXECUTOR_OUTPUT_LIMIT_EXCEEDED",
      message: "Component result exceeds the thread wire output limit",
    });
  }
}

function exactObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Thread message must be an object");
  }
  return input as Record<string, unknown>;
}

function parentMessage(input: unknown): ParentMessage {
  const value = exactObject(input);
  if (typeof value.kind !== "string" || typeof value.id !== "string") {
    throw new Error("Thread message identity is invalid");
  }
  if (value.kind === "bootstrap") {
    if (typeof value.now !== "string") throw new Error("Thread bootstrap clock is invalid");
    const artifact = exactObject(value.artifact);
    if (typeof artifact.artifactDigest !== "string" || typeof artifact.artifactRoot !== "string") {
      throw new Error("Thread bootstrap artifact is invalid");
    }
    return {
      kind: "bootstrap",
      id: value.id,
      now: value.now,
      artifact: {
        artifactDigest: artifact.artifactDigest,
        artifactRoot: artifact.artifactRoot,
        manifest: artifact.manifest,
      },
    };
  }
  if (value.kind === "command") {
    const attachments =
      value.attachments === undefined
        ? undefined
        : Array.isArray(value.attachments) &&
            value.attachments.every((candidate) => candidate instanceof ArrayBuffer)
          ? value.attachments
          : undefined;
    if (value.attachments !== undefined && attachments === undefined) {
      throw new Error("Thread command attachments are invalid");
    }
    return {
      kind: "command",
      id: value.id,
      command: value.command,
      ...(attachments === undefined ? {} : { attachments }),
    };
  }
  if (value.kind === "rpc-response") {
    return {
      kind: "rpc-response",
      id: value.id,
      ok: value.ok === true,
      ...(value.value === undefined ? {} : { value: value.value as JsonValue }),
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    };
  }
  if (value.kind === "ack") {
    return {
      kind: "ack",
      id: value.id,
      ok: value.ok === true,
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    };
  }
  throw new Error("Thread message kind is invalid");
}

function requestParent(
  message: Record<string, unknown>,
  overflow: "close" | "drop" = "close",
): Promise<JsonValue | undefined> {
  const id = `outbound-${++nextRpcId}`;
  const value = { ...message, id };
  let bytes: number;
  try {
    bytes = validateMessage(value);
  } catch (error) {
    return Promise.reject(error);
  }
  if (
    pendingOutbound.size >= MAX_OUTBOUND_PENDING ||
    pendingOutboundBytes + bytes > MAX_OUTBOUND_PENDING_BYTES
  ) {
    if (overflow === "drop") return Promise.resolve(undefined);
    brokerClose?.();
    return Promise.reject(new Error("Parent broker pending capacity is exhausted"));
  }
  return new Promise<JsonValue | undefined>((resolve, reject) => {
    pendingOutbound.set(id, { bytes, resolve, reject });
    pendingOutboundBytes += bytes;
    try {
      send(value);
    } catch (error) {
      pendingOutbound.delete(id);
      pendingOutboundBytes -= bytes;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function rpc(type: "capability" | "secret", payload: JsonValue): Promise<JsonValue | undefined> {
  return requestParent({ kind: "rpc-request", type, payload });
}

function diagnosticMessage(level: string, values: readonly unknown[]): void {
  void requestParent({ kind: "diagnostic", level, values }, "drop").catch(() => undefined);
}

function settleOutbound(message: AckMessage | RpcResponseMessage): void {
  const pending = pendingOutbound.get(message.id);
  if (pending === undefined) return;
  pendingOutbound.delete(message.id);
  pendingOutboundBytes -= pending.bytes;
  if (message.ok) {
    pending.resolve(message.kind === "rpc-response" ? message.value : undefined);
  } else {
    pending.reject(new Error(message.message ?? "Parent broker request failed"));
  }
}

function rejectOutbound(error: Error): void {
  for (const pending of pendingOutbound.values()) pending.reject(error);
  pendingOutbound.clear();
  pendingOutboundBytes = 0;
}

function permissionBoundary(): ComponentPermissionBoundary {
  return {
    validateGrant: (requested, granted) => validatePermissionGrant(requested, granted),
    authorize(granted, attempt) {
      const allowed = granted.some((permission) => {
        if (permission.kind !== attempt.kind) return false;
        if (permission.kind === "secret") {
          return typeof attempt.name === "string" && permission.names.includes(attempt.name);
        }
        if (permission.kind === "capability") {
          return permission.capabilities.some(
            (capability) =>
              capability.name === attempt.name &&
              typeof attempt.method === "string" &&
              capability.methods.includes(attempt.method),
          );
        }
        return false;
      });
      return allowed
        ? { allowed: true, diagnostics: [] }
        : {
            allowed: false,
            diagnostics: [
              {
                code: "PERMISSION_OPERATION_DENIED",
                message: "Component operation is not granted",
              },
            ],
          };
    },
  };
}

function capabilityBoundary(): ComponentCapabilityBoundary {
  const validators = new Map<
    string,
    {
      readonly request: ReturnType<typeof compileSchemaValidator<JsonValue>>;
      readonly response: ReturnType<typeof compileSchemaValidator<JsonValue>>;
    }
  >();
  const key = (identity: ComponentCapabilityIdentity) =>
    `${identity.name.length}:${identity.name}${identity.protocolVersion}`;
  return {
    register(definitions: readonly CapabilityDefinition[]) {
      try {
        for (const definition of definitions) {
          validators.set(key(definition.identity), {
            request: compileSchemaValidator<JsonValue>(definition.requestSchema),
            response: compileSchemaValidator<JsonValue>(definition.responseSchema),
          });
        }
        return { ok: true, diagnostics: [] };
      } catch (error) {
        validators.clear();
        return {
          ok: false,
          diagnostics: [
            {
              code: "CAPABILITY_SCHEMA_INVALID",
              message: error instanceof Error ? error.message : "Capability schema is invalid",
            },
          ],
        };
      }
    },
    request(identity, input) {
      const validator = validators.get(key(identity))?.request;
      if (validator === undefined) {
        return {
          allowed: false,
          diagnostics: [
            { code: "CAPABILITY_PAYLOAD_INVALID", message: "Capability is not registered" },
          ],
        };
      }
      try {
        return { allowed: true, diagnostics: [], value: validator.parse(input) };
      } catch (error) {
        return {
          allowed: false,
          diagnostics: [
            {
              code: "CAPABILITY_REQUEST_INVALID",
              message: error instanceof Error ? error.message : "Capability request is invalid",
            },
          ],
        };
      }
    },
    async invoke(request) {
      return rpc("capability", request);
    },
    response(identity, input) {
      const validator = validators.get(key(identity))?.response;
      if (validator === undefined) {
        return {
          allowed: false,
          diagnostics: [
            { code: "CAPABILITY_PAYLOAD_INVALID", message: "Capability is not registered" },
          ],
        };
      }
      try {
        return { allowed: true, diagnostics: [], value: validator.parse(input) };
      } catch (error) {
        return {
          allowed: false,
          diagnostics: [
            {
              code: "CAPABILITY_RESPONSE_INVALID",
              message: error instanceof Error ? error.message : "Capability response is invalid",
            },
          ],
        };
      }
    },
    clear() {
      validators.clear();
    },
  };
}

async function bootstrap(message: BootstrapMessage): Promise<void> {
  if (host !== undefined) throw new Error("Thread component host is already bootstrapped");
  const artifactDigest = parseArtifactDigest(message.artifact.artifactDigest);
  const manifest = parsePluginManifest(message.artifact.manifest);
  const logicalNow = new Date(message.now);
  if (!Number.isFinite(logicalNow.getTime())) throw new Error("Thread bootstrap clock is invalid");
  const started = Date.now();
  const clock: ComponentHostClock = {
    now: () => new Date(logicalNow.getTime() + (Date.now() - started)),
    setTimeout(callback, delay) {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return { cancel: () => clearTimeout(timer) };
    },
  };
  const secretProvider: SecretProvider = {
    developmentOnly: false,
    open: async () => {},
    health: async () => ({ status: "healthy", checkedAt: clock.now().toISOString() }),
    close: async () => {},
    async get(name) {
      const value = await rpc("secret", { name });
      if (value === undefined || typeof value === "string") return value;
      throw new Error("Secret RPC returned an invalid value");
    },
  };
  host = new ComponentHost({
    artifactResolver: {
      async resolve(requestedDigest) {
        if (requestedDigest !== artifactDigest) {
          throw new Error("Thread artifact resolver only accepts its bootstrap digest");
        }
        return {
          artifactDigest,
          artifactRoot: message.artifact.artifactRoot,
          manifest,
        };
      },
    },
    permissionBoundary: permissionBoundary(),
    capabilityBoundary: capabilityBoundary(),
    secretProvider,
    clock,
    logger: {
      debug: (...values) => diagnosticMessage("debug", values),
      error: (...values) => diagnosticMessage("error", values),
      info: (...values) => diagnosticMessage("info", values),
      warn: (...values) => diagnosticMessage("warn", values),
    },
    events: {
      emit: async (type, payload) => {
        await requestParent({ kind: "event", type, payload });
      },
    },
  });
}

async function handle(message: ParentMessage): Promise<void> {
  if (message.kind === "ack" || message.kind === "rpc-response") {
    settleOutbound(message);
    return;
  }
  if (message.kind === "bootstrap") {
    try {
      await bootstrap(message);
      respond(message.id, { ok: true });
    } catch (error) {
      respond(message.id, {
        ok: false,
        message: error instanceof Error ? error.message : "Bootstrap failed",
      });
    }
    return;
  }
  if (host === undefined) {
    respond(message.id, { ok: false, message: "Thread component host is not bootstrapped" });
    return;
  }
  respond(message.id, await host.handle(message.command));
}

function connect(value: unknown): void {
  const message = exactObject(value);
  if (
    message.kind !== "connect" ||
    !(message.port instanceof MessagePort) ||
    Object.keys(message).some((key) => key !== "kind" && key !== "port")
  ) {
    throw new Error("Thread broker connection is invalid");
  }
  if (broker !== undefined) throw new Error("Thread broker is already connected");
  broker = message.port;
  const postMessage = broker.postMessage.bind(broker);
  const close = broker.close.bind(broker);
  const on = broker.on.bind(broker);
  const start = broker.start.bind(broker);
  brokerSend = (outbound) => postMessage(outbound);
  brokerClose = close;
  on("message", (input: unknown) => {
    let message_: ParentMessage;
    try {
      validateMessage(input);
      message_ = parentMessage(input);
    } catch (error) {
      send({
        kind: "fatal",
        code: "PROTOCOL_THREAD_MESSAGE_INVALID",
        message: error instanceof Error ? error.message : "Thread input failed",
      });
      return;
    }
    void handle(message_).catch((error: unknown) => {
      respond(message_.id, {
        ok: false,
        message: error instanceof Error ? error.message : "Thread command failed",
      });
    });
  });
  on("close", () => {
    rejectOutbound(new Error("Parent thread channel closed"));
  });
  start();
}

if (parentPort === null) throw new Error("Thread entry requires a parent port");
parentPort.once("message", connect);
