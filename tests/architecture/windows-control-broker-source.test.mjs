import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const brokerPowerShellPath = new URL("../../scripts/windows-control-broker.ps1", import.meta.url);
const brokerCSharpPath = new URL("../../scripts/windows-control-broker.cs", import.meta.url);
const brokerAdapterPath = new URL(
  "../../packages/cli/src/control/windows-broker.ts",
  import.meta.url,
);
const taskOneProtocolPath = new URL(
  "../../packages/cli/src/control/windows-broker-protocol.ts",
  import.meta.url,
);

const expectedFrameNames = [
  "ready",
  "open",
  "data",
  "eof",
  "close",
  "fatal",
  "pause",
  "resume",
  "close-all",
  "close-all-ack",
];
const csharpFrameNames = new Map([
  ["FrameReady", "ready"],
  ["FrameOpen", "open"],
  ["FrameData", "data"],
  ["FrameEof", "eof"],
  ["FrameClose", "close"],
  ["FrameFatal", "fatal"],
  ["FramePause", "pause"],
  ["FrameResume", "resume"],
  ["FrameCloseAll", "close-all"],
  ["FrameCloseAllAck", "close-all-ack"],
]);

function balancedBlock(source, marker, open = "{", close = "}") {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing ${marker}`);
  const start = source.indexOf(open, markerIndex + marker.length);
  assert.notEqual(start, -1, `missing ${open} after ${marker}`);
  let depth = 0;
  let quote;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) depth -= 1;
    if (depth === 0) return source.slice(start + 1, index);
  }
  assert.fail(`unterminated block after ${marker}`);
}

function decimalProduct(expression) {
  assert.match(expression, /^\s*[\d_]+(?:\s*\*\s*[\d_]+)*\s*$/u);
  return expression
    .split("*")
    .map((term) => Number(term.trim().replaceAll("_", "")))
    .reduce((product, term) => product * term, 1);
}

function repeatedBalancedBlocks(source, marker) {
  const blocks = [];
  let offset = 0;
  while (offset < source.length) {
    const markerIndex = source.indexOf(marker, offset);
    if (markerIndex === -1) break;
    const fragment = source.slice(markerIndex);
    const block = balancedBlock(fragment, marker);
    blocks.push(block);
    offset = markerIndex + marker.length + block.length + 2;
  }
  return blocks;
}

function parseTypeScriptProtocol(source) {
  const constants = new Map(
    [...source.matchAll(/export const (WINDOWS_BROKER_[A-Z_]+) = ([^;]+);/gu)].map(
      ([, name, expression]) => [name, decimalProduct(expression)],
    ),
  );
  const header = Number(
    source.match(/const WINDOWS_BROKER_HEADER_BYTES = (\d+);/u)?.[1] ?? Number.NaN,
  );
  const magic = source.match(/const WINDOWS_BROKER_MAGIC = "([A-Z]+)";/u)?.[1];
  const typeBlock = balancedBlock(source, "const frameTypeCodes =");
  const types = Object.fromEntries(
    [...typeBlock.matchAll(/(?:"([a-z-]+)"|([a-z]+)):\s*(\d+),/gu)].map(
      ([, quoted, plain, value]) => [quoted ?? plain, Number(value)],
    ),
  );
  const directionBody = balancedBlock(source, "function directionAllows(");
  const arrays = [...directionBody.matchAll(/return \[([^\]]+)\]\.includes\(type\);/gu)].map(
    ([, values]) => [...values.matchAll(/"([a-z-]+)"/gu)].map((match) => match[1]),
  );
  assert.equal(arrays.length, 2, "Task 1 must retain two explicit direction allowlists");
  return {
    brokerToParent: arrays[0],
    header,
    magic,
    maxConnectionBytes: constants.get("WINDOWS_BROKER_MAX_CONNECTION_BYTES"),
    maxFrameBytes: constants.get("WINDOWS_BROKER_MAX_FRAME_BYTES"),
    parentToBroker: arrays[1],
    types,
    version: constants.get("WINDOWS_BROKER_PROTOCOL_VERSION"),
  };
}

function parseCSharpProtocol(source) {
  const constants = new Map(
    [
      ...source.matchAll(/private const (?:int|ushort) ([A-Za-z0-9]+) = (0x[\dA-Fa-f]+|\d+);/gu),
    ].map(([, name, value]) => [name, Number(value)]),
  );
  const parseDirection = (name) => {
    const block = balancedBlock(source, `ushort[] ${name}`);
    return [...block.matchAll(/Frame[A-Za-z]+/gu)].map((match) => {
      const frameName = csharpFrameNames.get(match[0]);
      assert.ok(frameName, `unknown C# frame constant ${match[0]}`);
      return frameName;
    });
  };
  return {
    brokerToParent: parseDirection("BrokerToParentFrameTypes"),
    header: constants.get("HeaderBytes"),
    magic: [
      constants.get("Magic0"),
      constants.get("Magic1"),
      constants.get("Magic2"),
      constants.get("Magic3"),
    ]
      .map((value) => String.fromCharCode(value))
      .join(""),
    maxConnectionBytes: constants.get("MaxConnectionBytes"),
    maxFrameBytes: constants.get("MaxFrameBytes"),
    parentToBroker: parseDirection("ParentToBrokerFrameTypes"),
    types: Object.fromEntries(
      [...csharpFrameNames].map(([constant, frameName]) => [frameName, constants.get(constant)]),
    ),
    version: constants.get("ProtocolVersion"),
  };
}

function assertPowerShellContract(source) {
  const parameterBlock = balancedBlock(source, "param", "(", ")");
  const parameters = [
    ...parameterBlock.matchAll(/\$(Endpoint|ParentProcessId|ProtocolVersion|SelfTest)\b/gu),
  ].map((match) => match[1]);
  assert.deepEqual([...new Set(parameters)].toSorted(), [
    "Endpoint",
    "ParentProcessId",
    "ProtocolVersion",
    "SelfTest",
  ]);
  assert.match(source, /\$args\.Count -ne 0/u);
  const endpointPattern = source.match(/\$Endpoint -notmatch '([^']+)'/u)?.[1];
  assert.ok(endpointPattern);
  assert.equal(new RegExp(endpointPattern).test("\\\\.\\pipe\\tego-contract"), true);
  assert.equal(new RegExp(endpointPattern).test("\\\\.\\pipe\\tego\\nested"), false);
  assert.equal(new RegExp(endpointPattern).test("tcp://127.0.0.1"), false);
  assert.match(source, /\[Environment\]::Is64BitProcess/u);
  assert.match(source, /PROCESSOR_ARCHITECTURE[\s\S]+AMD64/u);
  assert.match(source, /\[PlatformID\]::Win32NT/u);
  assert.match(source, /Join-Path \$PSScriptRoot "windows-control-broker\.cs"/u);
  const versionGuardIndex = source.indexOf("$PSVersionTable.PSVersion.Major -ne 5");
  const addTypeIndex = source.indexOf("Add-Type -Path $sourcePath");
  assert.notEqual(versionGuardIndex, -1, "Windows PowerShell 5.1 must be mandatory");
  assert.match(source, /\$PSVersionTable\.PSVersion\.Minor -ne 1/u);
  assert.ok(versionGuardIndex < addTypeIndex, "PowerShell version must be checked before Add-Type");
  assert.match(source, /Add-Type -Path \$sourcePath/u);
  assert.doesNotMatch(source, /Add-Type\s+-TypeDefinition|@['"]/u);
  assert.match(source, /if \(\$SelfTest\)[\s\S]+::SelfTest\(\)/u);
  assert.match(source, /::Run\(\$Endpoint, \$parentId, \$version\)/u);
  assert.doesNotMatch(source, /New-Object\s+System\.IO\.Pipes|NamedPipe|CreateNamedPipe/u);
  assert.doesNotMatch(
    source,
    /Write-(?:Error|Host|Output)|\$_|\.Exception|\.Message|\.StackTrace/u,
  );
  const stderrValues = [
    ...source.matchAll(/\[Console\]::Error\.WriteLine\("([A-Z0-9_]+)"\)/gu),
  ].map((match) => match[1]);
  assert.deepEqual([...new Set(stderrValues)].toSorted(), [
    "TEGO_WINDOWS_CONTROL_BROKER_ARCH_UNSUPPORTED",
    "TEGO_WINDOWS_CONTROL_BROKER_ARGUMENTS_INVALID",
    "TEGO_WINDOWS_CONTROL_BROKER_COMPILE_FAILED",
    "TEGO_WINDOWS_CONTROL_BROKER_POWERSHELL_UNSUPPORTED",
    "TEGO_WINDOWS_CONTROL_BROKER_START_FAILED",
  ]);
}

function assertCSharpContract(source) {
  const entry = balancedBlock(source, "public static int Run(");
  const execute = balancedBlock(source, "internal int Execute(");
  const inputLoop = balancedBlock(source, "private void InputLoop(");
  const createPipe = balancedBlock(source, "private static SafeFileHandle CreateVerifiedPipe(");
  const descriptor = balancedBlock(
    source,
    "private static SecurityDescriptorContext CreateSecurityDescriptor(",
  );
  const verify = balancedBlock(source, "private static void VerifyDescriptor(");
  const readyDescriptor = balancedBlock(source, "private static byte[] ReadReadyDescriptor(");
  const validate = balancedBlock(source, "private static void ValidateDescriptor(");
  const openParent = balancedBlock(source, "private static SafeWaitHandle OpenParentProcess(");
  const overlapped = balancedBlock(source, "sealed class OverlappedOperation");
  const overlappedDispose = balancedBlock(overlapped, "public void Dispose(");
  const requestCancellation = balancedBlock(overlapped, "internal void RequestCancellation(");
  const markIssued = balancedBlock(overlapped, "private bool MarkIssued(");
  const issueWrite = balancedBlock(overlapped, "internal bool IssueWrite(");
  const completeOperation = balancedBlock(overlapped, "internal bool Complete(");
  const writer = balancedBlock(source, "sealed class ParentFrameWriter");
  const selfTest = balancedBlock(source, "public static int SelfTest(");
  const descriptorSelfTest = balancedBlock(
    source,
    "private static void TestDescriptorConstruction(",
  );
  const x64Guard = balancedBlock(source, "private static bool IsX64Process(");
  const pipeConnection = balancedBlock(source, "private sealed class PipeConnection");
  const beginConnectionShutdown = balancedBlock(pipeConnection, "internal bool BeginShutdown(");
  const completeConnectionShutdown = balancedBlock(
    pipeConnection,
    "internal void CompleteShutdown(",
  );
  const broker = balancedBlock(source, "private sealed class Broker : IDisposable");
  const brokerDispose = balancedBlock(broker, "public void Dispose(");
  const readLoop = balancedBlock(pipeConnection, "private void ReadLoop(");
  const closeAll = balancedBlock(source, "private void CloseAllFromParent(");
  const closeConnection = balancedBlock(source, "private void CloseConnection(");
  const closeFromParent = balancedBlock(source, "private void CloseFromParent(");
  const pendingCloseTracker = balancedBlock(source, "private sealed class PendingCloseTracker");
  const addBrokerFirst = balancedBlock(pendingCloseTracker, "internal void AddBrokerFirst(");
  const acknowledgeParent = balancedBlock(pendingCloseTracker, "internal void AcknowledgeParent(");
  const closeDeadlineElapsed = balancedBlock(source, "private void CloseDeadlineElapsed(");
  const scheduleCloseDeadline = balancedBlock(source, "private void ScheduleCloseDeadlineLocked(");
  const closeEveryPipe = balancedBlock(source, "private void CloseEveryPipe(");
  const connectionCount = balancedBlock(source, "private int ConnectionCount(");
  const pendingRead = balancedBlock(source, "private sealed class PendingReadOperation");
  const retryCanceledRead = balancedBlock(source, "private static bool ShouldRetryCanceledRead(");
  const connectionDispose = balancedBlock(pipeConnection, "public void Dispose(");
  const waitForIoSettlement = balancedBlock(pipeConnection, "private void WaitForIoSettlement(");
  const acceptCleanup = balancedBlock(source, "private void StopAcceptLoop(");
  const failFastResource = balancedBlock(source, "private static void FailFastResource(");

  assert.match(
    entry,
    /OpenParentProcess\([^)]+\)[\s\S]+CreateSecurityDescriptor\([^)]*\)[\s\S]+CreateVerifiedPipe/u,
  );
  assert.match(openParent, /OpenProcess\(Synchronize, false, parentProcessId\)/u);
  assert.match(createPipe, /CreateNamedPipeW\([\s\S]+ref securityAttributes/u);
  assert.match(createPipe, /PipeAccessDuplex \| FileFlagOverlapped/u);
  assert.match(createPipe, /VerifyDescriptor\(handle, expectedSids\)/u);
  assert.match(entry, /ReadReadyDescriptor\(firstPipe, descriptor\.ExpectedSids\)/u);
  assert.match(execute, /WriteFrame\(FrameReady, 0, _readyDescriptor\)/u);
  assert.match(descriptor, /WindowsIdentity\.GetCurrent\(\)\.User/u);
  assert.match(descriptor, /LocalSystemSid[\s\S]+AdministratorsSid/u);
  assert.match(descriptor, /DiscretionaryAclProtected/u);
  assert.match(descriptor, /RawSecurityDescriptor\([\s\S]+currentUserSid[\s\S]+dacl/u);
  assert.match(verify, /GetKernelObjectSecurity/u);
  assert.match(verify, /ValidateDescriptor\(descriptor, expectedSids\)/u);
  assert.match(readyDescriptor, /GetKernelObjectSecurity/u);
  assert.match(readyDescriptor, /ValidateDescriptor\(descriptor, expectedSids\)/u);
  assert.match(readyDescriptor, /Encoding\.ASCII\.GetBytes/u);
  assert.match(readyDescriptor, /DescriptorPayloadVersion/u);
  assert.match(readyDescriptor, /DescriptorPayloadProtected/u);
  assert.match(readyDescriptor, /ace\.IsCallback/u);
  assert.match(readyDescriptor, /ace\.AceFlags/u);
  assert.match(readyDescriptor, /ace\.AccessMask/u);
  assert.match(readyDescriptor, /ace\.SecurityIdentifier/u);
  assert.match(validate, /descriptor\.Owner\.Equals\(expectedSids\[0\]\)/u);
  assert.match(validate, /DiscretionaryAclProtected/u);
  assert.match(validate, /DiscretionaryAcl\.Count != expectedSids\.Length/u);
  assert.match(validate, /AceQualifier\.AccessAllowed/u);
  assert.match(validate, /ace\.AceType != AceType\.AccessAllowed/u);
  assert.match(validate, /ace\.IsCallback/u);
  assert.match(validate, /ace\.GetOpaque\(\)/u);
  assert.match(validate, /AceFlags\.None/u);
  assert.match(validate, /ace\.AccessMask != PipeFullControl/u);
  assert.match(validate, /ace\.SecurityIdentifier\.Equals\(expectedSids\[index\]\)/u);
  assert.match(overlapped, /CancelIoEx/u);
  assert.match(overlapped, /WaitAny\([\s\S]+OperationTimeoutMilliseconds/u);
  assert.match(overlapped, /GetOverlappedResult/u);
  assert.match(overlapped, /FailFastResource/u);
  assert.match(source, /TerminateProcess\(GetCurrentProcess\(\), 1\)/u);
  assert.match(failFastResource, /try[\s\S]+EmitStage[\s\S]+catch/u);
  assert.match(failFastResource, /try[\s\S]+TerminateProcess[\s\S]+catch/u);
  assert.ok(
    failFastResource.indexOf("TerminateProcess") < failFastResource.indexOf("Environment.FailFast"),
  );
  assert.match(overlapped, /DangerousAddRef/u);
  assert.match(overlapped, /DangerousRelease/u);
  assert.equal(overlapped.match(/DangerousRelease/gu)?.length, 2);
  assert.match(overlapped, /SettleKernelOperation/u);
  assert.match(overlapped, /GetOverlappedResult/u);
  assert.match(overlapped, /ErrorOperationAborted/u);
  assert.match(overlapped, /bool _cancellationRequested/u);
  assert.match(requestCancellation, /_cancellationRequested = true;/u);
  assert.ok(
    requestCancellation.indexOf("_cancellationRequested = true;") <
      requestCancellation.indexOf("if (!_issued)"),
  );
  assert.ok(
    markIssued.indexOf("_issued = true;") < markIssued.indexOf("if (_cancellationRequested)"),
  );
  assert.match(issueWrite, /lock \(_stateGate\)/u);
  assert.ok(issueWrite.indexOf("MarkIssued") < issueWrite.indexOf("WriteFile"));
  assert.match(completeOperation, /catch[\s\S]+FailFastResource/u);
  assert.match(overlappedDispose, /catch[\s\S]+FailFastResource/u);
  assert.ok(
    overlappedDispose.indexOf("RequestCancellation") <
      overlappedDispose.indexOf("SettleKernelOperation"),
  );
  assert.ok(
    overlappedDispose.indexOf("SettleKernelOperation") <
      overlappedDispose.indexOf("Marshal.FreeHGlobal"),
  );
  assert.ok(
    overlappedDispose.indexOf("Marshal.FreeHGlobal") <
      overlappedDispose.lastIndexOf("DangerousRelease"),
  );
  assert.doesNotMatch(overlapped, /_pipeHandle\.Dispose/u);
  assert.match(writer, /PrepareFrame/u);
  assert.match(writer, /_servingTicket/u);
  assert.match(writer, /Monitor\.Wait/u);
  assert.match(writer, /MaxFrameBytes/u);
  assert.match(writer, /OperationTimeoutMilliseconds/u);
  assert.match(source, /OpenProcess\([\s\S]+uint desiredAccess/u);
  assert.match(source, /GetKernelObjectSecurity\([\s\S]+SafeFileHandle handle/u);
  assert.match(source, /CreateNamedPipeW\([\s\S]+ref SECURITY_ATTRIBUTES securityAttributes/u);
  assert.match(source, /private static extern bool CancelIoEx\(/u);
  assert.match(source, /SafeFileHandle/u);
  assert.match(source, /private const uint Synchronize = 0x00100000;/u);
  assert.match(source, /private const uint PipeFullControl = 0x001F01FF;/u);
  assert.match(source, /private const int MaxConnections = 64;/u);
  assert.match(source, /private const int MaxTotalQueuedBytes = 262144;/u);
  assert.match(source, /private const int ConnectionJoinTimeoutMilliseconds = 25;/u);
  assert.match(source, /ulong _nextConnectionId/u);
  assert.match(source, /if \(_nextConnectionId == ulong\.MaxValue\)/u);
  assert.match(source, /Thread[^;]+IsBackground = true/u);
  assert.match(
    x64Guard,
    /IsWow64Process2\(GetCurrentProcess\(\), out processMachine, out nativeMachine\)/u,
  );
  assert.match(x64Guard, /ImageFileMachineAmd64/u);
  assert.match(x64Guard, /nativeMachine != ImageFileMachineAmd64/u);
  assert.match(pipeConnection, /_paused = 1/u);
  assert.match(pipeConnection, /_paused = 0/u);
  assert.match(readLoop, /uint transferred = 0;/u);
  assert.match(pipeConnection, /pendingRead\.Cancel\(ReadCancellationReason\.Pause\)/u);
  assert.match(pipeConnection, /_pendingRead\.Generation == pendingRead\.Generation/u);
  assert.match(pendingRead, /long Generation/u);
  assert.match(pendingRead, /ReadCancellationReason CancellationReason/u);
  assert.match(pendingRead, /_cancellationReason == ReadCancellationReason\.None/u);
  assert.match(pipeConnection, /pendingRead\.Cancel\(ReadCancellationReason\.Pause\)/u);
  assert.match(
    retryCanceledRead,
    /pendingRead\.CancellationReason == ReadCancellationReason\.Pause/u,
  );
  assert.match(pipeConnection, /ShouldRetryCanceledRead\([\s\S]+continue/u);
  assert.doesNotMatch(
    pipeConnection,
    /ErrorOperationAborted[\s\S]{0,200}Interlocked\.CompareExchange\(ref _paused/u,
  );
  assert.match(pipeConnection, /MarkCompletedWithoutIo\(\)/u);
  assert.match(pipeConnection, /operation\.IssueWrite/u);
  assert.match(
    pipeConnection,
    /internal PipeConnection\(\s*Broker broker,\s*SafeFileHandle handle,\s*ulong id,\s*ManualResetEvent shutdown,/u,
  );
  assert.doesNotMatch(pipeConnection, /bool synchronous = WriteFile\(/u);
  assert.doesNotMatch(pipeConnection, /_readThread\.Join\(ShutdownTimeoutMilliseconds\)/u);
  assert.match(beginConnectionShutdown, /Interlocked\.Exchange\(ref _closed, 1\)/u);
  assert.match(beginConnectionShutdown, /RequestIoCancellation\(\)/u);
  assert.match(completeConnectionShutdown, /WaitForIoSettlement\(deadline\)/u);
  assert.doesNotMatch(completeConnectionShutdown, /DateTime\.UtcNow|AddMilliseconds/u);
  assert.ok(
    completeConnectionShutdown.indexOf("WaitForIoSettlement(deadline)") <
      completeConnectionShutdown.indexOf("_pipeHandle.Dispose"),
  );
  assert.match(pipeConnection, /private void WaitForIoSettlement\(DateTime deadline\)/u);
  assert.doesNotMatch(waitForIoSettlement, /DateTime\.UtcNow|AddMilliseconds/u);
  assert.match(connectionDispose, /DateTime shutdownDeadline/u);
  assert.match(connectionDispose, /BeginShutdown\(\)/u);
  assert.match(connectionDispose, /CompleteShutdown\(shutdownDeadline\)/u);
  assert.ok(acceptCleanup.indexOf("Set()") < acceptCleanup.indexOf("Join("));
  assert.ok(acceptCleanup.indexOf("Join(") < acceptCleanup.indexOf("DisposePendingAcceptHandle"));
  assert.match(broker, /private void StopAcceptLoop\(DateTime deadline\)/u);
  assert.match(acceptCleanup, /WaitUntil\(_acceptStopped, deadline\)/u);
  assert.doesNotMatch(acceptCleanup, /DateTime\.UtcNow|AddMilliseconds/u);
  assert.doesNotMatch(acceptCleanup, /WaitOne\(ShutdownTimeoutMilliseconds\)/u);
  assert.match(
    closeAll,
    /lock \(_outputGate\)[\s\S]+FrameClose[\s\S]+CloseEveryPipe\(\)[\s\S]+lock \(_outputGate\)[\s\S]+FrameCloseAllAck/u,
  );
  assert.match(closeAll, /_closeAllAcknowledged = true/u);
  assert.match(closeAll, /_closeAllAckQueued = true/u);
  assert.match(source, /readonly PendingCloseTracker _pendingCloses/u);
  assert.match(source, /readonly Timer _closeDeadlineTimer/u);
  assert.doesNotMatch(source, /RecentClosed|Queue<ulong>|closedConnectionOrder/iu);
  assert.match(addBrokerFirst, /state\.BrokerCloseSeen = true/u);
  assert.match(addBrokerFirst, /state\.ParentCloseSeen = false/u);
  assert.match(addBrokerFirst, /state\.DeadlineUtc = deadlineUtc/u);
  assert.match(acknowledgeParent, /state\.ParentCloseSeen/u);
  assert.match(acknowledgeParent, /state\.BrokerCloseSeen/u);
  assert.match(acknowledgeParent, /_states\.Remove\(id\)/u);
  assert.match(closeConnection, /_pendingCloses\.AddBrokerFirst/u);
  assert.match(
    closeConnection,
    /DateTime\.UtcNow\.AddMilliseconds\(ShutdownTimeoutMilliseconds\)/u,
  );
  assert.match(closeConnection, /PrepareFrame\(FrameClose/u);
  assert.match(closeFromParent, /_pendingCloses\.AcknowledgeParent\(id\)/u);
  assert.match(connectionCount, /_connections\.Count \+ _pendingCloses\.Count/u);
  assert.match(scheduleCloseDeadline, /EarliestDeadlineUtc/u);
  assert.match(scheduleCloseDeadline, /_closeDeadlineTimer\.Change/u);
  assert.match(closeDeadlineElapsed, /HasExpired/u);
  assert.match(closeDeadlineElapsed, /Fail\(FailureStage\.Protocol\)/u);
  assert.match(closeEveryPipe, /_pendingCloses\.Clear\(\)/u);
  assert.match(
    closeEveryPipe,
    /_closeDeadlineTimer\.Change\(Timeout\.Infinite, Timeout\.Infinite\)/u,
  );
  assert.equal(
    closeEveryPipe.match(/DateTime\.UtcNow\.AddMilliseconds\(ShutdownTimeoutMilliseconds\)/gu)
      ?.length,
    1,
  );
  assert.match(
    closeEveryPipe,
    /DateTime shutdownDeadline[\s\S]+BeginShutdown\(\)[\s\S]+StopAcceptLoop\(shutdownDeadline\)[\s\S]+CompleteShutdown\(shutdownDeadline\)/u,
  );
  assert.match(brokerDispose, /_closeDeadlineTimer\.Dispose\(timerStopped\)/u);
  assert.match(brokerDispose, /timerStopped\.WaitOne\(ShutdownTimeoutMilliseconds\)/u);
  assert.match(inputLoop, /CloseFromParent\(frame\.ConnectionId\)/u);
  assert.ok(
    inputLoop.indexOf("CloseFromParent(frame.ConnectionId)") <
      inputLoop.indexOf("FindConnection(frame.ConnectionId)"),
  );
  assert.match(source, /PrepareClientData\([\s\S]+lock \(_outputGate\)[\s\S]+ContainsConnection/u);
  const outputCriticalSections = repeatedBalancedBlocks(source, "lock (_outputGate)");
  assert.ok(outputCriticalSections.length >= 6);
  for (const section of outputCriticalSections) {
    assert.doesNotMatch(section, /WritePrepared|WriteFrame/u);
  }
  assert.match(selfTest, /TestCodecConstants\(\)/u);
  assert.match(selfTest, /TestDescriptorConstruction\(\)/u);
  assert.match(selfTest, /TestParentWatchCancellation\(\)/u);
  assert.match(selfTest, /TestInvalidFrameRejection\(\)/u);
  assert.match(selfTest, /TestRepeatedResourceCleanup\(\)/u);
  assert.match(selfTest, /TestPrivatePipeCancellation\(\)/u);
  assert.match(selfTest, /TestPauseImmediateResume\(\)/u);
  assert.match(selfTest, /TestRepeatedPipeCleanup\(\)/u);
  assert.match(selfTest, /TestWritePreIssueCancellation\(\)/u);
  assert.match(selfTest, /TestPendingCloseAdmission\(\)/u);
  assert.match(descriptorSelfTest, /callback \? new byte\[\] \{ 1, 0, 0, 0 \} : null/u);
  const pendingCloseSelfTest = balancedBlock(
    source,
    "private static void TestPendingCloseAdmission(",
  );
  assert.match(pendingCloseSelfTest, /MaxConnections/u);
  assert.match(pendingCloseSelfTest, /10_000|10000/u);
  assert.match(pendingCloseSelfTest, /AcknowledgeParent/u);
  assert.match(pendingCloseSelfTest, /CanAdmit/u);
  const writeInterlockSelfTest = balancedBlock(
    source,
    "private static void TestWritePreIssueCancellation(",
  );
  assert.match(writeInterlockSelfTest, /writePublished/u);
  assert.match(writeInterlockSelfTest, /writeCancellationObserved/u);
  assert.match(writeInterlockSelfTest, /connection\.Write/u);
  assert.match(writeInterlockSelfTest, /connection\.Dispose/u);
  assert.match(source, /WaitUntilWatchdogEntered/u);
  assert.doesNotMatch(selfTest, /CreateNamedPipeW|CreateVerifiedPipe|\\\\\.\\pipe/u);
  assert.doesNotMatch(
    source,
    /Console\.Out|Console\.Write|Console\.Error\.WriteLine\((?:exception|error|message)|System\.Net|TcpListener|NamedPipeServerStream|_handle|bootstrap|fallback/iu,
  );
  const explicitWideImports = ["CreateNamedPipeW", "CreateFileW"];
  for (const importName of explicitWideImports) {
    const declaration = source.slice(source.indexOf(`extern SafeFileHandle ${importName}`) - 180);
    assert.match(declaration.slice(0, 260), /ExactSpelling = true/u);
  }
  assert.doesNotMatch(
    source,
    /\$"|\busing var\b|\bout var\b|\bnameof\s*\(|\?\.|\bis\s+[A-Za-z0-9_.<>]+\s+[a-z][A-Za-z0-9_]*\b|=>/u,
  );
}

function mutateOnce(source, before, after) {
  const mutated = source.replace(before, after);
  assert.notEqual(mutated, source, `mutation target must exist: ${String(before)}`);
  return mutated;
}

function cancelledReadModel(cancellationReason, resumed, closing) {
  if (closing || cancellationReason !== "pause") {
    return "stop";
  }
  return resumed ? "issue-next-read" : "wait-for-resume";
}

function preIssueWriteCancellationModel() {
  const operation = { issued: false, cancellationRequested: false };
  operation.cancellationRequested = true;
  operation.issued = true;
  if (operation.cancellationRequested) {
    return "settled-without-native-issue";
  }
  return "native-write-issued";
}

function pendingCloseAdmissionModel(maxConnections) {
  const pending = new Map();
  return {
    acknowledge(id) {
      assert.equal(pending.delete(id), true);
    },
    admit(id, deadline) {
      if (pending.size >= maxConnections) return false;
      pending.set(id, deadline);
      return true;
    },
    get count() {
      return pending.size;
    },
    has(id) {
      return pending.has(id);
    },
  };
}

test("write cancellation published before issue cannot be lost", () => {
  assert.equal(preIssueWriteCancellationModel(), "settled-without-native-issue");
});

test("pending-read cancellation reason survives an immediate resume", () => {
  assert.equal(cancelledReadModel("pause", true, false), "issue-next-read");
  assert.equal(cancelledReadModel("pause", false, false), "wait-for-resume");
  assert.equal(cancelledReadModel("close", true, false), "stop");
  assert.equal(cancelledReadModel("pause", true, true), "stop");
});

test("broker-first CLOSE admission retains the earliest acknowledgement beyond 64 churn", () => {
  const model = pendingCloseAdmissionModel(64);
  for (let id = 1; id <= 64; id += 1) assert.equal(model.admit(id, 2_000), true);
  assert.equal(model.count, 64);
  assert.equal(model.has(1), true);
  assert.equal(model.admit(65, 2_000), false);

  model.acknowledge(1);
  assert.equal(model.admit(65, 2_000), true);
  assert.equal(model.count, 64);
  assert.equal(model.has(65), true);
});

test("Windows broker protocol constants and directions exactly match Task 1", async () => {
  const [taskOne, csharp] = await Promise.all([
    readFile(taskOneProtocolPath, "utf8"),
    readFile(brokerCSharpPath, "utf8"),
  ]);
  const taskOneProtocol = parseTypeScriptProtocol(taskOne);
  const brokerProtocol = parseCSharpProtocol(csharp);

  assert.deepEqual(Object.keys(taskOneProtocol.types), expectedFrameNames);
  assert.deepEqual(brokerProtocol, taskOneProtocol);
});

test("Node close acknowledgement deadline covers native write and global settlement", async () => {
  const [adapter, csharp] = await Promise.all([
    readFile(brokerAdapterPath, "utf8"),
    readFile(brokerCSharpPath, "utf8"),
  ]);
  const acknowledgementTimeout = Number(
    adapter
      .match(/WINDOWS_BROKER_CLOSE_ACKNOWLEDGEMENT_TIMEOUT_MS = ([\d_]+);/u)?.[1]
      ?.replaceAll("_", ""),
  );
  const postAcknowledgementTimeout = Number(
    adapter
      .match(/WINDOWS_BROKER_POST_ACKNOWLEDGEMENT_TIMEOUT_MS = ([\d_]+);/u)?.[1]
      ?.replaceAll("_", ""),
  );
  const forcedTerminationTimeout = Number(
    adapter.match(/WINDOWS_BROKER_SHUTDOWN_TIMEOUT_MS = ([\d_]+);/u)?.[1]?.replaceAll("_", ""),
  );
  const operationTimeout = Number(csharp.match(/OperationTimeoutMilliseconds = (\d+);/u)?.[1]);
  const shutdownTimeout = Number(csharp.match(/ShutdownTimeoutMilliseconds = (\d+);/u)?.[1]);
  const constructorBody = balancedBlock(
    adapter,
    "constructor(options: WindowsControlBrokerOptions)",
  );
  const closeBody = balancedBlock(adapter, "async #closeOnce()");
  const terminateBody = balancedBlock(adapter, "async #terminateChild()");

  assert.equal(acknowledgementTimeout, operationTimeout + shutdownTimeout + 1_000);
  assert.equal(forcedTerminationTimeout, shutdownTimeout);
  assert.equal(postAcknowledgementTimeout, shutdownTimeout * 3 + 1_000);
  assert.equal(
    constructorBody.includes(
      [
        "this.#postAcknowledgementTimeoutMs = duration(",
        "      options.postAcknowledgementTimeoutMs,",
        "      WINDOWS_BROKER_POST_ACKNOWLEDGEMENT_TIMEOUT_MS,",
        "    );",
      ].join("\n"),
    ),
    true,
  );
  assert.equal(
    closeBody.split(
      "await withDeadline(this.#childClosed.promise, this.#postAcknowledgementTimeoutMs);",
    ).length - 1,
    1,
  );
  assert.equal(
    closeBody.split("await withDeadline(this.#childClosed.promise, this.#shutdownTimeoutMs);")
      .length - 1,
    0,
  );
  assert.equal(
    terminateBody.split("await withDeadline(this.#childClosed.promise, this.#shutdownTimeoutMs);")
      .length - 1,
    2,
  );
  assert.equal(terminateBody.includes("#postAcknowledgementTimeoutMs"), false);
});

test("PowerShell is a fixed validating adjacent-source entry point", async () => {
  assertPowerShellContract(await readFile(brokerPowerShellPath, "utf8"));
});

test("C# owns creation-time security, strict readback, bounded I/O, and stable parent watch", async () => {
  assertCSharpContract(await readFile(brokerCSharpPath, "utf8"));
});

test("source contracts reject security and lifecycle mutations", async () => {
  const csharp = await readFile(brokerCSharpPath, "utf8");
  const mutations = [
    mutateOnce(
      csharp,
      "            ref securityAttributes);",
      "            ref defaultSecurityAttributes);",
    ),
    mutateOnce(csharp, "VerifyDescriptor(handle, expectedSids);", ""),
    mutateOnce(csharp, "ReadReadyDescriptor(firstPipe, descriptor.ExpectedSids)", "new byte[0]"),
    mutateOnce(
      csharp,
      "WindowsIdentity.GetCurrent().User",
      "new SecurityIdentifier(LocalSystemSid)",
    ),
    mutateOnce(
      csharp,
      "        ValidateDescriptor(descriptor, expectedSids);\n\n        byte[] ownerSid =",
      "\n        byte[] ownerSid =",
    ),
    mutateOnce(csharp, "descriptor.Owner.Equals(expectedSids[0])", "true"),
    mutateOnce(
      csharp,
      "_writer.WriteFrame(FrameReady, 0, _readyDescriptor);",
      "_writer.WriteFrame(FrameReady, 0, new byte[0]);",
    ),
    mutateOnce(csharp, "ControlFlags.DiscretionaryAclProtected", "ControlFlags.None"),
    mutateOnce(
      csharp,
      "OpenProcess(Synchronize, false, parentProcessId)",
      "OpenProcess(0, false, parentProcessId)",
    ),
    mutateOnce(csharp, "PipeAccessDuplex | FileFlagOverlapped", "PipeAccessDuplex"),
    mutateOnce(csharp, "pendingRead.Cancel(ReadCancellationReason.Pause);", ""),
    mutateOnce(
      csharp,
      "IsWow64Process2(GetCurrentProcess(), out processMachine, out nativeMachine)",
      "true",
    ),
    mutateOnce(csharp, "if (nativeMachine != ImageFileMachineAmd64)", "if (false)"),
    mutateOnce(
      csharp,
      "                        FrameClose,\n                        connections[index].Id,",
      "                        FrameData,\n                        connections[index].Id,",
    ),
    mutateOnce(csharp, "_closeAllAcknowledged = true;", ""),
    mutateOnce(csharp, "_closeAllAckQueued = true;", ""),
    mutateOnce(csharp, "_pendingCloses.AddBrokerFirst", "_pendingCloses.IgnoreBrokerFirst"),
    mutateOnce(csharp, "_pendingCloses.AcknowledgeParent(id);", ""),
    mutateOnce(
      csharp,
      "CloseFromParent(frame.ConnectionId);",
      "FindConnection(frame.ConnectionId);",
    ),
    mutateOnce(csharp, "_connections.Count + _pendingCloses.Count", "_connections.Count"),
    mutateOnce(csharp, "_pendingCloses.Clear();", ""),
    mutateOnce(
      csharp,
      "shutdownOwnership[index] = connections[index].BeginShutdown();",
      "shutdownOwnership[index] = true;",
    ),
    mutateOnce(
      csharp,
      "StopAcceptLoop(shutdownDeadline);",
      "StopAcceptLoop(DateTime.UtcNow.AddMilliseconds(ShutdownTimeoutMilliseconds));",
    ),
    mutateOnce(
      csharp,
      "connections[index].CompleteShutdown(shutdownDeadline);",
      "connections[index].CompleteShutdown(DateTime.UtcNow.AddMilliseconds(ShutdownTimeoutMilliseconds));",
    ),
    mutateOnce(
      csharp,
      "            WaitForIoSettlement(deadline);",
      "            deadline = DateTime.UtcNow.AddMilliseconds(ShutdownTimeoutMilliseconds);\n            WaitForIoSettlement(deadline);",
    ),
    mutateOnce(
      csharp,
      "            _acceptCancellation.Set();",
      "            deadline = DateTime.UtcNow.AddMilliseconds(ShutdownTimeoutMilliseconds);\n            _acceptCancellation.Set();",
    ),
    mutateOnce(
      csharp,
      "            bool onReadThread = Thread.CurrentThread == _readThread;",
      "            deadline = DateTime.UtcNow.AddMilliseconds(ShutdownTimeoutMilliseconds);\n            bool onReadThread = Thread.CurrentThread == _readThread;",
    ),
    mutateOnce(csharp, "_closeDeadlineTimer.Dispose(timerStopped)", "true"),
    mutateOnce(csharp, "TestPendingCloseAdmission();", ""),
    mutateOnce(csharp, "TerminateProcess(GetCurrentProcess(), 1);", ""),
    mutateOnce(csharp, "Environment.FailFast(StageCode(FailureStage.Resource));", ""),
    mutateOnce(csharp, "_pipeHandle.DangerousAddRef(ref addRef);", "addRef = true;"),
    mutateOnce(csharp, "_pipeHandle.DangerousRelease();", ""),
    mutateOnce(csharp, "SettleKernelOperation(out ignored);", ""),
    mutateOnce(csharp, "_cancellationRequested = true;", ""),
    mutateOnce(csharp, "if (_cancellationRequested)", "if (false)"),
    mutateOnce(csharp, "TestWritePreIssueCancellation();", ""),
    mutateOnce(
      csharp,
      "callback ? new byte[] { 1, 0, 0, 0 } : null",
      "callback ? new byte[] { 1 } : null",
    ),
    mutateOnce(
      csharp,
      / {8}internal PipeConnection\(\n {12}Broker broker,\n {12}SafeFileHandle handle,\n {12}ulong id,\n {12}ManualResetEvent shutdown,/u,
      "        private PipeConnection(\n            Broker broker,\n            SafeFileHandle handle,\n            ulong id,\n            ManualResetEvent shutdown,",
    ),
    mutateOnce(
      csharp,
      "pendingRead.CancellationReason == ReadCancellationReason.Pause",
      "Interlocked.CompareExchange(ref _paused, 0, 0) != 0",
    ),
    mutateOnce(csharp, "ace.IsCallback", "false"),
    mutateOnce(csharp, "ace.AceType != AceType.AccessAllowed ||", ""),
    mutateOnce(csharp, "ace.GetOpaque()", "null"),
    mutateOnce(csharp, "_pendingRead.Generation == pendingRead.Generation", "true"),
    mutateOnce(csharp, "uint transferred = 0;", "uint transferred;"),
    mutateOnce(
      csharp,
      "SetLastError = true, ExactSpelling = true)]\n    private static extern SafeFileHandle CreateNamedPipeW",
      "SetLastError = true)]\n    private static extern SafeFileHandle CreateNamedPipeW",
    ),
    mutateOnce(
      csharp,
      "private static extern bool CancelIoEx(",
      "private static extern bool CancelIoDisabled(",
    ),
  ];
  for (const [index, mutation] of mutations.entries()) {
    assert.throws(() => assertCSharpContract(mutation), `mutation ${index} must fail`);
  }
});

test("broker assets stay repository-owned auditable text", async () => {
  const [powerShell, csharp] = await Promise.all([
    readFile(brokerPowerShellPath),
    readFile(brokerCSharpPath),
  ]);
  assert.equal(powerShell.includes(0), false);
  assert.equal(csharp.includes(0), false);
  assert.equal(root.endsWith("/"), true);
});
