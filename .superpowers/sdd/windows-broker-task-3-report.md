# Windows control broker Task 3 report

## Status

`DONE_WITH_CONCERNS`

Windows x64 control startup now selects the packaged broker before any Node `net.Server` is
created. The broker adapter exposes virtual Duplex control connections, validates the broker's
read-back security descriptor before readiness, enforces protocol queue/backpressure limits, and
settles the child and its streams on startup and shutdown paths. The Unix socket path retains its
existing listener, permission, identity, dispatch, and cleanup behavior.

The remaining concern is an evidence boundary rather than a known local failure: this macOS host
cannot compile the C# through Windows PowerShell 5.1 or execute the Win32 named-pipe path. Task 4's
real-Windows gate must establish those facts.

## TDD evidence

The transport-neutral `ControlConnection` extraction was made under the existing control tests.
The pre-Windows-behavior run remained green at 45/45.

The first adapter/source run was intentionally RED:

```text
CLI build: failed because windows-broker.ts and windows-broker-security.ts did not exist
Windows broker C# source contract: tests 7; pass 5; fail 2
```

The two C# failures specifically showed that the first server-handle descriptor was not encoded
and that `READY` still carried an empty payload. Fake-child adapter tests were written with real
PassThrough stdin/stdout/stderr streams before the adapter implementation.

During self-review, a new close-settlement test proved RED when a child acknowledged `CLOSE_ALL`
but then exited nonzero: the close promise incorrectly resolved. The adapter now preserves that
terminal failure, and the focused test passes.

Final focused results:

```text
control + broker adapter: tests 35; pass 35; fail 0
Windows broker source contract: tests 7; pass 7; fail 0
source + clean-consumer package contracts: tests 25; pass 25; fail 0
```

## READY descriptor contract

The C# broker performs a fresh `GetKernelObjectSecurity` readback on the first server handle,
re-parses a `RawSecurityDescriptor`, and reuses the strict descriptor validator before encoding a
canonical binary `TGSD` version 1 payload. The format is independent of PowerShell JSON support:

- 12-byte big-endian header: four-byte `TGSD` magic, version, protected-DACL flag, owner SID byte
  length, and ACE count;
- canonical printable ASCII owner SID;
- ordered ACE entries containing allow/non-inherited/non-callback flags, the full pipe-control
  mask, and a canonical SID;
- exact payload length with zero reserved fields and no trailing data.

TypeScript decodes the payload strictly and requires the exact distinct ordered SID sequence of
owner, LocalSystem, and Administrators. It rejects wrong magic/version, unprotected DACLs,
malformed SIDs, missing/duplicate/reordered/unexpected ACEs, inherited or callback ACEs, wrong
masks, nonzero reserved fields, and trailing bytes. The protocol maximum frame size is unchanged.

## Implementation

- `server.ts` now dispatches through a transport-neutral `ControlConnection`. Unix still creates
  its paused `net.Server`, verifies the owner-private directory and exact owner-owned mode-0600
  socket, and uses the same request framing and drain rules.
- Windows selection occurs before Unix endpoint inspection or listener creation. Windows x64
  starts only the broker; unsupported architectures and broker construction/startup failures fail
  with `PROTOCOL_CONTROL_ENDPOINT_UNSAFE`. Tests inject a broker factory on macOS instead of
  spoofing `process.platform` or spawning real PowerShell.
- Pending virtual connections remain undispatched until `broker.start()` resolves after a valid
  `READY`. Failure destroys pending connections and awaits broker rollback; no Node named pipe,
  fallback, `NODE_PENDING_PIPE_INSTANCES`, or private `_handle` adoption remains.
- The adapter resolves the packaged `.ps1` and `.cs` beside `import.meta.url`, checks both assets,
  and invokes `powershell.exe` with fixed absolute arguments, `shell: false`, hidden window, and
  piped stdio.
- A Task 1 `WindowsBrokerConnectionState` validates every inbound and outbound frame and enforces
  per-connection/global queued-byte limits. `OPEN`, `DATA`, `EOF`, and `CLOSE` become Duplex
  connections; response writes become `DATA` and terminal `CLOSE` frames. Readable backpressure
  generates direction-correct `PAUSE`/`RESUME` frames.
- Startup abort/timeout, malformed/truncated stdout, invalid `READY`, `FATAL`, child errors/exits,
  and non-allowlisted or oversized stderr fail closed. Diagnostics expose only fixed stage codes.
- Close sends `CLOSE_ALL`, waits a bounded interval for ACK and child/stdio settlement, then
  escalates through terminate and kill. Cleanup aggregation keeps the primary protocol error first.
- The obsolete post-listen TypeScript security adapter, PowerShell helper, admission-barrier
  constants/logic/tests, emitted asset, and package requirement were removed. Active security,
  release, and delta-spec wording now documents broker creation/readback and READY validation.

## Packaging and verification

- `npm run test:unit --workspace @tego/cli`: 191/191 passed;
- `npm run build --workspace @tego/cli`: passed;
- `npm run typecheck --workspace @tego/cli`: passed;
- `node --test tests/architecture/*.test.mjs`: 352/352 passed;
- clean-consumer package verification passed for the exact nine public packages and includes only
  the broker `.ps1`/`.cs` assets for Windows control;
- repository broker `.ps1` and `.cs` sources match the emitted CLI copies byte-for-byte;
- full-repository Biome lint and format checks passed (261 files);
- Task 3 scoped `git diff --check` passed.

The whole-worktree diff still contains pre-existing, out-of-scope edits to
`.superpowers/sdd/task-8-brief.md` and `.superpowers/sdd/task-8-report.md`. They were neither modified
for Task 3 nor staged.

## Remaining concern

Do not interpret static source contracts or macOS fake-child tests as evidence that Windows
PowerShell 5.1 compiles the updated C#, that `GetKernelObjectSecurity` returns the expected live
descriptor on Windows, or that real Win32 process/pipe cleanup is leak-free. Task 4 must run the
packaged broker and control gate on the authoritative Windows worker.
