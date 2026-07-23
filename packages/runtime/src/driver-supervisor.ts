import {
  parseDriverHealth,
  serializeCause,
  type DriverHealth,
  type ManagedDriver,
  type RuntimeDriverName,
  type RuntimeDriverStatus,
  type RuntimeDrivers,
} from "@tegojs/contracts";

interface NamedDriver {
  readonly name: RuntimeDriverName;
  readonly driver: ManagedDriver;
}

export class DriverSupervisor {
  readonly #drivers: readonly NamedDriver[];
  readonly #opened: NamedDriver[] = [];

  constructor(drivers: RuntimeDrivers) {
    this.#drivers = [
      { name: "state", driver: drivers.state },
      { name: "coordination", driver: drivers.coordination },
      { name: "artifacts", driver: drivers.artifacts },
      { name: "processHost", driver: drivers.processHost },
      { name: "secrets", driver: drivers.secrets },
    ];
  }

  async open(): Promise<void> {
    for (const named of this.#drivers) {
      this.#opened.push(named);
      await named.driver.open();
    }
  }

  async health(checkedAt: string): Promise<readonly RuntimeDriverStatus[]> {
    return Promise.all(
      this.#opened.map(async ({ name, driver }) => {
        let health: DriverHealth;
        try {
          health = structuredClone(parseDriverHealth(await driver.health()));
        } catch (error) {
          health = {
            status: "unhealthy",
            checkedAt,
            message: serializeCause(error).message,
          };
        }
        return { name, health };
      }),
    );
  }

  async close(): Promise<readonly unknown[]> {
    const drivers = this.#opened.splice(0).reverse();
    const errors: unknown[] = [];
    for (const { driver } of drivers) {
      try {
        await driver.close();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
}
