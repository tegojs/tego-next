import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseRuntimeStatus, type RuntimeOperations } from "@tego/contracts";
import { requestControl } from "../src/control/client.js";
import { type ControlRuntimeOperations, startControlServer } from "../src/control/server.js";

const WINDOWS_CONTROL_GATE_MARKER = "TEGO_WINDOWS_CONTROL_GATE_OK";

function gateOperations(): ControlRuntimeOperations {
  return {
    operations: {} as RuntimeOperations,
    status: async () =>
      parseRuntimeStatus({
        identity: {
          applicationId: "application-windows-control-gate",
          nodeId: "node-windows-control-gate",
          runtimeId: "runtime-windows-control-gate",
        },
        mode: "single-main",
        lifecycle: "running",
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
      }),
    stop: async () => undefined,
  };
}

async function runWindowsControlSecurityContract(): Promise<void> {
  assert.equal(process.platform, "win32", "Windows control gate cannot run on another platform");
  const endpoint = `\\\\.\\pipe\\tego-windows-control-gate-${process.pid}-${randomUUID()}`;
  const server = await startControlServer({
    endpoint,
    operations: gateOperations(),
  });
  try {
    const response = await requestControl({
      endpoint,
      operation: "runtime.status",
      input: {},
      requestId: "windows-control-gate-status",
      timeoutMs: 1_000,
    });
    assert.equal(response.ok, true);
  } finally {
    await server.close();
  }
  await assert.rejects(
    requestControl({
      endpoint,
      operation: "runtime.status",
      input: {},
      requestId: "windows-control-gate-reconnect",
      timeoutMs: 1_000,
    }),
  );
}

try {
  await runWindowsControlSecurityContract();
  process.stdout.write(`${WINDOWS_CONTROL_GATE_MARKER}\n`);
} catch {
  process.stderr.write("TEGO_WINDOWS_CONTROL_GATE_FAILED\n");
  process.exitCode = 1;
}
