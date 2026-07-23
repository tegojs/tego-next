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
import { authenticateProcessMessage, signProcessMessage } from "./authentication.js";
import { ProcessFrameDecoder, encodeProcessFrame } from "./framing.js";
import {
  ProcessOutboundWriter,
  type ProcessOutboundPriority,
} from "./outbound-writer.js";

interface BootstrapMessage {
  readonly kind: "bootstrap";
  readonly id: string;
  readonly now: string;
  readonly channelKey: string;
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
}

interface RpcResponseMessage {
  readonly kind: "rpc-response";
  readonly id: string;
  readonly ok: boolean;
  readonly value?: JsonValue;
  readonly message?: string;
}

type ParentMessage = BootstrapMessage | CommandMessage | RpcResponseMessage;

const MAX_RPC_INFLIGHT = 64;
let host: ComponentHost | undefined;
let nextRpcId = 0;
let outboundSequence = 0;
let inboundSequence = 0;
let channelKey: Uint8Array | undefined;
const pendingRpc = new Map<
  string,
  {
    readonly resolve: (value: JsonValue | undefined) => void;
    readonly reject: (error: Error) => void;
  }
>();

function writeRaw(bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(Buffer.from(bytes), (error) => {
      if (error !== null && error !== undefined) reject(error);
      else resolve();
    });
  });
}

const outboundWriter = new ProcessOutboundWriter({
  encode(value) {
    const message =
      channelKey === undefined
        ? value
        : signProcessMessage(channelKey, "child-to-parent", outboundSequence, value);
    const frame = encodeProcessFrame(message, "EXECUTOR_OUTPUT_LIMIT_EXCEEDED");
    if (channelKey !== undefined) outboundSequence += 1;
    return frame;
  },
  write: writeRaw,
});

function send(value: unknown, priority: ProcessOutboundPriority = "required"): Promise<void> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Promise.reject(new Error("Process response must be an object"));
  }
  return outboundWriter.send(value as Record<string, unknown>, priority);
}

async function respond(id: string, result: unknown): Promise<void> {
  try {
    await send({ kind: "response", id, result });
  } catch {
    await send({
      kind: "response-error",
      id,
      code: "EXECUTOR_OUTPUT_LIMIT_EXCEEDED",
      message: "Component result exceeds the process wire output limit",
    });
  }
}

function exactObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Process message must be an object");
  }
  return input as Record<string, unknown>;
}

function parentMessage(input: unknown): ParentMessage {
  const value = exactObject(input);
  if (typeof value.kind !== "string" || typeof value.id !== "string") {
    throw new Error("Process message identity is invalid");
  }
  if (value.kind === "bootstrap") {
    if (
      typeof value.now !== "string" ||
      typeof value.channelKey !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.channelKey)
    ) {
      throw new Error("Bootstrap channel authentication is invalid");
    }
    const artifact = exactObject(value.artifact);
    if (typeof artifact.artifactDigest !== "string" || typeof artifact.artifactRoot !== "string") {
      throw new Error("Bootstrap artifact is invalid");
    }
    return {
      kind: "bootstrap",
      id: value.id,
      now: value.now,
      channelKey: value.channelKey,
      artifact: {
        artifactDigest: artifact.artifactDigest,
        artifactRoot: artifact.artifactRoot,
        manifest: artifact.manifest,
      },
    };
  }
  if (value.kind === "command") {
    return { kind: "command", id: value.id, command: value.command };
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
  throw new Error("Process message kind is invalid");
}

function rpc(type: "capability" | "secret", payload: JsonValue): Promise<JsonValue | undefined> {
  if (pendingRpc.size >= MAX_RPC_INFLIGHT) {
    return Promise.reject(new Error("Parent RPC capacity is exhausted"));
  }
  const id = `rpc-${++nextRpcId}`;
  return new Promise<JsonValue | undefined>((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    void send({ kind: "rpc-request", id, type, payload }).catch((error: unknown) => {
      pendingRpc.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
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
  if (host !== undefined) throw new Error("Process component host is already bootstrapped");
  channelKey = Buffer.from(message.channelKey, "hex");
  const artifactDigest = parseArtifactDigest(message.artifact.artifactDigest);
  const manifest = parsePluginManifest(message.artifact.manifest);
  const logicalNow = new Date(message.now);
  if (!Number.isFinite(logicalNow.getTime())) throw new Error("Bootstrap clock is invalid");
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
    health: async () => ({
      status: "healthy",
      checkedAt: clock.now().toISOString(),
    }),
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
          throw new Error("Child artifact resolver only accepts its bootstrap digest");
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
      debug: (...values) =>
        void send({ kind: "diagnostic", level: "debug", values }, "diagnostic").catch(
          () => undefined,
        ),
      error: (...values) =>
        void send({ kind: "diagnostic", level: "error", values }, "diagnostic").catch(
          () => undefined,
        ),
      info: (...values) =>
        void send({ kind: "diagnostic", level: "info", values }, "diagnostic").catch(
          () => undefined,
        ),
      warn: (...values) =>
        void send({ kind: "diagnostic", level: "warn", values }, "diagnostic").catch(
          () => undefined,
        ),
    },
    events: {
      emit: async (type, payload) => {
        await send({ kind: "event", type, payload });
      },
    },
  });
}

async function handle(message: ParentMessage): Promise<void> {
  if (message.kind === "rpc-response") {
    const pending = pendingRpc.get(message.id);
    if (pending === undefined) return;
    pendingRpc.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.message ?? "Parent RPC failed"));
    return;
  }
  if (message.kind === "bootstrap") {
    try {
      await bootstrap(message);
      await respond(message.id, { ok: true });
    } catch (error) {
      await respond(message.id, {
        ok: false,
        message: error instanceof Error ? error.message : "Bootstrap failed",
      });
    }
    return;
  }
  if (host === undefined) {
    await respond(message.id, { ok: false, message: "Process component host is not bootstrapped" });
    return;
  }
  await respond(message.id, await host.handle(message.command));
}

async function main(): Promise<void> {
  const decoder = new ProcessFrameDecoder();
  try {
    for await (const chunk of process.stdin) {
      for (const value of decoder.push(chunk)) {
        const authenticated =
          channelKey === undefined
            ? value
            : authenticateProcessMessage(channelKey, "parent-to-child", inboundSequence++, value);
        const message = parentMessage(authenticated);
        if (channelKey === undefined && message.kind !== "bootstrap") {
          throw new Error("First process message must bootstrap the authenticated channel");
        }
        void handle(message).catch(async (error: unknown) => {
          await respond(message.id, {
            ok: false,
            message: error instanceof Error ? error.message : "Process command failed",
          });
        });
      }
    }
    decoder.finish();
  } catch (error) {
    await send({
      kind: "fatal",
      code: "PROTOCOL_PROCESS_FRAME_INVALID",
      message: error instanceof Error ? error.message : "Process input failed",
    }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    for (const pending of pendingRpc.values()) pending.reject(new Error("Parent channel closed"));
    pendingRpc.clear();
    await outboundWriter.flush();
  }
}

await main();
