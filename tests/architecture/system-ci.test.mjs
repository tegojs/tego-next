import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DiagnosticError, runtimeDiagnostic } from "@tego/contracts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflowPath = join(root, ".github", "workflows", "ci.yml");
const windowsControlGateChildMarker = "TEGO_WINDOWS_CONTROL_GATE_INNER_OK";
const windowsControlGateMarker = "TEGO_WINDOWS_CONTROL_GATE_OK";
const windowsControlGateRunner = join(root, "scripts", "run-windows-control-gate.mjs");
const windowsControlGateSource = join(root, "packages", "cli", "test", "windows-control-gate.ts");
const windowsControlBrokerCSharpSource = join(root, "scripts", "windows-control-broker.cs");
const windowsControlBrokerPowerShellSource = join(root, "scripts", "windows-control-broker.ps1");
const [canonicalWindowsControlBrokerCSharpSource, canonicalWindowsControlBrokerPowerShellSource] =
  await Promise.all([
    readFile(windowsControlBrokerCSharpSource, "utf8"),
    readFile(windowsControlBrokerPowerShellSource, "utf8"),
  ]);

function validateWindowsControlGateSources(validate, sources) {
  return validate({
    brokerCSharpSource: canonicalWindowsControlBrokerCSharpSource,
    brokerPowerShellSource: canonicalWindowsControlBrokerPowerShellSource,
    ...sources,
  });
}

function windowsControlSourceDigest(source) {
  return createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex");
}

function canonicalWindowsControlRunnerForDigest(source) {
  const normalized = source.replaceAll("\r\n", "\n");
  const declaration = /^const expectedWindowsGateRunnerSourceSha256 =\s*\n?\s*"[0-9a-f]{64}";$/gmu;
  assert.equal([...normalized.matchAll(declaration)].length, 1);
  return normalized.replace(
    declaration,
    'const expectedWindowsGateRunnerSourceSha256 = "<WINDOWS_GATE_RUNNER_SOURCE_SHA256>";',
  );
}

const requiredWindowsControlGateStages = [
  ["packed-clean-consumer", "preparePackedWindowsControlConsumer"],
  ["powershell-csharp-self-test", "runPowerShellSelfTest"],
  ["live-server-handle-descriptor", "startLiveDescriptor"],
  ["status-request", "runStatusRequest"],
  ["malformed-broker-frame-fail-closed", "runMalformedFrameFailure"],
  ["parent-crash-cleanup", "runParentCrashCleanup"],
  ["broker-crash-cleanup", "runBrokerCrashCleanup"],
  ["reconnect-failure", "runReconnectFailure"],
  ["twenty-lifecycle-rounds", "runTwentyLifecycleRounds"],
];
function replaceTopLevelAsyncFunctionBody(source, name, body) {
  const declaration = new RegExp(`^async function ${name}\\b`, "mu").exec(source);
  assert.ok(declaration !== null, `${name} declaration must exist`);
  const bodyStart = source.indexOf("{", declaration.index);
  assert.notEqual(bodyStart, -1, `${name} body must start`);
  const bodyEndMatch = /^\}\r?$/gmu;
  bodyEndMatch.lastIndex = bodyStart;
  const bodyEnd = bodyEndMatch.exec(source)?.index ?? -1;
  assert.notEqual(bodyEnd, -1, `${name} body must end`);
  return `${source.slice(0, bodyStart + 1)}\n${body}\n${source.slice(bodyEnd)}`;
}

function replaceInTopLevelAsyncFunctionBody(source, name, from, to) {
  const declaration = new RegExp(`^async function ${name}\\b`, "mu").exec(source);
  assert.ok(declaration !== null, `${name} declaration must exist`);
  const bodyStart = source.indexOf("{", declaration.index);
  assert.notEqual(bodyStart, -1, `${name} body must start`);
  const bodyEndMatch = /^\}\r?$/gmu;
  bodyEndMatch.lastIndex = bodyStart;
  const bodyEnd = bodyEndMatch.exec(source)?.index ?? -1;
  assert.notEqual(bodyEnd, -1, `${name} body must end`);
  const body = source.slice(bodyStart + 1, bodyEnd);
  const mutatedBody = body.replace(from, to);
  assert.notEqual(mutatedBody, body, `${name} mutation must change its body`);
  return `${source.slice(0, bodyStart + 1)}${mutatedBody}${source.slice(bodyEnd)}`;
}
const requiredStepsByJob = {
  integration: [
    "Check out repository",
    "Set up Node.js",
    "Install pinned npm",
    "Verify npm version",
    "Install dependencies",
    "Build",
    "Run integration tests",
    "Upload integration diagnostics",
  ],
  quality: [
    "Check out repository",
    "Set up Node.js",
    "Install pinned npm",
    "Verify npm version",
    "Install dependencies",
    "Validate commit messages",
    "Check formatting",
    "Lint",
    "Build",
    "Verify deterministic plugin package",
    "Typecheck",
    "Run unit and architecture tests",
    "Validate OpenSpec",
  ],
  "windows-control": [
    "Check out repository",
    "Set up Node.js",
    "Verify Node.js version",
    "Install pinned npm",
    "Verify npm version",
    "Install dependencies",
    "Build CLI",
    "Typecheck CLI",
    "Run Windows control security test",
  ],
  "system-e2e": [
    "Check out repository",
    "Set up Node.js",
    "Install pinned npm",
    "Verify npm version",
    "Install dependencies",
    "Build",
    "Run single-Main system smoke",
    "Run multi-Main takeover",
    "Upload process diagnostics",
  ],
};

function jobRange(workflow, jobName) {
  const start = workflow.search(new RegExp(`^  ${jobName}:\\s*$`, "mu"));
  assert.notEqual(start, -1, `missing job ${jobName}`);
  const tail = workflow.slice(start);
  const next = tail.slice(tail.indexOf("\n") + 1).search(/^ {2}[a-zA-Z0-9_-]+:\s*$/mu);
  return {
    end: next === -1 ? workflow.length : start + tail.indexOf("\n") + 1 + next,
    start,
  };
}

function stepRanges(workflow, jobName) {
  const job = jobRange(workflow, jobName);
  const source = workflow.slice(job.start, job.end);
  const starts = [...source.matchAll(/^ {6}- name:\s*(.+?)\s*$/gmu)].map((match) => ({
    name: match[1],
    start: job.start + match.index,
  }));
  return starts.map((step, index) => ({
    ...step,
    end: starts[index + 1]?.start ?? job.end,
  }));
}

function mutateStepField(workflow, jobName, stepName, field, value) {
  const step = stepRanges(workflow, jobName).find(({ name }) => name === stepName);
  assert.ok(step, `missing step ${jobName}/${stepName}`);
  const block = workflow.slice(step.start, step.end);
  const fieldPattern = new RegExp(`^ {8}${field}:.*$`, "mu");
  const replacement = `        ${field}: ${value}`;
  const mutated = fieldPattern.test(block)
    ? block.replace(fieldPattern, replacement)
    : block.replace(/^ {6}- name:.*$/mu, (line) => `${line}\n${replacement}`);
  return `${workflow.slice(0, step.start)}${mutated}${workflow.slice(step.end)}`;
}

function moveStep(workflow, sourceJob, stepName, targetJob) {
  const step = stepRanges(workflow, sourceJob).find(({ name }) => name === stepName);
  assert.ok(step, `missing step ${sourceJob}/${stepName}`);
  const block = workflow.slice(step.start, step.end);
  const without = `${workflow.slice(0, step.start)}${workflow.slice(step.end)}`;
  const target = jobRange(without, targetJob);
  const stepsHeader = without.slice(target.start, target.end).match(/^ {4}steps:\s*$/mu);
  assert.ok(stepsHeader?.index !== undefined, `missing steps in ${targetJob}`);
  const insertion = target.start + stepsHeader.index + stepsHeader[0].length + 1;
  return `${without.slice(0, insertion)}${block}${without.slice(insertion)}`;
}

function replaceStepCommandWithNoop(workflow, jobName, stepName) {
  const step = stepRanges(workflow, jobName).find(({ name }) => name === stepName);
  assert.ok(step, `missing step ${jobName}/${stepName}`);
  const block = workflow.slice(step.start, step.end);
  const mutated = /^ {8}run:/mu.test(block)
    ? block.replace(/^ {8}run:.*$/mu, "        run: ':'")
    : block.replace(/^ {8}uses:.*$/mu, "        # uses: intentionally disabled");
  assert.notEqual(mutated, block, `${jobName}/${stepName} must have a command`);
  return `${workflow.slice(0, step.start)}${mutated}${workflow.slice(step.end)}`;
}

function swapStepOrder(workflow, jobName, stepName) {
  const steps = stepRanges(workflow, jobName);
  const index = steps.findIndex(({ name }) => name === stepName);
  assert.notEqual(index, -1, `missing step ${jobName}/${stepName}`);
  const leftIndex = index === steps.length - 1 ? index - 1 : index;
  const left = steps[leftIndex];
  const right = steps[leftIndex + 1];
  return [
    workflow.slice(0, left.start),
    workflow.slice(right.start, right.end),
    workflow.slice(left.start, left.end),
    workflow.slice(right.end),
  ].join("");
}

test("@spec:runtime-operations/ci-authoritative-system-acceptance/workflow-gates", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const verifier = await import(
    new URL(`../../scripts/verify-release.mjs?workflow=${Date.now()}`, import.meta.url)
  );
  const jobs = verifier.parseWorkflowJobs(workflow);

  assert.deepEqual([...jobs.keys()], ["quality", "windows-control", "integration", "system-e2e"]);
  assert.deepEqual(verifier.validateWorkflowContract(workflow), []);
});

test("Windows control gate rejects non-Windows, skipped, missing, and failed execution", async () => {
  assert.equal(existsSync(windowsControlGateRunner), true, "Windows gate runner must exist");
  if (!existsSync(windowsControlGateRunner)) return;
  const { assertWindowsControlGateResult } = await import(
    new URL(`../../scripts/run-windows-control-gate.mjs?contract=${Date.now()}`, import.meta.url)
  );
  const success = {
    error: undefined,
    signal: null,
    status: 0,
    stderr: "",
    stdout: `${windowsControlGateChildMarker}\n`,
  };

  assert.throws(() => assertWindowsControlGateResult("darwin", success), /requires Windows/u);
  assert.throws(
    () => assertWindowsControlGateResult("win32", { ...success, stdout: "" }),
    /completion marker/u,
  );
  assert.throws(
    () =>
      assertWindowsControlGateResult("win32", {
        ...success,
        stdout: "ℹ tests 1\nℹ pass 0\nℹ skipped 1\n",
      }),
    /completion marker/u,
  );
  assert.throws(
    () => assertWindowsControlGateResult("win32", { ...success, status: 1 }),
    /failed/u,
  );
  assert.doesNotThrow(() => assertWindowsControlGateResult("win32", success));

  if (process.platform !== "win32") {
    const result = spawnSync(process.execPath, [windowsControlGateRunner], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, new RegExp(windowsControlGateMarker, "u"));
  }
});

test("Windows control gate source contract fixes every real stage before the sole marker", async () => {
  const [{ validateWindowsControlGateContract }, runnerSource, gateSource] = await Promise.all([
    import(
      new URL(
        `../../scripts/run-windows-control-gate.mjs?source-contract=${Date.now()}`,
        import.meta.url,
      )
    ),
    readFile(windowsControlGateRunner, "utf8"),
    readFile(windowsControlGateSource, "utf8"),
  ]);

  assert.equal(
    typeof validateWindowsControlGateContract,
    "function",
    "Windows gate runner must export its structural source validator",
  );
  assert.deepEqual(
    validateWindowsControlGateSources(validateWindowsControlGateContract, {
      gateSource,
      runnerSource,
    }),
    [],
  );
});

test("Windows gate executable source digests are independently fixed", async (t) => {
  const [
    { validateWindowsControlGateContract },
    gateSource,
    runnerSource,
    brokerCSharpSource,
    brokerPowerShellSource,
  ] = await Promise.all([
    import(
      new URL(
        `../../scripts/run-windows-control-gate.mjs?independent-digests=${Date.now()}`,
        import.meta.url,
      )
    ),
    readFile(windowsControlGateSource, "utf8"),
    readFile(windowsControlGateRunner, "utf8"),
    readFile(windowsControlBrokerCSharpSource, "utf8"),
    readFile(windowsControlBrokerPowerShellSource, "utf8"),
  ]);
  const expectedDigests = {
    brokerCSharpSource: "26c14d7c78b632a6e9d49369e123a97dd28949e47bda8b7d760f0e4ce312f1c4",
    brokerPowerShellSource: "3b6279a12436f1d21c77f2e45b7b510995b1ad369cd53870483b9c03f33c3b53",
    gateSource: "99dbb76dd7d6d0a0dd93df16ab8140230dd7d84fe3ca7e7cfd3b83f75086a3d6",
    runnerSource: "a3f603349b03bea1d2506a4455eb7af8e2022809bfe6bbf73505b45c3f23ba0a",
  };
  const sources = { brokerCSharpSource, brokerPowerShellSource, gateSource, runnerSource };
  assert.deepEqual(
    validateWindowsControlGateContract(
      Object.fromEntries(
        Object.entries(sources).map(([sourceName, source]) => [
          sourceName,
          source.replaceAll("\n", "\r\n"),
        ]),
      ),
    ),
    [],
  );
  for (const [sourceName, source] of Object.entries(sources)) {
    const canonical =
      sourceName === "runnerSource" ? canonicalWindowsControlRunnerForDigest(source) : source;
    assert.equal(windowsControlSourceDigest(canonical), expectedDigests[sourceName]);
    assert.equal(
      windowsControlSourceDigest(canonical.replaceAll("\n", "\r\n")),
      expectedDigests[sourceName],
    );
  }

  for (const [sourceName, expectedDeclaration] of [
    ["gateSource", "expectedWindowsGateSourceSha256"],
    ["brokerCSharpSource", "expectedWindowsBrokerCSharpSourceSha256"],
    ["brokerPowerShellSource", "expectedWindowsBrokerPowerShellSourceSha256"],
  ]) {
    await t.test(`${sourceName} and validator hashes cannot change together`, () => {
      const mutatedSource = `${sources[sourceName]}// coordinated mutation\n`;
      const mutatedSourceDigest = windowsControlSourceDigest(mutatedSource);
      let mutatedRunner = runnerSource.replace(expectedDigests[sourceName], mutatedSourceDigest);
      assert.notEqual(mutatedRunner, runnerSource);
      const mutatedRunnerDigest = windowsControlSourceDigest(
        canonicalWindowsControlRunnerForDigest(mutatedRunner),
      );
      mutatedRunner = mutatedRunner.replace(expectedDigests.runnerSource, mutatedRunnerDigest);
      assert.match(
        mutatedRunner,
        new RegExp(`${expectedDeclaration}[\\s\\S]+${mutatedSourceDigest}`, "u"),
      );
      assert.notEqual(
        windowsControlSourceDigest(canonicalWindowsControlRunnerForDigest(mutatedRunner)),
        expectedDigests.runnerSource,
      );
      assert.ok(
        validateWindowsControlGateContract({
          ...sources,
          [sourceName]: mutatedSource,
          runnerSource: mutatedRunner,
        }).length > 0,
      );
    });
  }

  await t.test("runner source and self hash cannot change together", () => {
    let mutatedRunner = `${runnerSource}// coordinated runner mutation\n`;
    const mutatedRunnerDigest = windowsControlSourceDigest(
      canonicalWindowsControlRunnerForDigest(mutatedRunner),
    );
    mutatedRunner = mutatedRunner.replace(expectedDigests.runnerSource, mutatedRunnerDigest);
    assert.notEqual(
      windowsControlSourceDigest(canonicalWindowsControlRunnerForDigest(mutatedRunner)),
      expectedDigests.runnerSource,
    );
    assert.ok(
      validateWindowsControlGateContract({ ...sources, runnerSource: mutatedRunner }).length > 0,
    );
  });

  await t.test("runner self digest literal cannot change", () => {
    const mutatedRunner = runnerSource.replace(expectedDigests.runnerSource, "0".repeat(64));
    assert.notEqual(mutatedRunner, runnerSource);
    assert.ok(
      validateWindowsControlGateContract({ ...sources, runnerSource: mutatedRunner }).length > 0,
    );
    assert.ok(
      validateWindowsControlGateContract({
        ...Object.fromEntries(
          Object.entries(sources).map(([sourceName, source]) => [
            sourceName,
            source.replaceAll("\n", "\r\n"),
          ]),
        ),
        runnerSource: mutatedRunner.replaceAll("\n", "\r\n"),
      }).length > 0,
    );
  });
});

test("Windows gate proves the current-user descriptor without a redundant PowerShell SID query", async () => {
  const gateSource = await readFile(windowsControlGateSource, "utf8");
  assert.doesNotMatch(gateSource, /initializeCurrentUserSid|currentUserSid|\$PSVersionTable/u);
  assert.match(
    gateSource,
    /function assertDescriptor\([^)]+\)[\s\S]+const ownerSid = descriptor\.ownerSid;[\s\S]+\[ownerSid, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID\]/u,
  );
  assert.match(
    gateSource,
    /async function runParentCrashCleanup\(\): Promise<void> \{[\s\S]+tracked = await startTrackedServer\("parent-crash", fixture\);/u,
  );
});

test("Windows gate proves exact native pipe absence and fails closed on every other result", async () => {
  const gateSource = await readFile(windowsControlGateSource, "utf8");
  assert.match(gateSource, /realpathSync\(requiredEnvironment\("SystemRoot"\)\)/u);
  assert.match(
    gateSource,
    /join\(systemRoot, "System32", "WindowsPowerShell", "v1\.0", "powershell\.exe"\)/u,
  );
  assert.doesNotMatch(gateSource, /Path: requiredEnvironment\("Path"\)/u);
  assert.match(gateSource, /WaitNamedPipeW/u);
  assert.match(gateSource, /SetLastError = true/u);
  assert.match(gateSource, /Marshal\.GetLastWin32Error\(\)/u);
  assert.match(gateSource, /if \(error == 2\) return 0;/u);
  assert.match(gateSource, /if \(error == 121 \|\| error == 231\) return 2;/u);
  assert.match(
    gateSource,
    /assertNativePipeAbsent\(endpoint\);[\s\S]+await assert\.rejects\([\s\S]+requestControl/u,
  );
  assert.match(
    gateSource,
    /async function runStatusRequest\(\): Promise<void> \{[\s\S]+await assertStatus\([\s\S]+assertNativePipePresent\(liveServer\.endpoint\);/u,
  );
});

test("Windows gate source validation rejects weakened native pipe absence proofs", async (t) => {
  const [{ validateWindowsControlGateContract }, runnerSource, gateSource] = await Promise.all([
    import(
      new URL(
        `../../scripts/run-windows-control-gate.mjs?pipe-proof=${Date.now()}`,
        import.meta.url,
      )
    ),
    readFile(windowsControlGateRunner, "utf8"),
    readFile(windowsControlGateSource, "utf8"),
  ]);
  const mutations = [
    [
      "native probe early return",
      "function runNativePipeProbe(endpoint: string): number {",
      "function runNativePipeProbe(endpoint: string): number {\n  return 0;",
    ],
    [
      "pipe proof early return",
      "async function assertPipeUnavailable(endpoint: string): Promise<void> {",
      "async function assertPipeUnavailable(endpoint: string): Promise<void> {\n  return;",
    ],
    [
      "status calibration early return",
      "async function runStatusRequest(): Promise<void> {",
      "async function runStatusRequest(): Promise<void> {\n  return;",
    ],
    ["PowerShell success shortcut", "try {\n$null = Add-Type", "try {\nexit 0\n$null = Add-Type"],
    [
      "C sharp success shortcut",
      "    public static int Probe(string endpoint)\n    {",
      "    public static int Probe(string endpoint)\n    {\n        return 0;",
    ],
    [
      "secret parent environment added",
      "    env: {",
      "    env: {\n      EXTRA: process.env.GITHUB_TOKEN,",
    ],
    [
      "SystemRoot not canonicalized",
      'const systemRoot = realpathSync(requiredEnvironment("SystemRoot"));',
      'const systemRoot = requiredEnvironment("SystemRoot");',
    ],
    ["SystemRoot absolute check removed", "  assert.equal(isAbsolute(systemRoot), true);", ""],
    [
      "SystemRoot drive check removed",
      "  assert.match(systemRoot, /^[A-Za-z]:\\\\[^\\r\\n]+$/u);",
      "",
    ],
    [
      "PowerShell executable not canonicalized",
      [
        "  const powershellExecutable = realpathSync(",
        '    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),',
        "  );",
      ].join("\n"),
      [
        "  const powershellExecutable = join(",
        '    systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe",',
        "  );",
      ].join("\n"),
    ],
    [
      "PowerShell executable escapes SystemRoot",
      '    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),',
      '    join(requiredEnvironment("TEMP"), "powershell.exe"),',
    ],
    [
      "PowerShell containment check removed",
      "  assert.equal(isContained(systemRoot, powershellExecutable), true);",
      "",
    ],
    [
      "PowerShell executable resolved through PATH",
      "  const probe = spawnSync(powershellExecutable, windowsPipeProbeArguments, {",
      '  const probe = spawnSync("powershell.exe", windowsPipeProbeArguments, {',
    ],
    [
      "request rejection skipped",
      "  assertNativePipeAbsent(endpoint);\n  await assert.rejects(",
      "  assertNativePipeAbsent(endpoint);\n  return;\n  await assert.rejects(",
    ],
    ["native probe removed", "  assertNativePipeAbsent(endpoint);", ""],
    ["live present calibration removed", "  assertNativePipePresent(liveServer.endpoint);", ""],
    ["last-error capture disabled", "SetLastError = true", "SetLastError = false"],
    [
      "available pipe treated as absent",
      "if (WaitNamedPipeW(endpoint, 1)) return 2;",
      "if (WaitNamedPipeW(endpoint, 1)) return 0;",
    ],
    ["missing pipe treated as present", "if (error == 2) return 0;", "if (error == 2) return 2;"],
    [
      "busy pipe treated as absent",
      "if (error == 121 || error == 231) return 2;",
      "if (error == 121 || error == 231) return 0;",
    ],
    [
      "unknown native error treated as absent",
      "        return 3;\n    }\n}",
      "        return 0;\n    }\n}",
    ],
    ["probe errors ignored", "  assert.equal(probe.error, undefined);", ""],
    ["probe signals ignored", "  assert.equal(probe.signal, null);", ""],
    [
      "probe status allowlist removed",
      "  assert.ok(probe.status === 0 || probe.status === 2 || probe.status === 3);",
      "",
    ],
    [
      "absent assertion accepts present",
      "  assert.equal(runNativePipeProbe(endpoint), 0);",
      "  assert.notEqual(runNativePipeProbe(endpoint), 3);",
    ],
    [
      "present assertion accepts absent",
      "  assert.equal(runNativePipeProbe(endpoint), 2);",
      "  assert.notEqual(runNativePipeProbe(endpoint), 3);",
    ],
    ["probe stdout ignored", '  assert.equal(probe.stdout, "");', ""],
    ["probe stderr ignored", '  assert.equal(probe.stderr, "");', ""],
    [
      "endpoint interpolated into encoded source",
      'Buffer.from(windowsPipeProbeSource, "utf16le")',
      "Buffer.from(`" + "$" + "{windowsPipeProbeSource}" + "$" + '{endpoint}`, "utf16le")',
    ],
    ["endpoint data channel removed", "      TEGO_WINDOWS_PIPE_PROBE_ENDPOINT: endpoint,", ""],
    ["full parent environment inherited", "    env: {", "    env: {\n      ...process.env,"],
    ["encoded command replaced", '  "-EncodedCommand",', '  "-File",'],
    ["probe output bound removed", "    maxBuffer: POWERSHELL_STARTUP_STDERR_MAX_BYTES,", ""],
    ["shell enabled", "    shell: false,", "    shell: true,"],
    ["probe stdio contract removed", '    stdio: ["ignore", "pipe", "pipe"],', ""],
    ["timeout removed", "    timeout: PROCESS_CLEANUP_TIMEOUT_MS,", ""],
    ["hidden window contract removed", "    windowsHide: true,", ""],
  ];

  for (const [name, from, to] of mutations) {
    await t.test(name, () => {
      const mutation = gateSource.replace(from, to);
      assert.notEqual(mutation, gateSource);
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: mutation,
          runnerSource,
        }).length > 0,
      );
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: mutation.replaceAll("\n", "\r\n"),
          runnerSource: runnerSource.replaceAll("\n", "\r\n"),
        }).length > 0,
      );
    });
  }
});

test("Windows gate rolls back partial acquisition and owns parent-crash processes by handle", async (t) => {
  const [{ validateWindowsControlGateContract }, gateSource, runnerSource] = await Promise.all([
    import(
      new URL(
        `../../scripts/run-windows-control-gate.mjs?handle-ownership=${Date.now()}`,
        import.meta.url,
      )
    ),
    readFile(windowsControlGateSource, "utf8"),
    readFile(windowsControlGateRunner, "utf8"),
  ]);
  assert.match(gateSource, /interface OwnedChild/u);
  assert.match(gateSource, /async function rollbackTrackedServerAcquisition/u);
  assert.match(gateSource, /catch \(primary\) \{[\s\S]+rollbackTrackedServerAcquisition/u);
  assert.match(gateSource, /TEGO_WINDOWS_PARENT_FIXTURE_NONCE/u);
  assert.match(gateSource, /type: "challenge"/u);
  assert.match(gateSource, /type: "ack"/u);
  assert.match(gateSource, /"-ParentProcessId"/u);
  assert.doesNotMatch(gateSource, /function processExists|waitForProcessExit|process\.kill\(/u);
  assert.doesNotMatch(gateSource, /brokerPid/u);
  assert.deepEqual(
    validateWindowsControlGateSources(validateWindowsControlGateContract, {
      gateSource,
      runnerSource,
    }),
    [],
  );
  assert.deepEqual(
    validateWindowsControlGateSources(validateWindowsControlGateContract, {
      gateSource: gateSource.replaceAll("\n", "\r\n"),
      runnerSource: runnerSource.replaceAll("\n", "\r\n"),
    }),
    [],
  );

  const bodyMutation = (name, from, to) =>
    replaceInTopLevelAsyncFunctionBody(gateSource, name, from, to);
  const mutations = [
    [
      "close event replaced by exit",
      gateSource.replace(
        'child.once("close", () => resolveClose());',
        'child.once("exit", () => resolveClose());',
      ),
    ],
    [
      "acquisition rollback bypassed",
      bodyMutation(
        "startTrackedServer",
        "return await rollbackTrackedServerAcquisition({ broker, endpoint, server }, primary);",
        "throw primary;",
      ),
    ],
    [
      "descriptor assertion escapes acquisition",
      bodyMutation("startTrackedServer", "    assertDescriptor(descriptor);\n", ""),
    ],
    [
      "rollback server close removed",
      bodyMutation(
        "rollbackTrackedServerAcquisition",
        "      await withDeadline(pending.server.close(), PROCESS_CLEANUP_TIMEOUT_MS);",
        "      await Promise.resolve();",
      ),
    ],
    [
      "rollback broker kill removed",
      bodyMutation(
        "rollbackTrackedServerAcquisition",
        '      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");',
        "      void child;",
      ),
    ],
    [
      "rollback captured close removed",
      bodyMutation(
        "rollbackTrackedServerAcquisition",
        "      await withDeadline(pending.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
        "      await Promise.resolve();",
      ),
    ],
    [
      "rollback exact pipe proof removed",
      bodyMutation(
        "rollbackTrackedServerAcquisition",
        "    await assertPipeUnavailable(pending.endpoint);",
        "    await Promise.resolve();",
      ),
    ],
    [
      "rollback primary reordered",
      bodyMutation(
        "rollbackTrackedServerAcquisition",
        "      [primary, ...cleanupErrors],",
        "      [...cleanupErrors, primary],",
      ),
    ],
    [
      "ParentProcessId uniqueness removed",
      gateSource.replace("  assert.deepEqual(parentProcessIdIndexes, [9]);", ""),
    ],
    [
      "ParentProcessId default binding removed",
      gateSource.replace(
        "  assert.equal(brokerArguments[parentProcessIdIndex + 1], String(process.pid));",
        "",
      ),
    ],
    [
      "fixture parent is not watched",
      bodyMutation(
        "runParentCrashCleanup",
        'tracked = await startTrackedServer("parent-crash", fixture);',
        'tracked = await startTrackedServer("parent-crash");',
      ),
    ],
    [
      "ready nonce comparison removed",
      gateSource.replace("    candidate.nonce === nonce &&", "    nonce.length > 0 &&"),
    ],
    [
      "challenge nonce comparison removed",
      gateSource.replace("    candidate.nonce === nonce\n  );", "    nonce.length > 0\n  );"),
    ],
    [
      "ack nonce comparison removed",
      gateSource.replace(
        '    candidate.type === "ack" &&\n    candidate.nonce === nonce',
        '    candidate.type === "ack" &&\n    nonce.length > 0',
      ),
    ],
    [
      "challenge round trip removed",
      bodyMutation(
        "runParentCrashCleanup",
        "    await sendParentFixtureChallenge(fixture, nonce);",
        "    await Promise.resolve();",
      ),
    ],
    [
      "broker stdin closed before watchdog",
      bodyMutation(
        "runParentCrashCleanup",
        '    assert.equal(fixture.child.kill("SIGKILL"), true);',
        '    tracked.broker.child.stdin?.end();\n    assert.equal(fixture.child.kill("SIGKILL"), true);',
      ),
    ],
    [
      "broker killed instead of watchdog",
      bodyMutation(
        "runParentCrashCleanup",
        "    await withDeadline(fixture.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
        '    await withDeadline(fixture.closed, PROCESS_CLEANUP_TIMEOUT_MS);\n    tracked.broker.child.kill("SIGKILL");',
      ),
    ],
    [
      "server closed before watchdog",
      bodyMutation(
        "runParentCrashCleanup",
        "    await acknowledged;",
        "    await acknowledged;\n    await tracked.server.close();",
      ),
    ],
    [
      "malformed broker frame replaces watchdog",
      bodyMutation(
        "runParentCrashCleanup",
        "    await withDeadline(fixture.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
        "    await withDeadline(fixture.closed, PROCESS_CLEANUP_TIMEOUT_MS);\n    await writeMalformedFrame(tracked.broker.child);",
      ),
    ],
    [
      "broker error emission replaces watchdog",
      bodyMutation(
        "runParentCrashCleanup",
        "    await withDeadline(fixture.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
        '    await withDeadline(fixture.closed, PROCESS_CLEANUP_TIMEOUT_MS);\n    tracked.broker.child.emit("error", new Error("forced"));',
      ),
    ],
    [
      "bracket alias kills broker instead of watchdog",
      bodyMutation(
        "runParentCrashCleanup",
        "    await withDeadline(fixture.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
        '    await withDeadline(fixture.closed, PROCESS_CLEANUP_TIMEOUT_MS);\n    const injectedBrokerChild = tracked.broker["child"];\n    injectedBrokerChild.kill("SIGKILL");',
      ),
    ],
    [
      "broker close proof removed",
      bodyMutation(
        "runParentCrashCleanup",
        "    await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
        "    await Promise.resolve();",
      ),
    ],
    [
      "pipe proof removed",
      bodyMutation(
        "runParentCrashCleanup",
        "    await assertPipeUnavailable(tracked.endpoint);",
        "    await Promise.resolve();",
      ),
    ],
    [
      "tracked fallback removed",
      gateSource.replace(
        "      await cleanupTrackedServer(tracked);",
        "      await Promise.resolve();",
      ),
    ],
    [
      "fixture fallback removed",
      gateSource.replace(
        "      await cleanupOwnedChild(fixture);",
        "      await Promise.resolve();",
      ),
    ],
    [
      "top-level ownership released early",
      gateSource.replace(
        "      const owned = liveServer;\n      try {",
        "      const owned = liveServer;\n      liveServer = undefined;\n      try {",
      ),
    ],
    [
      "numeric process kill introduced",
      gateSource.replace("let liveServer", "process.kill(1, 0);\n\nlet liveServer"),
    ],
    [
      "numeric process probe introduced",
      gateSource.replace("let liveServer", "processExists(1);\n\nlet liveServer"),
    ],
    [
      "numeric process wait introduced",
      gateSource.replace("let liveServer", "waitForProcessExit(1);\n\nlet liveServer"),
    ],
    [
      "broker PID IPC reintroduced",
      gateSource.replace("let liveServer", "const brokerPid = 1;\n\nlet liveServer"),
    ],
  ];

  for (const [name, mutation] of mutations) {
    await t.test(name, () => {
      assert.notEqual(mutation, gateSource);
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: mutation,
          runnerSource,
        }).length > 0,
      );
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: mutation.replaceAll("\n", "\r\n"),
          runnerSource: runnerSource.replaceAll("\n", "\r\n"),
        }).length > 0,
      );
    });
  }

  const hashMatch = /const expectedParentCrashCleanupSha256 =\s+"([0-9a-f]{64})";/u.exec(
    runnerSource,
  );
  assert.ok(hashMatch !== null);
  const originalHash = hashMatch[1];
  const bracketAliasMutation = mutations.find(
    ([name]) => name === "bracket alias kills broker instead of watchdog",
  )?.[1];
  assert.ok(bracketAliasMutation !== undefined);
  const declaration = /^async function runParentCrashCleanup\b/mu.exec(bracketAliasMutation);
  assert.ok(declaration !== null);
  const bodyStart = bracketAliasMutation.indexOf("{", declaration.index);
  const bodyEndPattern = /^\}$/gmu;
  bodyEndPattern.lastIndex = bodyStart;
  const bodyEnd = bodyEndPattern.exec(bracketAliasMutation)?.index ?? -1;
  assert.notEqual(bodyEnd, -1);
  const mutatedBody = bracketAliasMutation.slice(bodyStart + 1, bodyEnd).trim();
  const mutatedHash = createHash("sha256").update(mutatedBody).digest("hex");
  const runnerMutations = [
    ["canonical hash changed", runnerSource.replace(originalHash, "0".repeat(64))],
    [
      "canonical digest calculation bypassed",
      runnerSource.replace(
        'return createHash("sha256").update(normalizedContractText(source)).digest("hex");',
        "return expectedParentCrashCleanupSha256;",
      ),
    ],
    [
      "gate body and hash changed together",
      runnerSource.replace(originalHash, mutatedHash),
      bracketAliasMutation,
    ],
  ];
  for (const [name, mutatedRunner, mutatedGate = gateSource] of runnerMutations) {
    await t.test(name, () => {
      assert.notEqual(mutatedRunner, runnerSource);
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: mutatedGate,
          runnerSource: mutatedRunner,
        }).length > 0,
      );
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: mutatedGate.replaceAll("\n", "\r\n"),
          runnerSource: mutatedRunner.replaceAll("\n", "\r\n"),
        }).length > 0,
      );
    });
  }
});

test("Windows control gate source validation rejects removed, reordered, softened, or no-op stages", async (t) => {
  const { validateWindowsControlGateContract } = await import(
    new URL(
      `../../scripts/run-windows-control-gate.mjs?stage-mutations=${Date.now()}`,
      import.meta.url,
    )
  );
  assert.equal(
    typeof validateWindowsControlGateContract,
    "function",
    "Windows gate runner must export its structural source validator",
  );

  const stageLines = requiredWindowsControlGateStages.map(
    ([stage, implementation], index) =>
      `${index === 0 ? "    " : "  "}await runWindowsControlGateStage("${stage}", ${implementation});`,
  );
  const markerWrite = `  process.stdout.write(\`\${WINDOWS_CONTROL_GATE_MARKER}\\n\`);`;
  const [runnerFixture, gateFixture] = await Promise.all([
    readFile(windowsControlGateRunner, "utf8"),
    readFile(windowsControlGateSource, "utf8"),
  ]);
  assert.deepEqual(
    validateWindowsControlGateSources(validateWindowsControlGateContract, {
      gateSource: gateFixture,
      runnerSource: runnerFixture,
    }),
    [],
  );
  assert.deepEqual(
    validateWindowsControlGateSources(validateWindowsControlGateContract, {
      gateSource: gateFixture.replaceAll("\n", "\r\n"),
      runnerSource: runnerFixture.replaceAll("\n", "\r\n"),
    }),
    [],
  );

  for (const [index, [stage, implementation]] of requiredWindowsControlGateStages.entries()) {
    const sourceName = index === 0 ? "runnerSource" : "gateSource";
    const indent = index === 0 ? "    " : "  ";
    const original = sourceName === "runnerSource" ? runnerFixture : gateFixture;
    const line = stageLines[index];
    const removed = original.replace(`${line}\n`, "");
    const noOp = original.replace(
      line,
      `${indent}await runWindowsControlGateStage("${stage}", async () => undefined);`,
    );
    const softened = original.replace(line, `${indent}if (false) ${line.trim()}`);
    let reordered;
    if (index === 0) {
      reordered = original.replace(
        `${line}\n    await runInstalledWindowsControlGate();`,
        `    await runInstalledWindowsControlGate();\n${line}`,
      );
    } else if (index === requiredWindowsControlGateStages.length - 1) {
      const previousLine = stageLines[index - 1];
      reordered = original.replace(`${previousLine}\n${line}`, `${line}\n${previousLine}`);
    } else {
      const nextLine = stageLines[index + 1];
      reordered = original.replace(`${line}\n${nextLine}`, `${nextLine}\n${line}`);
    }

    for (const [mutationName, mutation] of [
      ["removed", removed],
      ["replaced by no-op", noOp],
      ["softened by condition", softened],
      ["reordered", reordered],
    ]) {
      await t.test(`${stage}: ${mutationName}`, () => {
        assert.notEqual(mutation, original);
        const diagnostics = validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: sourceName === "gateSource" ? mutation : gateFixture,
          runnerSource: sourceName === "runnerSource" ? mutation : runnerFixture,
        });
        assert.ok(diagnostics.length > 0, `${stage} ${mutationName} must fail closed`);
        const crlfDiagnostics = validateWindowsControlGateSources(
          validateWindowsControlGateContract,
          {
            gateSource: (sourceName === "gateSource" ? mutation : gateFixture).replaceAll(
              "\n",
              "\r\n",
            ),
            runnerSource: (sourceName === "runnerSource" ? mutation : runnerFixture).replaceAll(
              "\n",
              "\r\n",
            ),
          },
        );
        assert.ok(
          crlfDiagnostics.length > 0,
          `${stage} ${mutationName} must fail closed with CRLF`,
        );
      });
    }

    assert.match(implementation, /^(?:prepare|run|start)/u);
  }

  for (const runnerMutation of [
    runnerFixture.replace("    await runInstalledWindowsControlGate();\n", ""),
    runnerFixture.replace(
      "    await runInstalledWindowsControlGate();",
      "    await Promise.resolve();",
    ),
    runnerFixture.replace(markerWrite, `${markerWrite}\n  await runInstalledWindowsControlGate();`),
  ]) {
    assert.ok(
      validateWindowsControlGateSources(validateWindowsControlGateContract, {
        gateSource: gateFixture,
        runnerSource: runnerMutation,
      }).length > 0,
      "installed execution and the sole marker must remain ordered and non-noop",
    );
  }

  for (const sourceName of ["gateSource", "runnerSource"]) {
    const source = sourceName === "gateSource" ? gateFixture : runnerFixture;
    const noOpHelper = source.replace("  await operation();", "  await Promise.resolve();");
    assert.ok(
      validateWindowsControlGateSources(validateWindowsControlGateContract, {
        gateSource: sourceName === "gateSource" ? noOpHelper : gateFixture,
        runnerSource: sourceName === "runnerSource" ? noOpHelper : runnerFixture,
      }).length > 0,
      `${sourceName} cannot replace the stage executor with a no-op`,
    );
  }
});

test("Windows control gate validation rejects hidden control flow and implementation no-ops", async (t) => {
  const [{ validateWindowsControlGateContract }, runnerSource, gateSource] = await Promise.all([
    import(
      new URL(
        `../../scripts/run-windows-control-gate.mjs?deep-stage-mutations=${Date.now()}`,
        import.meta.url,
      )
    ),
    readFile(windowsControlGateRunner, "utf8"),
    readFile(windowsControlGateSource, "utf8"),
  ]);
  const statusLine = '  await runWindowsControlGateStage("status-request", runStatusRequest);';

  for (const [name, mutation] of [
    ["conditional block", gateSource.replace(statusLine, `  if (false) {\n${statusLine}\n  }`)],
    ["swallowed catch", gateSource.replace(statusLine, `  try {\n${statusLine}\n  } catch {}`)],
    ["early return", gateSource.replace(statusLine, `  return;\n${statusLine}`)],
    [
      "loop continue",
      gateSource.replace(statusLine, `  for (;;) {\n    continue;\n${statusLine}\n  }`),
    ],
  ]) {
    await t.test(name, () => {
      assert.notEqual(mutation, gateSource);
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: mutation,
          runnerSource,
        }).length > 0,
      );
    });
  }

  for (const [index, [_stage, implementation]] of requiredWindowsControlGateStages.entries()) {
    const sourceName = index === 0 ? "runnerSource" : "gateSource";
    const source = sourceName === "runnerSource" ? runnerSource : gateSource;
    const mutation = replaceTopLevelAsyncFunctionBody(
      source,
      implementation,
      "  await Promise.resolve();",
    );
    await t.test(`${implementation} implementation no-op`, () => {
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: sourceName === "gateSource" ? mutation : gateSource,
          runnerSource: sourceName === "runnerSource" ? mutation : runnerSource,
        }).length > 0,
      );
    });
  }
});

test("Windows gate validator rejects executable bypasses and temporary diagnostics in every source", async (t) => {
  const [
    { validateWindowsControlGateContract },
    gateSource,
    runnerSource,
    brokerCSharpSource,
    brokerPowerShellSource,
  ] = await Promise.all([
    import(
      new URL(
        `../../scripts/run-windows-control-gate.mjs?executable-contract=${Date.now()}`,
        import.meta.url,
      )
    ),
    readFile(windowsControlGateSource, "utf8"),
    readFile(windowsControlGateRunner, "utf8"),
    readFile(windowsControlBrokerCSharpSource, "utf8"),
    readFile(windowsControlBrokerPowerShellSource, "utf8"),
  ]);
  const innerStatusStage =
    '  await runWindowsControlGateStage("status-request", runStatusRequest);';
  const outerPackedStage =
    '    await runWindowsControlGateStage("packed-clean-consumer", preparePackedWindowsControlConsumer);';
  const mutations = [
    {
      gateSource: gateSource.replace(
        "async function runInstalledWindowsControlGate(): Promise<void> {",
        "async function runInstalledWindowsControlGate(): Promise<void> {\n  if (true) return;",
      ),
      name: "inner orchestrator early return",
    },
    {
      gateSource: gateSource.replace(innerStatusStage, `  if (0) {\n${innerStatusStage}\n  }`),
      name: "inner stage hidden behind conditional",
    },
    {
      gateSource: gateSource.replace(innerStatusStage, `  /*\n${innerStatusStage}\n  */`),
      name: "inner stage moved into block comment",
    },
    {
      name: "outer orchestrator early return",
      runnerSource: runnerSource.replace(
        "export async function runWindowsControlGate(platform = process.platform) {",
        "export async function runWindowsControlGate(platform = process.platform) {\n  if (true) return;",
      ),
    },
    {
      name: "outer stage hidden behind conditional",
      runnerSource: runnerSource.replace(
        outerPackedStage,
        `    if (0) {\n${outerPackedStage}\n    }`,
      ),
    },
    {
      gateSource: replaceInTopLevelAsyncFunctionBody(
        gateSource,
        "startLiveDescriptor",
        '  liveServer = await startTrackedServer("live-descriptor");',
        '  // liveServer = await startTrackedServer("live-descriptor");\n  await Promise.resolve();',
      ),
      name: "implementation proof moved into comment",
    },
    {
      gateSource: replaceInTopLevelAsyncFunctionBody(
        gateSource,
        "startLiveDescriptor",
        '  liveServer = await startTrackedServer("live-descriptor");',
        '  try {\n    liveServer = await startTrackedServer("live-descriptor");\n  } catch {}',
      ),
      name: "implementation swallows failure",
    },
    {
      gateSource: replaceInTopLevelAsyncFunctionBody(
        gateSource,
        "runBrokerCrashCleanup",
        "    await assertPipeUnavailable(tracked.endpoint);",
        "    /* await assertPipeUnavailable(tracked.endpoint); */",
      ),
      name: "broker crash pipe proof moved into comment",
    },
    {
      gateSource: replaceInTopLevelAsyncFunctionBody(
        gateSource,
        "runBrokerCrashCleanup",
        "    await assertPipeUnavailable(tracked.endpoint);",
        "    try {\n      await assertPipeUnavailable(tracked.endpoint);\n    } catch {}",
      ),
      name: "broker crash pipe proof failure swallowed",
    },
    {
      gateSource: replaceInTopLevelAsyncFunctionBody(
        gateSource,
        "runMalformedFrameFailure",
        '  let tracked: TrackedServer | undefined = await startTrackedServer("malformed-frame");',
        '  if (true) return;\n  let tracked: TrackedServer | undefined = await startTrackedServer("malformed-frame");',
      ),
      name: "implementation returns before evidence",
    },
    {
      gateSource: replaceInTopLevelAsyncFunctionBody(
        gateSource,
        "runTwentyLifecycleRounds",
        "  for (let round = 0; round < 20; round += 1) {",
        "  for (let round = 0; round < 20; round += 1) {\n    continue;",
      ),
      name: "lifecycle loop continues before evidence",
    },
    {
      name: "packed consumer returns before pack",
      runnerSource: replaceInTopLevelAsyncFunctionBody(
        runnerSource,
        "preparePackedWindowsControlConsumer",
        '  const directory = await mkdtemp(join(tmpdir(), "tego-windows-control-gate-"));',
        '  if (true) return;\n  const directory = await mkdtemp(join(tmpdir(), "tego-windows-control-gate-"));',
      ),
    },
    {
      gateSource: gateSource.replace(
        '  const selfTest = spawnSync("powershell.exe", selfTestArguments, {',
        '  spawnSync(\n    "powershell.exe",\n    selfTestArguments,\n    {},\n  );\n  const selfTest = spawnSync("powershell.exe", selfTestArguments, {',
      ),
      name: "second multiline SelfTest spawn",
    },
    {
      brokerCSharpSource: brokerCSharpSource.replace(
        "WindowsIdentity.GetCurrent().User",
        "new SecurityIdentifier(LocalSystemSid) // WindowsIdentity.GetCurrent().User",
      ),
      name: "C sharp current user bypassed with comment decoy",
    },
    {
      brokerCSharpSource: brokerCSharpSource.replace(
        "        ValidateDescriptor(descriptor, expectedSids);\n\n        byte[] ownerSid =",
        "        // ValidateDescriptor(descriptor, expectedSids);\n\n        byte[] ownerSid =",
      ),
      name: "C sharp descriptor readback validation moved into comment",
    },
    {
      brokerCSharpSource: brokerCSharpSource.replace(
        "        ValidateDescriptor(descriptor, expectedSids);\n\n        byte[] ownerSid =",
        "        if (false) ValidateDescriptor(descriptor, expectedSids);\n\n        byte[] ownerSid =",
      ),
      name: "C sharp descriptor readback validation disabled",
    },
    {
      brokerPowerShellSource: brokerPowerShellSource.replace(
        "if ($SelfTest) {\n  if (",
        "if ($SelfTest) {\n  exit 0\n  if (",
      ),
      name: "PowerShell SelfTest exits before Add-Type",
    },
    {
      brokerPowerShellSource: brokerPowerShellSource.replace(
        "  $SelfTest -and (",
        "  $false -and $SelfTest -and (",
      ),
      name: "PowerShell 5.1 guard disabled",
    },
    {
      brokerPowerShellSource: brokerPowerShellSource.replace(
        "  Add-Type -Path $sourcePath",
        "  # Add-Type -Path $sourcePath",
      ),
      name: "PowerShell Add-Type moved into comment",
    },
    {
      brokerPowerShellSource: brokerPowerShellSource.replace(
        "  Add-Type -Path $sourcePath",
        "  if ($false) { Add-Type -Path $sourcePath }",
      ),
      name: "PowerShell Add-Type disabled",
    },
    {
      brokerPowerShellSource: brokerPowerShellSource.replace(
        "  Add-Type -Path $sourcePath",
        "  Add-Type -Path $sourcePath\n  Add-Type -Path $sourcePath",
      ),
      name: "PowerShell Add-Type duplicated",
    },
    {
      gateSource: `${gateSource}\nprocess.stderr.write(["TEGO", "TASK4", "NON", "AUTHORITATIVE"].join("_") + "\\n");\n`,
      name: "gate split temporary diagnostic reintroduced",
    },
    {
      name: "runner split temporary diagnostic reintroduced",
      runnerSource: runnerSource.replace(
        '    process.stderr.write("TEGO_WINDOWS_CONTROL_GATE_FAILED\\n");',
        '    process.stderr.write(["TEGO", "TASK4", "NON", "AUTHORITATIVE"].join("_") + "\\n");',
      ),
    },
    {
      brokerCSharpSource: `${brokerCSharpSource}\n// TEGO_TASK4_NON_AUTHORITATIVE_DIAGNOSTIC\n`,
      name: "C sharp temporary diagnostic reintroduced",
    },
    {
      brokerPowerShellSource: `${brokerPowerShellSource}\n# TEGO_TASK4_NON_AUTHORITATIVE_DIAGNOSTIC\n`,
      name: "PowerShell temporary diagnostic reintroduced",
    },
  ];

  for (const mutation of mutations) {
    const sources = {
      brokerCSharpSource,
      brokerPowerShellSource,
      gateSource,
      runnerSource,
      ...mutation,
    };
    delete sources.name;
    assert.notDeepEqual(sources, {
      brokerCSharpSource,
      brokerPowerShellSource,
      gateSource,
      runnerSource,
    });
    await t.test(mutation.name, () => {
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, sources).length > 0,
      );
      assert.ok(
        validateWindowsControlGateSources(
          validateWindowsControlGateContract,
          Object.fromEntries(
            Object.entries(sources).map(([sourceName, source]) => [
              sourceName,
              source.replaceAll("\n", "\r\n"),
            ]),
          ),
        ).length > 0,
      );
    });
  }

  for (const missingSource of [
    "brokerCSharpSource",
    "brokerPowerShellSource",
    "gateSource",
    "runnerSource",
  ]) {
    await t.test(`${missingSource} is required text`, () => {
      const sources = { brokerCSharpSource, brokerPowerShellSource, gateSource, runnerSource };
      delete sources[missingSource];
      assert.deepEqual(validateWindowsControlGateContract(sources), [
        "Windows gate sources must be text",
      ]);
      sources[missingSource] = null;
      assert.deepEqual(validateWindowsControlGateContract(sources), [
        "Windows gate sources must be text",
      ]);
    });
  }
});

test("Windows malformed-frame cleanup transfers ownership only after exact child close", async (t) => {
  const [{ validateWindowsControlGateContract }, runnerSource, gateSource] = await Promise.all([
    import(
      new URL(
        `../../scripts/run-windows-control-gate.mjs?malformed-ownership=${Date.now()}`,
        import.meta.url,
      )
    ),
    readFile(windowsControlGateRunner, "utf8"),
    readFile(windowsControlGateSource, "utf8"),
  ]);
  const mutations = [
    gateSource.replace(
      '    child.once("close", () => resolveClose());',
      '    child.once("exit", () => resolveClose());',
    ),
    gateSource.replace(
      "    await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
      "    await waitForProcessExit(1);",
    ),
    gateSource.replace(
      "    await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
      "    await withDeadline(tracked.failure, PROCESS_CLEANUP_TIMEOUT_MS);",
    ),
    gateSource.replace("    tracked = undefined;\n", ""),
    gateSource
      .replace("    tracked = undefined;\n", "")
      .replace(
        "    await assertPipeUnavailable(tracked.endpoint);",
        "    tracked = undefined;\n    await assertPipeUnavailable(tracked.endpoint);",
      ),
    gateSource.replace(
      "    if (tracked !== undefined) await cleanupTrackedServer(tracked);",
      "    await cleanupTrackedServer(tracked);",
    ),
  ];

  for (const [index, mutation] of mutations.entries()) {
    await t.test(`malformed ownership mutation ${String(index + 1)}`, () => {
      assert.notEqual(mutation, gateSource);
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: mutation,
          runnerSource,
        }).length > 0,
      );
    });
  }

  for (const [name, replaceFrom, replaceWith] of [
    ["aggregate cardinality", "error.errors.length === 2", "error.errors.length >= 1"],
    [
      "primary diagnostic",
      'diagnosticCode(error.errors[0]) === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE"',
      "error.errors[0] instanceof Error",
    ],
    [
      "observer identity",
      "error.errors[1] === observedFailure",
      "error.errors[0] === observedFailure",
    ],
    [
      "observer diagnostic",
      'diagnosticCode(error.errors[1]) === "PROTOCOL_CONTROL_ENDPOINT_UNSAFE"',
      "error.errors[1] instanceof Error",
    ],
  ]) {
    await t.test(`malformed close matcher ${name}`, () => {
      const mutatedGate = gateSource.replace(replaceFrom, replaceWith);
      const mutatedRunner = runnerSource.replace(replaceFrom, replaceWith);
      assert.notEqual(mutatedGate, gateSource);
      assert.notEqual(mutatedRunner, runnerSource);
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: mutatedGate,
          runnerSource: mutatedRunner,
        }).length > 0,
      );
    });
  }
});

test("Windows malformed close matcher requires the ordered unsafe aggregate", async () => {
  const { isExpectedMalformedServerClose } = await import(
    new URL(
      `../../scripts/run-windows-control-gate.mjs?close-aggregate=${Date.now()}`,
      import.meta.url,
    )
  );
  assert.equal(typeof isExpectedMalformedServerClose, "function");
  const endpointUnsafe = () =>
    new DiagnosticError(
      runtimeDiagnostic({
        code: "PROTOCOL_CONTROL_ENDPOINT_UNSAFE",
        message: "PROTOCOL_CONTROL_ENDPOINT_UNSAFE",
        source: { kind: "protocol" },
      }),
    );
  const brokerCleanup = endpointUnsafe();
  const observedFailure = endpointUnsafe();
  const other = new Error("other close failure");

  assert.equal(
    isExpectedMalformedServerClose(
      new AggregateError([brokerCleanup, observedFailure]),
      observedFailure,
    ),
    true,
  );
  for (const error of [
    brokerCleanup,
    new AggregateError([observedFailure, brokerCleanup]),
    new AggregateError([brokerCleanup, observedFailure, endpointUnsafe()]),
    new AggregateError([other, observedFailure]),
    new AggregateError([brokerCleanup, other]),
  ]) {
    assert.equal(isExpectedMalformedServerClose(error, observedFailure), false);
  }
});

test("Windows broker-crash cleanup reuses the exact aggregate and releases captured ownership", async (t) => {
  const [{ validateWindowsControlGateContract }, runnerSource, gateSource] = await Promise.all([
    import(
      new URL(
        `../../scripts/run-windows-control-gate.mjs?broker-crash-ownership=${Date.now()}`,
        import.meta.url,
      )
    ),
    readFile(windowsControlGateRunner, "utf8"),
    readFile(windowsControlGateSource, "utf8"),
  ]);
  assert.match(
    gateSource,
    /async function runBrokerCrashCleanup\(\): Promise<void> \{[\s\S]+let tracked: TrackedServer \| undefined = await startTrackedServer\("broker-crash"\);[\s\S]+isExpectedMalformedServerClose\(error, failure\)[\s\S]+await withDeadline\(tracked\.broker\.closed, PROCESS_CLEANUP_TIMEOUT_MS\);[\s\S]+await assertPipeUnavailable\(tracked\.endpoint\);[\s\S]+tracked = undefined;[\s\S]+if \(tracked !== undefined\) await cleanupTrackedServer\(tracked\);/u,
  );
  for (const [name, from, to] of [
    [
      "direct close matcher",
      "isExpectedMalformedServerClose(error, failure)",
      "/PROTOCOL_CONTROL_ENDPOINT_UNSAFE/u.test(error.message)",
    ],
    [
      "numeric PID polling",
      "await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
      "await waitForProcessExit(1);",
    ],
    ["missing release", "    tracked = undefined;", ""],
    [
      "early release",
      "    await assertPipeUnavailable(tracked.endpoint);\n    tracked = undefined;",
      "    tracked = undefined;\n    await assertPipeUnavailable(tracked.endpoint);",
    ],
    [
      "unconditional fallback",
      "    if (tracked !== undefined) await cleanupTrackedServer(tracked);",
      "    await cleanupTrackedServer(tracked);",
    ],
  ]) {
    await t.test(name, () => {
      const mutation = replaceInTopLevelAsyncFunctionBody(
        gateSource,
        "runBrokerCrashCleanup",
        from,
        to,
      );
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: mutation,
          runnerSource,
        }).length > 0,
      );
    });
  }
});

test("Windows reconnect and lifecycle close retain ownership through captured close and pipe proof", async (t) => {
  const [{ validateWindowsControlGateContract }, runnerSource, gateSource] = await Promise.all([
    import(
      new URL(
        `../../scripts/run-windows-control-gate.mjs?normal-close-ownership=${Date.now()}`,
        import.meta.url,
      )
    ),
    readFile(windowsControlGateRunner, "utf8"),
    readFile(windowsControlGateSource, "utf8"),
  ]);
  assert.match(
    gateSource,
    /async function runReconnectFailure\(\): Promise<void> \{[\s\S]+await tracked\.server\.close\(\);[\s\S]+await withDeadline\(tracked\.broker\.closed, PROCESS_CLEANUP_TIMEOUT_MS\);[\s\S]+await assertPipeUnavailable\(tracked\.endpoint\);[\s\S]+liveServer = undefined;[\s\S]+if \(liveServer === tracked\) \{[\s\S]+await cleanupTrackedServer\(tracked\);[\s\S]+liveServer = undefined;/u,
  );
  assert.match(
    gateSource,
    /async function runTwentyLifecycleRounds\(\): Promise<void> \{[\s\S]+let tracked: TrackedServer \| undefined = await startTrackedServer[\s\S]+await tracked\.server\.close\(\);[\s\S]+await withDeadline\(tracked\.broker\.closed, PROCESS_CLEANUP_TIMEOUT_MS\);[\s\S]+await assertPipeUnavailable\(tracked\.endpoint\);[\s\S]+tracked = undefined;[\s\S]+if \(tracked !== undefined\) await cleanupTrackedServer\(tracked\);/u,
  );
  for (const [implementation, mutations] of [
    [
      "runReconnectFailure",
      [
        [
          "numeric PID polling",
          "await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
          "await waitForProcessExit(1);",
        ],
        [
          "early release",
          "    await assertPipeUnavailable(tracked.endpoint);\n    assert.equal(liveServer, tracked);\n    liveServer = undefined;",
          "    liveServer = undefined;\n    await assertPipeUnavailable(tracked.endpoint);\n    assert.equal(liveServer, tracked);",
        ],
        [
          "release before fallback cleanup",
          "    if (liveServer === tracked) {\n      await cleanupTrackedServer(tracked);\n      liveServer = undefined;",
          "    if (liveServer === tracked) {\n      liveServer = undefined;\n      await cleanupTrackedServer(tracked);",
        ],
      ],
    ],
    [
      "runTwentyLifecycleRounds",
      [
        [
          "numeric PID polling",
          "await withDeadline(tracked.broker.closed, PROCESS_CLEANUP_TIMEOUT_MS);",
          "await waitForProcessExit(1);",
        ],
        [
          "early release",
          "      await assertPipeUnavailable(tracked.endpoint);\n      tracked = undefined;",
          "      tracked = undefined;\n      await assertPipeUnavailable(tracked.endpoint);",
        ],
        [
          "unconditional fallback",
          "      if (tracked !== undefined) await cleanupTrackedServer(tracked);",
          "      await cleanupTrackedServer(tracked);",
        ],
      ],
    ],
  ]) {
    for (const [name, from, to] of mutations) {
      await t.test(`${implementation}: ${name}`, () => {
        const mutation = replaceInTopLevelAsyncFunctionBody(gateSource, implementation, from, to);
        assert.ok(
          validateWindowsControlGateSources(validateWindowsControlGateContract, {
            gateSource: mutation,
            runnerSource,
          }).length > 0,
        );
      });
    }
  }
});

test("Windows gate validation keeps one bounded strict authoritative SelfTest", async (t) => {
  const [{ validateWindowsControlGateContract }, runnerSource, gateSource] = await Promise.all([
    import(
      new URL(
        `../../scripts/run-windows-control-gate.mjs?selftest-mutations=${Date.now()}`,
        import.meta.url,
      )
    ),
    readFile(windowsControlGateRunner, "utf8"),
    readFile(windowsControlGateSource, "utf8"),
  ]);
  assert.equal(
    gateSource.match(/spawnSync\("powershell\.exe", selfTestArguments, \{/gu)?.length,
    1,
  );
  assert.doesNotMatch(`${gateSource}\n${runnerSource}`, /\bprime\b|TEGO_TASK4_NON_AUTHORITATIVE/u);
  const mutations = [
    gateSource.replace(
      "  assert.equal(selfTest.status, 0);",
      "  assert.equal(selfTest.status, selfTest.status);",
    ),
    gateSource.replace(
      '  const selfTest = spawnSync("powershell.exe", selfTestArguments, {',
      '  const selfTest = spawnSync("powershell-disabled.exe", selfTestArguments, {',
    ),
    gateSource.replace('  assert.equal(selfTest.stderr, "");', "  void selfTest.stderr;"),
    gateSource.replace(
      "  assert.equal(selfTest.signal, null);",
      "  assert.equal(selfTest.signal, selfTest.signal);",
    ),
    gateSource.replace(
      "  assert.equal(selfTest.error, undefined);",
      '  spawnSync("powershell.exe", selfTestArguments, {});\n  assert.equal(selfTest.error, undefined);',
    ),
  ];

  for (const [index, mutation] of mutations.entries()) {
    await t.test(`SelfTest mutation ${String(index + 1)}`, () => {
      assert.notEqual(mutation, gateSource);
      assert.ok(
        validateWindowsControlGateSources(validateWindowsControlGateContract, {
          gateSource: mutation,
          runnerSource,
        }).length > 0,
      );
    });
  }
});

test("release verification is strict, complete, and non-recursive", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.devDependencies["js-yaml"], "4.3.0");
  assert.equal(packageJson.scripts["verify:release"], "node scripts/verify-release.mjs");
  assert.equal(
    packageJson.scripts.verify,
    "npm run format:check && npm run lint && npm run build && npm run typecheck && npm test && npm run test:integration:local && npm run test:e2e:single-main",
  );
  assert.equal(
    packageJson.scripts["test:integration:local"],
    "node --test tests/integration/*.test.mjs",
  );
  assert.equal(
    packageJson.scripts["test:integration"],
    "npm run test:integration:local && npm run test:integration --workspaces --if-present",
  );
  assert.equal(
    packageJson.scripts["openspec:validate"],
    "node scripts/verify-release.mjs --openspec",
  );
  assert.equal(
    packageJson.scripts["test:e2e:single-main"],
    'node --test --test-name-pattern="real-single-main-process-flow" tests/e2e/single-main-process.test.mjs',
  );
  assert.equal(
    packageJson.scripts["test:e2e:multi-main"],
    'node --test --test-name-pattern="real-two-main-postgres-worker-failover" tests/e2e/single-main-process.test.mjs',
  );

  const verifier = await import(
    new URL(`../../scripts/verify-release.mjs?test=${Date.now()}`, import.meta.url)
  );
  assert.equal(verifier.openspecInvocation.command, process.execPath);
  assert.deepEqual(verifier.openspecInvocation.args.slice(1), [
    "exec",
    "--yes",
    "--package=@fission-ai/openspec@1.4.1",
    "--",
    "openspec",
    "validate",
    "runtime-kernel-phase-1",
    "--strict",
    "--no-interactive",
  ]);
  assert.deepEqual(
    verifier.releaseCommands.map(({ name }) => name),
    [
      "clean lockfile install",
      "format",
      "lint",
      "build",
      "typecheck",
      "unit and architecture tests",
      "integration tests",
      "public package contracts",
      "deterministic plugin package",
      "single-Main smoke",
      "multi-Main takeover",
      "strict OpenSpec validation",
    ],
  );
  for (const { command, args } of verifier.releaseCommands) {
    if (command !== "internal:deterministic-plugin-package") {
      assert.equal(command, process.execPath);
    }
    assert.notEqual(
      [command, ...args].join(" ").includes("verify:release"),
      true,
      "release verification must not recursively invoke itself",
    );
  }
});

test("release verification preflight fails closed with structured diagnostics", async () => {
  const { validateReleasePreflight } = await import(
    new URL(`../../scripts/verify-release.mjs?preflight=${Date.now()}`, import.meta.url)
  );
  const valid = {
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
    workflow: await readFile(workflowPath, "utf8"),
  };

  assert.deepEqual(validateReleasePreflight(valid), []);
  for (const [field, value, code] of [
    ["gitStatus", " M package.json", "dirty_worktree"],
    ["nodeVersion", "v26.5.1", "node_version_mismatch"],
    ["npmVersion", "11.13.1", "npm_version_mismatch"],
    ["postgresUrl", "", "postgres_url_missing"],
    ["workflow", "quality:", "ci_contract_incomplete"],
  ]) {
    const diagnostics = validateReleasePreflight({ ...valid, [field]: value });
    assert.equal(
      diagnostics.some((diagnostic) => diagnostic.code === code),
      true,
    );
    assert.equal(
      diagnostics.every((diagnostic) => diagnostic.level === "error"),
      true,
    );
  }
});

test("CI workflow validation rejects every disabled, soft-fail, misplaced, no-op, or reordered required step", async (t) => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateReleasePreflight } = await import(
    new URL(`../../scripts/verify-release.mjs?mutations=${Date.now()}`, import.meta.url)
  );
  const base = {
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
  };
  const wrongJobs = {
    integration: "system-e2e",
    quality: "integration",
    "system-e2e": "quality",
    "windows-control": "quality",
  };

  for (const [jobName, stepNames] of Object.entries(requiredStepsByJob)) {
    for (const stepName of stepNames) {
      const mutations = {
        "commented or no-op command": replaceStepCommandWithNoop(workflow, jobName, stepName),
        disabled: mutateStepField(workflow, jobName, stepName, "if", "false"),
        misplaced: moveStep(workflow, jobName, stepName, wrongJobs[jobName]),
        reordered: swapStepOrder(workflow, jobName, stepName),
        "soft fail": mutateStepField(workflow, jobName, stepName, "continue-on-error", "true"),
      };
      for (const [mutationName, mutation] of Object.entries(mutations)) {
        await t.test(`${jobName}/${stepName}: ${mutationName}`, () => {
          assert.notEqual(mutation, workflow);
          const diagnostics = validateReleasePreflight({ ...base, workflow: mutation });
          assert.equal(
            diagnostics.some(({ code }) => code === "ci_contract_incomplete"),
            true,
          );
        });
      }
    }
  }
});

test("CI workflow validation rejects removal, replacement, or no-op of the Windows gate", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const oldPatternCommand =
    'node --test --test-name-pattern="Windows pipe hardening drains connections|windows-pipe-access-cleanup-contract" packages/cli/dist/test/control.test.js';
  const { validateReleasePreflight } = await import(
    new URL(`../../scripts/verify-release.mjs?windows-gate=${Date.now()}`, import.meta.url)
  );
  const base = {
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
  };
  assert.deepEqual(validateReleasePreflight({ ...base, workflow }), []);

  const step = stepRanges(workflow, "windows-control").find(
    ({ name }) => name === "Run Windows control security test",
  );
  assert.ok(step);
  const mutations = [
    `${workflow.slice(0, step.start)}${workflow.slice(step.end)}`,
    mutateStepField(
      workflow,
      "windows-control",
      "Run Windows control security test",
      "run",
      oldPatternCommand,
    ),
    mutateStepField(
      workflow,
      "windows-control",
      "Run Windows control security test",
      "run",
      `node -e 'console.log("${windowsControlGateMarker}")'`,
    ),
    mutateStepField(
      workflow,
      "windows-control",
      "Run Windows control security test",
      "timeout-minutes",
      "12",
    ),
  ];
  for (const mutation of mutations) {
    const diagnostics = validateReleasePreflight({ ...base, workflow: mutation });
    assert.equal(
      diagnostics.some(({ code }) => code === "ci_contract_incomplete"),
      true,
    );
  }
});

test("CI workflow validation requires automatic pull-request and main push triggers", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateReleasePreflight } = await import(
    new URL(`../../scripts/verify-release.mjs?trigger-mutations=${Date.now()}`, import.meta.url)
  );
  const base = {
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
  };
  const triggerBlock = [
    "on:",
    "  pull_request:",
    "    branches: [main]",
    "  push:",
    "    branches: [main]",
    "  workflow_dispatch:",
  ].join("\n");
  const mutations = [
    workflow.replace(triggerBlock, "on:\n  workflow_dispatch:"),
    workflow.replace("    branches: [main]", "    branches: [release]", 1),
    workflow.replace("  push:\n    branches: [main]\n", ""),
    workflow.replace("  pull_request:\n    branches: [main]\n", ""),
  ];

  for (const mutation of mutations) {
    assert.notEqual(mutation, workflow);
    const diagnostics = validateReleasePreflight({ ...base, workflow: mutation });
    assert.equal(
      diagnostics.some(({ code }) => code === "ci_contract_incomplete"),
      true,
    );
  }
});

test("CI workflow validation requires the deterministic package step after build", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateReleasePreflight } = await import(
    new URL(`../../scripts/verify-release.mjs?package-mutation=${Date.now()}`, import.meta.url)
  );
  const step = stepRanges(workflow, "quality").find(
    ({ name }) => name === "Verify deterministic plugin package",
  );
  assert.ok(step);
  const mutation = `${workflow.slice(0, step.start)}${workflow.slice(step.end)}`;
  const diagnostics = validateReleasePreflight({
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
    workflow: mutation,
  });

  assert.equal(
    diagnostics.some(({ code }) => code === "ci_contract_incomplete"),
    true,
  );
});

test("CI workflow validation rejects extra or duplicate PostgreSQL health flags", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateReleasePreflight } = await import(
    new URL(`../../scripts/verify-release.mjs?health-mutations=${Date.now()}`, import.meta.url)
  );
  const base = {
    gitStatus: "",
    nodeVersion: "v26.5.0",
    npmVersion: "11.13.0",
    postgresUrl: "postgresql://localhost/tego",
  };
  const mutations = [
    workflow.replace(
      "          --health-retries 30",
      "          --health-retries 30\n          --no-healthcheck",
    ),
    workflow.replace(
      "          --health-retries 30",
      "          --health-retries 30\n          --health-retries 30",
    ),
    workflow.replace(
      '          --health-cmd "pg_isready -U tego_test -d tego_next_test"',
      '          --health-cmd "pg_isready -U tego_test -d tego_next_test"\n          --health-cmd "true"',
    ),
  ];

  for (const mutation of mutations) {
    const diagnostics = validateReleasePreflight({ ...base, workflow: mutation });
    assert.equal(
      diagnostics.some(({ code }) => code === "ci_contract_incomplete"),
      true,
    );
  }
});

test("CI workflow validation binds action review comments to their required steps", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const { validateReleasePreflight } = await import(
    new URL(
      `../../scripts/verify-release.mjs?action-comment-mutations=${Date.now()}`,
      import.meta.url,
    )
  );
  const checkout = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0";
  const checkoutReference = checkout.split(" # ")[0];
  const mutations = [
    workflow
      .replace(`        uses: ${checkout}`, `        uses: ${checkoutReference}`)
      .replace(
        "permissions:\n  contents: read",
        `permissions:\n  contents: read\n\nenv:\n  ACTION_REVIEW_SPOOF: |\n    uses: ${checkout}`,
      ),
    workflow
      .replace(`        uses: ${checkout}`, `        uses: ${checkoutReference}`)
      .replace(
        "name: CI",
        [
          "name: |",
          "  quality:",
          "    steps:",
          "      - name: Check out repository",
          `        uses: ${checkout}`,
          "      - name: Set up Node.js",
          "        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0",
        ].join("\n"),
      ),
    workflow
      .replace("name: CI", `name: CI\n\nx-checkout: &checkout ${checkoutReference} # v6.1.0`)
      .replace(`        uses: ${checkout}`, "        uses: *checkout"),
  ];

  for (const mutation of mutations) {
    const diagnostics = validateReleasePreflight({
      gitStatus: "",
      nodeVersion: "v26.5.0",
      npmVersion: "11.13.0",
      postgresUrl: "postgresql://localhost/tego",
      workflow: mutation,
    });
    assert.equal(
      diagnostics.some(({ code }) => code === "ci_contract_incomplete"),
      true,
    );
  }
});

test("deterministic package gate compares independent artifacts and manifests without residue", async () => {
  const beforeStatus = spawnSync("git", ["status", "--porcelain=v1"], {
    cwd: root,
    encoding: "utf8",
  }).stdout;
  const beforeTemporaryDirectories = (await readdir(tmpdir()))
    .filter((name) => name.startsWith("tego-release-package-"))
    .sort();
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts", "verify-release.mjs"), "--deterministic-package"],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"artifactSha256":"[a-f0-9]{64}"/u);
  assert.match(result.stdout, /"manifestSha256":"[a-f0-9]{64}"/u);
  assert.equal(
    spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout,
    beforeStatus,
  );
  assert.deepEqual(
    (await readdir(tmpdir())).filter((name) => name.startsWith("tego-release-package-")).sort(),
    beforeTemporaryDirectories,
  );
});

test("CI reporter always writes nonempty JSON metadata and process logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-ci-reporter-"));
  const reporter = join(root, "scripts", "run-ci-test.mjs");
  try {
    for (const probe of [
      { name: "success", code: 0 },
      { name: "failure", code: 7 },
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          reporter,
          "--name",
          probe.name,
          "--artifacts",
          directory,
          "--",
          process.execPath,
          "-e",
          `console.log("stdout-${probe.name}"); console.error("stderr-${probe.name}"); process.exit(${probe.code})`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, probe.code);
      assert.match(result.stdout, new RegExp(`stdout-${probe.name}`, "u"));
      assert.match(result.stderr, new RegExp(`stderr-${probe.name}`, "u"));

      const metadata = JSON.parse(
        await readFile(join(directory, `${probe.name}-result.json`), "utf8"),
      );
      const log = await readFile(join(directory, `${probe.name}-process.log`), "utf8");
      assert.equal(metadata.name, probe.name);
      assert.equal(metadata.exitCode, probe.code);
      assert.equal(metadata.timedOut, false);
      assert.equal(metadata.command, process.execPath);
      assert.ok(metadata.startedAt.length > 0);
      assert.ok(metadata.finishedAt.length > 0);
      assert.ok(metadata.durationMs >= 0);
      assert.match(log, new RegExp(`stdout-${probe.name}`, "u"));
      assert.match(log, new RegExp(`stderr-${probe.name}`, "u"));
    }

    const npmProbe = spawnSync(
      process.execPath,
      [reporter, "--name", "npm", "--artifacts", directory, "--", "npm", "--version"],
      { encoding: "utf8" },
    );
    assert.equal(npmProbe.status, 0);
    const npmMetadata = JSON.parse(await readFile(join(directory, "npm-result.json"), "utf8"));
    assert.equal(npmMetadata.command, "npm");
    assert.equal(npmMetadata.actualCommand, process.execPath);
    assert.match(npmMetadata.actualArgs[0], /npm-cli\.js$/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("CI reporter times out and terminates a child before writing final metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-ci-reporter-timeout-"));
  const reporter = join(root, "scripts", "run-ci-test.mjs");
  const startedAt = Date.now();
  try {
    const result = spawnSync(
      process.execPath,
      [
        reporter,
        "--name",
        "timeout",
        "--artifacts",
        directory,
        "--timeout-ms",
        "200",
        "--ready-pattern",
        "child-pid:",
        "--startup-timeout-ms",
        "2000",
        "--",
        process.execPath,
        "-e",
        [
          'console.log("child-pid:" + process.pid);',
          'process.on("SIGTERM", () => console.log("ignored-sigterm"));',
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    const elapsedMs = Date.now() - startedAt;

    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined);
    assert.ok(elapsedMs < 5_000, `reporter exceeded bounded completion: ${elapsedMs}ms`);

    const metadata = JSON.parse(await readFile(join(directory, "timeout-result.json"), "utf8"));
    const log = await readFile(join(directory, "timeout-process.log"), "utf8");
    assert.equal(metadata.name, "timeout");
    assert.equal(metadata.timedOut, true);
    assert.equal(metadata.timeoutMs, 200);
    assert.notEqual(metadata.exitCode, 0);
    assert.ok(Object.hasOwn(metadata, "childExitCode"));
    assert.ok(Object.hasOwn(metadata, "childSignal"));
    assert.equal(metadata.command, process.execPath);
    assert.ok(metadata.startedAt.length > 0);
    assert.ok(metadata.finishedAt.length > 0);
    assert.ok(metadata.durationMs >= 200);
    assert.ok(metadata.terminationSignal);
    assert.match(log, /child-pid:\d+/u);

    const childPid = Number.parseInt(log.match(/child-pid:(\d+)/u)?.[1] ?? "", 10);
    assert.ok(Number.isInteger(childPid));
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("CI reporter reaps a timed-out child and grandchild before final metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-ci-reporter-process-tree-"));
  const reporter = join(root, "scripts", "run-ci-test.mjs");
  const grandchild = [
    'console.log("grandchild-pid:" + process.pid);',
    'process.on("SIGTERM", () => console.log("grandchild-ignored-sigterm"));',
    "setInterval(() => {}, 1000);",
  ].join("");
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}],`,
    "{ stdio: ['ignore', 'inherit', 'inherit'] });",
    'console.log("child-pid:" + process.pid);',
    'console.log("spawned-grandchild-pid:" + grandchild.pid);',
    'process.on("SIGTERM", () => console.log("child-ignored-sigterm"));',
    "setInterval(() => {}, 1000);",
  ].join("");
  try {
    const result = spawnSync(
      process.execPath,
      [
        reporter,
        "--name",
        "process-tree-timeout",
        "--artifacts",
        directory,
        "--timeout-ms",
        "200",
        "--ready-pattern",
        "spawned-grandchild-pid:",
        "--startup-timeout-ms",
        "2000",
        "--",
        process.execPath,
        "--input-type=commonjs",
        "-e",
        parent,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);

    const metadata = JSON.parse(
      await readFile(join(directory, "process-tree-timeout-result.json"), "utf8"),
    );
    const log = await readFile(join(directory, "process-tree-timeout-process.log"), "utf8");
    const childPid = Number.parseInt(log.match(/child-pid:(\d+)/u)?.[1] ?? "", 10);
    const grandchildPid = Number.parseInt(
      log.match(/spawned-grandchild-pid:(\d+)/u)?.[1] ?? "",
      10,
    );
    assert.ok(Number.isInteger(childPid));
    assert.ok(Number.isInteger(grandchildPid));
    assert.equal(metadata.timedOut, true);
    assert.equal(metadata.processTreeTerminated, true);
    assert.equal(metadata.childPid, childPid);
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("CI reporter reaps a background process after its successful parent exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-ci-reporter-background-tree-"));
  const reporter = join(root, "scripts", "run-ci-test.mjs");
  const background = [
    'process.on("SIGTERM", () => process.exit(0));',
    "setInterval(() => {}, 1000);",
  ].join("");
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const background = spawn(process.execPath, ["-e", ${JSON.stringify(background)}],`,
    "{ stdio: 'ignore' });",
    'console.log("background-pid:" + background.pid);',
    "background.unref();",
  ].join("");
  let processGroupId;
  try {
    const result = spawnSync(
      process.execPath,
      [
        reporter,
        "--name",
        "background-tree",
        "--artifacts",
        directory,
        "--timeout-ms",
        "1000",
        "--",
        process.execPath,
        "--input-type=commonjs",
        "-e",
        parent,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);

    const metadata = JSON.parse(
      await readFile(join(directory, "background-tree-result.json"), "utf8"),
    );
    const log = await readFile(join(directory, "background-tree-process.log"), "utf8");
    const backgroundPid = Number.parseInt(log.match(/background-pid:(\d+)/u)?.[1] ?? "", 10);
    assert.ok(Number.isInteger(backgroundPid));
    processGroupId = metadata.childPid;
    assert.equal(metadata.timedOut, false);
    assert.equal(metadata.childExitCode, 0);
    assert.equal(metadata.exitCode, 0);
    assert.equal(metadata.processTreeTerminated, true);
    assert.throws(() => process.kill(backgroundPid, 0), { code: "ESRCH" });
  } finally {
    if (process.platform !== "win32" && Number.isInteger(processGroupId)) {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {}
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test("managed runner proves Windows normal-close tree cleanup before success", async () => {
  const { runManagedProcessTree } = await import(
    new URL(`../../scripts/run-ci-test.mjs?windows-tree=${Date.now()}`, import.meta.url)
  );
  const events = [];
  let descendantAlive = true;
  const metadata = await runManagedProcessTree({
    name: "windows-proven-tree",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 1_000,
    platform: "win32",
    windowsTreeStrategy: {
      canTerminateAfterLeaderExit: true,
      async probe(processId) {
        events.push(`probe:${processId}:${descendantAlive}`);
        return !descendantAlive;
      },
      async terminate(processId, signal) {
        events.push(`terminate:${processId}:${signal}`);
        descendantAlive = false;
        return true;
      },
    },
  });

  assert.equal(metadata.timedOut, false);
  assert.equal(metadata.childExitCode, 0);
  assert.equal(metadata.exitCode, 0);
  assert.equal(metadata.processTreeTerminated, true);
  assert.equal(metadata.terminationSignal, "SIGTERM");
  assert.deepEqual(
    events.map((event) => event.replace(/:\d+:/u, ":pid:")),
    ["probe:pid:true", "terminate:pid:SIGTERM", "probe:pid:false"],
  );
});

test("managed runner fails closed when Windows tree termination cannot be proven", async () => {
  const { runManagedProcessTree } = await import(
    new URL(`../../scripts/run-ci-test.mjs?windows-tree-failure=${Date.now()}`, import.meta.url)
  );
  const events = [];
  const metadata = await runManagedProcessTree({
    name: "windows-unproven-tree",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 1_000,
    platform: "win32",
    windowsTreeStrategy: {
      canTerminateAfterLeaderExit: true,
      async probe(processId) {
        events.push(`probe:${processId}`);
        return false;
      },
      async terminate(processId, signal) {
        events.push(`terminate:${processId}:${signal}`);
        return false;
      },
    },
  });

  assert.equal(metadata.timedOut, false);
  assert.equal(metadata.childExitCode, 0);
  assert.equal(metadata.exitCode, 125);
  assert.equal(metadata.processTreeTerminated, false);
  assert.match(metadata.error, /process tree did not terminate/iu);
  assert.deepEqual(
    events.map((event) => event.replace(/:\d+/u, ":pid")),
    ["probe:pid", "terminate:pid:SIGTERM", "probe:pid", "terminate:pid:SIGKILL", "probe:pid"],
  );
});

test("managed runner never targets a closed Windows leader without stable tree ownership", async () => {
  const { runManagedProcessTree } = await import(
    new URL(`../../scripts/run-ci-test.mjs?windows-closed-leader=${Date.now()}`, import.meta.url)
  );
  const metadata = await runManagedProcessTree({
    name: "windows-closed-leader",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 1_000,
    platform: "win32",
  });

  assert.equal(metadata.timedOut, false);
  assert.equal(metadata.childExitCode, 0);
  assert.equal(metadata.terminationSignal, null);
  assert.equal(metadata.exitCode, 125);
  assert.equal(metadata.processTreeTerminated, false);
  assert.match(metadata.error, /stable Windows process-tree ownership.*closed PID/iu);
});

test("managed runner converts POSIX signaling permission failures into fail-closed metadata", async () => {
  const { runManagedProcessTree } = await import(
    new URL(`../../scripts/run-ci-test.mjs?posix-eperm=${Date.now()}`, import.meta.url)
  );
  const originalKill = process.kill;
  process.kill = () => {
    const denied = new Error("operation not permitted");
    denied.code = "EPERM";
    throw denied;
  };
  try {
    const metadata = await runManagedProcessTree({
      name: "posix-eperm",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 1_000,
      platform: "linux",
    });

    assert.equal(metadata.timedOut, false);
    assert.equal(metadata.childExitCode, 0);
    assert.equal(metadata.exitCode, 125);
    assert.equal(metadata.processTreeTerminated, false);
    assert.match(metadata.error, /process tree did not terminate/iu);
  } finally {
    process.kill = originalKill;
  }
});

test("release verification bounds stages and reports deterministic process metadata", async () => {
  const { runReleaseCommand } = await import(
    new URL(`../../scripts/verify-release.mjs?command=${Date.now()}`, import.meta.url)
  );

  const success = await runReleaseCommand({
    name: "successful probe",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 1_000,
  });
  assert.equal(success.name, "successful probe");
  assert.equal(success.timedOut, false);
  assert.equal(success.exitCode, 0);
  assert.equal(success.childExitCode, 0);
  assert.equal(success.childSignal, null);
  assert.equal(success.timeoutMs, 1_000);
  assert.ok(success.startedAt.length > 0);
  assert.ok(success.finishedAt.length > 0);
  assert.ok(success.durationMs >= 0);

  await assert.rejects(
    () =>
      runReleaseCommand({
        name: "failing probe",
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        timeoutMs: 1_000,
      }),
    (error) =>
      error.code === "command_failed" &&
      error.command === process.execPath &&
      error.stage.exitCode === 7 &&
      error.stage.timedOut === false,
  );

  const startedAt = Date.now();
  await assert.rejects(
    () =>
      runReleaseCommand({
        name: "hanging probe",
        command: process.execPath,
        args: ["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 750);'],
        timeoutMs: 100,
      }),
    (error) =>
      error.code === "command_timed_out" &&
      error.command === process.execPath &&
      error.stage.name === "hanging probe" &&
      error.stage.timedOut === true &&
      error.stage.timeoutMs === 100 &&
      error.stage.exitCode === 124 &&
      typeof error.stage.startedAt === "string" &&
      typeof error.stage.finishedAt === "string" &&
      error.stage.durationMs >= 100,
  );
  assert.ok(Date.now() - startedAt < 700, "release stage timeout must be bounded");
});
