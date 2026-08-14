import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { isAbsolute } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { setImmediate as waitImmediate } from "node:timers/promises";
import {
  createWindowsControlBroker,
  type WindowsBrokerChildProcess,
  type WindowsBrokerSpawnOptions,
} from "../src/control/windows-broker.js";
import {
  encodeWindowsBrokerFrame,
  type WindowsBrokerFrame,
  WindowsBrokerFrameDecoder,
} from "../src/control/windows-broker-protocol.js";
import {
  decodeWindowsBrokerReadyDescriptor,
  WINDOWS_ADMINISTRATORS_SID,
  WINDOWS_BROKER_DESCRIPTOR_VERSION,
  WINDOWS_PIPE_FULL_CONTROL,
  WINDOWS_SYSTEM_SID,
} from "../src/control/windows-broker-security.js";

const TEST_WINDOWS_USER_SID = "S-1-5-21-1000-1000-1000-1001";
const UNSAFE = /PROTOCOL_CONTROL_ENDPOINT_UNSAFE/u;

interface FakeBrokerChild extends WindowsBrokerChildProcess {
  readonly kills: (NodeJS.Signals | number | undefined)[];
  readonly stderr: PassThrough;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  beginExit(code?: number | null, signal?: NodeJS.Signals | null): void;
  exit(code?: number | null, signal?: NodeJS.Signals | null): void;
  settleClose(): void;
}

function createFakeBrokerChild(options: { readonly exitOnKill?: boolean } = {}): FakeBrokerChild {
  const child = new EventEmitter() as FakeBrokerChild;
  Object.assign(child, {
    exitCode: null,
    killed: false,
    kills: [] as (NodeJS.Signals | number | undefined)[],
    pid: 4242,
    signalCode: null,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
  let exitStarted = false;
  let closed = false;
  child.beginExit = (code = 0, signal = null) => {
    if (exitStarted) return;
    exitStarted = true;
    Object.assign(child, { exitCode: code, signalCode: signal });
    child.emit("exit", code, signal);
  };
  child.settleClose = () => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
    setImmediate(() => child.emit("close", child.exitCode, child.signalCode));
  };
  child.exit = (code = 0, signal = null) => {
    child.beginExit(code, signal);
    child.settleClose();
  };
  child.kill = (signal) => {
    child.kills.push(signal);
    Object.assign(child, { killed: true });
    child.emit("kill", signal);
    if (options.exitOnKill !== false) {
      setImmediate(() => child.exit(null, typeof signal === "string" ? signal : "SIGTERM"));
    }
    return true;
  };
  return child;
}

function encodeReadyDescriptor(
  options: {
    readonly aceSids?: readonly string[];
    readonly callbackIndex?: number;
    readonly inheritedIndex?: number;
    readonly maskIndex?: number;
    readonly ownerSid?: string;
    readonly protectedDacl?: boolean;
    readonly trailing?: Uint8Array;
    readonly version?: number;
  } = {},
): Buffer {
  const ownerSid = options.ownerSid ?? TEST_WINDOWS_USER_SID;
  const aceSids = options.aceSids ?? [ownerSid, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID];
  const owner = Buffer.from(ownerSid, "ascii");
  const aces = aceSids.map((sid, index) => {
    const encodedSid = Buffer.from(sid, "ascii");
    const encoded = Buffer.alloc(12 + encodedSid.byteLength);
    encoded[0] = 1;
    encoded[1] = options.inheritedIndex === index ? 1 : 0;
    encoded[2] = options.callbackIndex === index ? 1 : 0;
    encoded.writeUInt32BE(options.maskIndex === index ? 3 : WINDOWS_PIPE_FULL_CONTROL, 4);
    encoded.writeUInt16BE(encodedSid.byteLength, 8);
    encodedSid.copy(encoded, 12);
    return encoded;
  });
  const header = Buffer.alloc(12);
  header.write("TGSD", 0, "ascii");
  header.writeUInt16BE(options.version ?? WINDOWS_BROKER_DESCRIPTOR_VERSION, 4);
  header.writeUInt16BE(options.protectedDacl === false ? 0 : 1, 6);
  header.writeUInt16BE(owner.byteLength, 8);
  header.writeUInt16BE(aces.length, 10);
  return Buffer.concat([header, owner, ...aces, options.trailing ?? new Uint8Array()]);
}

function brokerFrame(
  type: WindowsBrokerFrame["type"],
  connectionId = 0n,
  payload: Uint8Array = new Uint8Array(),
): Buffer {
  return encodeWindowsBrokerFrame({ connectionId, payload, type });
}

function collectParentFrames(child: FakeBrokerChild): WindowsBrokerFrame[] {
  const decoder = new WindowsBrokerFrameDecoder();
  const frames: WindowsBrokerFrame[] = [];
  child.stdin.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  return frames;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await waitImmediate();
  }
  assert.fail("condition did not become true");
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

function createStartedBroker(
  child = createFakeBrokerChild(),
  overrides: Partial<Parameters<typeof createWindowsControlBroker>[0]> = {},
) {
  const stages: string[] = [];
  const broker = createWindowsControlBroker({
    endpoint: "\\\\.\\pipe\\tego-broker-test",
    maxConnections: 4,
    maxQueuedBytes: 256 * 1024,
    onFailureStage: (stage) => stages.push(stage),
    spawnBroker: () => child,
    startupTimeoutMs: 50,
    shutdownTimeoutMs: 50,
    ...overrides,
  });
  const startup = broker.start();
  child.stdout.write(brokerFrame("ready", 0n, encodeReadyDescriptor()));
  return { broker, child, stages, startup };
}

async function closeGracefully(
  broker: ReturnType<typeof createWindowsControlBroker>,
  child: FakeBrokerChild,
  frames: WindowsBrokerFrame[],
): Promise<void> {
  const closing = broker.close();
  await eventually(() => frames.some(({ type }) => type === "close-all"));
  child.stdout.write(brokerFrame("close-all-ack"));
  child.exit();
  await closing;
}

test("READY descriptor is a strict canonical versioned binary readback", () => {
  assert.deepEqual(decodeWindowsBrokerReadyDescriptor(encodeReadyDescriptor()), {
    accessRules: [TEST_WINDOWS_USER_SID, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID].map(
      (sid) => ({
        accessMask: WINDOWS_PIPE_FULL_CONTROL,
        callback: false,
        inherited: false,
        sid,
        type: "allow" as const,
      }),
    ),
    ownerSid: TEST_WINDOWS_USER_SID,
    protectedDacl: true,
  });

  for (const invalid of [
    encodeReadyDescriptor({ version: WINDOWS_BROKER_DESCRIPTOR_VERSION + 1 }),
    encodeReadyDescriptor({ protectedDacl: false }),
    encodeReadyDescriptor({ ownerSid: "not-a-sid" }),
    encodeReadyDescriptor({ aceSids: [TEST_WINDOWS_USER_SID, WINDOWS_ADMINISTRATORS_SID] }),
    encodeReadyDescriptor({
      aceSids: [TEST_WINDOWS_USER_SID, WINDOWS_ADMINISTRATORS_SID, WINDOWS_SYSTEM_SID],
    }),
    encodeReadyDescriptor({ inheritedIndex: 0 }),
    encodeReadyDescriptor({ callbackIndex: 0 }),
    encodeReadyDescriptor({ maskIndex: 0 }),
    encodeReadyDescriptor({ trailing: Uint8Array.of(0) }),
  ]) {
    assert.throws(() => decodeWindowsBrokerReadyDescriptor(invalid), UNSAFE);
  }

  const wrongMagic = encodeReadyDescriptor();
  wrongMagic.write("FAIL", 0, "ascii");
  assert.throws(() => decodeWindowsBrokerReadyDescriptor(wrongMagic), UNSAFE);

  const maximumSid = `S-1-281474976710655-${Array.from({ length: 15 }, (_, index) => index).join("-")}`;
  assert.equal(
    decodeWindowsBrokerReadyDescriptor(encodeReadyDescriptor({ ownerSid: maximumSid })).ownerSid,
    maximumSid,
  );
  for (const invalidSid of [
    "s-1-5-21",
    "S-2-5-21",
    "S-01-5-21",
    "S-1-05-21",
    "S-1-281474976710656-1",
    "S-1-5",
    "S-1-5-01",
    "S-1-5-4294967296",
    `S-1-5-${Array.from({ length: 16 }, (_, index) => index).join("-")}`,
  ]) {
    assert.throws(
      () => decodeWindowsBrokerReadyDescriptor(encodeReadyDescriptor({ ownerSid: invalidSid })),
      UNSAFE,
    );
  }
});

test("broker spawn uses the packaged absolute script and fixed shell-free PowerShell arguments", async () => {
  const child = createFakeBrokerChild();
  let invocation:
    | {
        readonly args: readonly string[];
        readonly command: string;
        readonly options: WindowsBrokerSpawnOptions;
      }
    | undefined;
  const broker = createWindowsControlBroker({
    endpoint: "\\\\.\\pipe\\tego-fixed-spawn",
    maxConnections: 4,
    maxQueuedBytes: 1024,
    spawnBroker(command, args, options) {
      invocation = { args, command, options };
      return child;
    },
    startupTimeoutMs: 50,
  });
  const startup = broker.start();
  child.stdout.write(brokerFrame("ready", 0n, encodeReadyDescriptor()));
  await startup;

  assert.ok(invocation !== undefined);
  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.options, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  assert.deepEqual(invocation.args.slice(0, 6), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
  ]);
  assert.equal(isAbsolute(invocation.args[6] ?? ""), true);
  assert.match(invocation.args[6] ?? "", /windows-control-broker\.ps1$/u);
  assert.deepEqual(invocation.args.slice(7), [
    "-Endpoint",
    "\\\\.\\pipe\\tego-fixed-spawn",
    "-ParentProcessId",
    String(process.pid),
    "-ProtocolVersion",
    "1",
  ]);

  const frames = collectParentFrames(child);
  await closeGracefully(broker, child, frames);
});

test("broker converts OPEN/DATA/EOF and virtual connection response DATA/CLOSE frames", async () => {
  const { broker, child, startup } = createStartedBroker();
  const parentFrames = collectParentFrames(child);
  let connection: Parameters<Parameters<typeof broker.onConnection>[0]>[0] | undefined;
  broker.onConnection((accepted) => {
    connection = accepted;
  });
  await startup;
  child.stdout.write(brokerFrame("open", 7n));
  assert.ok(connection !== undefined);
  const received: Buffer[] = [];
  connection.on("data", (chunk: Buffer) => received.push(chunk));
  const ended = once(connection, "end");
  child.stdout.write(
    Buffer.concat([brokerFrame("data", 7n, Buffer.from("request")), brokerFrame("eof", 7n)]),
  );
  await ended;
  assert.equal(Buffer.concat(received).toString("utf8"), "request");

  const closed = once(connection, "close");
  connection.end("response");
  await closed;
  await eventually(() => parentFrames.some(({ type }) => type === "close"));
  assert.deepEqual(
    parentFrames
      .filter(({ connectionId }) => connectionId === 7n)
      .map(({ payload, type }) => ({
        payload: Buffer.from(payload).toString("utf8"),
        type,
      })),
    [
      { payload: "response", type: "data" },
      { payload: "", type: "close" },
    ],
  );
  await closeGracefully(broker, child, parentFrames);
});

test("broker-first CLOSE promptly queues one parent acknowledgement without poisoning later connections", async () => {
  const { broker, child, startup } = createStartedBroker();
  const parentFrames = collectParentFrames(child);
  const connections: Parameters<Parameters<typeof broker.onConnection>[0]>[0][] = [];
  const failures: Error[] = [];
  broker.onConnection((connection) => connections.push(connection));
  broker.onError((error) => failures.push(error));
  await startup;

  child.stdout.write(brokerFrame("open", 11n));
  const first = connections[0];
  assert.ok(first !== undefined);
  first.write("response");
  await eventually(() =>
    parentFrames.some(({ connectionId, type }) => connectionId === 11n && type === "data"),
  );
  child.stdout.write(brokerFrame("close", 11n));
  await eventually(() =>
    parentFrames.some(({ connectionId, type }) => connectionId === 11n && type === "close"),
  );
  assert.equal(
    parentFrames.filter(({ connectionId, type }) => connectionId === 11n && type === "close")
      .length,
    1,
  );

  child.stdout.write(brokerFrame("open", 12n));
  const second = connections[1];
  assert.ok(second !== undefined);
  const received: Buffer[] = [];
  second.on("data", (chunk: Buffer) => received.push(chunk));
  const ended = once(second, "end");
  child.stdout.write(
    Buffer.concat([brokerFrame("data", 12n, Buffer.from("healthy")), brokerFrame("eof", 12n)]),
  );
  await ended;
  assert.equal(Buffer.concat(received).toString("utf8"), "healthy");
  assert.deepEqual(failures, []);

  child.stdout.write(brokerFrame("close", 12n));
  await closeGracefully(broker, child, parentFrames);
});

test("parent-first CLOSE accepts a late broker acknowledgement after the Duplex is removed", async () => {
  const { broker, child, startup } = createStartedBroker();
  const parentFrames = collectParentFrames(child);
  const connections: Parameters<Parameters<typeof broker.onConnection>[0]>[0][] = [];
  const failures: Error[] = [];
  broker.onConnection((connection) => connections.push(connection));
  broker.onError((error) => failures.push(error));
  await startup;

  child.stdout.write(brokerFrame("open", 21n));
  const first = connections[0];
  assert.ok(first !== undefined);
  const firstClosed = once(first, "close");
  first.end();
  await firstClosed;
  await eventually(() =>
    parentFrames.some(({ connectionId, type }) => connectionId === 21n && type === "close"),
  );

  child.stdout.write(brokerFrame("close", 21n));
  child.stdout.write(brokerFrame("open", 22n));
  await eventually(() => connections.length === 2 || failures.length > 0);
  assert.deepEqual(failures, []);
  assert.equal(connections.length, 2);

  child.stdout.write(brokerFrame("close", 22n));
  await eventually(() =>
    parentFrames.some(({ connectionId, type }) => connectionId === 22n && type === "close"),
  );
  await closeGracefully(broker, child, parentFrames);
});

test("64 parent-first closes retain admission until reciprocal broker acknowledgements", async () => {
  async function fillParentFirst(
    child: FakeBrokerChild,
    broker: ReturnType<typeof createWindowsControlBroker>,
    connections: Parameters<Parameters<typeof broker.onConnection>[0]>[0][],
    parentFrames: WindowsBrokerFrame[],
  ): Promise<void> {
    child.stdout.write(
      Buffer.concat(
        Array.from({ length: 64 }, (_, index) => brokerFrame("open", BigInt(index + 1))),
      ),
    );
    assert.equal(connections.length, 64);
    const closed = connections.map((connection) => once(connection, "close"));
    for (const connection of connections) connection.end();
    await Promise.all(closed);
    await eventually(() => parentFrames.filter(({ type }) => type === "close").length === 64);
  }

  const saturated = createStartedBroker(createFakeBrokerChild(), { maxConnections: 64 });
  const saturatedFrames = collectParentFrames(saturated.child);
  const saturatedConnections: Parameters<Parameters<typeof saturated.broker.onConnection>[0]>[0][] =
    [];
  const saturatedFailures: Error[] = [];
  saturated.broker.onConnection((connection) => saturatedConnections.push(connection));
  saturated.broker.onError((error) => saturatedFailures.push(error));
  await saturated.startup;
  await fillParentFirst(saturated.child, saturated.broker, saturatedConnections, saturatedFrames);
  saturated.child.stdout.write(brokerFrame("open", 65n));
  await eventually(() => saturatedConnections.length > 64 || saturatedFailures.length > 0);
  assert.equal(saturatedConnections.length, 64);
  assert.equal(saturatedFailures.length, 1);
  await assert.rejects(saturated.broker.close(), UNSAFE);

  const converging = createStartedBroker(createFakeBrokerChild(), { maxConnections: 64 });
  const convergingFrames = collectParentFrames(converging.child);
  const convergingConnections: Parameters<
    Parameters<typeof converging.broker.onConnection>[0]
  >[0][] = [];
  const convergingFailures: Error[] = [];
  converging.broker.onConnection((connection) => convergingConnections.push(connection));
  converging.broker.onError((error) => convergingFailures.push(error));
  await converging.startup;
  await fillParentFirst(
    converging.child,
    converging.broker,
    convergingConnections,
    convergingFrames,
  );

  converging.child.stdout.write(brokerFrame("close", 1n));
  converging.child.stdout.write(brokerFrame("open", 65n));
  await eventually(() => convergingConnections.length === 65 || convergingFailures.length > 0);
  assert.deepEqual(convergingFailures, []);
  assert.equal(convergingConnections.length, 65);

  converging.child.stdout.write(brokerFrame("close", 65n));
  await eventually(() =>
    convergingFrames.some(({ connectionId, type }) => connectionId === 65n && type === "close"),
  );
  await closeGracefully(converging.broker, converging.child, convergingFrames);
});

test("virtual connection propagates readable backpressure with PAUSE and RESUME", async () => {
  const { broker, child, startup } = createStartedBroker(createFakeBrokerChild(), {
    maxConnections: 2,
    maxQueuedBytes: 8,
  });
  const parentFrames = collectParentFrames(child);
  let connection: Parameters<Parameters<typeof broker.onConnection>[0]>[0] | undefined;
  broker.onConnection((accepted) => {
    connection = accepted;
  });
  await startup;
  child.stdout.write(brokerFrame("open", 1n));
  child.stdout.write(brokerFrame("data", 1n, Buffer.from("12345")));
  await eventually(() => parentFrames.some(({ type }) => type === "pause"));
  assert.ok(connection !== undefined);
  connection.resume();
  await eventually(() => parentFrames.some(({ type }) => type === "resume"));

  connection.destroy();
  await eventually(() => parentFrames.some(({ type }) => type === "close"));
  await closeGracefully(broker, child, parentFrames);
});

test("startup abort and READY timeout wait for child and stream settlement", async () => {
  for (const mode of ["abort", "timeout"] as const) {
    const child = createFakeBrokerChild({ exitOnKill: false });
    const controller = new AbortController();
    const broker = createWindowsControlBroker({
      endpoint: `\\\\.\\pipe\\tego-start-${mode}`,
      maxConnections: 1,
      maxQueuedBytes: 1024,
      shutdownTimeoutMs: 20,
      spawnBroker: () => child,
      startupTimeoutMs: mode === "timeout" ? 5 : 100,
    });
    const killed = once(child, "kill");
    const startup = broker.start(controller.signal);
    if (mode === "abort") controller.abort();
    await killed;
    assert.equal(await settlesImmediately(startup), false);
    child.exit(null, "SIGTERM");
    await assert.rejects(startup, mode === "abort" ? { name: "AbortError" } : UNSAFE);
    assert.equal(child.stdin.writableEnded, true);
    assert.equal(child.stdout.readableEnded, true);
    assert.equal(child.stderr.readableEnded, true);
  }
});

test("rollback and terminal close wait after exit state until stdio and child close settle", async () => {
  const startupChild = createFakeBrokerChild({ exitOnKill: false });
  const controller = new AbortController();
  const starting = createWindowsControlBroker({
    endpoint: "\\\\.\\pipe\\tego-exit-before-startup-close",
    maxConnections: 1,
    maxQueuedBytes: 1024,
    shutdownTimeoutMs: 50,
    spawnBroker: () => startupChild,
    startupTimeoutMs: 100,
  }).start(controller.signal);
  startupChild.beginExit(1);
  controller.abort();
  assert.equal(await settlesImmediately(starting), false);
  startupChild.settleClose();
  await assert.rejects(starting, { name: "AbortError" });

  const terminalChild = createFakeBrokerChild({ exitOnKill: false });
  const terminal = createStartedBroker(terminalChild);
  await terminal.startup;
  terminalChild.beginExit(1);
  terminalChild.stdout.write(Buffer.alloc(24, 0xff));
  const closing = terminal.broker.close();
  assert.equal(await settlesImmediately(closing), false);
  terminalChild.settleClose();
  await assert.rejects(closing, UNSAFE);
});

test("malformed stdout, FATAL, child crash, and non-allowlisted stderr fail closed", async () => {
  for (const inject of [
    (child: FakeBrokerChild) => child.stdout.write(Buffer.alloc(24, 0xff)),
    (child: FakeBrokerChild) =>
      child.stdout.write(
        brokerFrame(
          "fatal",
          0n,
          Buffer.from("TEGO_WINDOWS_CONTROL_BROKER_PROTOCOL_FAILED", "ascii"),
        ),
      ),
    (child: FakeBrokerChild) => child.stderr.write("sensitive endpoint detail\n"),
    (child: FakeBrokerChild) => child.exit(7),
  ]) {
    const child = createFakeBrokerChild();
    const { broker, startup } = createStartedBroker(child);
    const observed = Promise.withResolvers<Error>();
    broker.onError((error) => observed.resolve(error));
    await startup;
    inject(child);
    const failure = await observed.promise;
    assert.match(failure.message, UNSAFE);
    await assert.rejects(broker.close(), UNSAFE);
    assert.doesNotMatch(failure.message, /sensitive|endpoint detail/u);
  }
});

test("stderr accepts only fixed stage codes and reports the stable stage", async () => {
  const child = createFakeBrokerChild();
  const { broker, stages, startup } = createStartedBroker(child);
  const failed = Promise.withResolvers<void>();
  broker.onError(() => failed.resolve());
  await startup;
  child.stderr.write("TEGO_WINDOWS_CONTROL_BROKER_PIPE_VERIFY_FAILED\r\n");
  child.exit(1);
  await failed.promise;
  await assert.rejects(broker.close(), UNSAFE);
  assert.deepEqual(stages, ["TEGO_WINDOWS_CONTROL_BROKER_PIPE_VERIFY_FAILED"]);
});

test("close prefers graceful ACK and otherwise escalates to forced termination", async () => {
  const graceful = createStartedBroker();
  const gracefulFrames = collectParentFrames(graceful.child);
  await graceful.startup;
  await closeGracefully(graceful.broker, graceful.child, gracefulFrames);
  assert.deepEqual(graceful.child.kills, []);

  const abnormalChild = createFakeBrokerChild();
  const abnormal = createStartedBroker(abnormalChild);
  const abnormalFrames = collectParentFrames(abnormalChild);
  await abnormal.startup;
  const abnormalClose = abnormal.broker.close();
  await eventually(() => abnormalFrames.some(({ type }) => type === "close-all"));
  abnormalChild.stdout.write(brokerFrame("close-all-ack"));
  abnormalChild.exit(7);
  await assert.rejects(abnormalClose, UNSAFE);

  const forcedChild = createFakeBrokerChild();
  const forced = createStartedBroker(forcedChild, { shutdownTimeoutMs: 5 });
  const forcedFrames = collectParentFrames(forcedChild);
  await forced.startup;
  await forced.broker.close();
  assert.equal(
    forcedFrames.some(({ type }) => type === "close-all"),
    true,
  );
  assert.deepEqual(forcedChild.kills, ["SIGTERM"]);
});

test("cleanup errors retain the primary protocol failure first", async () => {
  const child = createFakeBrokerChild({ exitOnKill: false });
  child.kill = () => {
    throw new Error("cleanup kill failed");
  };
  const broker = createWindowsControlBroker({
    endpoint: "\\\\.\\pipe\\tego-cleanup-order",
    maxConnections: 1,
    maxQueuedBytes: 1024,
    shutdownTimeoutMs: 5,
    spawnBroker: () => child,
    startupTimeoutMs: 50,
  });
  const startup = broker.start();
  const stdinFinished = once(child.stdin, "finish");
  child.stdout.write(Buffer.alloc(24, 0xff));
  const outcome = startup.catch((error: unknown) => error);
  await stdinFinished;
  child.exit(1);
  const error = await outcome;
  assert.ok(error instanceof AggregateError);
  assert.match(String(error.errors[0]), UNSAFE);
  assert.match(String(error.errors[1]), /cleanup kill failed/u);
});
