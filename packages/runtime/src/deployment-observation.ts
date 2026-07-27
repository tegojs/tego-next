import {
  type JsonValue,
  type PluginDeploymentObservation,
  parsePluginDeploymentObservation,
  serializeWireValue,
} from "@tegojs/contracts";

export interface DecodedPersistedPluginDeploymentObservation {
  readonly legacy: boolean;
  readonly observation: PluginDeploymentObservation;
}

export function decodePersistedPluginDeploymentObservation(
  input: unknown,
): DecodedPersistedPluginDeploymentObservation {
  try {
    return {
      legacy: false,
      observation: parsePluginDeploymentObservation(input),
    };
  } catch (strictError) {
    let serialized: JsonValue;
    try {
      serialized = serializeWireValue(input);
    } catch {
      throw strictError;
    }
    if (serialized === null || typeof serialized !== "object" || Array.isArray(serialized)) {
      throw strictError;
    }
    const object = serialized as Readonly<Record<string, JsonValue>>;
    const legacyStatus = object.status;
    const status =
      legacyStatus === "converging"
        ? "reconciling"
        : legacyStatus === "inconsistent" || legacyStatus === "unavailable"
          ? "blocked"
          : undefined;
    if (status === undefined) throw strictError;
    try {
      return {
        legacy: true,
        observation: parsePluginDeploymentObservation({
          ...object,
          status,
        }),
      };
    } catch {
      throw strictError;
    }
  }
}
