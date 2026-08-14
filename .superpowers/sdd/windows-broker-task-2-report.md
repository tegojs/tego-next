# Windows control broker Task 2 report

## Status

`DONE_WITH_CONCERNS`

The auditable broker source, static security/lifecycle contracts, build copies, npm allowlist, and
clean-consumer packaging checks are implemented. The remaining concern is an evidence boundary,
not a known local failure: this macOS host has no Windows PowerShell, PowerShell 7, `dotnet`, `csc`,
or Win32 runtime, so it cannot execute `Add-Type`, `CreateNamedPipeW`, descriptor readback, or the
Windows-only self-test. Those checks remain authoritative in the later real-Windows task.

## TDD evidence

The first focused run occurred after adding only the architecture/package contracts:

```text
node --test tests/architecture/windows-control-broker-source.test.mjs \
  tests/architecture/package-release.test.mjs

tests 25; pass 18; fail 7; skipped 0
```

All seven failures were the expected RED reasons: the broker `.ps1`/`.cs` files did not exist, the
build finalizer did not copy them, and the CLI tarball did not contain them. There were no test
syntax failures or unrelated regressions.

The final fresh focused run after implementation reported:

```text
tests 25; pass 25; fail 0; skipped 0
duration_ms 125058.812834
```

The source contract parses the Task 1 TypeScript type map and direction allowlists and separately
parses the C# numeric constants and direction arrays before comparing the complete values. It also
runs in-memory mutations which remove or weaken creation-time security attributes, descriptor
readback, protected DACL construction, `SYNCHRONIZE` parent opening, x64 detection, overlapped I/O,
pause state transitions, graceful terminal frames, and `CancelIoEx`; every mutation is rejected.

## Implementation

- `scripts/windows-control-broker.ps1` accepts only `Endpoint`, `ParentProcessId`,
  `ProtocolVersion`, and `SelfTest`; manually validates their allowed combinations; rejects
  non-Windows/non-AMD64 processes before source compilation; loads only the adjacent fixed C# path;
  and maps argument, architecture, compile, and start failure to fixed stage codes.
- `scripts/windows-control-broker.cs` deliberately stays within the older C# syntax accepted by the
  Windows PowerShell 5.1 `Add-Type` compiler. It also remains callable from PowerShell 7.
- The C# entrypoint opens one stable parent `SYNCHRONIZE` handle before endpoint creation. A
  watchdog waits on that exact handle and closes every server instance when it signals.
- Every instance is created by `CreateNamedPipeW` with `FILE_FLAG_OVERLAPPED` and the final
  `SECURITY_ATTRIBUTES`. The first instance also uses `FILE_FLAG_FIRST_PIPE_INSTANCE`.
- The self-relative descriptor is owned by the current user and has one explicit, non-inherited,
  full-control allow ACE for each distinct SID in current user, LocalSystem, Administrators order.
  The DACL is protected.
- Before an instance can be armed, `GetKernelObjectSecurity` reads the descriptor back from that
  server handle and verifies owner, protected/present DACL, exact ACE count/order/class/qualifier,
  SID, flags, and access mask.
- Accept, read, and write operations use native overlapped state, pinned buffers, cancellation, and
  bounded settlement. Public-connection buffers, aggregate queued bytes, connections, and parent
  frame payloads are capped. Parent stdout uses ticket reservation for strict ordering and one
  serialized binary writer. State/output locks reserve tickets only; all bounded I/O waits happen
  after those locks are released.
- `CLOSE_ALL` reserves the complete terminal sequence before closing handles, fences later
  connection output, and reserves the acknowledgement as the last ticket. ACK failure emits only a
  fixed stage and shuts down; a successful ACK cannot be followed by a connection or fatal frame.
- The C# frame header, numeric type mapping, directions, global/scoped ID rules, and 64-bit monotonic
  IDs match Task 1. Parent EOF, malformed input, parent signal, close-all, and internal failure all
  fail closed and settle owned handles.
- `SelfTest` is a fixed script mode which exercises constants, descriptor construction,
  parent-watch cancellation, invalid-frame rejection, private test-pipe I/O cancellation, and
  repeated handle cleanup. It does not create or announce a public broker endpoint. The normal CLI
  does not expose this mode. The implementation does not claim that another direct script caller is
  technically unable to invoke it.
- stdout is used only through the binary frame writer. stderr is centralized on fixed enumerated
  codes; endpoint, SID, payload, and exception text are never written.
- The obsolete `windows-pipe-security.ps1` helper remains copied and packaged for Task 3 to replace.
  No `_handle`, network, bootstrap endpoint, fd adoption, or fallback path was added.

## Packaging

Task 2's two broker assets require two small derived changes beyond the brief's explicit modify
list:

- `packages/cli/package.json` includes emitted `.cs` assets.
- `scripts/package-contract.mjs` admits only the two named broker assets, requires both in the CLI
  tarball, and verifies both exist and are non-empty in a clean installed consumer.

The public package set remains exactly the existing nine packages at `2.0.0-alpha.1`. Package tests
extract both assets from the actual CLI tarball and compare them byte-for-byte with the repository
sources. Direct build-output comparisons also passed.

## Verification

- focused source/package test: 25/25 passed, zero skipped;
- `npm run build --workspace @tego/cli`: passed;
- `npm run typecheck --workspace @tego/cli`: passed;
- source versus `packages/cli/dist/src/control` `cmp` for `.ps1` and `.cs`: passed;
- Biome on all changed supported files: passed;
- `git diff --check` limited to Task 2 files: passed.
- independent source/security/lifecycle re-review: approved with no blocking finding after the
  close-all, PAUSE cancellation, native-overlapped cancellation, AMD64, and writer-ticket fixes.

Whole-worktree `git diff --check` is not clean because the pre-existing, out-of-scope modified file
`.superpowers/sdd/task-8-brief.md` has a blank line at EOF. Task 2 did not modify or stage that file.

## Remaining concern

The C# compatibility and Win32 behavior are statically constrained but not executable on this
host. Do not treat this report as evidence that Windows PowerShell 5.1 compiled the source, that the
real descriptor readback passed, or that Windows process/pipe cleanup is leak-free. The fixed
`SelfTest` and authoritative Windows gate must establish those facts on `windows-2025`.

## Independent-review remediation

Root's independent review rejected the first implementation despite the earlier internal approval.
That rejection identified a PAUSE/immediate-RESUME race, premature SafeHandle closure around native
overlapped operations, callback ACE acceptance, and insufficient real-Windows self-testing. This
section supersedes the earlier review statement for those findings and records the second strict TDD
cycle.

The first remediation test run was against the unchanged `18dc466` implementation:

```text
node --test tests/architecture/windows-control-broker-source.test.mjs

tests 5; pass 3; fail 2; skipped 0
```

The failures were the intended RED signals: there was no per-read cancellation token/generation and
no `DangerousAddRef` lifetime ownership. The lifecycle mutation did not find its target because the
required ownership code did not exist. A small cancellation model was then added to prove that a
PAUSE-bound cancellation still requests another read after an immediate RESUME, while CLOSE and
shutdown stay terminal.

The requested internal re-review then found one C# definite-assignment compile blocker in the new
read loop. A source assertion was added first and failed 5/6 because `transferred` was not initialized;
initializing it to zero made the test green, and a mutation back to the uninitialized declaration is
now rejected. The reviewer rechecked the fix and approved with no remaining blocking finding.

The remediation changes are:

- each pending read owns a monotonic generation plus immutable `ReadCancellationReason`; PAUSE binds
  to that operation, so `ERROR_OPERATION_ABORTED` retries through the pause gate even when RESUME has
  already arrived, while close/shutdown remains terminal;
- every accept/read/write `OverlappedOperation` takes a `SafeFileHandle.DangerousAddRef` before the
  Win32 call, cancels and settles through `GetOverlappedResult` on that same valid handle, then frees
  native OVERLAPPED memory, pinned data, and event before `DangerousRelease`;
- disposal continues through every cleanup step before returning a fixed failure. A settlement
  deadline instead emits `TEGO_WINDOWS_CONTROL_BROKER_RESOURCE_FAILED` and terminates/fail-fasts,
  never freeing memory which the kernel may still reference;
- connection owners cancel tracked read/write operations, wait on bounded thread/operation-idle
  signals, and only then dispose the pipe SafeHandle. The accept owner signals its dedicated cancel
  event, waits for accept-thread exit, and only then disposes any pending accept handle;
- descriptor validation now explicitly rejects callback `CommonAce` instances and non-empty opaque
  data in addition to requiring `AceType.AccessAllowed`, access-allowed qualifier, and exact
  flags/mask/SID/order;
- `CreateNamedPipeW` and the private-self-test `CreateFileW` import use `ExactSpelling = true`;
- the fixed `SelfTest` now uses randomized private pipe names to cancel real pending accept, read, and
  write operations, exercises PAUSE then immediate RESUME followed by a successful new read, repeats
  close/dispose, constructs and rejects a callback ACE with the same SID/mask, and waits until the
  watchdog thread has actually entered. It never publishes READY or a public endpoint.

Fresh post-remediation verification:

```text
focused source/model: 6/6 passed
focused architecture + real tarball clean-consumer package contract: 26/26 passed
npm run build --workspace @tego/cli: passed
npm run typecheck --workspace @tego/cli: passed
Biome on the changed JavaScript test: passed
repository source vs emitted .ps1/.cs cmp: passed
Task 2 scoped git diff --check: passed
```

The package run builds actual tarballs, validates the nine-package allowlist, installs into a clean
consumer, and checks the broker `.ps1` and `.cs` assets. The source test parses both Task 1 and C#
protocol maps and includes in-memory mutations for SafeHandle add-ref/release, settlement-before-free,
per-read cancellation reason/generation, callback/opaque ACE rejection, and explicit wide-import
spelling.

The evidence boundary is unchanged: this macOS host has no `powershell`, `pwsh`, `dotnet`, `csc`, or
`mcs`. The new private-pipe SelfTest and Windows PowerShell 5.1 `Add-Type` path were therefore not
executed here and must be run on the authoritative Windows worker.

## Pre-issue write-cancellation remediation

A final independent review found a narrower write-owner race after `ade0a17`: `Write` published
`_activeWrite` and released `_writeGate` before `MarkIssued`. A concurrent connection Dispose could
find that active operation, call `RequestCancellation`, and receive the old pre-issue early return.
The write could then become pending with no cancellation until its five-second I/O timeout, while
the owner reached its two-second settlement deadline and fail-fasted.

The final TDD cycle began on the unchanged implementation. The source/model run reported 5 passed
and 2 failed: the required gated issue method did not exist, and the mutation could not find a
persisted cancellation request. A separate fail-fast reliability assertion was then observed RED at
6 passed and 1 failed because a managed stderr/P/Invoke exception could prevent the final fail-fast.

The final implementation:

- atomically persists `_cancellationRequested` even before issue and dispatches `CancelIoEx` at most
  once after a kernel operation exists;
- routes accept/read/write through `IssueConnect`, `IssueRead`, and `IssueWrite`, each holding the
  operation state gate across issued-state publication and the non-blocking overlapped Win32 call;
- makes `MarkIssued` observe a previously persisted cancellation and settle with
  `ERROR_OPERATION_ABORTED` without issuing a new kernel operation;
- adds a deterministic private-pipe SelfTest interlock which stops immediately after `_activeWrite`
  publication, starts connection disposal, waits until cancellation is observed, and only then
  permits the write to issue. The write and disposer must both finish inside the owner bound without
  fail-fast;
- treats unexpected managed exceptions while issuing, cancelling, or settling as unsafe kernel
  state and calls the fixed resource fail-fast before any pinned/native/event/SafeHandle cleanup;
- makes the fail-fast path itself tolerate stderr and `TerminateProcess` exceptions before the final
  `Environment.FailFast` call. Expected Win32 completion, broken-pipe, no-data, and aborted results
  remain bounded normal returns.

Final fresh verification for this cycle:

```text
focused source/model: 7/7 passed
focused architecture + real tarball clean-consumer package contract: 27/27 passed
npm run build --workspace @tego/cli: passed
npm run typecheck --workspace @tego/cli: passed
Biome on the changed JavaScript test: passed
```

The macOS evidence boundary remains unchanged: the deterministic interlock is compiled into the
fixed Windows-only SelfTest but could not be executed here with Win32 or PowerShell 5.1.
