import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, chmod, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
} from "@tego/contracts";
import { requestControl } from "../src/control/client.js";
import { type ControlResponse, MAX_CONTROL_LINE_BYTES } from "../src/control/protocol.js";
import { type ControlRuntimeOperations, startControlServer } from "../src/control/server.js";
import {
  createWindowsPipeSecurityAdapter,
  parseWindowsPipeSecurityHelperOutput,
  validateWindowsPipeSecurityDescriptor,
  type WindowsPipeSecurityHelperSpawner,
} from "../src/control/windows-pipe-security.js";

const TEST_WINDOWS_USER_SID = "S-1-5-21-1000-1000-1000-1001";
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
const WINDOWS_PIPE_FULL_CONTROL = 0x1f01ff;

interface TestWindowsPipeSecurityDescriptor {
  readonly ownerSid: string | undefined;
  readonly accessSids: readonly string[];
  readonly protectedDacl: boolean;
  readonly accessRules: readonly {
    readonly accessMask: number;
    readonly inherited: boolean;
    readonly sid: string;
    readonly type: "allow" | "deny";
  }[];
}

function allowedWindowsPipeSecurityDescriptor(): TestWindowsPipeSecurityDescriptor {
  const accessSids = [TEST_WINDOWS_USER_SID, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID];
  return {
    ownerSid: TEST_WINDOWS_USER_SID,
    accessSids,
    protectedDacl: true,
    accessRules: accessSids.map((sid) => ({
      accessMask: WINDOWS_PIPE_FULL_CONTROL,
      inherited: false,
      sid,
      type: "allow" as const,
    })),
  };
}

function fakeWindowsPipeSecurityHelperProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  Object.assign(child, { stderr, stdout });
  child.kill = () => true;
  return {
    child: child as unknown as ReturnType<WindowsPipeSecurityHelperSpawner>,
    stderr,
    stdout,
  };
}

type WindowsSecurityControlOptions = Omit<
  Parameters<typeof startControlServer>[0],
  "windowsPipeSecurityAdapter"
> & {
  readonly windowsPipeCurrentUserSid: string;
  readonly windowsPipeSecurityAdapter: {
    harden(endpoint: string, signal?: AbortSignal): Promise<TestWindowsPipeSecurityDescriptor>;
  };
};

type WindowsSecurityControlOptionsWithBarrier = Omit<
  WindowsSecurityControlOptions,
  "windowsPipeSecurityAdapter"
> & {
  readonly windowsPipeSecurityAdapter: WindowsSecurityControlOptions["windowsPipeSecurityAdapter"] & {
    readonly usesAdmissionBarrier: true;
  };
};

const startWithWindowsSecurityUnchecked = startControlServer as unknown as (
  options: WindowsSecurityControlOptionsWithBarrier,
) => ReturnType<typeof startControlServer>;

function startWithWindowsSecurity(options: WindowsSecurityControlOptions) {
  const windowsPipeSecurityAdapter = {
    ...options.windowsPipeSecurityAdapter,
    usesAdmissionBarrier: true as const,
  };
  return startWithWindowsSecurityUnchecked({
    ...options,
    windowsPipeSecurityAdapter,
  });
}

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
    snapshot: () => Promise.reject(new Error("not used")),
  };
}

test("runtime.snapshot dispatches the public snapshot request", async () => {
  await withEndpoint(async (endpoint) => {
    let input: unknown;
    const operations = fakeOperations();
    const server = await startControlServer({
      endpoint,
      operations: {
        ...operations,
        operations: {
          ...operations.operations,
          snapshot: async (request: unknown) => {
            input = request;
            return {
              installations: { items: [] },
              deployments: { items: [] },
              instances: { items: [] },
              operations: { items: [] },
              tasks: { items: [] },
            };
          },
        } as RuntimeOperations,
      },
    });
    try {
      const result = await requestControl({
        endpoint,
        operation: "runtime.snapshot" as never,
        input: { limit: 10 },
        requestId: "request-runtime-snapshot",
        timeoutMs: 1_000,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(input, { limit: 10 });
    } finally {
      await server.close();
    }
  });
});

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

function runtimeStopFrame(requestId: string): string {
  return `${JSON.stringify({
    protocolVersion: "1.0",
    requestId,
    operation: "runtime.stop",
    input: {},
  })}\n`;
}

async function readUntilClosed(socket: Socket): Promise<string> {
  return await new Promise((resolve) => {
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("error", () => undefined);
    socket.once("close", () => resolve(response));
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

test("artifact ingress occurs exactly once before follower installation is fenced", async () => {
  await withEndpoint(async (endpoint, directory) => {
    const artifactPath = join(directory, "plugin.tego");
    const expectedDigest = `sha256:${"b".repeat(64)}` as ArtifactDigest;
    const calls: string[] = [];
    const semanticState = {
      installations: [],
      deployments: [],
      instances: [],
      operations: [],
      tasks: [],
    };
    const semanticStateBefore = JSON.stringify(semanticState);
    const operations = fakeOperations();
    const server = await startControlServer({
      endpoint,
      artifactIngress: {
        putPath: async (path: string) => {
          calls.push(`putPath:${path}`);
          return expectedDigest;
        },
      },
      operations: {
        ...operations,
        operations: {
          ...operations.operations,
          installPlugin: async (request: InstallPluginRequest) => {
            calls.push(`installPlugin:${request.digest}`);
            throw new DiagnosticError(
              runtimeDiagnostic({
                code: "COORDINATION_NOT_LEADER",
                message: "Operation requires the current leader",
                source: { kind: "coordination" },
              }),
            );
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
      assert.equal(response.ok, false);
      assert.equal(response.diagnostic?.code, "COORDINATION_NOT_LEADER");
      assert.deepEqual(calls, [`putPath:${artifactPath}`, `installPlugin:${expectedDigest}`]);
      assert.equal(JSON.stringify(semanticState), semanticStateBefore);
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

test("permission initialization pauses accepted Unix sockets until owner-private 0600 verification", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket permission initialization does not apply to named pipes");
    return;
  }
  await withEndpoint(async (endpoint) => {
    const permissionEntered = Promise.withResolvers<void>();
    const permissionRelease = Promise.withResolvers<void>();
    let stopCalls = 0;
    const operations = fakeOperations();
    const startup = startControlServer({
      endpoint,
      operations: {
        ...operations,
        stop: async () => {
          stopCalls += 1;
        },
      },
      setEndpointPermissions: async (path) => {
        permissionEntered.resolve();
        await permissionRelease.promise;
        await chmod(path, 0o600);
      },
    });
    await permissionEntered.promise;
    const socket = await connect(endpoint);
    const response = readResponse(socket);
    socket.end(runtimeStopFrame("permission-window"));

    const responseSettledBeforePermission = await settlesBeforeDeadline(response);
    const stopCallsBeforePermission = stopCalls;
    permissionRelease.resolve();
    const server = await startup;
    try {
      assert.equal((await response).ok, true);
      assert.equal(stopCalls, 1);
    } finally {
      await server.close();
    }
    assert.equal(responseSettledBeforePermission, false);
    assert.equal(stopCallsBeforePermission, 0);
  });
});

test("permission initialization rejects a no-op hook and closes its queued socket", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket permission initialization does not apply to named pipes");
    return;
  }
  await withEndpoint(async (endpoint) => {
    const permissionEntered = Promise.withResolvers<void>();
    const permissionRelease = Promise.withResolvers<void>();
    const startup = startControlServer({
      endpoint,
      operations: fakeOperations(),
      setEndpointPermissions: async () => {
        permissionEntered.resolve();
        await permissionRelease.promise;
      },
    });
    await permissionEntered.promise;
    const socket = await connect(endpoint);
    const closed = readUntilClosed(socket);
    socket.end(runtimeStopFrame("permission-no-op"));
    permissionRelease.resolve();

    const outcome = await startup.then(
      (server) => ({ ok: true as const, server }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    const response = await closed;
    if (outcome.ok) await outcome.server.close();
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.error instanceof DiagnosticError);
      assert.equal(outcome.error.diagnostic.code, "PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
    }
    assert.equal(response, "");
    await assert.rejects(connect(endpoint));
  });
});

test("permission initialization rejects a non-socket path and closes its queued socket", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket permission initialization does not apply to named pipes");
    return;
  }
  await withEndpoint(async (endpoint) => {
    const permissionEntered = Promise.withResolvers<void>();
    const permissionRelease = Promise.withResolvers<void>();
    const startup = startControlServer({
      endpoint,
      operations: fakeOperations(),
      setEndpointPermissions: async (path) => {
        permissionEntered.resolve();
        await permissionRelease.promise;
        await unlink(path);
        await writeFile(path, "not a socket", { mode: 0o600 });
      },
    });
    await permissionEntered.promise;
    const socket = await connect(endpoint);
    const closed = readUntilClosed(socket);
    socket.end(runtimeStopFrame("permission-non-socket"));
    permissionRelease.resolve();

    const outcome = await startup.then(
      (server) => ({ ok: true as const, server }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    const response = await closed;
    if (outcome.ok) await outcome.server.close();
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.error instanceof DiagnosticError);
      assert.equal(outcome.error.diagnostic.code, "PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
    }
    assert.equal(response, "");
    await assert.rejects(connect(endpoint));
  });
});

test("permission initialization rejects a same-owner 0600 replacement socket", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket identity verification does not apply to named pipes");
    return;
  }
  await withEndpoint(async (endpoint) => {
    let replacement: Server | undefined;
    const permissionEntered = Promise.withResolvers<void>();
    const permissionRelease = Promise.withResolvers<void>();
    const startup = startControlServer({
      endpoint,
      operations: fakeOperations(),
      setEndpointPermissions: async (path) => {
        await chmod(path, 0o600);
        permissionEntered.resolve();
        await permissionRelease.promise;
        await unlink(path);
        replacement = createServer();
        await new Promise<void>((resolve, reject) => {
          replacement?.once("error", reject);
          replacement?.listen(path, resolve);
        });
        await chmod(path, 0o600);
      },
    });
    await permissionEntered.promise;
    const socket = await connect(endpoint);
    const closed = readUntilClosed(socket);
    socket.end(runtimeStopFrame("permission-replacement"));
    permissionRelease.resolve();

    const outcome = await startup.then(
      (server) => ({ ok: true as const, server }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    const response = await closed;
    if (outcome.ok) await outcome.server.close();
    await new Promise<void>((resolve, reject) => {
      if (replacement === undefined || !replacement.listening) {
        resolve();
        return;
      }
      replacement.close((error) => (error === undefined ? resolve() : reject(error)));
    });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.error instanceof DiagnosticError);
      assert.equal(outcome.error.diagnostic.code, "PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
    }
    assert.equal(response, "");
  });
});

test("permission initialization rejects a parent directory made public by its hook", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix directory permissions do not apply to named pipes");
    return;
  }
  await withEndpoint(async (endpoint, directory) => {
    const startup = startControlServer({
      endpoint,
      operations: fakeOperations(),
      setEndpointPermissions: async (path) => {
        await chmod(path, 0o600);
        await chmod(directory, 0o777);
      },
    });

    const outcome = await startup.then(
      (server) => ({ ok: true as const, server }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    if (outcome.ok) await outcome.server.close();
    await chmod(directory, 0o700);

    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.error instanceof DiagnosticError);
      assert.equal(outcome.error.diagnostic.code, "PROTOCOL_CONTROL_PARENT_NOT_PRIVATE");
    }
  });
});

test("permission initialization rejects a symlink endpoint", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket identity verification does not apply to named pipes");
    return;
  }
  await withEndpoint(async (endpoint, directory) => {
    const target = join(directory, "replacement.sock");
    const replacement = createServer();
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(target, resolve);
    });
    await chmod(target, 0o600);
    try {
      const startup = startControlServer({
        endpoint,
        operations: fakeOperations(),
        setEndpointPermissions: async (path) => {
          await chmod(path, 0o600);
          await unlink(path);
          await symlink(target, path);
        },
      });
      const outcome = await startup.then(
        (server) => ({ ok: true as const, server }),
        (error: unknown) => ({ error, ok: false as const }),
      );
      if (outcome.ok) await outcome.server.close();

      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.ok(outcome.error instanceof DiagnosticError);
        assert.equal(outcome.error.diagnostic.code, "PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        replacement.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});

test("permission initialization rejects a mode other than 0600 and closes its queued socket", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket permission initialization does not apply to named pipes");
    return;
  }
  await withEndpoint(async (endpoint) => {
    const permissionEntered = Promise.withResolvers<void>();
    const permissionRelease = Promise.withResolvers<void>();
    const startup = startControlServer({
      endpoint,
      operations: fakeOperations(),
      setEndpointPermissions: async (path) => {
        permissionEntered.resolve();
        await permissionRelease.promise;
        await chmod(path, 0o640);
      },
    });
    await permissionEntered.promise;
    const socket = await connect(endpoint);
    const closed = readUntilClosed(socket);
    socket.end(runtimeStopFrame("permission-mode"));
    permissionRelease.resolve();

    const outcome = await startup.then(
      (server) => ({ ok: true as const, server }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    const response = await closed;
    if (outcome.ok) await outcome.server.close();
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.error instanceof DiagnosticError);
      assert.equal(outcome.error.diagnostic.code, "PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
    }
    assert.equal(response, "");
    await assert.rejects(connect(endpoint));
  });
});

test("permission initialization rejects the wrong owner and closes its queued socket", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket permission initialization does not apply to named pipes");
    return;
  }
  const originalGetuid = process.getuid;
  if (originalGetuid === undefined) {
    context.skip("Unix owner verification requires getuid");
    return;
  }
  await withEndpoint(async (endpoint) => {
    const permissionEntered = Promise.withResolvers<void>();
    const permissionRelease = Promise.withResolvers<void>();
    const startup = startControlServer({
      endpoint,
      operations: fakeOperations(),
      setEndpointPermissions: async (path) => {
        permissionEntered.resolve();
        await permissionRelease.promise;
        await chmod(path, 0o600);
        process.getuid = () => originalGetuid() + 1;
      },
    });
    await permissionEntered.promise;
    const socket = await connect(endpoint);
    const closed = readUntilClosed(socket);
    socket.end(runtimeStopFrame("permission-owner"));
    permissionRelease.resolve();
    try {
      const outcome = await startup.then(
        (server) => ({ ok: true as const, server }),
        (error: unknown) => ({ error, ok: false as const }),
      );
      const response = await closed;
      if (outcome.ok) await outcome.server.close();
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.ok(outcome.error instanceof DiagnosticError);
        assert.equal(outcome.error.diagnostic.code, "PROTOCOL_CONTROL_PARENT_NOT_PRIVATE");
      }
      assert.equal(response, "");
      await assert.rejects(connect(endpoint));
    } finally {
      process.getuid = originalGetuid;
    }
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

test("Windows pipe hardening pauses accepted sockets until descriptor validation", async () => {
  await withEndpoint(async (endpoint) => {
    const hardeningEntered = Promise.withResolvers<void>();
    const hardeningRelease = Promise.withResolvers<void>();
    let stopCalls = 0;
    const operations = fakeOperations();
    const startup = startWithWindowsSecurity({
      endpoint,
      operations: {
        ...operations,
        stop: async () => {
          stopCalls += 1;
        },
      },
      windowsPipeCurrentUserSid: TEST_WINDOWS_USER_SID,
      windowsPipeSecurityAdapter: {
        async harden(hardenedEndpoint) {
          assert.equal(hardenedEndpoint, endpoint);
          hardeningEntered.resolve();
          await hardeningRelease.promise;
          return allowedWindowsPipeSecurityDescriptor();
        },
      },
    });

    const adapterWasInvoked = await Promise.race([
      hardeningEntered.promise.then(() => true),
      startup.then(() => false),
    ]);
    if (!adapterWasInvoked) {
      await (await startup).close();
      assert.equal(adapterWasInvoked, true, "Windows security adapter must gate readiness");
      return;
    }

    const socket = await connect(endpoint);
    const closed = readUntilClosed(socket);
    socket.end(runtimeStopFrame("windows-security-window"));
    const stopCallsBeforeHardening = stopCalls;

    hardeningRelease.resolve();
    const server = await startup;
    try {
      assert.equal(await closed, "");
      const response = await requestControl({
        endpoint,
        operation: "runtime.status",
        input: {},
        timeoutMs: 1_000,
      });
      assert.equal(response.ok, true);
      assert.equal(stopCalls, 0);
    } finally {
      await server.close();
    }
    assert.equal(stopCallsBeforeHardening, 0);
  });
});

test("Windows pipe hardening drains connections accepted before the security cutover", async () => {
  await withEndpoint(async (endpoint) => {
    let preCutoverClosed: Promise<string> | undefined;
    let stopCalls = 0;
    const operations = fakeOperations();
    const server = await startWithWindowsSecurity({
      endpoint,
      operations: {
        ...operations,
        stop: async () => {
          stopCalls += 1;
        },
      },
      windowsPipeCurrentUserSid: TEST_WINDOWS_USER_SID,
      windowsPipeSecurityAdapter: {
        async harden() {
          const preCutoverSocket = createConnection(endpoint);
          preCutoverClosed = readUntilClosed(preCutoverSocket);
          preCutoverSocket.end(runtimeStopFrame("windows-security-cutover"));
          const barrierSocket = await connect(endpoint);
          const acknowledgement = readUntilClosed(barrierSocket);
          barrierSocket.end("TEGO_WINDOWS_PIPE_SECURITY_BARRIER_V1\n");
          assert.equal(await acknowledgement, "TEGO_WINDOWS_PIPE_SECURITY_BARRIER_ACK_V1\n");
          return allowedWindowsPipeSecurityDescriptor();
        },
      },
    });
    try {
      assert.ok(preCutoverClosed !== undefined);
      assert.equal(await preCutoverClosed, "");
      assert.equal(stopCalls, 0);
    } finally {
      await server.close();
    }
  });
});

test("Windows pipe startup rejects an adapter without a deterministic admission barrier", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await withEndpoint(async (endpoint) => {
      const outcome = await startControlServer({
        endpoint,
        operations: fakeOperations(),
        windowsPipeCurrentUserSid: TEST_WINDOWS_USER_SID,
        windowsPipeSecurityAdapter: {
          harden: async () => allowedWindowsPipeSecurityDescriptor(),
          usesAdmissionBarrier: false,
        } as never,
      }).then(
        (server) => ({ ok: true as const, server }),
        (error: unknown) => ({ error, ok: false as const }),
      );
      if (outcome.ok) await outcome.server.close();

      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.ok(outcome.error instanceof DiagnosticError);
        assert.equal(outcome.error.diagnostic.code, "PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
      }
    });
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

for (const [name, mutate] of [
  [
    "missing owner",
    (descriptor: TestWindowsPipeSecurityDescriptor) => ({ ...descriptor, ownerSid: undefined }),
  ],
  [
    "wrong owner",
    (descriptor: TestWindowsPipeSecurityDescriptor) => ({
      ...descriptor,
      ownerSid: "S-1-5-21-1000-1000-1000-2002",
    }),
  ],
  [
    "unprotected DACL",
    (descriptor: TestWindowsPipeSecurityDescriptor) => ({
      ...descriptor,
      protectedDacl: false,
    }),
  ],
  ...(
    [
      ["Everyone", "S-1-1-0"],
      ["Anonymous", "S-1-5-7"],
      ["Authenticated Users", "S-1-5-11"],
      ["an unexpected principal", "S-1-5-21-1000-1000-1000-3003"],
    ] as const
  ).map(
    ([label, sid]) =>
      [
        `${label} allow ACE`,
        (descriptor: TestWindowsPipeSecurityDescriptor) => ({
          ...descriptor,
          accessSids: [...descriptor.accessSids, sid],
          accessRules: [
            ...descriptor.accessRules,
            { accessMask: 1, inherited: false, sid, type: "allow" as const },
          ],
        }),
      ] as const,
  ),
  [
    "deny ACE",
    (descriptor: TestWindowsPipeSecurityDescriptor) => ({
      ...descriptor,
      accessRules: descriptor.accessRules.map((rule, index) =>
        index === 0 ? { ...rule, type: "deny" as const } : rule,
      ),
    }),
  ],
  [
    "inherited ACE",
    (descriptor: TestWindowsPipeSecurityDescriptor) => ({
      ...descriptor,
      accessRules: descriptor.accessRules.map((rule, index) =>
        index === 0 ? { ...rule, inherited: true } : rule,
      ),
    }),
  ],
  [
    "noncanonical ACE order",
    (descriptor: TestWindowsPipeSecurityDescriptor) => ({
      ...descriptor,
      accessSids: descriptor.accessSids.toReversed(),
      accessRules: descriptor.accessRules.toReversed(),
    }),
  ],
  [
    "current user without pipe control",
    (descriptor: TestWindowsPipeSecurityDescriptor) => ({
      ...descriptor,
      accessRules: descriptor.accessRules.map((rule, index) =>
        index === 0 ? { ...rule, accessMask: 0x3 } : rule,
      ),
    }),
  ],
] as const) {
  test(`Windows pipe hardening rejects ${name} and rolls back queued sockets`, async () => {
    await withEndpoint(async (endpoint) => {
      const hardeningEntered = Promise.withResolvers<void>();
      const hardeningRelease = Promise.withResolvers<void>();
      const startup = startWithWindowsSecurity({
        endpoint,
        operations: fakeOperations(),
        windowsPipeCurrentUserSid: TEST_WINDOWS_USER_SID,
        windowsPipeSecurityAdapter: {
          async harden() {
            hardeningEntered.resolve();
            await hardeningRelease.promise;
            return mutate(allowedWindowsPipeSecurityDescriptor());
          },
        },
      });

      const adapterWasInvoked = await Promise.race([
        hardeningEntered.promise.then(() => true),
        startup.then(() => false),
      ]);
      if (!adapterWasInvoked) {
        await (await startup).close();
        assert.equal(adapterWasInvoked, true, "Windows security adapter must gate readiness");
        return;
      }

      const socket = await connect(endpoint);
      const closed = readUntilClosed(socket);
      socket.end(runtimeStopFrame("windows-security-rejected"));
      hardeningRelease.resolve();
      const outcome = await startup.then(
        (server) => ({ ok: true as const, server }),
        (error: unknown) => ({ error, ok: false as const }),
      );
      const response = await closed;
      if (outcome.ok) await outcome.server.close();

      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.ok(outcome.error instanceof DiagnosticError);
        assert.equal(outcome.error.diagnostic.code, "PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
        assert.equal(outcome.error.diagnostic.message, "PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
      }
      assert.equal(response, "");
      await assert.rejects(connect(endpoint));
    });
  });
}

test("Windows pipe hardening reports adapter failure with a stable unsafe diagnostic", async () => {
  await withEndpoint(async (endpoint) => {
    const outcome = await startWithWindowsSecurity({
      endpoint,
      operations: fakeOperations(),
      windowsPipeCurrentUserSid: TEST_WINDOWS_USER_SID,
      windowsPipeSecurityAdapter: {
        harden: () => Promise.reject(new Error("sensitive helper detail")),
      },
    }).then(
      (server) => ({ ok: true as const, server }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    if (outcome.ok) await outcome.server.close();

    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.error instanceof DiagnosticError);
      assert.equal(outcome.error.diagnostic.code, "PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
      assert.equal(outcome.error.diagnostic.message, "PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
      assert.doesNotMatch(JSON.stringify(outcome.error.diagnostic), /sensitive helper detail/u);
    }
    await assert.rejects(connect(endpoint));
  });
});

test("Windows pipe helper output is exactly one strict JSON descriptor line", () => {
  const inspection = allowedWindowsPipeSecurityDescriptor();
  const line = JSON.stringify({ currentUserSid: TEST_WINDOWS_USER_SID, ...inspection });
  assert.deepEqual(parseWindowsPipeSecurityHelperOutput(`${line}\r\n`), inspection);
  for (const output of [
    "",
    "not-json\n",
    `${line}\n${line}\n`,
    `notice\n${line}\n`,
    `${JSON.stringify({
      currentUserSid: TEST_WINDOWS_USER_SID,
      ...inspection,
      accessRules: {},
    })}\n`,
    `${JSON.stringify({ currentUserSid: TEST_WINDOWS_USER_SID, ...inspection, extra: true })}\n`,
    `${JSON.stringify({
      currentUserSid: "S-1-5-21-1000-1000-1000-2002",
      ...inspection,
    })}\n`,
  ]) {
    assert.throws(
      () => parseWindowsPipeSecurityHelperOutput(output),
      (error: unknown) =>
        error instanceof DiagnosticError &&
        error.diagnostic.code === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE",
    );
  }
});

test("Windows pipe helper uses fixed shell-free arguments and an admission barrier", async () => {
  const { child, stderr, stdout } = fakeWindowsPipeSecurityHelperProcess();
  let invocation: { readonly args: readonly string[]; readonly command: string } | undefined;
  const adapter = createWindowsPipeSecurityAdapter({
    spawnHelper(command, args) {
      invocation = { args, command };
      queueMicrotask(() => {
        stdout.end(
          `${JSON.stringify({
            currentUserSid: TEST_WINDOWS_USER_SID,
            ...allowedWindowsPipeSecurityDescriptor(),
          })}\n`,
        );
        stderr.end();
        (child as unknown as EventEmitter).emit("close", 0, null);
      });
      return child;
    },
  });
  const endpoint = "\\\\.\\pipe\\tego-helper-contract";

  await adapter.harden(endpoint);

  assert.ok(invocation !== undefined);
  assert.equal(invocation.command, "pwsh");
  assert.deepEqual(invocation.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-File"]);
  assert.deepEqual(invocation.args.slice(-6), [
    "-Endpoint",
    endpoint,
    "-Operation",
    "harden",
    "-BarrierCount",
    "2",
  ]);
});

test("Windows pipe helper exposes only fixed failure stages", async () => {
  const fixed = fakeWindowsPipeSecurityHelperProcess();
  const stages: string[] = [];
  const fixedAdapter = createWindowsPipeSecurityAdapter({
    onHelperFailure: (stage) => stages.push(stage),
    spawnHelper() {
      queueMicrotask(() => {
        fixed.stdout.end();
        fixed.stderr.end("TEGO_WINDOWS_PIPE_SECURITY_INITIAL_OPEN_FAILED\n");
        (fixed.child as unknown as EventEmitter).emit("close", 1, null);
      });
      return fixed.child;
    },
  });

  await assert.rejects(
    fixedAdapter.harden("\\\\.\\pipe\\tego-helper-fixed-failure"),
    (error: unknown) =>
      error instanceof DiagnosticError &&
      error.diagnostic.code === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE" &&
      error.message === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE",
  );
  assert.deepEqual(stages, ["TEGO_WINDOWS_PIPE_SECURITY_INITIAL_OPEN_FAILED"]);

  const unsafe = fakeWindowsPipeSecurityHelperProcess();
  const unsafeAdapter = createWindowsPipeSecurityAdapter({
    onHelperFailure: (stage) => stages.push(stage),
    spawnHelper() {
      queueMicrotask(() => {
        unsafe.stdout.end();
        unsafe.stderr.end("sensitive helper detail: \\\\.\\pipe\\private-endpoint\n");
        (unsafe.child as unknown as EventEmitter).emit("close", 1, null);
      });
      return unsafe.child;
    },
  });
  const outcome = await unsafeAdapter.harden("\\\\.\\pipe\\tego-helper-unsafe-failure").then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ error, ok: false as const }),
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.ok(outcome.error instanceof DiagnosticError);
    assert.equal(outcome.error.diagnostic.code, "PROTOCOL_CONTROL_ENDPOINT_UNSAFE");
    assert.doesNotMatch(JSON.stringify(outcome.error), /sensitive|private-endpoint/u);
  }
  assert.deepEqual(stages, ["TEGO_WINDOWS_PIPE_SECURITY_INITIAL_OPEN_FAILED"]);
});

test("Windows pipe helper abort waits for observed child close", async () => {
  const { child } = fakeWindowsPipeSecurityHelperProcess();
  let killCalls = 0;
  child.kill = () => {
    killCalls += 1;
    return true;
  };
  const controller = new AbortController();
  const adapter = createWindowsPipeSecurityAdapter({ spawnHelper: () => child });
  const hardening = adapter.harden("\\\\.\\pipe\\tego-helper-abort", controller.signal);
  controller.abort();

  const settledBeforeClose = await settlesBeforeDeadline(hardening);
  (child as unknown as EventEmitter).emit("close", null, "SIGKILL");

  await assert.rejects(hardening, { name: "AbortError" });
  assert.equal(killCalls, 1);
  assert.equal(settledBeforeClose, false);
});

test("Windows pipe policy rejects a descriptor that omits ACE inspection detail", () => {
  const { accessRules: _accessRules, ...descriptor } = allowedWindowsPipeSecurityDescriptor();
  assert.throws(
    () => validateWindowsPipeSecurityDescriptor(descriptor, TEST_WINDOWS_USER_SID),
    (error: unknown) =>
      error instanceof DiagnosticError &&
      error.diagnostic.code === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE",
  );
});

test("Windows pipe policy accepts LocalSystem as the current user without duplicate ACEs", () => {
  const accessSids = [WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID];
  const descriptor = {
    ownerSid: WINDOWS_SYSTEM_SID,
    accessSids,
    protectedDacl: true,
    accessRules: accessSids.map((sid) => ({
      accessMask: WINDOWS_PIPE_FULL_CONTROL,
      inherited: false,
      sid,
      type: "allow" as const,
    })),
  };

  const { accessRules: _accessRules, ...expected } = descriptor;
  assert.deepEqual(validateWindowsPipeSecurityDescriptor(descriptor, WINDOWS_SYSTEM_SID), expected);
});

test("Windows pipe startup waits for adapter abort cleanup before rollback settles", async () => {
  await withEndpoint(async (endpoint) => {
    const hardeningEntered = Promise.withResolvers<void>();
    const cleanupRelease = Promise.withResolvers<void>();
    const controller = new AbortController();
    const startup = startWithWindowsSecurity({
      endpoint,
      operations: fakeOperations(),
      signal: controller.signal,
      windowsPipeCurrentUserSid: TEST_WINDOWS_USER_SID,
      windowsPipeSecurityAdapter: {
        async harden(_endpoint, signal) {
          hardeningEntered.resolve();
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
          await cleanupRelease.promise;
          throw new DOMException("Aborted", "AbortError");
        },
      },
    });
    await hardeningEntered.promise;
    controller.abort();
    const settledBeforeCleanup = await settlesBeforeDeadline(startup);
    cleanupRelease.resolve();

    await assert.rejects(startup, { name: "AbortError" });
    assert.equal(settledBeforeCleanup, false);
    await assert.rejects(connect(endpoint));
  });
});
