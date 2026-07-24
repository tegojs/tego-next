import {
  type DiagnosticCode,
  DiagnosticError,
  type DriverHealth,
  type JsonValue,
  runtimeDiagnostic,
  serializeWireValue,
} from "@tegojs/contracts";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { applyPostgresMigrations } from "./migrations.js";

const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const poolFailures = new WeakMap<Pool, Error>();

export interface PostgresClientMonitor {
  readonly close: () => void;
  readonly failure: () => Error | undefined;
}

export interface PostgresConnectionOptions {
  readonly connectionString: string;
  readonly namespace: string;
}

export function assertPostgresOptions(options: PostgresConnectionOptions): void {
  if (options.connectionString.length === 0) {
    throw new TypeError("connectionString must not be empty");
  }
  if (!NAMESPACE_PATTERN.test(options.namespace)) {
    throw new TypeError("namespace must be a portable non-empty identifier");
  }
}

export function createPool(options: PostgresConnectionOptions, component: string, max = 10): Pool {
  assertPostgresOptions(options);
  const pool = new Pool({
    application_name: `tego:${options.namespace}:${component}`,
    connectionString: options.connectionString,
    max,
  });
  pool.on("error", (error: Error) => {
    poolFailures.set(pool, error);
  });
  return pool;
}

export async function openPool(pool: Pool): Promise<void> {
  await applyPostgresMigrations(pool);
}

export function monitorPostgresClient(client: PoolClient, pool: Pool): PostgresClientMonitor {
  let failure: Error | undefined;
  const onError = (error: Error) => {
    failure = error;
    poolFailures.set(pool, error);
  };
  client.on("error", onError);
  return {
    close: () => client.off("error", onError),
    failure: () => failure,
  };
}

export async function postgresPoolHealth(pool: Pool): Promise<DriverHealth> {
  const previousFailure = poolFailures.get(pool);
  const result = await pool.query<{ checked_at: Date }>("SELECT clock_timestamp() AS checked_at");
  const checkedAt = isoTimestamp(result.rows[0]?.checked_at, "health timestamp");
  if (previousFailure === undefined) return { status: "healthy", checkedAt };
  poolFailures.delete(pool);
  return {
    status: "degraded",
    checkedAt,
    message: "PostgreSQL pool recovered from a connection failure",
  };
}

export async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const monitor = monitorPostgresClient(client, pool);
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    const destroy = monitor.failure() !== undefined;
    monitor.close();
    client.release(destroy);
  }
}

export function postgresError(
  code: DiagnosticCode,
  message: string,
  source: "artifact" | "coordination" | "state",
  details?: JsonValue,
): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: source, id: `postgres-${source}` },
      ...(details === undefined ? {} : { details }),
    }),
  );
}

export function canonicalJson<T extends JsonValue>(value: T): string {
  return JSON.stringify(serializeWireValue(value));
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return serializeWireValue(JSON.parse(canonicalJson(value)) as unknown) as T;
}

export function jsonValue(row: QueryResultRow, column: string): JsonValue {
  return cloneJson(row[column] as JsonValue);
}

export function decimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw postgresError("STATE_DATA_INVALID", `PostgreSQL returned an invalid ${field}`, "state", {
      field,
      value: typeof value === "string" ? value : typeof value,
    });
  }
  return value;
}

export function isoTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw postgresError("STATE_DATA_INVALID", `PostgreSQL returned an invalid ${field}`, "state", {
      field,
    });
  }
  return date.toISOString();
}
