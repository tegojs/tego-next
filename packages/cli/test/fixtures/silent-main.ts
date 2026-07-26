import { MessageChannel } from "node:worker_threads";

const channel = new MessageChannel();
channel.port1.on("message", () => undefined);
