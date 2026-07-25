import type { Pool, PoolClient } from "pg";
import { isPortableStateString, stateStringOrderKey } from "@tegojs/contracts";

const migrations = [
  `
    CREATE TABLE tego_state_revisions (
      driver_namespace text PRIMARY KEY,
      revision bigint NOT NULL CHECK (revision >= 0)
    );

    CREATE TABLE tego_records (
      driver_namespace text NOT NULL,
      namespace text NOT NULL,
      collection_name text NOT NULL,
      record_id text NOT NULL,
      value_json jsonb NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      PRIMARY KEY (driver_namespace, namespace, collection_name, record_id)
    );

    CREATE TABLE tego_state_changes (
      sequence bigserial PRIMARY KEY,
      driver_namespace text NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      namespace text NOT NULL,
      collection_name text NOT NULL,
      record_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('delete', 'put')),
      value_json jsonb
    );
    CREATE INDEX tego_state_changes_cursor
      ON tego_state_changes(driver_namespace, revision, sequence);

    CREATE TABLE tego_operations (
      driver_namespace text NOT NULL,
      operation_id text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      state_json jsonb NOT NULL,
      updated_at timestamptz NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      PRIMARY KEY (driver_namespace, operation_id)
    );

    CREATE TABLE tego_outbox (
      driver_namespace text NOT NULL,
      message_id text NOT NULL,
      operation_id text NOT NULL,
      topic text NOT NULL,
      payload_json jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      available_at timestamptz NOT NULL,
      enqueue_sequence bigint NOT NULL CHECK (enqueue_sequence > 0),
      attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      claim_owner text,
      claim_epoch bigint,
      claimed_at timestamptz,
      claim_expires_at timestamptz,
      acknowledgement_outcome text CHECK (
        acknowledgement_outcome IS NULL OR acknowledgement_outcome IN ('completed', 'retry')
      ),
      acknowledgement_owner text,
      acknowledgement_claim_epoch bigint,
      acknowledgement_retry_at timestamptz,
      acknowledged_at timestamptz,
      revision bigint NOT NULL CHECK (revision > 0),
      PRIMARY KEY (driver_namespace, message_id),
      UNIQUE (driver_namespace, enqueue_sequence)
    );
    CREATE INDEX tego_outbox_delivery
      ON tego_outbox(driver_namespace, available_at, enqueue_sequence, message_id);

    CREATE TABLE tego_idempotency (
      driver_namespace text NOT NULL,
      idempotency_key text NOT NULL,
      fingerprint text NOT NULL,
      result_json jsonb NOT NULL,
      PRIMARY KEY (driver_namespace, idempotency_key)
    );

    CREATE TABLE tego_fences (
      driver_namespace text NOT NULL,
      resource text NOT NULL,
      epoch bigint NOT NULL CHECK (epoch >= 0),
      PRIMARY KEY (driver_namespace, resource)
    );

    CREATE TABLE tego_artifacts (
      driver_namespace text NOT NULL,
      digest text NOT NULL,
      content bytea NOT NULL,
      size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (driver_namespace, digest)
    );

    CREATE TABLE tego_coordination_revisions (
      driver_namespace text PRIMARY KEY,
      revision bigint NOT NULL CHECK (revision >= 0)
    );

    CREATE TABLE tego_coordination_epochs (
      driver_namespace text NOT NULL,
      resource text NOT NULL,
      epoch bigint NOT NULL CHECK (epoch >= 0),
      PRIMARY KEY (driver_namespace, resource)
    );

    CREATE TABLE tego_coordination_leases (
      driver_namespace text NOT NULL,
      resource text NOT NULL,
      owner text NOT NULL,
      epoch bigint NOT NULL CHECK (epoch > 0),
      acquired_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (driver_namespace, resource)
    );

    CREATE TABLE tego_coordination_records (
      driver_namespace text NOT NULL,
      record_key text NOT NULL,
      value_json jsonb NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      PRIMARY KEY (driver_namespace, record_key)
    );

    CREATE TABLE tego_coordination_changes (
      sequence bigserial PRIMARY KEY,
      driver_namespace text NOT NULL,
      record_key text NOT NULL,
      value_json jsonb NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0)
    );
    CREATE INDEX tego_coordination_changes_cursor
      ON tego_coordination_changes(driver_namespace, revision, sequence);
  `,
  `
    ALTER TABLE tego_artifacts
      ADD CONSTRAINT tego_artifacts_size_limit
      CHECK (size_bytes <= 16777216);
  `,
  `
    ALTER TABLE tego_records
      ADD COLUMN record_id_order_key bytea;

    CREATE INDEX tego_records_scan_order
      ON tego_records(
        driver_namespace,
        namespace,
        collection_name,
        record_id_order_key
      );

    CREATE INDEX tego_operations_scan_order
      ON tego_operations(driver_namespace, revision, operation_id COLLATE "C");
  `,
  `
    CREATE TABLE tego_operation_history (
      driver_namespace text NOT NULL,
      operation_id text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      state_json jsonb NOT NULL,
      updated_at timestamptz NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      PRIMARY KEY (driver_namespace, revision, operation_id)
    );

    INSERT INTO tego_operation_history(
      driver_namespace,
      operation_id,
      kind,
      status,
      state_json,
      updated_at,
      revision
    )
    SELECT
      driver_namespace,
      operation_id,
      kind,
      status,
      state_json,
      updated_at,
      revision
    FROM tego_operations;

    CREATE INDEX tego_operation_history_scan_order
      ON tego_operation_history(driver_namespace, revision, operation_id COLLATE "C");
  `,
] as const;

export const postgresSchemaVersion = migrations.length;

async function applyMigration(client: PoolClient, version: number, sql: string): Promise<void> {
  const applied = await client.query<{ applied: number }>(
    "SELECT 1 AS applied FROM tego_schema_migrations WHERE version = $1",
    [version],
  );
  if (applied.rowCount !== 0) return;
  await client.query(sql);
  await client.query("INSERT INTO tego_schema_migrations(version) VALUES ($1)", [version]);
}

export async function applyPostgresMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let connectionFailed = false;
  const onError = () => {
    connectionFailed = true;
  };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('tegojs:runtime-schema', 0))",
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS tego_schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    const latest = await client.query<{ version: number | null }>(
      "SELECT MAX(version)::integer AS version FROM tego_schema_migrations",
    );
    const version = latest.rows[0]?.version ?? 0;
    if (version > postgresSchemaVersion) {
      throw new Error(
        `PostgreSQL state schema ${version} is newer than supported version ${postgresSchemaVersion}`,
      );
    }
    for (let index = 0; index < migrations.length; index += 1) {
      await applyMigration(client, index + 1, migrations[index] ?? "");
    }
    const missingOrderKeys = await client.query<{
      driver_namespace: string;
      namespace: string;
      collection_name: string;
      record_id: string;
    }>(
      `
        SELECT driver_namespace, namespace, collection_name, record_id
        FROM tego_records
        WHERE record_id_order_key IS NULL
      `,
    );
    for (const row of missingOrderKeys.rows) {
      if (
        !isPortableStateString(row.driver_namespace) ||
        !isPortableStateString(row.namespace) ||
        !isPortableStateString(row.collection_name) ||
        !isPortableStateString(row.record_id)
      ) {
        throw new Error("PostgreSQL state contains a non-portable state key");
      }
      await client.query(
        `
          UPDATE tego_records
          SET record_id_order_key = $1
          WHERE driver_namespace = $2
            AND namespace = $3
            AND collection_name = $4
            AND record_id = $5
        `,
        [
          Buffer.from(stateStringOrderKey(row.record_id)),
          row.driver_namespace,
          row.namespace,
          row.collection_name,
          row.record_id,
        ],
      );
    }
    const orderKeyColumn = await client.query<{ is_nullable: "NO" | "YES" }>(
      `
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'tego_records'
          AND column_name = 'record_id_order_key'
      `,
    );
    if (orderKeyColumn.rows[0]?.is_nullable === "YES") {
      await client.query("ALTER TABLE tego_records ALTER COLUMN record_id_order_key SET NOT NULL");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.off("error", onError);
    client.release(connectionFailed);
  }
}
