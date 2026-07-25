import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkerId } from "@tegojs/contracts";
import {
  connectWorker,
  createMainEndpoint,
  createWorkerEndpoint,
  listenForMain,
  MemoryWorkerEpochAllocator,
} from "../src/index.js";

test("@spec:worker-protocol/real-process-transport-acceptance/loopback-session", async () => {
  const workerId = parseWorkerId("worker-network-loopback");
  const main = createMainEndpoint({
    credential: "loopback-secret",
    workerId,
    epochAllocator: new MemoryWorkerEpochAllocator(),
  });
  const worker = createWorkerEndpoint({
    credential: "loopback-secret",
    workerId,
  });

  const listener = await listenForMain({
    endpoint: main,
    host: "127.0.0.1",
    port: 0,
  });
  const session = await connectWorker({ endpoint: worker, url: listener.url });

  try {
    await session.ready;
    assert.equal(main.current(workerId)?.available, true);
  } finally {
    await Promise.all([session.close(), listener.close(), main.close(), worker.close()]);
  }
});
