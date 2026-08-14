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
  parent-watch cancellation, invalid-frame rejection, and repeated handle cleanup without creating
  a named-pipe endpoint. The normal CLI does not expose this mode. The implementation does not claim
  that another direct script caller is technically unable to invoke it.
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
