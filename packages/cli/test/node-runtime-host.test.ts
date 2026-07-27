import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseFencingEpoch, parseWorkerId } from "@tegojs/contracts";
import { connectWorker, createWorkerEndpoint } from "@tegojs/transport-websocket";
import {
  createAuthorityCapabilityAdmission,
  createNodeRuntimeHost,
  NodeWorkerListenerOwner,
} from "../src/runtime/create-node-runtime-host.js";
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

test("Node Worker listener rejects blank and oversized credentials before binding or readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-node-listener-credential-"));
  try {
    for (const credential of ["", "   ", "x".repeat(4_097)]) {
      await assert.rejects(
        createNodeRuntimeHost({
          ...options(directory),
          worker: { ...options(directory).worker, credential },
        }),
        /credential/iu,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("single-main rejects PostgreSQL shared storage composition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-node-single-main-postgres-"));
  try {
    await assert.rejects(
      createNodeRuntimeHost({
        ...options(directory),
        postgresUrl: "postgresql://unused.invalid/tego",
      }),
      /single-main.*PostgreSQL|PostgreSQL.*single-main/iu,
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

test("Worker listener shutdown reports a failed close during a bind race", async () => {
  const binding = Promise.withResolvers<{
    readonly url: URL;
    close(): Promise<void>;
  }>();
  const owner = new NodeWorkerListenerOwner(() => binding.promise);
  const starting = owner.start();
  const closing = owner.close();
  binding.resolve({
    url: new URL("ws://127.0.0.1:12345/"),
    close: async () => {
      throw new Error("listener close failed");
    },
  });

  const [startResult, closeResult] = await Promise.allSettled([starting, closing]);
  assert.equal(startResult.status, "rejected");
  assert.equal(closeResult.status, "rejected");
  assert.equal(closeResult.reason instanceof AggregateError, true);
  assert.match(String(closeResult.reason), /listener rollback failed/iu);
  assert.match(String(closeResult.reason.errors[0]), /listener close failed/iu);
});

test("Worker listener shutdown completes after a successful close during a bind race", async () => {
  const binding = Promise.withResolvers<{
    readonly url: URL;
    close(): Promise<void>;
  }>();
  const owner = new NodeWorkerListenerOwner(() => binding.promise);
  const starting = owner.start();
  const closing = owner.close();
  binding.resolve({
    url: new URL("ws://127.0.0.1:12345/"),
    close: async () => undefined,
  });

  const [startResult, closeResult] = await Promise.allSettled([starting, closing]);
  assert.equal(startResult.status, "rejected");
  assert.equal(closeResult.status, "fulfilled");
});

test("Worker listener shutdown does not reclassify a bind failure as cleanup failure", async () => {
  const binding = Promise.withResolvers<{
    readonly url: URL;
    close(): Promise<void>;
  }>();
  const owner = new NodeWorkerListenerOwner(() => binding.promise);
  const starting = owner.start();
  binding.reject(new Error("listener bind failed"));

  await assert.rejects(starting, /listener bind failed/iu);
  await owner.close();
});

test("capability authority admission rejects post-loss calls while admitted calls finish", async () => {
  const admission = createAuthorityCapabilityAdmission();
  const authority = {
    epoch: parseFencingEpoch("3"),
    resource: "runtime:runtime-listener",
  };
  const inFlight = Promise.withResolvers<string>();

  admission.open(authority);
  const admitted = admission.invoke(() => inFlight.promise);
  admission.close(authority);

  await assert.rejects(
    admission.invoke(async () => "not admitted"),
    /capability invocation authority is unavailable/iu,
  );
  inFlight.resolve("completed");
  assert.equal(await admitted, "completed");
});

test("capability authority token fences an admitted call that has not entered provider code", async () => {
  const admission = createAuthorityCapabilityAdmission();
  const authority = {
    epoch: parseFencingEpoch("3"),
    resource: "runtime:runtime-listener",
  };
  const beforeDispatch = Promise.withResolvers<void>();
  const releaseDispatch = Promise.withResolvers<void>();
  let providerEntered = false;

  admission.open(authority);
  const invoking = admission.invoke(async (token) => {
    beforeDispatch.resolve();
    await releaseDispatch.promise;
    token.assertActive();
    providerEntered = true;
    return "unreachable";
  });
  await beforeDispatch.promise;
  admission.close(authority);
  releaseDispatch.resolve();

  await assert.rejects(invoking, /capability invocation authority is unavailable/iu);
  assert.equal(providerEntered, false);
});

test("stale capability authority close cannot fence a newer leadership epoch", async () => {
  const admission = createAuthorityCapabilityAdmission();
  const first = {
    epoch: parseFencingEpoch("3"),
    resource: "runtime:runtime-listener",
  };
  const second = {
    epoch: parseFencingEpoch("4"),
    resource: "runtime:runtime-listener",
  };

  admission.open(first);
  admission.open(second);
  admission.close(first);

  assert.equal(await admission.invoke(async () => "new leader"), "new leader");
  admission.close(second);
  await assert.rejects(
    admission.invoke(async () => "not admitted"),
    /capability invocation authority is unavailable/iu,
  );
});

test("a newer capability authority epoch revokes the previous pre-dispatch token", async () => {
  const admission = createAuthorityCapabilityAdmission();
  const first = {
    epoch: parseFencingEpoch("3"),
    resource: "runtime:runtime-listener",
  };
  const second = {
    epoch: parseFencingEpoch("4"),
    resource: "runtime:runtime-listener",
  };
  const firstAdmitted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();

  admission.open(first);
  const oldInvocation = admission.invoke(async (token) => {
    firstAdmitted.resolve();
    await releaseFirst.promise;
    token.assertActive();
    return "old leader";
  });
  await firstAdmitted.promise;
  admission.open(second);
  releaseFirst.resolve();

  await assert.rejects(oldInvocation, /capability invocation authority is unavailable/iu);
  assert.equal(await admission.invoke(async () => "new leader"), "new leader");
});

test("SQLite-backed Worker epochs advance across Main restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-node-listener-epoch-"));
  const worker = createWorkerEndpoint({
    credential: "worker-secret",
    workerId: parseWorkerId("worker-listener"),
    handshakeTimeoutMs: 1_000,
  });
  let first: Awaited<ReturnType<typeof createNodeRuntimeHost>> | undefined =
    await createNodeRuntimeHost(options(directory));
  let second: Awaited<ReturnType<typeof createNodeRuntimeHost>> | undefined;
  try {
    await first.runtime.start();
    const firstUrl = await first.startWorkerListener();
    const firstSession = await connectWorker({
      endpoint: worker,
      url: new URL(firstUrl as string),
      signal: AbortSignal.timeout(1_000),
    });
    await firstSession.ready;
    const firstEpoch = BigInt(firstSession.epoch);

    await first.runtime.stop();
    first = undefined;

    second = await createNodeRuntimeHost(options(directory));
    await second.runtime.start();
    const secondUrl = await second.startWorkerListener();
    const secondSession = await connectWorker({
      endpoint: worker,
      url: new URL(secondUrl as string),
      signal: AbortSignal.timeout(1_000),
    });
    await secondSession.ready;
    assert.equal(BigInt(secondSession.epoch) > firstEpoch, true);
    await secondSession.close();
  } finally {
    await second?.runtime.stop().catch(() => undefined);
    await first?.runtime.stop().catch(() => undefined);
    await worker.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
