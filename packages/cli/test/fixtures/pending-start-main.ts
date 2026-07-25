import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import type { Runtime, RuntimeStatus } from "@tegojs/contracts";
import { runMainProcess } from "../../src/runtime/main-process.js";

const options = JSON.parse(process.env.TEGO_PENDING_START_OPTIONS ?? "{}") as {
  readonly directory?: string;
  readonly endpoint?: string;
};

if (options.directory === undefined || options.endpoint === undefined) {
  throw new Error("fixture requires directory and endpoint");
}

const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
const channel = new MessageChannel();
channel.port1.on("message", () => undefined);

const runtime: Runtime = {
  start: async () => {
    await writeFile(join(options.directory as string, "startup.entered"), "");
    await new Promise<void>(() => undefined);
  },
  status: async () => ({ lifecycle: "running" }) as RuntimeStatus,
  stop: async () => {
    await writeFile(join(options.directory as string, "runtime.stopped"), "");
    channel.port1.close();
    channel.port2.close();
  },
  operations: {} as Runtime["operations"],
  events: {
    async *[Symbol.asyncIterator]() {},
  },
};

try {
  await runMainProcess({
    endpoint: options.endpoint,
    runtime,
    onBackgroundError: () => {
      process.exitCode = 1;
    },
    signal: controller.signal,
  });
} finally {
  process.off("SIGINT", abort);
  process.off("SIGTERM", abort);
}
