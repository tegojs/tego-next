import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ArtifactDigest,
  type InstallPluginRequest,
  type JsonValue,
  parsePluginInstallation,
  parseRuntimeStatus,
  type RuntimeOperations,
} from "@tegojs/contracts";
import { requestControl } from "../src/control/client.js";
import { type ControlResponse, MAX_CONTROL_LINE_BYTES } from "../src/control/protocol.js";
import { type ControlRuntimeOperations, startControlServer } from "../src/control/server.js";

function runtimeStatus() {
  return parseRuntimeStatus({
    identity: {
      runtimeId: "runtime-control-test",
      applicationId: "application-control-test",
      nodeId: "node-control-test",
    },
    mode: "single-main" as const,
    lifecycle: "running" as const,
    liveness: true,
    readiness: true,
    acceptingOperations: true,
    drivers: [],
    counts: {
      deployments: 0,
      installations: 0,
      recoverableOperations: 0,
      tasks: 0,
      workers: 0,
    },
  });
}

function fakeRuntimeOperations(): RuntimeOperations {
  return {
    installPlugin: async (request) =>
      parsePluginInstallation({
        pluginId: "plugin-control-test",
        version: "1.0.0",
        digest: request.digest,
        installedAt: "2026-07-25T00:00:00.000Z",
        manifest: {
          schemaVersion: "1.0",
          pluginId: "plugin-control-test",
          version: "1.0.0",
          contractRange: "^1.0.0",
          nodeRange: ">=26.0.0",
          moduleFormat: "esm",
          components: [
            {
              componentId: "component-control-test",
              kind: "task",
              entrypoint: "dist/component.js",
              executors: ["thread"],
            },
          ],
          capabilities: { provides: [], requires: [] },
          permissions: [],
        },
      }),
    deployPlugin: () => Promise.reject(new Error("not used")),
    pluginStatus: () => Promise.reject(new Error("not used")),
    runTask: () => Promise.reject(new Error("not used")),
    taskStatus: () => Promise.reject(new Error("not used")),
    waitTask: () => Promise.reject(new Error("not used")),
    cancelTask: () => Promise.reject(new Error("not used")),
    recoveredOperations: async () => [],
  };
}

function fakeOperations(): ControlRuntimeOperations {
  return {
    status: async () => runtimeStatus(),
    stop: async () => undefined,
    operations: fakeRuntimeOperations(),
  };
}

async function withEndpoint<T>(
  action: (endpoint: string, directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "tego-control-test-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\tego-control-${process.pid}-${Date.now()}`
      : join(directory, "control.sock");
  try {
    return await action(endpoint, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function sendRaw(endpoint: string, data: string): Promise<ControlResponse> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(data));
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        resolve(JSON.parse(response.trim()) as ControlResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("@spec:runtime-operations/local-runtime-operations/inspect-empty-runtime", async () => {
  await withEndpoint(async (endpoint) => {
    const server = await startControlServer({ endpoint, operations: fakeOperations() });
    try {
      const response = await requestControl({
        endpoint,
        operation: "runtime.status",
        input: {},
        timeoutMs: 1_000,
      });
      assert.equal(response.ok, true);
      assert.equal(
        (response.result as { readonly lifecycle?: JsonValue } | undefined)?.lifecycle,
        "running",
      );
      assert.equal(response.protocolVersion, "1.0");
      assert.notEqual(response.requestId, "");
    } finally {
      await server.close();
    }
  });
});

test("@spec:runtime-operations/local-runtime-operations/reject-invalid-control-frames", async () => {
  await withEndpoint(async (endpoint) => {
    const server = await startControlServer({ endpoint, operations: fakeOperations() });
    try {
      const malformed = await sendRaw(endpoint, "{not-json}\n");
      assert.equal(malformed.ok, false);
      assert.match(malformed.diagnostic?.code ?? "", /^PROTOCOL_/u);

      const oversized = await sendRaw(endpoint, `${"x".repeat(MAX_CONTROL_LINE_BYTES + 1)}\n`);
      assert.equal(oversized.ok, false);
      assert.equal(oversized.diagnostic?.code, "PROTOCOL_CONTROL_FRAME_TOO_LARGE");
    } finally {
      await server.close();
    }
  });
});

test("@spec:runtime-operations/local-runtime-operations/bounded-control-timeout", async () => {
  await withEndpoint(async (endpoint) => {
    const pending = Promise.withResolvers<ReturnType<typeof runtimeStatus>>();
    const operations = fakeOperations();
    const server = await startControlServer({
      endpoint,
      operations: { ...operations, status: () => pending.promise },
    });
    try {
      await assert.rejects(
        requestControl({
          endpoint,
          operation: "runtime.status",
          input: {},
          timeoutMs: 25,
        }),
        /PROTOCOL_CONTROL_TIMEOUT/u,
      );
    } finally {
      pending.resolve(runtimeStatus());
      await server.close();
    }
  });
});

test("@spec:runtime-operations/local-runtime-operations/path-ingress-stays-outside-kernel", async () => {
  await withEndpoint(async (endpoint, directory) => {
    const artifactPath = join(directory, "plugin.tego");
    const expectedDigest = `sha256:${"a".repeat(64)}` as ArtifactDigest;
    const ingested: string[] = [];
    const installed: ArtifactDigest[] = [];
    const operations = fakeOperations();
    const server = await startControlServer({
      endpoint,
      artifactIngress: {
        putPath: async (path: string) => {
          ingested.push(path);
          return expectedDigest;
        },
      },
      operations: {
        ...operations,
        operations: {
          ...operations.operations,
          installPlugin: async (request: InstallPluginRequest) => {
            installed.push(request.digest);
            return await fakeRuntimeOperations().installPlugin(request);
          },
        },
      },
    });
    try {
      const response = await requestControl({
        endpoint,
        operation: "plugin.install-path",
        input: { artifactPath },
        timeoutMs: 1_000,
      });
      assert.equal(response.ok, true);
      assert.deepEqual(ingested, [artifactPath]);
      assert.deepEqual(installed, [expectedDigest]);
    } finally {
      await server.close();
    }
  });
});

test("@spec:runtime-operations/local-runtime-operations/control-cleanup", async () => {
  await withEndpoint(async (endpoint) => {
    const server = await startControlServer({ endpoint, operations: fakeOperations() });
    const idleClient = createConnection(endpoint);
    await new Promise<void>((resolve, reject) => {
      idleClient.once("connect", resolve);
      idleClient.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => idleClient.once("close", () => resolve()));

    await server.close();
    await closed;
    if (process.platform !== "win32") {
      await assert.rejects(readFile(endpoint), (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
        return true;
      });
    }
  });
});
