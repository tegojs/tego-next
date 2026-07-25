import { runWorkerProcess } from "@tegojs/cli";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const command = JSON.parse(process.env.TEGO_TEST_WORKER_COMMAND ?? "{}");
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await runWorkerProcess(command, {
    signal: controller.signal,
    onReady: (readiness) => emit(readiness),
  });
  emit({ type: "worker.stopped", pid: process.pid });
} catch {
  emit({ type: "worker.failed", pid: process.pid });
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
