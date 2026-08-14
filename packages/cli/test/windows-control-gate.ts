import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
const task4NonAuthoritativeStagePrefix = ["TEGO", "TASK4", "NON", "AUTHORITATIVE", "STAGE"].join(
  "_",
);
let task4NonAuthoritativeStageDetail = "none";
const WINDOWS_PIPE_FULL_CONTROL = 0x1f01ff;
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
const PROCESS_CLEANUP_TIMEOUT_MS = 15_000;
const POWERSHELL_STARTUP_STDERR_MAX_BYTES = 64 * 1024;
const windowsPipeProbeSource = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
try {
$null = Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TegoWindowsPipeProbe
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WaitNamedPipeW(string name, uint timeout);

    public static int Probe(string endpoint)
    {
        if (String.IsNullOrEmpty(endpoint)) return 3;
        if (WaitNamedPipeW(endpoint, 1)) return 2;
        int error = Marshal.GetLastWin32Error();
        if (error == 2) return 0;
        if (error == 121 || error == 231) return 2;
        return 3;
    }
}
'@
$probeResult = [TegoWindowsPipeProbe]::Probe($env:TEGO_WINDOWS_PIPE_PROBE_ENDPOINT)
exit $probeResult
} catch {
exit 3
}`;
const windowsPipeProbeArguments = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  Buffer.from(windowsPipeProbeSource, "utf16le").toString("base64"),
];
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
  readonly broker: OwnedChild;
  readonly descriptor: WindowsBrokerSecurityDescriptor;
  readonly endpoint: string;
  readonly failure: Promise<Error>;
  readonly server: ControlServer;
}

interface OwnedChild {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  readonly spawnError: Promise<Error>;
}

interface ParentFixtureReady {
  readonly nonce: string;
  readonly parentPid: number;
  readonly type: "ready";
}

interface ParentFixtureChallenge {
  readonly nonce: string;
  readonly type: "challenge";
}

interface ParentFixtureAcknowledgement {
  readonly nonce: string;
  readonly type: "ack";
}

let liveServer: TrackedServer | undefined;

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

function ownChild(child: ChildProcess): OwnedChild {
  const failed = Promise.withResolvers<Error>();
  child.once("error", (error) => failed.resolve(error));
  const closed = new Promise<void>((resolveClose) => {
    child.once("close", () => resolveClose());
  });
  return { child, closed, spawnError: failed.promise };
}

function runNativePipeProbe(endpoint: string): number {
  task4NonAuthoritativeStageDetail = "powershell-path";
  const systemRoot = realpathSync(requiredEnvironment("SystemRoot"));
  assert.equal(isAbsolute(systemRoot), true);
  assert.match(systemRoot, /^[A-Za-z]:\\[^\r\n]+$/u);
  const powershellExecutable = realpathSync(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  assert.equal(isContained(systemRoot, powershellExecutable), true);
  task4NonAuthoritativeStageDetail = "powershell-spawn";
  const probe = spawnSync(powershellExecutable, windowsPipeProbeArguments, {
    encoding: "utf8",
    env: {
      SystemRoot: systemRoot,
      TEGO_WINDOWS_PIPE_PROBE_ENDPOINT: endpoint,
      TEMP: requiredEnvironment("TEMP"),
      TMP: requiredEnvironment("TMP"),
      WINDIR: systemRoot,
    },
    maxBuffer: POWERSHELL_STARTUP_STDERR_MAX_BYTES,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROCESS_CLEANUP_TIMEOUT_MS,
    windowsHide: true,
  });
  const probeErrorCode = (probe.error as NodeJS.ErrnoException | undefined)?.code;
  task4NonAuthoritativeStageDetail =
    probe.error !== undefined
      ? probeErrorCode === "ETIMEDOUT"
        ? "powershell-spawn-timeout"
        : probeErrorCode === "ENOBUFS"
          ? "powershell-spawn-buffer"
          : probeErrorCode === "ENOENT"
            ? "powershell-spawn-missing"
            : probeErrorCode === "EACCES"
              ? "powershell-spawn-denied"
              : probeErrorCode === "EINVAL"
                ? "powershell-spawn-invalid"
                : "powershell-spawn-other"
      : probe.signal !== null
        ? "powershell-signal"
        : probe.stdout !== ""
          ? "powershell-stdout"
          : probe.stderr !== ""
            ? "powershell-stderr"
            : probe.status === 0
              ? "powershell-status-absent"
              : probe.status === 2
                ? "powershell-status-present"
                : probe.status === 3
                  ? "powershell-status-error"
                  : "powershell-status-unknown";
  assert.equal(probe.error, undefined);
  assert.equal(probe.signal, null);
  assert.equal(probe.stdout, "");
  assert.equal(probe.stderr, "");
  assert.ok(probe.status === 0 || probe.status === 2 || probe.status === 3);
  return probe.status;
}

function assertNativePipeAbsent(endpoint: string): void {
  assert.equal(runNativePipeProbe(endpoint), 0);
}

function assertNativePipePresent(endpoint: string): void {
  assert.equal(runNativePipeProbe(endpoint), 2);
}

async function assertPipeUnavailable(endpoint: string): Promise<void> {
  assertNativePipeAbsent(endpoint);
  await assert.rejects(
    requestControl({
      endpoint,
      operation: "runtime.status",
      input: {},
      requestId: `windows-control-unavailable-${randomUUID()}`,
      timeoutMs: 250,
    }),
  );
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

interface PendingTrackedServer {
  readonly broker: OwnedChild | undefined;
  readonly endpoint: string;
  readonly server: ControlServer | undefined;
}

async function rollbackTrackedServerAcquisition(
  pending: PendingTrackedServer,
  primary: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  if (pending.server !== undefined) {
    try {
      await withDeadline(pending.server.close(), PROCESS_CLEANUP_TIMEOUT_MS);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (pending.broker !== undefined) {
    try {
      const { child } = pending.broker;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await withDeadline(pending.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await assertPipeUnavailable(pending.endpoint);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primary, ...cleanupErrors],
      "Windows tracked server acquisition rollback failed",
    );
  }
  throw primary;
}

function brokerArgumentsForParent(args: readonly string[], watchedParent?: OwnedChild): string[] {
  const brokerArguments = [...args];
  if (watchedParent === undefined) return brokerArguments;
  const parentProcessIdIndexes = brokerArguments.flatMap((argument, index) =>
    argument === "-ParentProcessId" ? [index] : [],
  );
  assert.deepEqual(parentProcessIdIndexes, [9]);
  const parentProcessIdIndex = parentProcessIdIndexes[0] as number;
  assert.equal(brokerArguments[parentProcessIdIndex + 1], String(process.pid));
  const watchedProcessId = watchedParent.child.pid;
  assert.ok(Number.isSafeInteger(watchedProcessId) && (watchedProcessId ?? 0) > 0);
  assert.equal(watchedParent.child.exitCode, null);
  assert.equal(watchedParent.child.signalCode, null);
  brokerArguments[parentProcessIdIndex + 1] = String(watchedProcessId);
  return brokerArguments;
}

async function startTrackedServer(
  label: string,
  watchedParent?: OwnedChild,
): Promise<TrackedServer> {
  const endpoint = `\\\\.\\pipe\\tego-windows-control-${label}-${process.pid}-${randomUUID()}`;
  const failed = Promise.withResolvers<Error>();
  let broker: OwnedChild | undefined;
  let descriptor: WindowsBrokerSecurityDescriptor | undefined;
  let server: ControlServer | undefined;
  try {
    server = await startControlServer({
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
            const spawned = spawn(command, brokerArgumentsForParent(args, watchedParent), {
              shell: false,
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            });
            broker = ownChild(spawned);
            return spawned as never;
          },
        });
      },
    });
    assert.ok(broker !== undefined);
    assert.ok(Number.isSafeInteger(broker.child.pid) && (broker.child.pid ?? 0) > 0);
    assert.ok(descriptor !== undefined);
    assertDescriptor(descriptor);
    return {
      broker,
      descriptor,
      endpoint,
      failure: failed.promise,
      server,
    };
  } catch (primary) {
    return await rollbackTrackedServerAcquisition({ broker, endpoint, server }, primary);
  }
}

async function cleanupTrackedServer(tracked: TrackedServer): Promise<void> {
  try {
    await withDeadline(tracked.server.close(), PROCESS_CLEANUP_TIMEOUT_MS);
  } catch {}
  if (tracked.broker.child.exitCode === null && tracked.broker.child.signalCode === null) {
    tracked.broker.child.kill("SIGKILL");
  }
  await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);
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
  _stage: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    process.stderr.write(
      `${task4NonAuthoritativeStagePrefix}:${_stage}:${task4NonAuthoritativeStageDetail}\n`,
    );
    throw error;
  }
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
  task4NonAuthoritativeStageDetail = "status-request";
  assert.ok(liveServer !== undefined);
  await assertStatus(liveServer.endpoint, "windows-control-gate-status");
  assertNativePipePresent(liveServer.endpoint);
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
    await writeMalformedFrame(tracked.broker.child);
    const failure = await withDeadline(tracked.failure, PROCESS_CLEANUP_TIMEOUT_MS);
    assert.match(failure.message, /PROTOCOL_CONTROL_ENDPOINT_UNSAFE/u);
    await assert.rejects(tracked.server.close(), (error: unknown) =>
      isExpectedMalformedServerClose(error, failure),
    );
    await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);
    await assertPipeUnavailable(tracked.endpoint);
    tracked = undefined;
  } finally {
    if (tracked !== undefined) await cleanupTrackedServer(tracked);
  }
}

async function runParentCrashFixture(): Promise<void> {
  if (process.send === undefined) throw new Error("Windows parent fixture requires IPC");
  const nonce = requiredEnvironment("TEGO_WINDOWS_PARENT_FIXTURE_NONCE");
  assert.match(nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const stopped = Promise.withResolvers<never>();
  let challengeSeen = false;
  process.on("message", (message) => {
    if (!isParentFixtureChallenge(message, nonce) || challengeSeen) {
      stopped.reject(new Error("Windows parent fixture received invalid IPC"));
      return;
    }
    challengeSeen = true;
    process.send?.({ nonce, type: "ack" } satisfies ParentFixtureAcknowledgement, (error) => {
      if (error !== null) stopped.reject(new Error("Windows parent fixture IPC failed"));
    });
  });
  process.once("disconnect", () =>
    stopped.reject(new Error("Windows parent fixture IPC disconnected")),
  );
  await new Promise<void>((resolveSend, rejectSend) => {
    process.send?.(
      {
        nonce,
        parentPid: process.pid,
        type: "ready",
      } satisfies ParentFixtureReady,
      (error) => (error === null ? resolveSend() : rejectSend(error)),
    );
  });
  await stopped.promise;
}

function isParentFixtureReady(value: unknown, nonce: string): value is ParentFixtureReady {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ParentFixtureReady>;
  return (
    Object.keys(value).sort().join(",") === "nonce,parentPid,type" &&
    candidate.type === "ready" &&
    candidate.nonce === nonce &&
    Number.isSafeInteger(candidate.parentPid) &&
    (candidate.parentPid ?? 0) > 0
  );
}

function isParentFixtureChallenge(value: unknown, nonce: string): value is ParentFixtureChallenge {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ParentFixtureChallenge>;
  return (
    Object.keys(value).sort().join(",") === "nonce,type" &&
    candidate.type === "challenge" &&
    candidate.nonce === nonce
  );
}

function isParentFixtureAcknowledgement(
  value: unknown,
  nonce: string,
): value is ParentFixtureAcknowledgement {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ParentFixtureAcknowledgement>;
  return (
    Object.keys(value).sort().join(",") === "nonce,type" &&
    candidate.type === "ack" &&
    candidate.nonce === nonce
  );
}

async function waitForParentFixtureMessage<T>(
  fixture: OwnedChild,
  isExpected: (value: unknown) => value is T,
): Promise<T> {
  const received = Promise.withResolvers<unknown>();
  const onMessage = (message: unknown) => received.resolve(message);
  fixture.child.once("message", onMessage);
  try {
    const message = await withDeadline(
      Promise.race([
        received.promise,
        fixture.spawnError.then(() => {
          throw new Error("Windows parent fixture failed");
        }),
        fixture.closed.then(() => {
          throw new Error("Windows parent fixture exited early");
        }),
      ]),
      PROCESS_CLEANUP_TIMEOUT_MS,
    );
    if (!isExpected(message)) throw new Error("Windows parent fixture emitted invalid IPC");
    return message;
  } finally {
    fixture.child.off("message", onMessage);
  }
}

async function sendParentFixtureChallenge(fixture: OwnedChild, nonce: string): Promise<void> {
  assert.equal(fixture.child.connected, true);
  await withDeadline(
    new Promise<void>((resolveSend, rejectSend) => {
      fixture.child.send({ nonce, type: "challenge" } satisfies ParentFixtureChallenge, (error) =>
        error === null ? resolveSend() : rejectSend(new Error("Windows parent fixture IPC failed")),
      );
    }),
    PROCESS_CLEANUP_TIMEOUT_MS,
  );
}

async function cleanupOwnedChild(owned: OwnedChild): Promise<void> {
  let killError: unknown;
  try {
    if (owned.child.exitCode === null && owned.child.signalCode === null) {
      owned.child.kill("SIGKILL");
    }
  } catch (error) {
    killError = error;
  }
  let closeError: unknown;
  try {
    await withDeadline(owned.closed, PROCESS_CLEANUP_TIMEOUT_MS);
  } catch (error) {
    closeError = error;
  }
  if (killError !== undefined && closeError !== undefined) {
    throw new AggregateError([killError, closeError], "Windows child cleanup failed");
  }
  if (killError !== undefined) throw killError;
  if (closeError !== undefined) throw closeError;
}

async function cleanupParentCrashOwners(
  tracked: TrackedServer | undefined,
  fixture: OwnedChild | undefined,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (tracked !== undefined) {
    try {
      await cleanupTrackedServer(tracked);
    } catch (error) {
      errors.push(error);
    }
  }
  if (fixture !== undefined) {
    try {
      await cleanupOwnedChild(fixture);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function runParentCrashCleanup(): Promise<void> {
  const nonce = randomUUID();
  const spawnedFixture = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--parent-crash-fixture"],
    {
      env: { ...process.env, NODE_PATH: "", TEGO_WINDOWS_PARENT_FIXTURE_NONCE: nonce },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  let fixture: OwnedChild | undefined = ownChild(spawnedFixture);
  const fixtureStdout: Buffer[] = [];
  const fixtureStderr: Buffer[] = [];
  let fixtureOutputBytes = 0;
  const captureFixtureOutput = (target: Buffer[], chunk: Buffer): void => {
    fixtureOutputBytes += chunk.length;
    if (fixtureOutputBytes <= POWERSHELL_STARTUP_STDERR_MAX_BYTES) target.push(chunk);
    else spawnedFixture.kill("SIGKILL");
  };
  spawnedFixture.stdout?.on("data", (chunk: Buffer) => captureFixtureOutput(fixtureStdout, chunk));
  spawnedFixture.stderr?.on("data", (chunk: Buffer) => captureFixtureOutput(fixtureStderr, chunk));
  let tracked: TrackedServer | undefined;
  let primary: unknown;
  let primaryFailed = false;
  try {
    const ready = await waitForParentFixtureMessage(fixture, (value): value is ParentFixtureReady =>
      isParentFixtureReady(value, nonce),
    );
    assert.equal(ready.parentPid, fixture.child.pid);
    tracked = await startTrackedServer("parent-crash", fixture);
    await assertStatus(tracked.endpoint, "windows-control-gate-parent-crash-status");
    assert.equal(tracked.broker.child.exitCode, null);
    assert.equal(tracked.broker.child.signalCode, null);
    assert.equal(tracked.broker.child.stdin?.writableEnded, false);
    assert.equal(tracked.broker.child.stdin?.destroyed, false);
    const acknowledged = waitForParentFixtureMessage(
      fixture,
      (value): value is ParentFixtureAcknowledgement =>
        isParentFixtureAcknowledgement(value, nonce),
    );
    await sendParentFixtureChallenge(fixture, nonce);
    await acknowledged;
    assert.equal(fixture.child.exitCode, null);
    assert.equal(fixture.child.signalCode, null);
    assert.equal(fixture.child.kill("SIGKILL"), true);
    await withDeadline(fixture.closed, PROCESS_CLEANUP_TIMEOUT_MS);
    assert.equal(fixture.child.stdout?.readableEnded, true);
    assert.equal(fixture.child.stderr?.readableEnded, true);
    assert.equal(fixtureOutputBytes, 0);
    assert.equal(Buffer.concat(fixtureStdout).length, 0);
    assert.equal(Buffer.concat(fixtureStderr).length, 0);
    fixture = undefined;
    const failure = await withDeadline(tracked.failure, PROCESS_CLEANUP_TIMEOUT_MS);
    assert.match(failure.message, /PROTOCOL_CONTROL_ENDPOINT_UNSAFE/u);
    await assert.rejects(tracked.server.close(), (error: unknown) =>
      isExpectedMalformedServerClose(error, failure),
    );
    await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);
    await assertPipeUnavailable(tracked.endpoint);
    tracked = undefined;
  } catch (error) {
    primary = error;
    primaryFailed = true;
  }
  const cleanupErrors = await cleanupParentCrashOwners(tracked, fixture);
  if (primaryFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primary, ...cleanupErrors], "Windows parent crash gate failed");
    }
    throw primary;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Windows parent crash cleanup failed");
  }
}

async function runBrokerCrashCleanup(): Promise<void> {
  let tracked: TrackedServer | undefined = await startTrackedServer("broker-crash");
  try {
    assert.equal(tracked.broker.child.kill("SIGKILL"), true);
    const failure = await withDeadline(tracked.failure, PROCESS_CLEANUP_TIMEOUT_MS);
    assert.match(failure.message, /PROTOCOL_CONTROL_ENDPOINT_UNSAFE/u);
    await assert.rejects(tracked.server.close(), (error: unknown) =>
      isExpectedMalformedServerClose(error, failure),
    );
    await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);
    await assertPipeUnavailable(tracked.endpoint);
    tracked = undefined;
  } finally {
    if (tracked !== undefined) await cleanupTrackedServer(tracked);
  }
}

async function runReconnectFailure(): Promise<void> {
  assert.ok(liveServer !== undefined);
  const tracked = liveServer;
  try {
    await tracked.server.close();
    await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);
    await assertPipeUnavailable(tracked.endpoint);
    assert.equal(liveServer, tracked);
    liveServer = undefined;
  } finally {
    if (liveServer === tracked) {
      await cleanupTrackedServer(tracked);
      liveServer = undefined;
    }
  }
}

async function runTwentyLifecycleRounds(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    let tracked: TrackedServer | undefined = await startTrackedServer(`round-${String(round)}`);
    try {
      await assertStatus(tracked.endpoint, `windows-control-gate-round-${String(round)}`);
      await tracked.server.close();
      await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);
      await assertPipeUnavailable(tracked.endpoint);
      tracked = undefined;
    } finally {
      if (tracked !== undefined) await cleanupTrackedServer(tracked);
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
    if (liveServer !== undefined) {
      const owned = liveServer;
      try {
        await cleanupTrackedServer(owned);
        if (liveServer === owned) liveServer = undefined;
      } catch {}
    }
    process.stderr.write(`${WINDOWS_CONTROL_GATE_FAILURE}\n`);
    process.exitCode = 1;
  }
}
