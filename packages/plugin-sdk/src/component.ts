import type { ComponentCapabilityInvocation, JsonObject, JsonValue } from "@tegojs/contracts";
import { type ComponentContext, snapshotComponentJson } from "./context.js";

export const COMPONENT_DEFINITION_PROTOCOL = "tego.component/1.0" as const;

export interface PluginComponentDefinition {
  readonly protocol: typeof COMPONENT_DEFINITION_PROTOCOL;
  readonly kind: "service" | "task";
  readonly metadata?: JsonObject;
  readonly start?: (context: ComponentContext) => Promise<void> | void;
  readonly health?: (context: ComponentContext) => Promise<JsonValue> | JsonValue;
  readonly run?: (context: ComponentContext, input: JsonValue) => Promise<JsonValue> | JsonValue;
  readonly invokeCapability?: (
    context: ComponentContext,
    request: ComponentCapabilityInvocation,
  ) => Promise<JsonValue> | JsonValue;
  readonly drain?: (context: ComponentContext) => Promise<void> | void;
  readonly stop?: (context: ComponentContext) => Promise<void> | void;
}

export type PluginComponentDefinitionInput = Omit<PluginComponentDefinition, "protocol">;

const FIELDS = new Set([
  "drain",
  "health",
  "invokeCapability",
  "kind",
  "metadata",
  "run",
  "start",
  "stop",
]);
const HOOKS = ["drain", "health", "invokeCapability", "run", "start", "stop"] as const;

export function defineComponent(input: PluginComponentDefinitionInput): PluginComponentDefinition {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Component definition must be a plain object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Component definition must be a plain object");
  }
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !FIELDS.has(key)) {
      throw new TypeError("Component definition contains unsupported fields");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`Component definition ${key} must be an enumerable data property`);
    }
    values.set(key, descriptor.value);
  }
  const kind = values.get("kind");
  if (kind !== "service" && kind !== "task") {
    throw new TypeError("Component definition kind must be service or task");
  }
  for (const hook of HOOKS) {
    const value = values.get(hook);
    if (value !== undefined && typeof value !== "function") {
      throw new TypeError(`Component definition ${hook} must be a function`);
    }
  }
  if (kind === "service" && values.get("invokeCapability") !== undefined) {
    throw new TypeError("Capability provider hooks are supported only by task components");
  }
  const metadataValue = values.get("metadata");
  let metadata: JsonObject | undefined;
  if (metadataValue !== undefined) {
    const snapshot = snapshotComponentJson(metadataValue);
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      throw new TypeError("Component definition metadata must be a plain JSON object");
    }
    metadata = snapshot as JsonObject;
  }
  return Object.freeze({
    protocol: COMPONENT_DEFINITION_PROTOCOL,
    kind,
    ...(metadata === undefined ? {} : { metadata }),
    ...(values.get("start") === undefined ? {} : { start: values.get("start") }),
    ...(values.get("health") === undefined ? {} : { health: values.get("health") }),
    ...(values.get("run") === undefined ? {} : { run: values.get("run") }),
    ...(values.get("invokeCapability") === undefined
      ? {}
      : { invokeCapability: values.get("invokeCapability") }),
    ...(values.get("drain") === undefined ? {} : { drain: values.get("drain") }),
    ...(values.get("stop") === undefined ? {} : { stop: values.get("stop") }),
  }) as PluginComponentDefinition;
}
