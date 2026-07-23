import {
  DiagnosticError,
  runtimeDiagnostic,
  type Clock,
  type DriverHealth,
  type SecretProvider,
} from "@tegojs/contracts";

export const DEVELOPMENT_SECRET_PROVIDER_NOTICE =
  "Development secret provider stores values in process memory and is not for production";

const defaultClock: Clock = {
  now: () => new Date(),
  sleep: async () => {},
};

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function snapshotValues(input: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Secret configuration must be a plain object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Secret configuration must be a plain object");
  }
  const values = new Map<string, string>();
  for (const key of Reflect.ownKeys(input).sort((left, right) =>
    String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
  )) {
    if (typeof key !== "string") {
      throw new TypeError("Secret configuration must not contain symbol properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`Secret ${key} must be an enumerable data property`);
    }
    if (!SECRET_NAME.test(key)) {
      throw new TypeError(`Secret name ${key} is invalid`);
    }
    if (typeof descriptor.value !== "string") {
      throw new TypeError(`Secret ${key} must be a string`);
    }
    if (!hasWellFormedUnicode(descriptor.value)) {
      throw new TypeError(`Secret ${key} must contain valid Unicode`);
    }
    values.set(key, descriptor.value);
  }
  return values;
}

export interface DevelopmentSecretProviderOptions {
  readonly values: Readonly<Record<string, string>>;
  readonly clock?: Clock;
}

export class DevelopmentSecretProvider implements SecretProvider {
  readonly developmentOnly = true;
  readonly #clock: Clock;
  readonly #values: ReadonlyMap<string, string>;
  #state: "closed" | "open" = "closed";

  constructor(options: DevelopmentSecretProviderOptions) {
    this.#clock = options.clock ?? defaultClock;
    this.#values = snapshotValues(options.values);
  }

  async open(): Promise<void> {
    this.#state = "open";
  }

  async get(name: string): Promise<string | undefined> {
    if (this.#state !== "open") {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "BOOTSTRAP_SECRET_PROVIDER_CLOSED",
          message: "Secret provider is closed",
          source: { kind: "runtime", id: "development-secrets" },
          observedAt: this.#clock.now().toISOString(),
        }),
      );
    }
    if (!SECRET_NAME.test(name)) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "PERMISSION_SECRET_NAME_INVALID",
          message: "Secret name is invalid",
          source: { kind: "runtime", id: "development-secrets" },
          observedAt: this.#clock.now().toISOString(),
        }),
      );
    }
    return this.#values.get(name);
  }

  async health(): Promise<DriverHealth> {
    return {
      status: this.#state === "open" ? "healthy" : "unhealthy",
      checkedAt: this.#clock.now().toISOString(),
      message: DEVELOPMENT_SECRET_PROVIDER_NOTICE,
    };
  }

  async close(): Promise<void> {
    this.#state = "closed";
  }
}
