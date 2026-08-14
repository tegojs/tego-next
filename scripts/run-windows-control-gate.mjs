import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnosticCode } from "@tego/contracts";
import { packWorkspaceSet, withPackedConsumer } from "./package-contract.mjs";

export const WINDOWS_CONTROL_GATE_MARKER = "TEGO_WINDOWS_CONTROL_GATE_OK";
export const WINDOWS_CONTROL_GATE_CHILD_MARKER = "TEGO_WINDOWS_CONTROL_GATE_INNER_OK";
const temporaryTaskDiagnosticMarker = ["TEGO", "TASK4", "NON", "AUTHORITATIVE"].join("_");

const root = fileURLToPath(new URL("../", import.meta.url));
const gateSourcePath = fileURLToPath(
  new URL("../packages/cli/test/windows-control-gate.ts", import.meta.url),
);
const runnerSourcePath = fileURLToPath(import.meta.url);

export function isExpectedMalformedServerClose(error, observedFailure) {
  return (
    error instanceof AggregateError &&
    error.errors.length === 2 &&
    diagnosticCode(error.errors[0]) === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE" &&
    error.errors[1] === observedFailure &&
    diagnosticCode(error.errors[1]) === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE"
  );
}

const expectedMalformedServerCloseBody = [
  "return (",
  "    error instanceof AggregateError &&",
  "    error.errors.length === 2 &&",
  '    diagnosticCode(error.errors[0]) === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE" &&',
  "    error.errors[1] === observedFailure &&",
  '    diagnosticCode(error.errors[1]) === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE"',
  "  );",
].join("\n");

const requiredWindowsControlGateStages = [
  [
    "packed-clean-consumer",
    "preparePackedWindowsControlConsumer",
    ["await packWorkspaceSet(", "preparedConsumer ="],
  ],
  [
    "powershell-csharp-self-test",
    "runPowerShellSelfTest",
    ["spawnSync(", '"-SelfTest"', "selfTest.status", "selfTest.stderr"],
  ],
  [
    "live-server-handle-descriptor",
    "startLiveDescriptor",
    ['startTrackedServer("live-descriptor")'],
  ],
  ["status-request", "runStatusRequest", ["await assertStatus("]],
  [
    "malformed-broker-frame-fail-closed",
    "runMalformedFrameFailure",
    [
      "await writeMalformedFrame(",
      "PROTOCOL_CONTROL_ENDPOINT_UNSAFE",
      "await assertPipeUnavailable(",
    ],
  ],
  [
    "parent-crash-cleanup",
    "runParentCrashCleanup",
    ['"--parent-crash-fixture"', "details.brokerPid", "await assertPipeUnavailable("],
  ],
  [
    "broker-crash-cleanup",
    "runBrokerCrashCleanup",
    ['tracked.broker.kill("SIGKILL")', "await assertPipeUnavailable("],
  ],
  [
    "reconnect-failure",
    "runReconnectFailure",
    ["await tracked.server.close();", "await assertPipeUnavailable("],
  ],
  [
    "twenty-lifecycle-rounds",
    "runTwentyLifecycleRounds",
    ["round < 20", "await assertStatus(", "await assertPipeUnavailable("],
  ],
];

function uniqueTopLevelAsyncFunctionBody(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const declarations = [
    ...source.matchAll(new RegExp(`^(?:export\\s+)?async function ${escaped}\\b`, "gmu")),
  ];
  if (declarations.length !== 1) return undefined;
  const bodyStart = source.indexOf("{", declarations[0].index);
  if (bodyStart === -1) return undefined;
  const bodyEndPattern = /^\}\r?$/gmu;
  bodyEndPattern.lastIndex = bodyStart;
  const bodyEnd = bodyEndPattern.exec(source)?.index ?? -1;
  return bodyEnd === -1 ? undefined : source.slice(bodyStart + 1, bodyEnd);
}

function uniqueTopLevelSyncFunctionBody(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const declarations = [
    ...source.matchAll(new RegExp(`^(?:export\\s+)?function ${escaped}\\b`, "gmu")),
  ];
  if (declarations.length !== 1) return undefined;
  const bodyStart = source.indexOf("{", declarations[0].index);
  if (bodyStart === -1) return undefined;
  const bodyEndPattern = /^\}\r?$/gmu;
  bodyEndPattern.lastIndex = bodyStart;
  const bodyEnd = bodyEndPattern.exec(source)?.index ?? -1;
  return bodyEnd === -1 ? undefined : source.slice(bodyStart + 1, bodyEnd);
}

function stageCalls(body) {
  return [
    ...body.matchAll(
      /^\s*await runWindowsControlGateStage\("([a-z0-9-]+)", ([A-Za-z_$][\w$]*)\);\s*$/gmu,
    ),
  ].map((match) => [match[1], match[2]]);
}

function exactAwaitCount(source, expression) {
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...source.matchAll(new RegExp(`^\\s*await ${escaped};\\s*$`, "gmu"))].length;
}

function hasActiveStageExecutor(source) {
  const body = uniqueTopLevelAsyncFunctionBody(source, "runWindowsControlGateStage")
    ?.replaceAll("\r\n", "\n")
    .trim();
  return (
    body === "await operation();" || body === "nonAuthoritativeStage = stage;\n  await operation();"
  );
}

function hasForbiddenGateFlow(body) {
  return (
    /\bif\s*\(\s*false\s*\)/u.test(body) ||
    /\bcatch\b/u.test(body) ||
    /^\s*(?:return\b|break\b|continue\b)/mu.test(body)
  );
}

function hasStrictPowerShellSelfTest(source) {
  const body = uniqueTopLevelAsyncFunctionBody(source, "runPowerShellSelfTest");
  if (
    body === undefined ||
    body.includes('"-Endpoint"') ||
    /\bprime\b/u.test(body) ||
    body.includes(temporaryTaskDiagnosticMarker)
  )
    return false;
  const spawnExpression = 'spawnSync("powershell.exe", selfTestArguments, {';
  if (body.split(spawnExpression).length - 1 !== 1) return false;
  if (body.split("maxBuffer: POWERSHELL_STARTUP_STDERR_MAX_BYTES").length - 1 !== 1) {
    return false;
  }
  const requiredInOrder = [
    'const selfTest = spawnSync("powershell.exe", selfTestArguments, {',
    "assert.equal(selfTest.error, undefined);",
    "assert.equal(selfTest.signal, null);",
    "assert.equal(selfTest.status, 0);",
    'assert.equal(selfTest.stdout, "");',
    'assert.equal(selfTest.stderr, "");',
  ];
  let cursor = -1;
  for (const token of requiredInOrder) {
    cursor = body.indexOf(token, cursor + 1);
    if (cursor === -1) return false;
  }
  return true;
}

function hasCapturedTrackedBrokerClose(source) {
  const startBody = uniqueTopLevelAsyncFunctionBody(source, "startTrackedServer");
  const cleanupBody = uniqueTopLevelAsyncFunctionBody(source, "cleanupTrackedServer");
  if (startBody === undefined || cleanupBody === undefined) return false;
  const startTokens = [
    "let brokerClosed:",
    "const spawned = spawn(",
    "brokerClosed = new Promise<void>((resolveClose) => {",
    'spawned.once("close", resolveClose);',
    "broker = spawned;",
    "return spawned as never;",
    "assert.ok(brokerClosed !== undefined);",
    "brokerClosed,",
  ];
  let cursor = -1;
  for (const token of startTokens) {
    cursor = startBody.indexOf(token, cursor + 1);
    if (cursor === -1) return false;
  }
  return (
    cleanupBody.includes(
      "tracked.broker.exitCode === null && tracked.broker.signalCode === null",
    ) &&
    cleanupBody.includes('tracked.broker.kill("SIGKILL");') &&
    cleanupBody.includes("await withDeadline(tracked.brokerClosed, PROCESS_CLEANUP_TIMEOUT_MS);") &&
    !cleanupBody.includes("processExists(") &&
    !cleanupBody.includes("waitForProcessExit(")
  );
}

function hasMalformedOwnershipTransfer(source) {
  const body = uniqueTopLevelAsyncFunctionBody(source, "runMalformedFrameFailure");
  if (body === undefined) return false;
  const requiredInOrder = [
    'let tracked: TrackedServer | undefined = await startTrackedServer("malformed-frame");',
    "await writeMalformedFrame(tracked.broker);",
    "isExpectedMalformedServerClose(error, failure),",
    "await withDeadline(tracked.brokerClosed, PROCESS_CLEANUP_TIMEOUT_MS);",
    "await assertPipeUnavailable(tracked.endpoint);",
    "tracked = undefined;",
    "} finally {",
    "if (tracked !== undefined) await cleanupTrackedServer(tracked);",
  ];
  let cursor = -1;
  for (const token of requiredInOrder) {
    cursor = body.indexOf(token, cursor + 1);
    if (cursor === -1) return false;
  }
  return true;
}

export function validateWindowsControlGateContract({ gateSource, runnerSource }) {
  const errors = [];
  if (typeof gateSource !== "string" || typeof runnerSource !== "string") {
    return ["Windows gate sources must be text"];
  }
  const expectedOuter = requiredWindowsControlGateStages.slice(0, 1);
  const expectedInner = requiredWindowsControlGateStages.slice(1);
  const runnerBody = uniqueTopLevelAsyncFunctionBody(runnerSource, "runWindowsControlGate");
  const gateBody = uniqueTopLevelAsyncFunctionBody(gateSource, "runInstalledWindowsControlGate");
  const outerStages = expectedOuter.map(([stage, implementation]) => [stage, implementation]);
  const innerStages = expectedInner.map(([stage, implementation]) => [stage, implementation]);
  if (
    runnerBody === undefined ||
    JSON.stringify(stageCalls(runnerBody)) !== JSON.stringify(outerStages)
  ) {
    errors.push("Windows gate runner stages are missing, reordered, conditional, or replaced");
  }
  if (
    gateBody === undefined ||
    JSON.stringify(stageCalls(gateBody)) !== JSON.stringify(innerStages)
  ) {
    errors.push("installed Windows gate stages are missing, reordered, conditional, or replaced");
  }
  if (
    (runnerBody !== undefined && hasForbiddenGateFlow(runnerBody)) ||
    (gateBody !== undefined && hasForbiddenGateFlow(gateBody))
  ) {
    errors.push(
      "Windows gate orchestration cannot skip, return early, continue, or swallow failure",
    );
  }
  if (!hasActiveStageExecutor(runnerSource) || !hasActiveStageExecutor(gateSource)) {
    errors.push("Windows gate stage executors must await their required operation");
  }
  if (!hasStrictPowerShellSelfTest(gateSource)) {
    errors.push("Windows gate must retain one bounded strict authoritative SelfTest");
  }
  if (!hasCapturedTrackedBrokerClose(gateSource)) {
    errors.push("Windows gate must capture and await the exact spawned broker close event");
  }
  if (!hasMalformedOwnershipTransfer(gateSource)) {
    errors.push("malformed-frame cleanup ownership must release only after its postconditions");
  }
  const gateCloseMatcher = uniqueTopLevelSyncFunctionBody(
    gateSource,
    "isExpectedMalformedServerClose",
  )
    ?.replaceAll("\r\n", "\n")
    .trim();
  const runnerCloseMatcher = uniqueTopLevelSyncFunctionBody(
    runnerSource,
    "isExpectedMalformedServerClose",
  )
    ?.replaceAll("\r\n", "\n")
    .trim();
  if (
    gateCloseMatcher === undefined ||
    runnerCloseMatcher === undefined ||
    gateCloseMatcher !== expectedMalformedServerCloseBody ||
    runnerCloseMatcher !== expectedMalformedServerCloseBody
  ) {
    errors.push("malformed-frame server close must retain its exact ordered unsafe aggregate");
  }
  if (`${gateSource}\n${runnerSource}`.includes(temporaryTaskDiagnosticMarker)) {
    errors.push("Windows gate cannot retain temporary diagnostic output");
  }
  for (const [stage, implementation, evidence] of requiredWindowsControlGateStages) {
    const implementationBody = uniqueTopLevelAsyncFunctionBody(
      stage === "packed-clean-consumer" ? runnerSource : gateSource,
      implementation,
    );
    if (
      implementationBody === undefined ||
      evidence.some((token) => !implementationBody.includes(token))
    ) {
      errors.push(`${stage} implementation is missing its required real operation`);
    }
  }
  if (
    runnerBody === undefined ||
    exactAwaitCount(runnerBody, "runInstalledWindowsControlGate()") !== 1
  ) {
    errors.push("Windows gate runner must await exactly one installed consumer execution");
  }
  const installedMatch = /^\s*await runInstalledWindowsControlGate\(\);\s*$/mu.exec(
    runnerBody ?? "",
  );
  const packedMatch =
    /^\s*await runWindowsControlGateStage\("packed-clean-consumer", preparePackedWindowsControlConsumer\);\s*$/mu.exec(
      runnerBody ?? "",
    );
  const installedIndex = installedMatch?.index ?? -1;
  const packedIndex = packedMatch?.index ?? -1;
  if (packedIndex === -1 || installedIndex === -1 || packedIndex > installedIndex) {
    errors.push("packed Windows consumer preparation must precede installed execution");
  }
  const markerWrite = `process.stdout.write(\`\${WINDOWS_CONTROL_GATE_MARKER}\\n\`);`;
  const markerIndex = runnerBody?.indexOf(markerWrite) ?? -1;
  if (
    markerIndex === -1 ||
    markerIndex < installedIndex ||
    runnerBody?.indexOf(markerWrite, markerIndex + markerWrite.length) !== -1 ||
    gateSource.includes(markerWrite)
  ) {
    errors.push("Windows gate completion marker must be unique and follow installed execution");
  }
  return errors;
}

const gateProgram = fileURLToPath(
  new URL("../packages/cli/dist/test/windows-control-gate.js", import.meta.url),
);

let preparedConsumer;

async function runWindowsControlGateStage(_stage, operation) {
  await operation();
}

async function preparePackedWindowsControlConsumer() {
  const directory = await mkdtemp(join(tmpdir(), "tego-windows-control-gate-"));
  try {
    const packed = await packWorkspaceSet(root, join(directory, "tarballs"));
    preparedConsumer = { directory, packed };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

async function runInstalledWindowsControlGate() {
  if (preparedConsumer === undefined) throw new Error("Windows gate consumer is unavailable");
  const { directory, packed } = preparedConsumer;
  await withPackedConsumer(packed, directory, async (consumer) => {
    const installedGate = join(consumer.directory, "windows-control-gate.mjs");
    await copyFile(gateProgram, installedGate);
    const result = spawnSync(process.execPath, [installedGate], {
      cwd: consumer.directory,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_PATH: "",
        TEGO_WINDOWS_CONTROL_BROKER_CS: consumer.brokerCSharp,
        TEGO_WINDOWS_CONTROL_BROKER_PS1: consumer.brokerPowerShell,
        TEGO_WINDOWS_CONTROL_CONSUMER_PACKAGES: consumer.packageNames.join(","),
        TEGO_WINDOWS_CONTROL_CONSUMER_ROOT: consumer.directory,
      },
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 12 * 60 * 1000,
      windowsHide: true,
    });
    try {
      assertWindowsControlGateResult(process.platform, result);
    } catch (error) {
      if (typeof result.stdout === "string" && result.stdout !== "") {
        process.stderr.write(result.stdout);
      }
      if (typeof result.stderr === "string" && result.stderr !== "") {
        process.stderr.write(result.stderr);
      }
      throw error;
    }
  });
}

export function assertWindowsControlGateResult(platform, result) {
  if (platform !== "win32") {
    throw new Error("Windows control security gate requires Windows");
  }
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error("Windows control security gate failed");
  }
  if (result.stderr !== "" || !/^[^\r\n]+\r?\n$/u.test(result.stdout)) {
    throw new Error("Windows control security gate did not emit one clean completion marker");
  }
  if (result.stdout.trim() !== WINDOWS_CONTROL_GATE_CHILD_MARKER) {
    throw new Error("Windows control security gate completion marker is missing");
  }
}

export async function runWindowsControlGate(platform = process.platform) {
  if (platform !== "win32") {
    throw new Error("Windows control security gate requires Windows");
  }
  try {
    const [gateSource, runnerSource] = await Promise.all([
      readFile(gateSourcePath, "utf8"),
      readFile(runnerSourcePath, "utf8"),
    ]);
    if (validateWindowsControlGateContract({ gateSource, runnerSource }).length > 0) {
      throw new Error("Windows gate source contract is incomplete");
    }
    await runWindowsControlGateStage("packed-clean-consumer", preparePackedWindowsControlConsumer);
    await runInstalledWindowsControlGate();
  } finally {
    if (preparedConsumer !== undefined) {
      await rm(preparedConsumer.directory, { force: true, recursive: true });
      preparedConsumer = undefined;
    }
  }
  process.stdout.write(`${WINDOWS_CONTROL_GATE_MARKER}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runWindowsControlGate();
  } catch {
    process.stderr.write("TEGO_WINDOWS_CONTROL_GATE_FAILED\n");
    process.exitCode = 1;
  }
}
