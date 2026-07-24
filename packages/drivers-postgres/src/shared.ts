import {
  type DiagnosticCode,
  DiagnosticError,
  type JsonValue,
  runtimeDiagnostic,
  serializeWireValue,
} from "@tegojs/contracts";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { applyPostgresMigrations } from "./migrations.js";

const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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
  return new Pool({
    application_name: `tego:${options.namespace}:${component}`,
    connectionString: options.connectionString,
    max,
  });
}

export async function openPool(pool: Pool): Promise<void> {
  await applyPostgresMigrations(pool);
}

export async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
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
