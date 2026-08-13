import { Pool } from "pg";

const disposableNamespacePattern = /^test_[a-z0-9]+_[a-z0-9_]+$/u;
const cleanupTables = Object.freeze([
  "tego_operation_history",
  "tego_operations",
  "tego_outbox",
  "tego_idempotency",
  "tego_state_changes",
  "tego_records",
  "tego_fences",
  "tego_state_revisions",
  "tego_coordination_changes",
  "tego_coordination_records",
  "tego_coordination_leases",
  "tego_coordination_epochs",
  "tego_coordination_revisions",
  "tego_artifacts",
  "tego_artifact_namespace_usage",
]);

export function assertDisposablePostgresNamespace(namespace) {
  if (typeof namespace !== "string" || !disposableNamespacePattern.test(namespace)) {
    throw new Error(`UNSAFE_POSTGRES_TEST_NAMESPACE:${String(namespace)}`);
  }
}

export async function cleanupPostgresNamespace({ connectionString, namespace }) {
  assertDisposablePostgresNamespace(namespace);
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000, max: 1 });
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query("SET LOCAL lock_timeout = '5000ms'");
    for (const table of cleanupTables) {
      await client.query(`DELETE FROM ${table} WHERE driver_namespace = $1`, [namespace]);
    }
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await client?.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}
