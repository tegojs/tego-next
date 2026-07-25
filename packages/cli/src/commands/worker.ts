import type { WorkerStartCommand } from "../parse-command.js";
import { runWorkerProcess, type WorkerReadiness } from "../worker/worker-process.js";

export type WorkerReadyHandler = (readiness: WorkerReadiness) => Promise<void> | void;

export async function startWorkerForeground(
  command: WorkerStartCommand,
  onReady: WorkerReadyHandler,
): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runWorkerProcess(command, {
      signal: controller.signal,
      onReady,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
