import type { ManagedDriver } from "./drivers.js";

/**
 * Bootstrap-only secret access. Implementations must never expose their backing
 * configuration through plugin contexts or wire contracts.
 */
export interface SecretProvider extends ManagedDriver {
  readonly developmentOnly: boolean;
  get(name: string): Promise<string | undefined>;
}
