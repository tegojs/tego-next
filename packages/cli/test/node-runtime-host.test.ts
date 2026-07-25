import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNodeRuntimeHost } from "../src/runtime/create-node-runtime-host.js";
import { runNodeMainProcess } from "../src/runtime/main-process.js";

async function assertPort(workerUrl: string, expected: "closed" | "open"): Promise<void> {
  const url = new URL(workerUrl);
  const state = await new Promise<"closed" | "open">((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve("open");
    });
    socket.once("error", () => resolve("closed"));
  });
  assert.equal(state, expected);
}

function options(dataDirectory: string) {
  return {
    applicationId: "application-default",
    dataDirectory,
    mode: "single-main" as const,
    nodeId: "node-listener",
    runtimeId: "runtime-listener",
    worker: {
      credential: "worker-secret",
      host: "127.0.0.1",
      port: 0,
      workerId: "worker-listener",
    },
  };
}

test("Node Worker listener binds only after runtime readiness and closes with its owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-node-listener-"));
  const host = await createNodeRuntimeHost(options(directory));
  try {
    await assert.rejects(
      host.startWorkerListener(),
      /runtime must be running before the Worker listener binds/iu,
    );
    await host.runtime.start();
    const workerUrl = await host.startWorkerListener();
    assert.equal(typeof workerUrl, "string");
    await assertPort(workerUrl as string, "open");
    await host.runtime.stop();
    await assertPort(workerUrl as string, "closed");
  } finally {
    await host.runtime.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node Worker listener rejects an empty credential before binding or readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-node-listener-credential-"));
  try {
    await assert.rejects(
      createNodeRuntimeHost({
        ...options(directory),
        worker: { ...options(directory).worker, credential: "" },
      }),
      /credential must not be empty/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a readiness failure after Worker bind rolls the listener back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-node-listener-rollback-"));
  const endpoint = join(directory, "control.sock");
  let workerUrl: string | undefined;
  try {
    await assert.rejects(
      runNodeMainProcess({
        ...options(directory),
        endpoint,
        onReady: (_status, readiness) => {
          workerUrl = readiness.workerUrl;
          throw new Error("readiness sink failed");
        },
      }),
      /readiness sink failed/iu,
    );
    assert.equal(typeof workerUrl, "string");
    await assertPort(workerUrl as string, "closed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
