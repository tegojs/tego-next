import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnosticCode } from "@tego/contracts";
import { packWorkspaceSet, withPackedConsumer } from "./package-contract.mjs";

export const WINDOWS_CONTROL_GATE_MARKER = "TEGO_WINDOWS_CONTROL_GATE_OK";
export const WINDOWS_CONTROL_GATE_CHILD_MARKER = "TEGO_WINDOWS_CONTROL_GATE_INNER_OK";
const temporaryTaskDiagnosticMarker = ["TEGO", "TASK4", "NON", "AUTHORITATIVE"].join("_");
const temporaryTaskDiagnosticTokens = [
  ["TEGO", "TASK4"].join("_"),
  ["TASK4", "NON", "AUTHORITATIVE"].join("_"),
  ["Task", "4", "Diagnostic"].join(""),
  ["TEGO", "WINDOWS", "CONTROL", "DIAGNOSTIC"].join("_"),
];
const expectedParentCrashCleanupSha256 =
  "bac041802252245f8a4a01f1270699a67282dde9bbb65c66dec80fbbaefbf3ef";
const expectedWindowsGateSourceSha256 =
  "0965ff9d074096e56fbdb8b953a27797e8f3420633cd42c4f7d5664999521df1";
const expectedWindowsBrokerCSharpSourceSha256 =
  "26c14d7c78b632a6e9d49369e123a97dd28949e47bda8b7d760f0e4ce312f1c4";
const expectedWindowsBrokerPowerShellSourceSha256 =
  "3b6279a12436f1d21c77f2e45b7b510995b1ad369cd53870483b9c03f33c3b53";
const expectedWindowsGateRunnerSourceSha256 =
  "dc24428c857726edf71593723661e61ff576b7309b48bdc0e6c0e7aad3385a36";
const expectedWindowsPipeProbeSource = `$ErrorActionPreference = 'Stop'
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
const expectedWindowsPipeProbeArgumentsBody = [
  '"-NoLogo",',
  '  "-NoProfile",',
  '  "-NonInteractive",',
  '  "-ExecutionPolicy",',
  '  "Bypass",',
  '  "-EncodedCommand",',
  '  Buffer.from(windowsPipeProbeSource, "utf16le").toString("base64"),',
].join("\n");
const expectedRunNativePipeProbeBody = [
  'task4NonAuthoritativeStageDetail = "powershell-path";',
  '  const systemRoot = realpathSync(requiredEnvironment("SystemRoot"));',
  "  assert.equal(isAbsolute(systemRoot), true);",
  "  assert.match(systemRoot, /^[A-Za-z]:\\\\[^\\r\\n]+$/u);",
  "  const powershellExecutable = realpathSync(",
  '    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),',
  "  );",
  "  assert.equal(isContained(systemRoot, powershellExecutable), true);",
  '  task4NonAuthoritativeStageDetail = "powershell-spawn";',
  "  const probe = spawnSync(powershellExecutable, windowsPipeProbeArguments, {",
  '    encoding: "utf8",',
  "    env: {",
  "      SystemRoot: systemRoot,",
  "      TEGO_WINDOWS_PIPE_PROBE_ENDPOINT: endpoint,",
  '      TEMP: requiredEnvironment("TEMP"),',
  '      TMP: requiredEnvironment("TMP"),',
  "      WINDIR: systemRoot,",
  "    },",
  "    maxBuffer: POWERSHELL_STARTUP_STDERR_MAX_BYTES,",
  "    shell: false,",
  '    stdio: ["ignore", "pipe", "pipe"],',
  "    timeout: PROCESS_CLEANUP_TIMEOUT_MS,",
  "    windowsHide: true,",
  "  });",
  "  task4NonAuthoritativeStageDetail =",
  "    probe.error !== undefined",
  '      ? "powershell-spawn-error"',
  "      : probe.signal !== null",
  '        ? "powershell-signal"',
  '        : probe.stdout !== ""',
  '          ? "powershell-stdout"',
  '          : probe.stderr !== ""',
  '            ? "powershell-stderr"',
  "            : probe.status === 0",
  '              ? "powershell-status-absent"',
  "              : probe.status === 2",
  '                ? "powershell-status-present"',
  "                : probe.status === 3",
  '                  ? "powershell-status-error"',
  '                  : "powershell-status-unknown";',
  "  assert.equal(probe.error, undefined);",
  "  assert.equal(probe.signal, null);",
  '  assert.equal(probe.stdout, "");',
  '  assert.equal(probe.stderr, "");',
  "  assert.ok(probe.status === 0 || probe.status === 2 || probe.status === 3);",
  "  return probe.status;",
].join("\n");
const expectedAssertPipeUnavailableBody = [
  "assertNativePipeAbsent(endpoint);",
  "  await assert.rejects(",
  "    requestControl({",
  "      endpoint,",
  '      operation: "runtime.status",',
  "      input: {},",
  ["      requestId: `windows-control-unavailable-", "$", "{randomUUID()}`,"].join(""),
  "      timeoutMs: 250,",
  "    }),",
  "  );",
].join("\n");
const expectedRunStatusRequestBody = [
  'task4NonAuthoritativeStageDetail = "status-request";',
  "  assert.ok(liveServer !== undefined);",
  '  await assertStatus(liveServer.endpoint, "windows-control-gate-status");',
  "  assertNativePipePresent(liveServer.endpoint);",
].join("\n");
const expectedNonAuthoritativeStageExecutorBody = [
  "try {",
  "    await operation();",
  "  } catch (error) {",
  "    process.stderr.write(",
  [
    "      `",
    "$",
    "{task4NonAuthoritativeStagePrefix}:",
    "$",
    "{_stage}:",
    "$",
    "{task4NonAuthoritativeStageDetail}\\n`,",
  ].join(""),
  "    );",
  "    throw error;",
  "  }",
].join("\n");

const root = fileURLToPath(new URL("../", import.meta.url));
const gateSourcePath = fileURLToPath(
  new URL("../packages/cli/test/windows-control-gate.ts", import.meta.url),
);
const brokerCSharpSourcePath = fileURLToPath(
  new URL("./windows-control-broker.cs", import.meta.url),
);
const brokerPowerShellSourcePath = fileURLToPath(
  new URL("./windows-control-broker.ps1", import.meta.url),
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
    [
      '"--parent-crash-fixture"',
      'startTrackedServer("parent-crash", fixture)',
      "await sendParentFixtureChallenge(",
      "await assertPipeUnavailable(",
    ],
  ],
  [
    "broker-crash-cleanup",
    "runBrokerCrashCleanup",
    ['tracked.broker.child.kill("SIGKILL")', "await assertPipeUnavailable("],
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

function uniqueTopLevelTemplateLiteral(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const prefix = `const ${name} = \``;
  const templateMarker = String.fromCodePoint(96);
  const declarations = [
    ...source.matchAll(new RegExp(`^const ${escaped} = ${templateMarker}`, "gmu")),
  ];
  if (declarations.length !== 1) return undefined;
  const valueStart = (declarations[0].index ?? -1) + prefix.length;
  const valueEnd = source.indexOf("`;", valueStart);
  return valueEnd === -1 ? undefined : source.slice(valueStart, valueEnd);
}

function uniqueTopLevelArrayBody(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const declarations = [...source.matchAll(new RegExp(`^const ${escaped} = \\[`, "gmu"))];
  if (declarations.length !== 1) return undefined;
  const bodyStart = source.indexOf("[", declarations[0].index) + 1;
  const bodyEndPattern = /^\];\r?$/gmu;
  bodyEndPattern.lastIndex = bodyStart;
  const bodyEnd = bodyEndPattern.exec(source)?.index ?? -1;
  return bodyEnd === -1 ? undefined : source.slice(bodyStart, bodyEnd);
}

function normalizedContractText(source) {
  return source.replaceAll("\r\n", "\n").trim();
}

function canonicalBodyDigest(source) {
  return createHash("sha256").update(normalizedContractText(source)).digest("hex");
}

function canonicalSourceDigest(source) {
  return createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex");
}

function canonicalWindowsGateRunnerSource(source) {
  const canonical = source.replaceAll("\r\n", "\n");
  const declaration =
    /^const expectedWindowsGateRunnerSourceSha256 =\s*\n?\s*"([0-9a-f]{64})";$/gmu;
  const matches = [...canonical.matchAll(declaration)];
  if (matches.length !== 1 || matches[0][1] !== expectedWindowsGateRunnerSourceSha256) {
    return undefined;
  }
  return canonical.replace(
    declaration,
    'const expectedWindowsGateRunnerSourceSha256 = "<WINDOWS_GATE_RUNNER_SOURCE_SHA256>";',
  );
}

function hasCanonicalWindowsGateSources({
  brokerCSharpSource,
  brokerPowerShellSource,
  gateSource,
  runnerSource,
}) {
  const canonicalRunnerSource = canonicalWindowsGateRunnerSource(runnerSource);
  return (
    canonicalRunnerSource !== undefined &&
    canonicalSourceDigest(gateSource) === expectedWindowsGateSourceSha256 &&
    canonicalSourceDigest(brokerCSharpSource) === expectedWindowsBrokerCSharpSourceSha256 &&
    canonicalSourceDigest(brokerPowerShellSource) === expectedWindowsBrokerPowerShellSourceSha256 &&
    canonicalSourceDigest(canonicalRunnerSource) === expectedWindowsGateRunnerSourceSha256
  );
}

function hasCanonicalParentCrashContractSource(source) {
  const normalizedSource = source.replaceAll("\r\n", "\n");
  const declaration = `const expectedParentCrashCleanupSha256 =\n  "${expectedParentCrashCleanupSha256}";`;
  const digestBody = uniqueTopLevelSyncFunctionBody(normalizedSource, "canonicalBodyDigest");
  return (
    normalizedSource.split(declaration).length - 1 === 1 &&
    normalizedContractText(digestBody ?? "") ===
      'return createHash("sha256").update(normalizedContractText(source)).digest("hex");'
  );
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
  return body === "await operation();" || body === expectedNonAuthoritativeStageExecutorBody;
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

function hasExactNativePipeAbsence(source) {
  const probeSource = uniqueTopLevelTemplateLiteral(source, "windowsPipeProbeSource");
  const probeArguments = uniqueTopLevelArrayBody(source, "windowsPipeProbeArguments");
  const probeBody = uniqueTopLevelSyncFunctionBody(source, "runNativePipeProbe");
  const absentBody = uniqueTopLevelSyncFunctionBody(source, "assertNativePipeAbsent");
  const presentBody = uniqueTopLevelSyncFunctionBody(source, "assertNativePipePresent");
  const unavailableBody = uniqueTopLevelAsyncFunctionBody(source, "assertPipeUnavailable");
  const statusBody = uniqueTopLevelAsyncFunctionBody(source, "runStatusRequest");
  if (
    probeSource === undefined ||
    probeArguments === undefined ||
    probeBody === undefined ||
    absentBody === undefined ||
    presentBody === undefined ||
    unavailableBody === undefined ||
    statusBody === undefined
  )
    return false;
  return (
    normalizedContractText(probeSource) === expectedWindowsPipeProbeSource &&
    normalizedContractText(probeArguments) === expectedWindowsPipeProbeArgumentsBody &&
    normalizedContractText(probeBody) === expectedRunNativePipeProbeBody &&
    normalizedContractText(absentBody) === "assert.equal(runNativePipeProbe(endpoint), 0);" &&
    normalizedContractText(presentBody) === "assert.equal(runNativePipeProbe(endpoint), 2);" &&
    normalizedContractText(unavailableBody) === expectedAssertPipeUnavailableBody &&
    normalizedContractText(statusBody) === expectedRunStatusRequestBody
  );
}

function hasCapturedTrackedBrokerClose(source) {
  if (
    /\b(?:processExists|waitForProcessExit|brokerPid)\b/u.test(source) ||
    /\bprocess\.kill\s*\(/u.test(source)
  ) {
    return false;
  }
  const ownBody = uniqueTopLevelSyncFunctionBody(source, "ownChild");
  const startBody = uniqueTopLevelAsyncFunctionBody(source, "startTrackedServer");
  const rollbackBody = uniqueTopLevelAsyncFunctionBody(source, "rollbackTrackedServerAcquisition");
  const cleanupBody = uniqueTopLevelAsyncFunctionBody(source, "cleanupTrackedServer");
  const argumentsBody = uniqueTopLevelSyncFunctionBody(source, "brokerArgumentsForParent");
  if (
    ownBody === undefined ||
    startBody === undefined ||
    rollbackBody === undefined ||
    cleanupBody === undefined ||
    argumentsBody === undefined
  )
    return false;
  if (
    normalizedContractText(ownBody) !==
    [
      "const failed = Promise.withResolvers<Error>();",
      '  child.once("error", (error) => failed.resolve(error));',
      "  const closed = new Promise<void>((resolveClose) => {",
      '    child.once("close", () => resolveClose());',
      "  });",
      "  return { child, closed, spawnError: failed.promise };",
    ].join("\n")
  )
    return false;
  const startTokens = [
    "let broker: OwnedChild | undefined;",
    "let server: ControlServer | undefined;",
    "try {",
    "server = await startControlServer({",
    "const spawned = spawn(",
    "broker = ownChild(spawned);",
    "return spawned as never;",
    "assert.ok(broker !== undefined);",
    "assertDescriptor(descriptor);",
    "return {",
    "} catch (primary) {",
    "return await rollbackTrackedServerAcquisition({ broker, endpoint, server }, primary);",
  ];
  let cursor = -1;
  for (const token of startTokens) {
    cursor = startBody.indexOf(token, cursor + 1);
    if (cursor === -1) return false;
  }
  const rollbackTokens = [
    "await withDeadline(pending.server.close(), PROCESS_CLEANUP_TIMEOUT_MS);",
    "const { child } = pending.broker;",
    'child.kill("SIGKILL")',
    "await withDeadline(pending.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
    "await assertPipeUnavailable(pending.endpoint);",
    "[primary, ...cleanupErrors]",
    "throw primary;",
  ];
  cursor = -1;
  for (const token of rollbackTokens) {
    cursor = rollbackBody.indexOf(token, cursor + 1);
    if (cursor === -1) return false;
  }
  const argumentTokens = [
    "const brokerArguments = [...args];",
    'argument === "-ParentProcessId" ? [index] : []',
    "assert.deepEqual(parentProcessIdIndexes, [9]);",
    "assert.equal(brokerArguments[parentProcessIdIndex + 1], String(process.pid));",
    "const watchedProcessId = watchedParent.child.pid;",
    "assert.equal(watchedParent.child.exitCode, null);",
    "assert.equal(watchedParent.child.signalCode, null);",
    "brokerArguments[parentProcessIdIndex + 1] = String(watchedProcessId);",
    "return brokerArguments;",
  ];
  cursor = -1;
  for (const token of argumentTokens) {
    cursor = argumentsBody.indexOf(token, cursor + 1);
    if (cursor === -1) return false;
  }
  return [
    "await withDeadline(tracked.server.close(), PROCESS_CLEANUP_TIMEOUT_MS);",
    "tracked.broker.child.exitCode === null && tracked.broker.child.signalCode === null",
    'tracked.broker.child.kill("SIGKILL");',
    "await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
    "await assertPipeUnavailable(tracked.endpoint);",
  ].every((token) => cleanupBody.includes(token));
}

function hasTokensInOrder(body, tokens) {
  let cursor = -1;
  for (const token of tokens) {
    cursor = body.indexOf(token, cursor + 1);
    if (cursor === -1) return false;
  }
  return true;
}

function hasParentCrashHandleOwnership(source) {
  const normalizedSource = source.replaceAll("\r\n", "\n");
  const fixtureBody = uniqueTopLevelAsyncFunctionBody(normalizedSource, "runParentCrashFixture");
  const readyBody = uniqueTopLevelSyncFunctionBody(normalizedSource, "isParentFixtureReady");
  const challengeBody = uniqueTopLevelSyncFunctionBody(
    normalizedSource,
    "isParentFixtureChallenge",
  );
  const acknowledgementBody = uniqueTopLevelSyncFunctionBody(
    normalizedSource,
    "isParentFixtureAcknowledgement",
  );
  const waitBody = uniqueTopLevelAsyncFunctionBody(normalizedSource, "waitForParentFixtureMessage");
  const sendBody = uniqueTopLevelAsyncFunctionBody(normalizedSource, "sendParentFixtureChallenge");
  const cleanupBody = uniqueTopLevelAsyncFunctionBody(normalizedSource, "cleanupParentCrashOwners");
  const parentBody = uniqueTopLevelAsyncFunctionBody(normalizedSource, "runParentCrashCleanup");
  if (
    fixtureBody === undefined ||
    readyBody === undefined ||
    challengeBody === undefined ||
    acknowledgementBody === undefined ||
    waitBody === undefined ||
    sendBody === undefined ||
    cleanupBody === undefined ||
    parentBody === undefined
  )
    return false;
  if (canonicalBodyDigest(parentBody) !== expectedParentCrashCleanupSha256) return false;
  if (
    /\b(?:processExists|waitForProcessExit|brokerPid)\b/u.test(normalizedSource) ||
    /\bprocess\.kill\s*\(/u.test(normalizedSource) ||
    /tracked\.broker\.child\.(?:kill|disconnect)\s*\(/u.test(parentBody) ||
    /tracked\.broker\.child\.stdin\??\.(?:destroy|end|write)\s*\(/u.test(parentBody) ||
    parentBody.includes("writeMalformedFrame(") ||
    parentBody.includes("cleanupTrackedServer(tracked)") ||
    parentBody.split("tracked.broker.child").length - 1 !== 4 ||
    parentBody.split("tracked.server").length - 1 !== 1 ||
    parentBody.split("tracked.server.close()").length - 1 !== 1 ||
    parentBody.split("tracked.broker.closed").length - 1 !== 1 ||
    parentBody.split("tracked.failure").length - 1 !== 1
  )
    return false;
  if (
    !hasTokensInOrder(fixtureBody, [
      'requiredEnvironment("TEGO_WINDOWS_PARENT_FIXTURE_NONCE")',
      'process.on("message"',
      "isParentFixtureChallenge(message, nonce)",
      '{ nonce, type: "ack" }',
      '{\n        nonce,\n        parentPid: process.pid,\n        type: "ready",',
      "await stopped.promise;",
    ]) ||
    !readyBody.includes('Object.keys(value).sort().join(",") === "nonce,parentPid,type"') ||
    !readyBody.includes('candidate.type === "ready"') ||
    !readyBody.includes("candidate.nonce === nonce") ||
    !challengeBody.includes('candidate.type === "challenge"') ||
    !challengeBody.includes("candidate.nonce === nonce") ||
    !acknowledgementBody.includes('candidate.type === "ack"') ||
    !acknowledgementBody.includes("candidate.nonce === nonce") ||
    !waitBody.includes("fixture.spawnError.then(") ||
    !waitBody.includes("fixture.closed.then(") ||
    !waitBody.includes('fixture.child.off("message", onMessage);') ||
    !sendBody.includes("await withDeadline(") ||
    !sendBody.includes('{ nonce, type: "challenge" }')
  )
    return false;
  if (
    !hasTokensInOrder(cleanupBody, [
      "await cleanupTrackedServer(tracked);",
      "errors.push(error);",
      "await cleanupOwnedChild(fixture);",
      "errors.push(error);",
      "return errors;",
    ])
  )
    return false;
  if (
    !hasTokensInOrder(parentBody, [
      "const nonce = randomUUID();",
      '"--parent-crash-fixture"',
      "TEGO_WINDOWS_PARENT_FIXTURE_NONCE: nonce",
      "ownChild(spawnedFixture)",
      "captureFixtureOutput(fixtureStdout, chunk)",
      "captureFixtureOutput(fixtureStderr, chunk)",
      "await waitForParentFixtureMessage(fixture",
      "assert.equal(ready.parentPid, fixture.child.pid);",
      'tracked = await startTrackedServer("parent-crash", fixture);',
      "await assertStatus(tracked.endpoint",
      "assert.equal(tracked.broker.child.exitCode, null);",
      "assert.equal(tracked.broker.child.signalCode, null);",
      "assert.equal(tracked.broker.child.stdin?.writableEnded, false);",
      "assert.equal(tracked.broker.child.stdin?.destroyed, false);",
      "const acknowledged = waitForParentFixtureMessage(",
      "await sendParentFixtureChallenge(fixture, nonce);",
      "await acknowledged;",
      "assert.equal(fixture.child.exitCode, null);",
      "assert.equal(fixture.child.signalCode, null);",
      'assert.equal(fixture.child.kill("SIGKILL"), true);',
      "await withDeadline(fixture.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
      "assert.equal(fixtureOutputBytes, 0);",
      "assert.equal(Buffer.concat(fixtureStdout).length, 0);",
      "assert.equal(Buffer.concat(fixtureStderr).length, 0);",
      "fixture = undefined;",
      "const failure = await withDeadline(tracked.failure, PROCESS_CLEANUP_TIMEOUT_MS);",
      "await assert.rejects(tracked.server.close()",
      "isExpectedMalformedServerClose(error, failure)",
      "await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
      "await assertPipeUnavailable(tracked.endpoint);",
      "tracked = undefined;",
      "const cleanupErrors = await cleanupParentCrashOwners(tracked, fixture);",
      "[primary, ...cleanupErrors]",
    ])
  )
    return false;
  return (
    normalizedSource.includes(
      "await cleanupTrackedServer(owned);\n        if (liveServer === owned) liveServer = undefined;",
    ) && !/const owned = liveServer;\s*liveServer = undefined;/u.test(normalizedSource)
  );
}

function hasMalformedOwnershipTransfer(source) {
  const body = uniqueTopLevelAsyncFunctionBody(source, "runMalformedFrameFailure");
  if (body === undefined) return false;
  const requiredInOrder = [
    'let tracked: TrackedServer | undefined = await startTrackedServer("malformed-frame");',
    "await writeMalformedFrame(tracked.broker.child);",
    "isExpectedMalformedServerClose(error, failure),",
    "await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
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

function hasBrokerCrashOwnershipTransfer(source) {
  const body = uniqueTopLevelAsyncFunctionBody(source, "runBrokerCrashCleanup");
  if (body === undefined || body.includes("waitForProcessExit(")) return false;
  const requiredInOrder = [
    'let tracked: TrackedServer | undefined = await startTrackedServer("broker-crash");',
    'tracked.broker.child.kill("SIGKILL")',
    "isExpectedMalformedServerClose(error, failure)",
    "await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
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

function hasReconnectOwnershipTransfer(source) {
  const body = uniqueTopLevelAsyncFunctionBody(source, "runReconnectFailure");
  if (body === undefined || body.includes("waitForProcessExit(")) return false;
  const requiredInOrder = [
    "const tracked = liveServer;",
    "await tracked.server.close();",
    "await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
    "await assertPipeUnavailable(tracked.endpoint);",
    "assert.equal(liveServer, tracked);",
    "liveServer = undefined;",
    "} finally {",
    "if (liveServer === tracked) {",
    "await cleanupTrackedServer(tracked);",
    "liveServer = undefined;",
  ];
  let cursor = -1;
  for (const token of requiredInOrder) {
    cursor = body.indexOf(token, cursor + 1);
    if (cursor === -1) return false;
  }
  return true;
}

function hasLifecycleOwnershipTransfer(source) {
  const body = uniqueTopLevelAsyncFunctionBody(source, "runTwentyLifecycleRounds");
  if (body === undefined || body.includes("waitForProcessExit(")) return false;
  const requiredInOrder = [
    "round < 20",
    "let tracked: TrackedServer | undefined = await startTrackedServer(",
    "await assertStatus(",
    "await tracked.server.close();",
    "await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
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

export function validateWindowsControlGateContract({
  brokerCSharpSource,
  brokerPowerShellSource,
  gateSource,
  runnerSource,
}) {
  const errors = [];
  if (
    typeof brokerCSharpSource !== "string" ||
    typeof brokerPowerShellSource !== "string" ||
    typeof gateSource !== "string" ||
    typeof runnerSource !== "string"
  ) {
    return ["Windows gate sources must be text"];
  }
  if (
    !hasCanonicalWindowsGateSources({
      brokerCSharpSource,
      brokerPowerShellSource,
      gateSource,
      runnerSource,
    })
  ) {
    errors.push("Windows gate executable sources must match the canonical reviewed contract");
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
  if (!hasExactNativePipeAbsence(gateSource)) {
    errors.push("Windows gate must prove exact native pipe absence and fail closed");
  }
  if (!hasCapturedTrackedBrokerClose(gateSource)) {
    errors.push("Windows gate must capture and await the exact spawned broker close event");
  }
  if (!hasParentCrashHandleOwnership(gateSource)) {
    errors.push("parent-crash cleanup must retain exact handle ownership and watchdog proof");
  }
  if (!hasCanonicalParentCrashContractSource(runnerSource)) {
    errors.push("parent-crash canonical body contract cannot be changed or bypassed");
  }
  if (!hasMalformedOwnershipTransfer(gateSource)) {
    errors.push("malformed-frame cleanup ownership must release only after its postconditions");
  }
  if (!hasBrokerCrashOwnershipTransfer(gateSource)) {
    errors.push("broker-crash cleanup ownership must release only after exact child close");
  }
  if (!hasReconnectOwnershipTransfer(gateSource)) {
    errors.push("reconnect cleanup ownership must release only after exact child close");
  }
  if (!hasLifecycleOwnershipTransfer(gateSource)) {
    errors.push("lifecycle cleanup ownership must release only after exact child close");
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
  const allSources = `${brokerCSharpSource}\n${brokerPowerShellSource}\n${gateSource}\n${runnerSource}`;
  if (
    allSources.includes(temporaryTaskDiagnosticMarker) ||
    temporaryTaskDiagnosticTokens.some((token) => allSources.includes(token))
  ) {
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
    const [brokerCSharpSource, brokerPowerShellSource, gateSource, runnerSource] =
      await Promise.all([
        readFile(brokerCSharpSourcePath, "utf8"),
        readFile(brokerPowerShellSourcePath, "utf8"),
        readFile(gateSourcePath, "utf8"),
        readFile(runnerSourcePath, "utf8"),
      ]);
    if (
      validateWindowsControlGateContract({
        brokerCSharpSource,
        brokerPowerShellSource,
        gateSource,
        runnerSource,
      }).length > 0
    ) {
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
