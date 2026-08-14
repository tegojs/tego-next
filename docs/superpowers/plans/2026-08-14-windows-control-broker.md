# Windows Control Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unsupported post-listen Windows ACL mutation with a fail-closed `win32-x64` broker that creates every named-pipe instance with the final protected DACL and passes the real Windows release gate.

**Architecture:** Unix continues using `node:net`. Windows launches a packaged PowerShell/C# broker which owns the public pipe and forwards raw connection bytes over a bounded, versioned parent protocol; TypeScript adapts those frames to the existing control dispatcher. The broker verifies its own server-handle descriptor before readiness and watches a stable parent-process handle for orphan cleanup.

**Tech Stack:** Node.js 26.5.0, npm 11.13.0, TypeScript 7.0.2, Node streams/test runner, Windows PowerShell, C# `Add-Type`, Win32 named-pipe/security/process APIs, GitHub Actions `windows-2025`.

## Global Constraints

- Support exactly `win32-x64` for `2.0.0-alpha.1`; every other Windows architecture fails closed.
- Do not use Node private `_handle`, unsupported fd adoption, an unhardened bootstrap pipe, network ports, shell interpolation, or executable-path lookup.
- The public DACL is protected, owned by the current user, and contains exactly one explicit full-access allow ACE for current user, LocalSystem, and Administrators.
- stdout is binary protocol only; stderr accepts fixed redacted stage codes only.
- Preserve the existing nine-package `@tego/*@2.0.0-alpha.1` topology and alpha-only release rules.
- No npm publication, dist-tag mutation, Git tag, GitHub Release, spec sync, or archive occurs before the final exact-SHA local and authoritative CI gates pass.

---

### Task 1: Define and Prove the Parent/Broker Protocol

**Files:**
- Create: `packages/cli/src/control/windows-broker-protocol.ts`
- Create: `packages/cli/test/windows-broker-protocol.test.ts`

**Interfaces:**
- Produces:

```ts
export const WINDOWS_BROKER_PROTOCOL_VERSION = 1;
export const WINDOWS_BROKER_MAX_FRAME_BYTES = 64 * 1024;
export const WINDOWS_BROKER_MAX_CONNECTION_BYTES = 256 * 1024;
export type WindowsBrokerFrameType =
  | "ready" | "open" | "data" | "eof" | "close" | "fatal"
  | "pause" | "resume" | "close-all" | "close-all-ack";
export interface WindowsBrokerFrame {
  readonly type: WindowsBrokerFrameType;
  readonly connectionId: bigint;
  readonly payload: Uint8Array;
}
export function encodeWindowsBrokerFrame(frame: WindowsBrokerFrame): Buffer;
export class WindowsBrokerFrameDecoder {
  push(chunk: Uint8Array): readonly WindowsBrokerFrame[];
  finish(): void;
}
export class WindowsBrokerConnectionState {
  accept(frame: WindowsBrokerFrame): void;
}
```

- [ ] **Step 1: Write failing codec tests**

Cover split/coalesced frames, wrong magic/version, unknown type, zero/nonzero ID rules, payload above 64 KiB, truncated finish, and unsigned 64-bit IDs.

```ts
const decoder = new WindowsBrokerFrameDecoder();
const encoded = encodeWindowsBrokerFrame({ type: "data", connectionId: 7n, payload });
assert.deepEqual([...decoder.push(encoded.subarray(0, 5)), ...decoder.push(encoded.subarray(5))], [
  { type: "data", connectionId: 7n, payload },
]);
```

- [ ] **Step 2: Run RED**

Run: `npm run build --workspace @tego/cli && node --test packages/cli/dist/test/windows-broker-protocol.test.js`

Expected: FAIL because the protocol module does not exist.

- [ ] **Step 3: Implement the fixed binary codec**

Use a 24-byte big-endian header: four-byte `TGBP` magic, `uint16` version, `uint16` type, `uint64` connection ID, `uint32` payload length, and four reserved zero bytes. Buffer partial input internally and copy payloads before returning them.

- [ ] **Step 4: Write failing state-machine and pressure tests**

Prove monotonically increasing nonzero IDs, no reuse, one `OPEN`, no data before open/after terminal, one terminal frame, total/per-connection queue limits, and legal `PAUSE`/`RESUME` transitions. Mutation tests must show each invalid transition throws a stable protocol error.

- [ ] **Step 5: Implement minimal state tracking and run GREEN**

Run the focused test, CLI typecheck, and Biome. Expected: all pass with no skipped tests.

- [ ] **Step 6: Commit**

```sh
git add packages/cli/src/control/windows-broker-protocol.ts packages/cli/test/windows-broker-protocol.test.ts
git commit -m "feat(cli): define Windows broker protocol"
```

### Task 2: Implement the Auditable Windows Broker

**Files:**
- Create: `scripts/windows-control-broker.ps1`
- Create: `scripts/windows-control-broker.cs`
- Create: `tests/architecture/windows-control-broker-source.test.mjs`
- Modify: `scripts/copy-windows-pipe-security.mjs`
- Modify: `tests/architecture/package-release.test.mjs`

**Interfaces:**
- Consumes the Task 1 frame header and type constants, duplicated as numeric constants with an architecture test requiring exact equality.
- Broker invocation:

```text
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass
  -File <absolute packaged script> -Endpoint <validated pipe name>
  -ParentProcessId <decimal pid> -ProtocolVersion 1
```

- Produces `READY`, connection, terminal, and fixed `FATAL` frames on stdout; fixed stage codes on stderr.

- [ ] **Step 1: Write failing source and packaging contracts**

Require fixed argument validation, x64 guard, `CreateNamedPipeW` with `SECURITY_ATTRIBUTES`, protected DACL construction, server-handle readback, parent `OpenProcess(SYNCHRONIZE)`, bounded buffers, overlapped I/O, no arbitrary stderr, and no `_handle`. Require source/build copies and tarball assets to be byte-identical.

- [ ] **Step 2: Run RED**

Run: `node --test tests/architecture/windows-control-broker-source.test.mjs tests/architecture/package-release.test.mjs`

Expected: FAIL because broker sources and package assets are absent.

- [ ] **Step 3: Implement the PowerShell entry point**

Validate only the fixed named parameters, require x64, load the adjacent `.cs` file with `Add-Type`, and invoke one C# entry method. PowerShell must not contain pipe lifecycle logic and must map compile/start failure to one enumerated stage code.

- [ ] **Step 4: Implement C# security creation and descriptor verification**

Build the descriptor from the current user SID plus `SY` and `BA`; set `SE_DACL_PROTECTED`; create each instance with the descriptor at creation. Immediately use the server handle to verify owner, protection, ACE type/order/SID/mask/inheritance, and reject any deviation before emitting `READY`.

- [ ] **Step 5: Implement C# overlapped connection and parent-watch loops**

Use bounded per-connection buffers and a single serialized parent writer. Maintain monotonically increasing `ulong` IDs. A watchdog waits on the exact parent process handle; stdin EOF or parent signal closes every pipe handle and exits. Every Win32 handle is owned by one disposable object and all exit paths are bounded.

- [ ] **Step 6: Add Windows-only broker self-tests to the script**

Add a fixed `-SelfTest` mode callable only by CI which validates codec constants, descriptor construction, parent-watch cancellation, invalid-frame rejection, and repeated resource cleanup without exposing a public endpoint.

- [ ] **Step 7: Run local static GREEN and commit**

Run architecture/package tests, CLI build/typecheck, source-copy comparison, Biome, and `git diff --check`. The real Win32 behavior remains RED/unverified until Task 4.

```sh
git add scripts/windows-control-broker.ps1 scripts/windows-control-broker.cs scripts/copy-windows-pipe-security.mjs tests/architecture
git commit -m "feat(cli): add Windows control broker"
```

### Task 3: Integrate Broker Connections with the Control Dispatcher

**Files:**
- Create: `packages/cli/src/control/windows-broker.ts`
- Create: `packages/cli/src/control/windows-broker-security.ts`
- Create: `packages/cli/test/windows-broker.test.ts`
- Modify: `packages/cli/src/control/server.ts`
- Modify: `packages/cli/test/control.test.ts`
- Delete after replacement is proven: `packages/cli/src/control/windows-pipe-security.ts`
- Delete after replacement is proven: `scripts/windows-pipe-security.ps1`

**Interfaces:**
- Produces:

```ts
export interface ControlConnection extends NodeJS.ReadWriteStream {
  readonly destroyed: boolean;
  destroy(error?: Error): void;
}
export interface WindowsControlBroker {
  readonly endpoint: string;
  start(signal?: AbortSignal): Promise<void>;
  onConnection(listener: (connection: ControlConnection) => void): void;
  close(): Promise<void>;
}
export function createWindowsControlBroker(options: {
  readonly endpoint: string;
  readonly maxConnections: number;
  readonly maxQueuedBytes: number;
}): WindowsControlBroker;
```

- [ ] **Step 1: Extract a transport-neutral control connection under existing tests**

Change `beginControlConnection` and `writeResponse` to accept `ControlConnection`, keeping Unix `Socket` behavior byte-for-byte. Run existing control tests before adding Windows behavior.

- [ ] **Step 2: Write failing broker-adapter tests**

Use a fake child with real streams. Cover absolute shell-free spawn, READY deadline, OPEN/DATA/EOF conversion, response DATA/CLOSE frames, backpressure, malformed/fatal output, child crash, abort during startup, graceful ACK, forced termination, stderr allowlist, and cleanup error ordering.

- [ ] **Step 3: Run RED**

Run: `npm run build --workspace @tego/cli && node --test packages/cli/dist/test/windows-broker.test.js packages/cli/dist/test/control.test.js`

Expected: the new adapter tests fail because no broker adapter exists.

- [ ] **Step 4: Implement the child adapter and virtual connection**

Resolve broker assets relative to `import.meta.url`; invoke fixed `powershell.exe` arguments with `shell: false`; cap stdout/stderr; decode frames; expose a Duplex-compatible connection; apply Task 1 state/queue limits; propagate pause/resume; and settle child exit plus streams on every path.

- [ ] **Step 5: Select transport before endpoint creation**

In `startControlServer`, select Unix `net.Server` unless `process.platform === "win32"`. On Windows x64, start only the broker and mark readiness only after its verified `READY`. On other Windows architectures, missing assets, or broker failure, throw `PROTOCOL_CONTROL_ENDPOINT_UNSAFE` without creating a Node named pipe.

- [ ] **Step 6: Replace admission-barrier tests and remove the obsolete helper**

Move the strict descriptor types and validator into `windows-broker-security.ts`, then delete only the
post-listen helper spawner/adapter and admission-barrier logic. Tests must prove no Windows
`net.Server` is created, no connection dispatches before broker READY, and broker failure leaves no
reachable endpoint. Preserve injected platform-independent policy tests through an injectable
broker factory and validate every broker READY descriptor again in TypeScript.

- [ ] **Step 7: Run GREEN and commit**

Run all CLI tests, build, typecheck, lint/format, package tests, and architecture tests.

```sh
git add packages/cli scripts tests/architecture
git commit -m "fix(cli): own Windows control pipes in broker"
```

### Task 4: Make Real Windows and Package Gates Authoritative

**Files:**
- Modify: `packages/cli/test/windows-control-gate.ts`
- Modify: `scripts/run-windows-control-gate.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/verify-release.mjs`
- Modify: `tests/architecture/project-ci.test.mjs`
- Modify: `tests/architecture/system-ci.test.mjs`
- Modify: `tests/architecture/package-release.test.mjs`

**Interfaces:**
- The fixed workflow command remains `node scripts/run-windows-control-gate.mjs` and emits exactly `TEGO_WINDOWS_CONTROL_GATE_OK` only after every real check passes.

- [ ] **Step 1: Write failing gate mutations**

Require a packed clean-consumer install, PowerShell/C# self-test, real owner/DACL inspection from the broker server handle, status request, malformed-frame crash, parent-crash cleanup, broker-crash cleanup, reconnection failure, and twenty lifecycle rounds. Mutations that remove, skip, reorder, soften, or replace any step must fail architecture validation.

- [ ] **Step 2: Run RED locally**

Run CI architecture tests. Expected: FAIL until the workflow and runner include the new broker gates; the real test remains Windows-only and may not skip on Windows.

- [ ] **Step 3: Implement the real Windows gate**

Have the broker return a typed descriptor frame from its own server handle over the inherited parent channel. Validate it in TypeScript, execute a real current-user request, crash each side in controlled child fixtures, prove all exact PIDs and pipe names disappear, and repeat start/request/close twenty times.

- [ ] **Step 4: Verify the packed consumer**

Pack all nine tarballs, install them into an empty temporary consumer, invoke the installed CLI/broker assets, and prove the test does not resolve repository-only paths.

- [ ] **Step 5: Push a diagnostic source commit and require real Windows GREEN**

Push the branch and dispatch the exact SHA. Require quality, `windows-control`, integration, and system E2E to pass. A skip, missing PowerShell, source compilation failure, ACL mismatch, leak, or timeout is a failure.

- [ ] **Step 6: Commit any test-first fixes and obtain independent review**

Every Windows-discovered defect gets a focused regression before its minimal fix. Remove all temporary diagnostic workflow changes before review.

### Task 5: Update Specs, Documentation, and Restart Final Release Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-14-windows-control-broker-design.md` only if verified behavior differs
- Modify: `docs/security/threat-model.md`
- Modify: `docs/operations/deployment-topologies.md`
- Modify: `docs/releases/2.0.0-alpha.1.md`
- Modify: `docs/reviews/phase-1-security-concurrency-recovery-review.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/runtime-bootstrap/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/runtime-operations/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/tasks.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/verification-report.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/.comet.yaml`
- Modify: `tests/architecture/documentation.test.mjs`

**Interfaces:**
- Consumes the reviewed Task 4 implementation and exact authoritative CI run.
- Produces a fresh `targetSha` evidence chain accepted by `npm run release:alpha -- --preflight`.

- [ ] **Step 1: Write failing documentation contracts**

Reject post-listen ACL mutation/admission-barrier claims. Require the broker ownership boundary,
`win32-x64` alpha scope, PowerShell/C# source delivery, parent-handle cleanup, no fallback, real
Windows evidence URL, and deferred ARM64/precompiled broker work.

- [ ] **Step 2: Update active delta specs and documents**

Describe only behavior proven by Task 4. Keep npm/Git/GitHub publication, spec sync, and archive unchecked.

- [ ] **Step 3: Run clean local release verification**

Use Node 26.5.0/npm 11.13.0 and an isolated disposable PostgreSQL 16 cluster. Run
`npm run verify:release`, the three twenty-round stress groups, package determinism, and strict
OpenSpec. Record exact commands/counts/timestamps and the new source `targetSha`.

- [ ] **Step 4: Commit and push evidence, then require exact-SHA CI again**

The evidence-only chain must obey the publisher's per-commit allowlist. Require all four jobs on the
source/evidence SHA, add immutable job URLs in the permitted evidence follow-up, push, and require
the follow-up documentation/quality gate.

- [ ] **Step 5: Resume the existing release plan**

Only after Task 5 review passes, return to Task 11 of
`docs/superpowers/plans/2026-08-13-phase-1-alpha-release-and-hardening.md` for irreversible npm
publication, registry verification, `v2.0.0-alpha.1`, GitHub prerelease, spec sync, and archive.
