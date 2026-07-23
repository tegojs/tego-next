import { DiagnosticError, runtimeDiagnostic } from "./diagnostic.js";

export type JsonPrimitive = boolean | null | number | string;
export type JsonArray = readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

function wireValueError(path: string, value: unknown, reason: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_WIRE_VALUE_INVALID",
      message: `Value at ${path} cannot be serialized for the wire: ${reason}`,
      source: { kind: "protocol", id: "wire-value" },
      details: { path, valueType: typeof value, reason },
    }),
  );
}

function serialize(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw wireValueError(path, value, "numbers must be finite");
    }
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString(10);
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw wireValueError(path, value, "date must be valid");
    }
    return value.toISOString();
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }

  if (typeof value !== "object") {
    throw wireValueError(path, value, `${typeof value} is not JSON data`);
  }

  if (ancestors.has(value)) {
    throw wireValueError(path, value, "cyclic references are not supported");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const descriptors: PropertyDescriptor[] = [];
      const allowedKeys = new Set<PropertyKey>(["length"]);

      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined) {
          throw wireValueError(`${path}/${key}`, value, "arrays must be dense");
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw wireValueError(
            `${path}/${key}`,
            value,
            "array elements must be enumerable data properties",
          );
        }
        allowedKeys.add(key);
        descriptors.push(descriptor);
      }

      if (Reflect.ownKeys(value).some((key) => !allowedKeys.has(key))) {
        throw wireValueError(path, value, "extended array properties are not supported");
      }

      return descriptors.map((descriptor, index) =>
        serialize(descriptor.value, `${path}/${index}`, ancestors),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw wireValueError(path, value, "only plain objects are supported");
    }

    const result: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: serialize((value as Record<string, unknown>)[key], `${path}/${key}`, ancestors),
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function serializeWireValue(value: unknown): JsonValue {
  return serialize(value, "$", new Set());
}
