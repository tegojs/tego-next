import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ArtifactDigest,
  DiagnosticError,
  type InstallPluginRequest,
  type JsonValue,
  parsePluginInstallation,
  parseRuntimeStatus,
  type RuntimeOperations,
  runtimeDiagnostic,
} from "@tegojs/contracts";
import { requestControl } from "../src/control/client.js";
import { type ControlResponse, MAX_CONTROL_LINE_BYTES } from "../src/control/protocol.js";
import { type ControlRuntimeOperations, startControlServer } from "../src/control/server.js";
import { defaultControlEndpoint } from "../src/parse-command.js";

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

async function connect(endpoint: string): Promise<Socket> {
  const socket = createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function settlesBeforeDeadline(
  promise: PromiseLike<unknown>,
  timeoutMs = 100,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(socket: Socket, timeoutMs = 1_000): Promise<ControlResponse> {
  return await new Promise((resolve, reject) => {
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TEST_RESPONSE_TIMEOUT"));
    }, timeoutMs);
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(response.trim()) as ControlResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function sendFragmented(endpoint: string, data: string): Promise<ControlResponse> {
  const socket = await connect(endpoint);
  const response = readResponse(socket);
  socket.setNoDelay(true);
  for (const byte of Buffer.from(data)) {
    await new Promise<void>((resolve, reject) => {
      socket.write(Buffer.from([byte]), (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return await response;
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

test("@spec:runtime-operations/local-runtime-operations/incomplete-frames-reserve-bounded-capacity", async () => {
  await withEndpoint(async (endpoint) => {
    const server = await startControlServer({
      endpoint,
      operations: fakeOperations(),
      maxOutstandingRequests: 1,
      readTimeoutMs: 50,
    } as Parameters<typeof startControlServer>[0] & { readonly readTimeoutMs: number });
    const incomplete = await connect(endpoint);
    try {
      const rejected = await sendRaw(
        endpoint,
        `${JSON.stringify({
          protocolVersion: "1.0",
          requestId: "capacity-request",
          operation: "runtime.status",
          input: {},
        })}\n`,
      );
      assert.equal(rejected.ok, false);
      assert.equal(rejected.diagnostic?.code, "PROTOCOL_CONTROL_CAPACITY_EXCEEDED");

      const timedOut = await readResponse(incomplete);
      assert.equal(timedOut.ok, false);
      assert.equal(timedOut.diagnostic?.code, "PROTOCOL_CONTROL_READ_TIMEOUT");
    } finally {
      incomplete.destroy();
      await server.close();
    }
  });
});

test("@spec:runtime-operations/local-runtime-operations/disconnected-dispatch-retains-capacity", async () => {
  await withEndpoint(async (endpoint) => {
    const operation = Promise.withResolvers<ReturnType<typeof runtimeStatus>>();
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    let calls = 0;
    const operations = fakeOperations();
    const server = await startControlServer({
      endpoint,
      operations: {
        ...operations,
        status: () => {
          calls += 1;
          if (calls === 1) firstStarted.resolve();
          if (calls === 2) secondStarted.resolve();
          return operation.promise;
        },
      },
      maxOutstandingRequests: 1,
    });
    const frame = `${JSON.stringify({
      protocolVersion: "1.0",
      requestId: "pending-dispatch",
      operation: "runtime.status",
      input: {},
    })}\n`;
    const first = await connect(endpoint);
    try {
      first.end(frame);
      await firstStarted.promise;
      if (!first.destroyed) {
        const closed = new Promise<void>((resolve) => first.once("close", resolve));
        first.destroy();
        await closed;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));

      const second = await connect(endpoint);
      const secondResponse = readResponse(second);
      second.end(frame);
      const outcome = await Promise.race([
        secondResponse.then((response) => ({ response })),
        secondStarted.promise.then(() => ({ dispatched: true as const })),
      ]);
      operation.resolve(runtimeStatus());
      if ("dispatched" in outcome) await secondResponse;
      assert.ok("response" in outcome, "a disconnected pending dispatch released capacity");
      assert.equal(outcome.response.diagnostic?.code, "PROTOCOL_CONTROL_CAPACITY_EXCEEDED");

      await new Promise<void>((resolve) => setImmediate(resolve));
      const holding = await connect(endpoint);
      try {
        const rejected = await sendRaw(endpoint, frame);
        assert.equal(rejected.diagnostic?.code, "PROTOCOL_CONTROL_CAPACITY_EXCEEDED");
      } finally {
        const closed = new Promise<void>((resolve) => holding.once("close", resolve));
        holding.destroy();
        await closed;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const accepted = await sendRaw(endpoint, frame);
      assert.equal(accepted.ok, true);
      assert.equal(calls, 2);
    } finally {
      operation.resolve(runtimeStatus());
      first.destroy();
      await server.close();
    }
  });
});

test("@spec:runtime-operations/local-runtime-operations/fragmented-frames-copy-linearly", async () => {
  await withEndpoint(async (endpoint) => {
    const server = await startControlServer({ endpoint, operations: fakeOperations() });
    const bufferConstructor = Buffer as typeof Buffer & { concat: typeof Buffer.concat };
    const originalConcat = bufferConstructor.concat;
    let copiedBytes = 0;
    bufferConstructor.concat = ((chunks: readonly Uint8Array[], totalLength?: number) => {
      copiedBytes += chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      return originalConcat(chunks, totalLength);
    }) as typeof Buffer.concat;
    const frame = `${JSON.stringify({
      protocolVersion: "1.0",
      requestId: "fragmented-request",
      operation: "runtime.status",
      input: { padding: "x".repeat(256) },
    })}\n`;
    try {
      const response = await sendFragmented(endpoint, frame);
      assert.equal(response.ok, true);
      assert.ok(copiedBytes <= Buffer.byteLength(frame) * 2, `copied ${String(copiedBytes)} bytes`);
    } finally {
      bufferConstructor.concat = originalConcat;
      await server.close();
    }
  });
});

test("@spec:runtime-operations/local-runtime-operations/protocol-errors-preserve-request-id", async () => {
  await withEndpoint(async (endpoint) => {
    const server = await startControlServer({ endpoint, operations: fakeOperations() });
    try {
      const response = await sendRaw(
        endpoint,
        `${JSON.stringify({
          protocolVersion: "1.0",
          requestId: "unsupported-request",
          operation: "runtime.unsupported",
          input: {},
        })}\n`,
      );
      assert.equal(response.ok, false);
      assert.equal(response.requestId, "unsupported-request");
      assert.equal(response.diagnostic?.code, "PROTOCOL_OPERATION_INVALID");
    } finally {
      await server.close();
    }
  });
});

test("@spec:runtime-operations/local-runtime-operations/control-diagnostics-are-redacted", async () => {
  await withEndpoint(async (endpoint) => {
    const operations = fakeOperations();
    const server = await startControlServer({
      endpoint,
      operations: {
        ...operations,
        status: () =>
          Promise.reject(
            new DiagnosticError(
              runtimeDiagnostic({
                code: "STATE_READ_FAILED",
                message:
                  "password=hunter2 postgresql://user:secret@localhost/db /Users/alice/private",
                source: { kind: "state", id: "/Users/alice/private/state.sqlite" },
                details: {
                  password: "hunter2",
                  url: "postgresql://user:secret@localhost/db?token=raw",
                },
                cause: {
                  name: "Error",
                  message: "token=raw",
                  stack: "Error: token=raw\n at /Users/alice/private/file.js:1:1",
                },
              }),
            ),
          ),
      },
    });
    try {
      const response = await requestControl({
        endpoint,
        operation: "runtime.status",
        input: {},
        timeoutMs: 1_000,
      });
      const serialized = JSON.stringify(response);
      assert.equal(response.requestId.length > 0, true);
      assert.equal(response.diagnostic?.code, "STATE_READ_FAILED");
      assert.doesNotMatch(serialized, /hunter2|secret|token=raw|\/Users\/alice|stack/u);
    } finally {
      await server.close();
    }
  });
});

test("@spec:runtime-operations/local-runtime-operations/rejects-public-unix-parent", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix directory permissions do not apply to named pipes");
    return;
  }
  await withEndpoint(async (endpoint, directory) => {
    await chmod(directory, 0o755);
    let unexpected: Awaited<ReturnType<typeof startControlServer>> | undefined;
    try {
      await assert.rejects(async () => {
        unexpected = await startControlServer({ endpoint, operations: fakeOperations() });
      }, /PROTOCOL_CONTROL_PARENT_NOT_PRIVATE/u);
    } finally {
      await unexpected?.close();
    }
  });
});

test("@spec:runtime-operations/local-runtime-operations/permission-init-rolls-back-listener", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket permission initialization does not apply to named pipes");
    return;
  }
  await withEndpoint(async (endpoint) => {
    type PermissionOptions = Parameters<typeof startControlServer>[0] & {
      readonly setEndpointPermissions: (path: string) => Promise<void>;
    };
    const startWithPermissions = startControlServer as (
      options: PermissionOptions,
    ) => ReturnType<typeof startControlServer>;
    let unexpected: Awaited<ReturnType<typeof startControlServer>> | undefined;
    try {
      await assert.rejects(async () => {
        unexpected = await startWithPermissions({
          endpoint,
          operations: fakeOperations(),
          setEndpointPermissions: () => Promise.reject(new Error("permission init failed")),
        });
      }, /permission init failed/u);
    } finally {
      await unexpected?.close();
    }
    await assert.rejects(connect(endpoint));
  });
});

test("@spec:runtime-operations/local-runtime-operations/aborted-control-initialization-rolls-back", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket initialization rollback is exercised on Unix");
    return;
  }
  await withEndpoint(async (endpoint) => {
    type AbortableControlOptions = Parameters<typeof startControlServer>[0] & {
      readonly signal: AbortSignal;
    };
    const startAbortable = startControlServer as (
      options: AbortableControlOptions,
    ) => ReturnType<typeof startControlServer>;

    const preAborted = new AbortController();
    preAborted.abort();
    const preAbortedOutcome = await startAbortable({
      endpoint,
      operations: fakeOperations(),
      signal: preAborted.signal,
    }).then(
      (server) => ({ ok: true as const, server }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    if (preAbortedOutcome.ok) await preAbortedOutcome.server.close();
    await assert.rejects(access(endpoint));

    const permissionEntered = Promise.withResolvers<void>();
    const permissionCompletion = Promise.withResolvers<void>();
    const controller = new AbortController();
    const outcome = startAbortable({
      endpoint,
      operations: fakeOperations(),
      signal: controller.signal,
      setEndpointPermissions: () => {
        permissionEntered.resolve();
        return permissionCompletion.promise;
      },
    }).then(
      (server) => ({ ok: true as const, server }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    await permissionEntered.promise;
    controller.abort();
    const settledBeforePermission = await settlesBeforeDeadline(outcome);
    permissionCompletion.resolve();
    const result = await outcome;
    if (result.ok) await result.server.close();

    assert.equal(preAbortedOutcome.ok, false);
    assert.equal(settledBeforePermission, true);
    assert.equal(result.ok, false);
    await assert.rejects(access(endpoint));
  });
});

test("@spec:runtime-operations/local-runtime-operations/windows-pipe-access-cleanup-contract", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows named-pipe contract runs on Windows");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "tego-windows-control-"));
  const endpoint = defaultControlEndpoint(directory, {
    platform: "win32",
    runtimeScope: "main",
    userScope: process.env.USERNAME ?? "current-user",
  });
  const server = await startControlServer({ endpoint, operations: fakeOperations() });
  try {
    const response = await requestControl({
      endpoint,
      operation: "runtime.status",
      input: {},
      timeoutMs: 1_000,
    });
    assert.equal(response.ok, true);
  } finally {
    await server.close();
    await rm(directory, { force: true, recursive: true });
  }
  await assert.rejects(connect(endpoint));
});
