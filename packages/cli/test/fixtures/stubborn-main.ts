import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";

const options = JSON.parse(process.env.TEGO_MAIN_PROCESS_OPTIONS ?? "{}") as {
  readonly dataDirectory?: string;
};

if (options.dataDirectory === undefined) {
  throw new Error("fixture requires dataDirectory");
}

process.on("SIGTERM", () => undefined);
await writeFile(join(options.dataDirectory, "stubborn.pid"), String(process.pid));
process.send?.({ type: "fixture.ready" });

const channel = new MessageChannel();
channel.port1.on("message", () => undefined);
