# Task 7 Report: Windows Named-Pipe Access Hardening

## Delivered

- Windows control listeners now fail closed until a production ACL helper has applied and
  inspected a protected named-pipe DACL. Sockets accepted during initialization remain outside
  request dispatch and are destroyed before the endpoint becomes ready.
- The descriptor policy requires:
  - the current Windows user SID as owner;
  - a protected DACL;
  - canonical, explicit allow ACEs only for the current user, LocalSystem (`S-1-5-18`), and
    Administrators (`S-1-5-32-544`);
  - full pipe access (`0x1f01ff`) for every allowed SID;
  - no deny ACEs, inherited ACEs, duplicate or reordered ACEs, broad principals, or unexpected
    allow principals.
- LocalSystem is supported without emitting or expecting a duplicate SYSTEM ACE.
- The fixed PowerShell helper uses .NET/Win32 security descriptor APIs and shell-free arguments.
  It accepts only a validated pipe endpoint and fixed operation/barrier arguments, emits exactly
  one JSON line, and has a child-owned 9-second `Environment.FailFast` watchdog plus a parent-owned
  10-second kill timeout. Abort and timeout paths wait for observed helper close before startup
  rollback settles, and helper output is capped at 64 KiB.
- The helper is copied beside the compiled module, included in the `@tego/cli` npm artifact, and
  exercised through clean-consumer package verification. The production adapter resolves this
  installed, colocated asset rather than relying on a repository-only script path.
- The real Windows test inspects the descriptor without applying it a second time, makes a
  current-user status request, closes the server, and proves reconnection fails.
- Added a required `windows-control` job on `windows-2025` with pinned actions, exact Node.js
  26.5.0 and npm 11.13.0 checks, clean install, CLI build/typecheck, the injected admission-race
  test, and the real Windows ACL/cleanup contract. Workflow mutation tests reject removal,
  disabling, soft failure, relocation, no-op replacement, or reordering of any required step.

## Admission Boundary

Node.js 26.5.0/libuv is pinned and the Windows listener is created with one pending pipe instance.
The helper opens that original instance, applies and validates the ACL, then completes two
acknowledged post-hardening barrier connections. Those connections consume the first replacement
instance and prove the next replacement was created after the descriptor changed. All sockets
accepted before the barrier completes are queued and destroyed. Only later connections can reach
the control dispatcher.

This uses the documented Node pending-instance configuration and public `node:net` APIs; it does
not access Node private `_handle` state. A production Windows adapter must declare the admission
barrier contract or startup rejects it.

## TDD Evidence

RED was observed before production changes:

- the new platform-independent Windows policy/startup cases failed because
  `startControlServer` had no Windows hardening hook or admission queue;
- the real Windows ACL test was authored but could not execute on macOS;
- workflow contract tests rejected the missing `windows-control` job;
- package contract tests rejected the missing installed helper asset.

Review-driven RED cases then reproduced four concrete defects before their fixes:

- a descriptor with omitted ACE inspection detail passed validation;
- startup rollback settled before injected adapter abort cleanup completed;
- a connection opened before the security cutover reached runtime dispatch;
- LocalSystem produced an invalid duplicate-SYSTEM policy expectation.

GREEN now covers strict owner/DACL/ACE/mask validation, stable redacted diagnostics, queued-socket
rollback, deterministic two-connection admission cutover, LocalSystem de-duplication, strict
one-line helper parsing, fixed shell-free helper arguments, abort cleanup ordering, query-only
inspection, installed helper packaging, watchdog retention, and the exact Windows CI contract.

## Verification

All local verification used Node.js 26.5.0:

- `npm run build --workspace @tego/cli` passed;
- `npm run typecheck --workspace @tego/cli` passed;
- CLI control suite: 44 passed, 0 failed, 1 Windows-only test skipped;
- project/system CI architecture suite: 216/216 passed;
- package-release suite: 15/15 passed;
- Biome check passed for all changed TypeScript, JavaScript, and test files;
- the built and source PowerShell helpers are byte-identical;
- `git diff --check` passed;
- no Node private `_handle` usage exists in the changed control implementation or tests;
- independent review found no remaining Critical or Important findings. Its one Minor request was
  closed by an architecture regression test that requires the helper's fail-fast watchdog.

## Unverified Real Windows Status

The real named-pipe ACL gate is intentionally not claimed as locally verified. This host is macOS,
and `pwsh` is unavailable, so neither Windows ACL behavior nor a local PowerShell parser run was
possible. The Windows-only test remains skipped here and is configured to fail, not skip, on
Windows if PowerShell, ACL application, inspection, admission cutover, current-user access, or
cleanup is unavailable.

Per the task boundary, no branch was pushed and no release action was taken. Task 10 must push the
branch and require the real `windows-control` job to pass. If that job cannot apply and inspect the
descriptor reliably on Windows, the alpha release remains blocked.
