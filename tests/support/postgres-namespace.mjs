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

function timeoutError(stage, timeoutMs) {
  return new Error(`POSTGRES_NAMESPACE_CLEANUP_TIMEOUT:${stage}:${timeoutMs}ms`);
}

async function settleBeforeDeadline(operation, stage, deadline, timeoutMs) {
  const remaining = Math.max(0, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError(stage, timeoutMs)), remaining);
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

function releaseClient(client, errors) {
  try {
    const released = client.release(true);
    if (released?.then !== undefined) {
      return Promise.resolve(released).catch((error) => errors.push(error));
    }
  } catch (error) {
    errors.push(error);
  }
  return Promise.resolve();
}

function beginAcquisition(pool) {
  const acquisition = Promise.resolve().then(() => pool.connect());
  acquisition.catch(() => undefined);
  return acquisition;
}

function throwCollectedErrors(errors) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "PostgreSQL namespace cleanup failed");
  }
}

export async function cleanupPostgresNamespace({
  connectionString,
  namespace,
  timeoutMs = 5_000,
  cleanupGraceMs = 100,
  createPool = (options) => new Pool(options),
}) {
  assertDisposablePostgresNamespace(namespace);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`INVALID_POSTGRES_NAMESPACE_CLEANUP_TIMEOUT:${String(timeoutMs)}`);
  }
  const deadline = Date.now() + timeoutMs;
  const cleanupDeadline = deadline + cleanupGraceMs;
  const pool = createPool({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    max: 1,
    query_timeout: timeoutMs,
  });
  let client;
  let transactionStarted = false;
  let destroyClient = false;
  const errors = [];
  const acquisition = beginAcquisition(pool);
  let acquisitionTimedOut = false;
  try {
    try {
      client = await settleBeforeDeadline(() => acquisition, "connect", deadline, timeoutMs);
    } catch (error) {
      acquisitionTimedOut = true;
      throw error;
    }
    await settleBeforeDeadline(() => client.query("BEGIN"), "BEGIN", deadline, timeoutMs);
    transactionStarted = true;
    await settleBeforeDeadline(
      () => client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`),
      "statement_timeout",
      deadline,
      timeoutMs,
    );
    await settleBeforeDeadline(
      () => client.query(`SET LOCAL lock_timeout = '${timeoutMs}ms'`),
      "lock_timeout",
      deadline,
      timeoutMs,
    );
    for (const table of cleanupTables) {
      await settleBeforeDeadline(
        () => client.query(`DELETE FROM ${table} WHERE driver_namespace = $1`, [namespace]),
        `DELETE:${table}`,
        deadline,
        timeoutMs,
      );
    }
    await settleBeforeDeadline(() => client.query("COMMIT"), "COMMIT", deadline, timeoutMs);
    transactionStarted = false;
  } catch (error) {
    errors.push(error);
    destroyClient = error?.message?.startsWith("POSTGRES_NAMESPACE_CLEANUP_TIMEOUT:") === true;
    if (transactionStarted) {
      try {
        await settleBeforeDeadline(() => client.query("ROLLBACK"), "ROLLBACK", deadline, timeoutMs);
      } catch (rollbackError) {
        errors.push(rollbackError);
        destroyClient = true;
      }
    }
  } finally {
    if (client !== undefined) {
      try {
        client.release(destroyClient);
      } catch (releaseError) {
        errors.push(releaseError);
      }
    }
    const poolEnd = Promise.resolve().then(() => pool.end());
    poolEnd.catch(() => undefined);
    if (acquisitionTimedOut) {
      try {
        const lateClient = await settleBeforeDeadline(
          () => acquisition,
          "late-connect",
          cleanupDeadline,
          timeoutMs,
        );
        await releaseClient(lateClient, errors);
      } catch (lateError) {
        if (!lateError.message.startsWith("POSTGRES_NAMESPACE_CLEANUP_TIMEOUT:late-connect")) {
          errors.push(lateError);
        }
      }
    }
    try {
      await settleBeforeDeadline(() => poolEnd, "pool.end", cleanupDeadline, timeoutMs);
    } catch (endError) {
      errors.push(endError);
    }
  }
  throwCollectedErrors(errors);
}
