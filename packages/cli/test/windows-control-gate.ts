import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type ControlRuntimeOperations,
  type ControlServer,
  createWindowsControlBroker,
  requestControl,
  startControlServer,
  type WindowsBrokerSecurityDescriptor,
} from "@tego/cli";
import { diagnosticCode, parseRuntimeStatus, type RuntimeOperations } from "@tego/contracts";

const WINDOWS_CONTROL_GATE_CHILD_MARKER = "TEGO_WINDOWS_CONTROL_GATE_INNER_OK";
const WINDOWS_CONTROL_GATE_FAILURE = "TEGO_WINDOWS_CONTROL_GATE_FAILED";
const WINDOWS_PIPE_FULL_CONTROL = 0x1f01ff;
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
const PROCESS_CLEANUP_TIMEOUT_MS = 15_000;
const POWERSHELL_STARTUP_STDERR_MAX_BYTES = 64 * 1024;
const expectedPackageNames = [
  "@tego/cli",
  "@tego/contracts",
  "@tego/drivers-local",
  "@tego/drivers-postgres",
  "@tego/executor-node",
  "@tego/plugin-sdk",
  "@tego/runtime",
  "@tego/testkit",
  "@tego/transport-websocket",
];

const expectedStatus = parseRuntimeStatus({
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
});

interface TrackedServer {
  readonly broker: ChildProcess;
  readonly brokerClosed: Promise<void>;
  readonly brokerPid: number;
  readonly descriptor: WindowsBrokerSecurityDescriptor;
  readonly endpoint: string;
  readonly failure: Promise<Error>;
  readonly server: ControlServer;
}

interface ParentFixtureReady {
  readonly brokerPid: number;
  readonly endpoint: string;
  readonly parentPid: number;
  readonly type: "ready";
}

let liveServer: TrackedServer | undefined;
// TEMPORARY NON-AUTHORITATIVE TASK 4 DIAGNOSTIC. Remove after this Windows RED is localized.
const task4DiagnosticMarker = ["TEGO", "TASK4", "NON", "AUTHORITATIVE"].join("_");
let nonAuthoritativeStage = "not-entered";

function isExpectedMalformedServerClose(error: unknown, observedFailure: Error): boolean {
  return (
    error instanceof AggregateError &&
    error.errors.length === 2 &&
    diagnosticCode(error.errors[0]) === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE" &&
    error.errors[1] === observedFailure &&
    diagnosticCode(error.errors[1]) === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE"
  );
}

function gateOperations(): ControlRuntimeOperations {
  return {
    operations: {} as RuntimeOperations,
    status: async () => expectedStatus,
    stop: async () => undefined,
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error("Windows gate environment missing");
  return value;
}

function isContained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Windows gate deadline exceeded")), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw new Error("Windows process probe failed");
  }
}

async function waitForProcessExit(processId: number): Promise<void> {
  const deadline = Date.now() + PROCESS_CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processExists(processId)) return;
    await delay(25);
  }
  assert.equal(processExists(processId), false, "exact Windows process remained alive");
}

async function assertPipeUnavailable(endpoint: string): Promise<void> {
  const deadline = Date.now() + PROCESS_CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await requestControl({
        endpoint,
        operation: "runtime.status",
        input: {},
        requestId: `windows-control-unavailable-${randomUUID()}`,
        timeoutMs: 250,
      });
    } catch {
      return;
    }
    await delay(25);
  }
  assert.fail("Windows control pipe remained reachable");
}

function assertDescriptor(descriptor: WindowsBrokerSecurityDescriptor): void {
  const ownerSid = descriptor.ownerSid;
  assert.match(ownerSid, /^S-1-(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*))+$/u);
  assert.equal(descriptor.protectedDacl, true);
  const expectedSids = [...new Set([ownerSid, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID])];
  assert.deepEqual(
    descriptor.accessRules,
    expectedSids.map((sid) => ({
      accessMask: WINDOWS_PIPE_FULL_CONTROL,
      callback: false as const,
      inherited: false as const,
      sid,
      type: "allow" as const,
    })),
  );
}

async function startTrackedServer(label: string): Promise<TrackedServer> {
  const endpoint = `\\\\.\\pipe\\tego-windows-control-${label}-${process.pid}-${randomUUID()}`;
  const failed = Promise.withResolvers<Error>();
  let broker: ChildProcess | undefined;
  let brokerClosed: Promise<void> | undefined;
  let descriptor: WindowsBrokerSecurityDescriptor | undefined;
  const server = await startControlServer({
    endpoint,
    onServerError(error) {
      failed.resolve(error);
    },
    operations: gateOperations(),
    windowsControlBrokerFactory(options) {
      return createWindowsControlBroker({
        ...options,
        onReadyDescriptor(value) {
          descriptor = value;
        },
        spawnBroker(command, args, spawnOptions) {
          assert.equal(command, "powershell.exe");
          assert.deepEqual(spawnOptions, {
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
          const spawned = spawn(command, [...args], {
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
          brokerClosed = new Promise<void>((resolveClose) => {
            spawned.once("close", resolveClose);
          });
          broker = spawned;
          return spawned as never;
        },
      });
    },
  });
  assert.ok(broker !== undefined);
  assert.ok(brokerClosed !== undefined);
  assert.ok(Number.isSafeInteger(broker.pid) && (broker.pid ?? 0) > 0);
  assert.ok(descriptor !== undefined);
  assertDescriptor(descriptor);
  return {
    broker,
    brokerClosed,
    brokerPid: broker.pid as number,
    descriptor,
    endpoint,
    failure: failed.promise,
    server,
  };
}

async function cleanupTrackedServer(tracked: TrackedServer): Promise<void> {
  try {
    await tracked.server.close();
  } catch {}
  if (tracked.broker.exitCode === null && tracked.broker.signalCode === null) {
    tracked.broker.kill("SIGKILL");
  }
  await withDeadline(tracked.brokerClosed, PROCESS_CLEANUP_TIMEOUT_MS);
  await assertPipeUnavailable(tracked.endpoint);
}

async function assertStatus(endpoint: string, requestId: string): Promise<void> {
  const response = await requestControl({
    endpoint,
    operation: "runtime.status",
    input: {},
    requestId,
    timeoutMs: 2_000,
  });
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, expectedStatus);
}

async function runWindowsControlGateStage(
  stage: string,
  operation: () => Promise<void>,
): Promise<void> {
  nonAuthoritativeStage = stage;
  await operation();
}

async function runPowerShellSelfTest(): Promise<void> {
  assert.equal(process.platform, "win32", "Windows control gate requires win32");
  assert.equal(process.arch, "x64", "Windows control gate requires x64");
  const consumerRoot = await realpath(requiredEnvironment("TEGO_WINDOWS_CONTROL_CONSUMER_ROOT"));
  const brokerPowerShell = await realpath(requiredEnvironment("TEGO_WINDOWS_CONTROL_BROKER_PS1"));
  const brokerCSharp = await realpath(requiredEnvironment("TEGO_WINDOWS_CONTROL_BROKER_CS"));
  const installedCliEntry = await realpath(fileURLToPath(import.meta.resolve("@tego/cli")));
  const installedCliRoot = resolve(dirname(installedCliEntry), "..", "..");
  const installedGate = await realpath(fileURLToPath(import.meta.url));
  assert.equal(isContained(consumerRoot, installedCliEntry), true);
  assert.equal(isContained(consumerRoot, installedGate), true);
  assert.equal(isContained(installedCliRoot, brokerPowerShell), true);
  assert.equal(isContained(installedCliRoot, brokerCSharp), true);
  assert.equal(
    requiredEnvironment("TEGO_WINDOWS_CONTROL_CONSUMER_PACKAGES"),
    expectedPackageNames.join(","),
  );
  assert.equal(
    brokerPowerShell,
    join(installedCliRoot, "dist", "src", "control", "windows-control-broker.ps1"),
  );
  assert.equal(
    brokerCSharp,
    join(installedCliRoot, "dist", "src", "control", "windows-control-broker.cs"),
  );
  const selfTestArguments = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    brokerPowerShell,
    "-SelfTest",
  ];
  const selfTest = spawnSync("powershell.exe", selfTestArguments, {
    encoding: "utf8",
    maxBuffer: POWERSHELL_STARTUP_STDERR_MAX_BYTES,
    shell: false,
    timeout: 2 * 60 * 1000,
    windowsHide: true,
  });
  assert.equal(selfTest.error, undefined);
  assert.equal(selfTest.signal, null);
  assert.equal(selfTest.status, 0);
  assert.equal(selfTest.stdout, "");
  assert.equal(selfTest.stderr, "");
}

async function startLiveDescriptor(): Promise<void> {
  liveServer = await startTrackedServer("live-descriptor");
}

async function runStatusRequest(): Promise<void> {
  assert.ok(liveServer !== undefined);
  await assertStatus(liveServer.endpoint, "windows-control-gate-status");
}

async function writeMalformedFrame(broker: ChildProcess): Promise<void> {
  assert.ok(broker.stdin !== null);
  await new Promise<void>((resolveWrite, rejectWrite) => {
    broker.stdin?.write(Buffer.alloc(24, 0xff), (error) =>
      error === undefined || error === null ? resolveWrite() : rejectWrite(error),
    );
  });
}

async function runMalformedFrameFailure(): Promise<void> {
  let tracked: TrackedServer | undefined = await startTrackedServer("malformed-frame");
  try {
    await writeMalformedFrame(tracked.broker);
    const failure = await withDeadline(tracked.failure, PROCESS_CLEANUP_TIMEOUT_MS);
    assert.match(failure.message, /PROTOCOL_CONTROL_ENDPOINT_UNSAFE/u);
    await assert.rejects(tracked.server.close(), (error: unknown) =>
      isExpectedMalformedServerClose(error, failure),
    );
    await withDeadline(tracked.brokerClosed, PROCESS_CLEANUP_TIMEOUT_MS);
    await assertPipeUnavailable(tracked.endpoint);
    tracked = undefined;
  } finally {
    if (tracked !== undefined) await cleanupTrackedServer(tracked);
  }
}

async function runParentCrashFixture(): Promise<void> {
  const tracked = await startTrackedServer("parent-crash");
  if (process.send === undefined) throw new Error("Windows parent fixture requires IPC");
  await new Promise<void>((resolveSend, rejectSend) => {
    process.send?.(
      {
        brokerPid: tracked.brokerPid,
        endpoint: tracked.endpoint,
        parentPid: process.pid,
        type: "ready",
      } satisfies ParentFixtureReady,
      (error) => (error === null ? resolveSend() : rejectSend(error)),
    );
  });
  await new Promise<never>(() => undefined);
}

function isParentFixtureReady(value: unknown): value is ParentFixtureReady {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ParentFixtureReady>;
  return (
    candidate.type === "ready" &&
    Number.isSafeInteger(candidate.parentPid) &&
    (candidate.parentPid ?? 0) > 0 &&
    Number.isSafeInteger(candidate.brokerPid) &&
    (candidate.brokerPid ?? 0) > 0 &&
    typeof candidate.endpoint === "string" &&
    /^\\\\\.\\pipe\\/u.test(candidate.endpoint)
  );
}

async function runParentCrashCleanup(): Promise<void> {
  const fixture = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--parent-crash-fixture"],
    {
      env: { ...process.env, NODE_PATH: "" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  const ready = Promise.withResolvers<ParentFixtureReady>();
  const closed = once(fixture, "close");
  fixture.on("message", (message) => {
    if (isParentFixtureReady(message)) ready.resolve(message);
    else ready.reject(new Error("Windows parent fixture emitted invalid IPC"));
  });
  fixture.once("error", () => ready.reject(new Error("Windows parent fixture failed")));
  fixture.once("exit", () => ready.reject(new Error("Windows parent fixture exited early")));
  let details: ParentFixtureReady | undefined;
  try {
    details = await withDeadline(ready.promise, PROCESS_CLEANUP_TIMEOUT_MS);
    assert.equal(details.parentPid, fixture.pid);
    assert.equal(fixture.kill("SIGKILL"), true);
    await withDeadline(
      closed.then(() => undefined),
      PROCESS_CLEANUP_TIMEOUT_MS,
    );
    await waitForProcessExit(details.parentPid);
    await waitForProcessExit(details.brokerPid);
    await assertPipeUnavailable(details.endpoint);
    assert.equal(fixture.stdout?.readableEnded, true);
    assert.equal(fixture.stderr?.readableEnded, true);
  } finally {
    if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGKILL");
    if (details !== undefined && processExists(details.brokerPid)) {
      try {
        process.kill(details.brokerPid, "SIGKILL");
      } catch {}
      await waitForProcessExit(details.brokerPid);
    }
  }
}

async function runBrokerCrashCleanup(): Promise<void> {
  let tracked: TrackedServer | undefined = await startTrackedServer("broker-crash");
  try {
    assert.equal(tracked.broker.kill("SIGKILL"), true);
    const failure = await withDeadline(tracked.failure, PROCESS_CLEANUP_TIMEOUT_MS);
    assert.match(failure.message, /PROTOCOL_CONTROL_ENDPOINT_UNSAFE/u);
    await assert.rejects(tracked.server.close(), (error: unknown) =>
      isExpectedMalformedServerClose(error, failure),
    );
    await withDeadline(tracked.brokerClosed, PROCESS_CLEANUP_TIMEOUT_MS);
    await assertPipeUnavailable(tracked.endpoint);
    tracked = undefined;
  } finally {
    if (tracked !== undefined) await cleanupTrackedServer(tracked);
  }
}

async function runReconnectFailure(): Promise<void> {
  assert.ok(liveServer !== undefined);
  const tracked = liveServer;
  liveServer = undefined;
  await tracked.server.close();
  await waitForProcessExit(tracked.brokerPid);
  await assertPipeUnavailable(tracked.endpoint);
}

async function runTwentyLifecycleRounds(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    const tracked = await startTrackedServer(`round-${String(round)}`);
    try {
      await assertStatus(tracked.endpoint, `windows-control-gate-round-${String(round)}`);
      await tracked.server.close();
      await waitForProcessExit(tracked.brokerPid);
      await assertPipeUnavailable(tracked.endpoint);
    } finally {
      await cleanupTrackedServer(tracked);
    }
  }
}

async function runInstalledWindowsControlGate(): Promise<void> {
  await runWindowsControlGateStage("powershell-csharp-self-test", runPowerShellSelfTest);
  await runWindowsControlGateStage("live-server-handle-descriptor", startLiveDescriptor);
  await runWindowsControlGateStage("status-request", runStatusRequest);
  await runWindowsControlGateStage("malformed-broker-frame-fail-closed", runMalformedFrameFailure);
  await runWindowsControlGateStage("parent-crash-cleanup", runParentCrashCleanup);
  await runWindowsControlGateStage("broker-crash-cleanup", runBrokerCrashCleanup);
  await runWindowsControlGateStage("reconnect-failure", runReconnectFailure);
  await runWindowsControlGateStage("twenty-lifecycle-rounds", runTwentyLifecycleRounds);
}

if (process.argv[2] === "--parent-crash-fixture") {
  try {
    await runParentCrashFixture();
  } catch {
    process.exitCode = 1;
  }
} else {
  try {
    await runInstalledWindowsControlGate();
    process.stdout.write(`${WINDOWS_CONTROL_GATE_CHILD_MARKER}\n`);
  } catch {
    process.stderr.write(`${task4DiagnosticMarker}_STAGE:${nonAuthoritativeStage}\n`);
    const owned = liveServer;
    liveServer = undefined;
    if (owned !== undefined) {
      try {
        await cleanupTrackedServer(owned);
      } catch {}
    }
    process.stderr.write(`${WINDOWS_CONTROL_GATE_FAILURE}\n`);
    process.exitCode = 1;
  }
}
