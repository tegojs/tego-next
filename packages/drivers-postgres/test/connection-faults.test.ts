import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

const connectionString =
  process.env.TEGO_POSTGRES_URL ??
  "postgresql://tego_test:tego_test@127.0.0.1:55432/tego_next_test";

function namespace(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function nextMessage(
  child: ChildProcess,
  expectedType: "ready" | "result",
  timeoutMs = 4_000,
): Promise<Record<string, unknown>> {
  return Promise.race([
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        reject(
          new Error(`Fault fixture exited before ${expectedType}: code=${code} signal=${signal}`),
        );
      };
      const onMessage = (message: unknown) => {
        if (
          typeof message !== "object" ||
          message === null ||
          !("type" in message) ||
          message.type !== expectedType
        ) {
          return;
        }
        child.off("exit", onExit);
        child.off("message", onMessage);
        resolve(message as Record<string, unknown>);
      };
      child.on("exit", onExit);
      child.on("message", onMessage);
    }),
    delay(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for fault fixture ${expectedType}`);
    }),
  ]);
}

async function terminateBackend(
  pool: Pool,
  applicationName: string,
  state: "idle" | "idle in transaction",
): Promise<void> {
  const result = await pool.query<{ terminated: boolean }>(
    `SELECT pg_terminate_backend(pid) AS terminated
       FROM pg_stat_activity
      WHERE application_name = $1
        AND state = $2
        AND pid <> pg_backend_pid()`,
    [applicationName, state],
  );
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0]?.terminated, true);
}

async function runFaultFixture(mode: "active" | "idle"): Promise<Record<string, unknown>> {
  const fixtureNamespace = namespace(`pool_${mode}`);
  const child = fork(
    new URL("./fixtures/postgres-connection-fault-child.js", import.meta.url),
    [mode, connectionString, fixtureNamespace],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const admin = new Pool({ connectionString });
  try {
    await nextMessage(child, "ready");
    await terminateBackend(
      admin,
      `tego:${fixtureNamespace}:state`,
      mode === "idle" ? "idle" : "idle in transaction",
    );
    child.send({ type: "continue" });
    const result = await nextMessage(child, "result");
    const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(await Promise.race([exit, delay(4_000).then(() => -1)]), 0);
    return result;
  } finally {
    child.kill();
    await admin.end();
  }
}

test("terminating an idle PostgreSQL backend degrades health without crashing the process", async () => {
  const result = await runFaultFixture("idle");
  assert.equal(result.status, "degraded");
});

test("terminating an active PostgreSQL transaction settles with a backend diagnostic", async () => {
  const result = await runFaultFixture("active");
  assert.equal(result.code, "STATE_BACKEND_FAILURE");
});
