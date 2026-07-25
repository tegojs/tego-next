import type { DatabaseSync } from "node:sqlite";
import { isPortableStateString, stateStringOrderKey } from "@tegojs/contracts";

const migrations = [
  `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE revisions (
      revision INTEGER PRIMARY KEY AUTOINCREMENT
    ) STRICT;

    CREATE TABLE records (
      namespace TEXT NOT NULL,
      collection_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      revision INTEGER NOT NULL REFERENCES revisions(revision),
      PRIMARY KEY (namespace, collection_name, record_id)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      revision INTEGER NOT NULL REFERENCES revisions(revision),
      namespace TEXT NOT NULL,
      collection_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('delete', 'put')),
      value_json TEXT
    ) STRICT;

    CREATE INDEX changes_revision_sequence
      ON changes(revision, sequence);

    CREATE TABLE operations (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL REFERENCES revisions(revision)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE outbox (
      message_id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revision INTEGER NOT NULL REFERENCES revisions(revision)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE idempotency (
      idempotency_key TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE fences (
      resource TEXT PRIMARY KEY,
      epoch TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
  `,
  `
    ALTER TABLE outbox RENAME TO outbox_v1;

    CREATE TABLE outbox (
      message_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      claim_owner TEXT,
      claim_epoch TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      acknowledgement_outcome TEXT CHECK (
        acknowledgement_outcome IS NULL OR acknowledgement_outcome IN ('completed', 'retry')
      ),
      acknowledgement_owner TEXT,
      acknowledgement_claim_epoch TEXT,
      acknowledgement_retry_at TEXT,
      acknowledged_at TEXT,
      revision INTEGER NOT NULL REFERENCES revisions(revision)
    ) STRICT, WITHOUT ROWID;

    INSERT INTO outbox(
      message_id,
      operation_id,
      topic,
      payload_json,
      created_at,
      available_at,
      revision
    )
    SELECT
      message_id,
      message_id,
      topic,
      payload_json,
      created_at,
      created_at,
      revision
    FROM outbox_v1;

    DROP TABLE outbox_v1;

    CREATE INDEX outbox_delivery
      ON outbox(available_at, message_id);
  `,
  `
    ALTER TABLE outbox
      ADD COLUMN enqueue_sequence INTEGER NOT NULL DEFAULT 0;

    WITH ranked AS (
      SELECT
        message_id,
        ROW_NUMBER() OVER (ORDER BY revision, message_id) AS enqueue_sequence
      FROM outbox
    )
    UPDATE outbox
    SET enqueue_sequence = (
      SELECT ranked.enqueue_sequence
      FROM ranked
      WHERE ranked.message_id = outbox.message_id
    );

    DROP INDEX outbox_delivery;

    CREATE UNIQUE INDEX outbox_enqueue_sequence
      ON outbox(enqueue_sequence);

    CREATE INDEX outbox_delivery
      ON outbox(available_at, enqueue_sequence, message_id);
  `,
  `
    ALTER TABLE records
      ADD COLUMN record_id_order_key BLOB;

    CREATE INDEX records_scan_order
      ON records(namespace, collection_name, record_id_order_key);

    CREATE TRIGGER records_order_key_insert
    BEFORE INSERT ON records
    WHEN NEW.record_id_order_key IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'record_id_order_key is required');
    END;

    CREATE TRIGGER records_order_key_update
    BEFORE UPDATE OF record_id_order_key ON records
    WHEN NEW.record_id_order_key IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'record_id_order_key is required');
    END;
  `,
] as const;

export const sqliteSchemaVersion = migrations.length;

export function applySqliteMigrations(database: DatabaseSync, now: Date): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 0");

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT
    `);

    const latest = database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get()?.version;
    if (typeof latest === "number" && latest > sqliteSchemaVersion) {
      throw new Error(
        `SQLite state schema ${String(latest)} is newer than supported version ${String(sqliteSchemaVersion)}`,
      );
    }

    const applied = database.prepare(
      "SELECT 1 AS applied FROM schema_migrations WHERE version = ?",
    );
    const record = database.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
    );
    for (let index = 0; index < migrations.length; index += 1) {
      const version = index + 1;
      if (applied.get(version) !== undefined) {
        continue;
      }
      database.exec(migrations[index] ?? "");
      record.run(version, now.toISOString());
    }

    const missingOrderKeys = database
      .prepare(
        `
          SELECT namespace, collection_name, record_id
          FROM records
          WHERE record_id_order_key IS NULL
        `,
      )
      .all();
    const updateOrderKey = database.prepare(
      `
        UPDATE records
        SET record_id_order_key = ?
        WHERE namespace = ? AND collection_name = ? AND record_id = ?
      `,
    );
    for (const row of missingOrderKeys) {
      const namespace = row.namespace;
      const collection = row.collection_name;
      const id = row.record_id;
      if (
        typeof namespace !== "string" ||
        typeof collection !== "string" ||
        typeof id !== "string" ||
        !isPortableStateString(namespace) ||
        !isPortableStateString(collection) ||
        !isPortableStateString(id)
      ) {
        throw new Error("SQLite state contains a non-portable state key");
      }
      updateOrderKey.run(Buffer.from(stateStringOrderKey(id)), namespace, collection, id);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
