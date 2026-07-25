import { runNodeMainProcess } from "@tegojs/cli";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const options = JSON.parse(process.env.TEGO_TEST_MAIN_OPTIONS ?? "{}");
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await runNodeMainProcess({
    ...options,
    signal: controller.signal,
    onReady: (status, readiness) => {
      emit({
        type: "main.ready",
        pid: process.pid,
        status,
        workerUrl: readiness?.workerUrl,
      });
    },
    onBackgroundError: () => {
      emit({ type: "main.background-error", pid: process.pid });
      process.exitCode = 1;
    },
  });
  emit({ type: "main.stopped", pid: process.pid });
} catch {
  emit({ type: "main.failed", pid: process.pid });
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
