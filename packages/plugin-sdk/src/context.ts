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
  const configuration = snapshotJson(input.configuration);
  const identity = snapshotObject(input.identity, "Component identity");
  const lifecycle = snapshotObject(input.lifecycle, "Component lifecycle");
  const runtime = snapshotObject(input.runtime, "Component runtime");
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
    debug: (...values: readonly unknown[]) => input.logger.debug(...values),
    error: (...values: readonly unknown[]) => input.logger.error(...values),
    info: (...values: readonly unknown[]) => input.logger.info(...values),
    warn: (...values: readonly unknown[]) => input.logger.warn(...values),
  });
  const events = Object.freeze({
    emit: (type: string, payload: JsonValue) => input.events.emit(type, snapshotJson(payload)),
  });
  const capabilities = Object.freeze({
    call: (request: ComponentCapabilityCall) => input.capabilities.call(request),
  });
  const secrets = Object.freeze({
    get: (name: string) => input.secrets.get(name),
  });
  return Object.freeze({
    identity,
    config,
    logger,
    events,
    capabilities,
    lifecycle,
    runtime,
    cancellation: input.cancellation,
    disposables: input.disposables,
    secrets,
  });
}

export function snapshotComponentJson(value: unknown): JsonValue {
  return snapshotJson(value);
}
