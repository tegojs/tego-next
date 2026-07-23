import type {
  ApplicationId,
  ComponentId,
  JsonObject,
  JsonValue,
  PluginId,
  RuntimeId,
  RuntimeMode,
} from "@tegojs/contracts";
import type { ComponentDisposableStack } from "./disposables.js";

function snapshotJson(value: unknown, path = "$", ancestors = new Set<object>()): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError(`Value at ${path} must be finite acyclic JSON data`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`Value at ${path} must have the standard array prototype`);
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError(`Value at ${path}/${index} must be an enumerable data property`);
        }
        result.push(snapshotJson(descriptor.value, `${path}/${index}`, ancestors));
      }
      if (
        Reflect.ownKeys(value).some(
          (key) =>
            key !== "length" &&
            !(
              typeof key === "string" &&
              /^(?:0|[1-9]\d*)$/u.test(key) &&
              Number(key) < value.length
            ),
        )
      ) {
        throw new TypeError(`Value at ${path} must not extend an array`);
      }
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Value at ${path} must be a plain object`);
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value).sort((left, right) =>
      String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
    )) {
      if (typeof key !== "string") {
        throw new TypeError(`Value at ${path} must not contain symbol properties`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`Value at ${path}/${key} must be an enumerable data property`);
      }
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        value: snapshotJson(descriptor.value, `${path}/${key}`, ancestors),
        writable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function snapshotObject<T extends JsonObject>(value: T, label: string): T {
  const snapshot = snapshotJson(value);
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return snapshot as T;
}

function dataFields(
  value: unknown,
  label: string,
  expected: readonly string[],
): ReadonlyMap<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(expected);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError(`${label} fields are invalid`);
  }
  const fields = new Map<string, unknown>();
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} ${key} must be an enumerable data property`);
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function methods(
  value: unknown,
  label: string,
  expected: readonly string[],
): ReadonlyMap<string, (...values: readonly unknown[]) => unknown> {
  const fields = dataFields(value, label, expected);
  const result = new Map<string, (...values: readonly unknown[]) => unknown>();
  for (const key of expected) {
    const method = fields.get(key);
    if (typeof method !== "function") {
      throw new TypeError(`${label} ${key} must be a function`);
    }
    result.set(key, method as (...values: readonly unknown[]) => unknown);
  }
  return result;
}

export interface ComponentIdentity extends JsonObject {
  readonly runtimeId?: RuntimeId;
  readonly applicationId: ApplicationId | string;
  readonly pluginId: PluginId | string;
  readonly componentId: ComponentId | string;
  readonly instanceId: string;
}

export interface ComponentLogger {
  debug(...values: readonly unknown[]): void;
  error(...values: readonly unknown[]): void;
  info(...values: readonly unknown[]): void;
  warn(...values: readonly unknown[]): void;
}

export interface ComponentEvents {
  emit(type: string, payload: JsonValue): Promise<void>;
}

export interface ComponentCapabilityCall extends JsonObject {
  readonly name: string;
  readonly protocolVersion: string;
  readonly method: string;
  readonly input: JsonValue;
}

export interface ComponentCapabilityClient {
  call(request: ComponentCapabilityCall): Promise<JsonValue>;
}

export interface ComponentSecretClient {
  get(name: string): Promise<string | undefined>;
}

export interface ComponentLifecycleInfo extends JsonObject {
  readonly state: string;
}

export interface ComponentRuntimeInfo extends JsonObject {
  readonly runtimeId: RuntimeId | string;
  readonly mode: RuntimeMode;
  readonly executor: "process" | "remote" | "thread";
}

export interface ComponentConfigReader {
  get(): JsonValue;
  get(key: string): JsonValue | undefined;
}

export interface ComponentContext {
  readonly identity: ComponentIdentity;
  readonly config: ComponentConfigReader;
  readonly logger: ComponentLogger;
  readonly events: ComponentEvents;
  readonly capabilities: ComponentCapabilityClient;
  readonly lifecycle: ComponentLifecycleInfo;
  readonly runtime: ComponentRuntimeInfo;
  readonly cancellation: AbortSignal;
  readonly disposables: ComponentDisposableStack;
  readonly secrets: ComponentSecretClient;
}

export interface CreateComponentContextInput {
  readonly identity: ComponentIdentity;
  readonly configuration: JsonValue;
  readonly logger: ComponentLogger;
  readonly events: ComponentEvents;
  readonly capabilities: ComponentCapabilityClient;
  readonly lifecycle: ComponentLifecycleInfo;
  readonly runtime: ComponentRuntimeInfo;
  readonly cancellation: AbortSignal;
  readonly disposables: ComponentDisposableStack;
  readonly secrets: ComponentSecretClient;
}

export function createComponentContext(input: CreateComponentContextInput): ComponentContext {
  const envelope = dataFields(input, "Component context input", [
    "identity",
    "configuration",
    "logger",
    "events",
    "capabilities",
    "lifecycle",
    "runtime",
    "cancellation",
    "disposables",
    "secrets",
  ]);
  const configuration = snapshotJson(envelope.get("configuration"));
  const identity = snapshotObject(
    envelope.get("identity") as ComponentIdentity,
    "Component identity",
  );
  const lifecycle = snapshotObject(
    envelope.get("lifecycle") as ComponentLifecycleInfo,
    "Component lifecycle",
  );
  const runtime = snapshotObject(
    envelope.get("runtime") as ComponentRuntimeInfo,
    "Component runtime",
  );
  const loggerMethods = methods(envelope.get("logger"), "Component logger", [
    "debug",
    "error",
    "info",
    "warn",
  ]);
  const eventMethods = methods(envelope.get("events"), "Component events", ["emit"]);
  const capabilityMethods = methods(envelope.get("capabilities"), "Component capabilities", [
    "call",
  ]);
  const secretMethods = methods(envelope.get("secrets"), "Component secrets", ["get"]);
  const cancellation = envelope.get("cancellation");
  const disposables = envelope.get("disposables");
  if (!(cancellation instanceof AbortSignal)) {
    throw new TypeError("Component cancellation must be an AbortSignal");
  }
  if (typeof disposables !== "object" || disposables === null) {
    throw new TypeError("Component disposables must be an object");
  }
  const config = Object.freeze({
    get(key?: string): JsonValue | undefined {
      if (key === undefined) return configuration;
      if (
        typeof configuration !== "object" ||
        configuration === null ||
        Array.isArray(configuration)
      ) {
        return undefined;
      }
      const objectConfiguration = configuration as JsonObject;
      return Object.hasOwn(objectConfiguration, key) ? objectConfiguration[key] : undefined;
    },
  }) as ComponentConfigReader;
  const logger = Object.freeze({
    debug: (...values: readonly unknown[]) => loggerMethods.get("debug")?.(...values),
    error: (...values: readonly unknown[]) => loggerMethods.get("error")?.(...values),
    info: (...values: readonly unknown[]) => loggerMethods.get("info")?.(...values),
    warn: (...values: readonly unknown[]) => loggerMethods.get("warn")?.(...values),
  });
  const events = Object.freeze({
    emit: async (type: string, payload: JsonValue) => {
      await eventMethods.get("emit")?.(type, snapshotJson(payload));
    },
  });
  const capabilities = Object.freeze({
    call: async (request: ComponentCapabilityCall): Promise<JsonValue> => {
      const requestSnapshot = snapshotObject(request, "Component capability request");
      const response = await capabilityMethods.get("call")?.(requestSnapshot);
      return snapshotJson(response);
    },
  });
  const secrets = Object.freeze({
    get: async (name: string): Promise<string | undefined> => {
      const value = await secretMethods.get("get")?.(name);
      if (value !== undefined && typeof value !== "string") {
        throw new TypeError("Component secret result must be a string or undefined");
      }
      return value as string | undefined;
    },
  });
  return Object.freeze({
    identity,
    config,
    logger,
    events,
    capabilities,
    lifecycle,
    runtime,
    cancellation,
    disposables: disposables as ComponentDisposableStack,
    secrets,
  });
}

export function snapshotComponentJson(value: unknown): JsonValue {
  return snapshotJson(value);
}
