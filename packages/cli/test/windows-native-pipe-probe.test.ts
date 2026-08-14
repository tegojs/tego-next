import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  startWindowsNativePipeProbe,
  WindowsNativePipeProbeClient,
} from "./windows-control-gate.js";

const endpoint = String.raw`\\.\pipe\tego-windows-control-test-123-01234567-89ab-4cde-8fab-0123456789ab`;

class FakeProbeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  beginExit(exitCode: number | null, signalCode: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = exitCode;
    this.signalCode = signalCode;
    this.emit("exit", exitCode, signalCode);
  }

  settleClose(): void {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", this.exitCode, this.signalCode));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    this.beginExit(null, signal);
    return true;
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

async function startedClient(timeoutMs = 100): Promise<{
  child: FakeProbeChild;
  client: WindowsNativePipeProbeClient;
}> {
  const child = new FakeProbeChild();
  const client = new WindowsNativePipeProbeClient(child.asChildProcess(), timeoutMs);
  return { child, client };
}

async function nextRequestFrame(child: FakeProbeChild): Promise<Buffer> {
  const [chunk] = (await once(child.stdin, "data")) as [Buffer];
  return chunk;
}

function assertRequestFrame(frame: Buffer, expectedEndpoint = endpoint): void {
  const payload = Buffer.from(expectedEndpoint, "utf8");
  assert.equal(frame.length, 4 + payload.length);
  assert.equal(frame.readUInt32LE(0), payload.length);
  assert.deepEqual(frame.subarray(4), payload);
}

async function waitImmediate(): Promise<void> {
  await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
}

async function settlesImmediately(promise: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    waitImmediate().then(() => false),
  ]);
}

async function closeCleanly(
  child: FakeProbeChild,
  client: WindowsNativePipeProbeClient,
): Promise<void> {
  child.stdin.once("finish", () => child.beginExit(0, null));
  const closing = client.close(100);
  await once(child.stdin, "finish");
  assert.equal(await settlesImmediately(closing), false);
  child.settleClose();
  await closing;
}

async function settleForcedClose(child: FakeProbeChild, cleanup: Promise<void>): Promise<void> {
  assert.equal(await settlesImmediately(cleanup), false);
  child.settleClose();
  await cleanup;
}

test("persistent Windows pipe probe sends exact binary requests and responses", async () => {
  const { child, client } = await startedClient();
  const request = client.probe(endpoint);
  assertRequestFrame(await nextRequestFrame(child));
  child.stdout.write(Buffer.from([2]));
  assert.equal(await request, 2);

  await closeCleanly(child, client);
  assert.deepEqual(child.killSignals, []);
});

test("persistent Windows pipe probe serializes twenty requests without respawning", async () => {
  const child = new FakeProbeChild();
  let spawnCalls = 0;
  let capturedArguments: readonly string[] = [];
  const starting = startWindowsNativePipeProbe({
    requestTimeoutMs: 100,
    resolveLaunch: async () => ({
      environment: {
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Temp",
        TMP: "C:\\Temp",
        WINDIR: "C:\\Windows",
      },
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    }),
    spawnProbe: ((command: string, args: readonly string[], options: unknown) => {
      spawnCalls += 1;
      capturedArguments = args;
      assert.equal(command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.deepEqual(options, {
        env: {
          SystemRoot: "C:\\Windows",
          TEMP: "C:\\Temp",
          TMP: "C:\\Temp",
          WINDIR: "C:\\Windows",
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      return child.asChildProcess();
    }) as typeof import("node:child_process").spawn,
    startupEndpoint: endpoint.replace("-test-", "-probe-startup-"),
    startupTimeoutMs: 100,
  });
  assertRequestFrame(await nextRequestFrame(child), endpoint.replace("-test-", "-probe-startup-"));
  child.stdout.write(Buffer.from([0]));
  const client = await starting;
  assert.deepEqual(capturedArguments.slice(0, 6), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
  ]);
  assert.equal(capturedArguments.length, 7);
  const encodedProbeSource = capturedArguments[6];
  assert.ok(encodedProbeSource !== undefined);
  assert.ok(
    Buffer.from(encodedProbeSource, "base64")
      .toString("utf16le")
      .includes(String.raw`@"^\\\\[.]\\pipe\\tego-windows-control-`),
  );
  assert.doesNotMatch(capturedArguments.join(" "), /tego-windows-control-probe-startup/u);
  for (let round = 0; round < 20; round += 1) {
    const roundEndpoint = endpoint.replace("-test-", `-round-${String(round)}-`);
    const request = client.probe(roundEndpoint);
    assertRequestFrame(await nextRequestFrame(child), roundEndpoint);
    child.stdout.write(Buffer.from([round % 2 === 0 ? 0 : 2]));
    assert.equal(await request, round % 2 === 0 ? 0 : 2);
  }
  assert.equal(spawnCalls, 1);
  await closeCleanly(child, client);
});

test("persistent Windows pipe probe keeps concurrent callers in request order", async () => {
  const { child, client } = await startedClient();
  const firstEndpoint = endpoint.replace("-test-", "-first-");
  const secondEndpoint = endpoint.replace("-test-", "-second-");
  const first = client.probe(firstEndpoint);
  const second = client.probe(secondEndpoint);
  assertRequestFrame(await nextRequestFrame(child), firstEndpoint);
  child.stdout.write(Buffer.from([2]));
  assert.equal(await first, 2);
  assertRequestFrame(await nextRequestFrame(child), secondEndpoint);
  child.stdout.write(Buffer.from([0]));
  assert.equal(await second, 0);
  await closeCleanly(child, client);
});

test("persistent Windows pipe probe fails the active request and future work on stderr", async () => {
  const { child, client } = await startedClient(50);
  const pending = client.probe(endpoint);
  await nextRequestFrame(child);
  child.stderr.write(Buffer.from("unexpected"));
  await assert.rejects(pending);
  await assert.rejects(client.probe(endpoint));
  const cleanup = client.forceClose(50);
  await settleForcedClose(child, cleanup);
  assert.deepEqual(child.killSignals, ["SIGKILL"]);
});

test("persistent Windows pipe probe rejects a valid response coalesced with extra stdout", async () => {
  const { child, client } = await startedClient();
  const request = client.probe(endpoint);
  await nextRequestFrame(child);
  child.stdout.write(Buffer.from([0, 2]));
  await assert.rejects(request);
  const cleanup = client.forceClose(50);
  await settleForcedClose(child, cleanup);
  assert.deepEqual(child.killSignals, ["SIGKILL"]);
});

test("persistent Windows pipe probe rejects malformed response bytes", async () => {
  const { child, client } = await startedClient();
  const request = client.probe(endpoint);
  await nextRequestFrame(child);
  child.stdout.write(Buffer.from([9]));
  await assert.rejects(request);
  const cleanup = client.forceClose(50);
  await settleForcedClose(child, cleanup);
  assert.deepEqual(child.killSignals, ["SIGKILL"]);
});

test("persistent Windows pipe probe poisons timed out requests", async () => {
  const { child, client } = await startedClient(20);
  const request = client.probe(endpoint);
  await nextRequestFrame(child);
  await assert.rejects(request);
  await assert.rejects(client.probe(endpoint));
  const cleanup = client.forceClose(50);
  await settleForcedClose(child, cleanup);
  assert.deepEqual(child.killSignals, ["SIGKILL"]);
});

test("persistent Windows pipe probe rejects a crashed helper and awaits forced cleanup", async () => {
  const { child, client } = await startedClient();
  const request = client.probe(endpoint);
  await nextRequestFrame(child);
  child.beginExit(1, null);
  assert.equal(await settlesImmediately(request), false);
  child.settleClose();
  await assert.rejects(request);
  await client.forceClose(50);
  assert.deepEqual(child.killSignals, []);
});

test("persistent Windows pipe probe rejects invalid endpoints before writing", async () => {
  const { child, client } = await startedClient();
  const writes: Buffer[] = [];
  child.stdin.on("data", (chunk: Buffer) => writes.push(chunk));
  await assert.rejects(client.probe(String.raw`\\.\pipe\untrusted`));
  assert.deepEqual(writes, []);
  const cleanup = client.forceClose(50);
  await settleForcedClose(child, cleanup);
});

for (const startupResponse of [2, 3, 9] as const) {
  test(`persistent Windows pipe probe rejects startup response ${String(startupResponse)}`, async () => {
    const child = new FakeProbeChild();
    const starting = startWindowsNativePipeProbe({
      resolveLaunch: async () => ({ environment: {}, executable: "fixed-powershell.exe" }),
      spawnProbe: (() => child.asChildProcess()) as typeof import("node:child_process").spawn,
      startupEndpoint: endpoint.replace("-test-", "-probe-startup-"),
      startupTimeoutMs: 50,
    });
    await nextRequestFrame(child);
    child.stdout.write(Buffer.from([startupResponse]));
    assert.equal(await settlesImmediately(starting), false);
    child.settleClose();
    await assert.rejects(starting);
    assert.deepEqual(child.killSignals, ["SIGKILL"]);
  });
}

test("persistent Windows pipe probe startup timeout kills and awaits the captured close", async () => {
  const child = new FakeProbeChild();
  const starting = startWindowsNativePipeProbe({
    resolveLaunch: async () => ({ environment: {}, executable: "fixed-powershell.exe" }),
    spawnProbe: (() => child.asChildProcess()) as typeof import("node:child_process").spawn,
    startupEndpoint: endpoint.replace("-test-", "-probe-startup-"),
    startupTimeoutMs: 20,
  });
  await nextRequestFrame(child);
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30));
  assert.deepEqual(child.killSignals, ["SIGKILL"]);
  assert.equal(await settlesImmediately(starting), false);
  child.stdout.write(Buffer.from([0]));
  child.settleClose();
  await assert.rejects(starting);
});
