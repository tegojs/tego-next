import { setTimeout as delay } from "node:timers/promises";
import { diagnosticCode } from "@tegojs/contracts";
import { PostgresStateStore } from "../../src/postgres-state-store.js";

const mode = process.argv[2];
const connectionString = process.argv[3];
const namespace = process.argv[4];
if (
  (mode !== "active" && mode !== "idle") ||
  connectionString === undefined ||
  namespace === undefined
) {
  throw new Error("Expected fault mode, PostgreSQL URL, and namespace");
}
if (process.send === undefined) throw new Error("Fault fixture requires an IPC channel");

function send(message: unknown): void {
  process.send?.(message);
}

function waitForContinue(): Promise<void> {
  return new Promise((resolve) => {
    process.once("message", () => resolve());
  });
}

const store = new PostgresStateStore({ connectionString, namespace });
await store.open();
try {
  if (mode === "idle") {
    send({ type: "ready" });
    await waitForContinue();
    await delay(100);
    const health = await store.health();
    send({ type: "result", status: health.status });
  } else {
    const result = await store
      .transact({}, async (transaction) => {
        send({ type: "ready" });
        await waitForContinue();
        await delay(100);
        await transaction.get({ namespace: "fault", collection: "records", id: "active" });
        return null;
      })
      .then(
        () => ({ type: "result", code: "fulfilled" }),
        (error: unknown) => ({ type: "result", code: diagnosticCode(error) ?? "unknown" }),
      );
    send(result);
  }
} finally {
  await store.close();
}
