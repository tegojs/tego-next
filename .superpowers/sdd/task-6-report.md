# Task 6 Report: Deterministic Readiness and PostgreSQL Cleanup

## Status

Implemented and verified. Readiness timeout and predicate failure now clean an immediately owned
process group, preserve diagnostic stream finalization, retain the primary failure ahead of any
cleanup failures, and leave no child or grandchild behind. PostgreSQL test cleanup is exact,
guarded, parameterized, transaction-bounded, and includes the Phase 1 artifact usage table.

## Delivered behavior

- `spawnManagedProcess()` starts a detached process group on POSIX. `ManagedProcess.stop()` keeps
  the existing stdin EOF, SIGTERM, and SIGKILL phases but applies signals to the whole group and
  waits boundedly for the group to disappear before finalizing streams.
- `usingManagedProcess()` creates and owns the handle before invoking its callback. Its `finally`
  path always attempts stop and `assertClean`; `settleWithCleanup()` keeps a callback/readiness
  error first in any `AggregateError`.
- The two-Main E2E stores each Main handle in its cleanup collection immediately after spawn and
  before `ready()`. Its final cleanup validates per-process artifacts, cleans the exact database
  namespace, then removes the workspace and artifacts.
- `assertDisposablePostgresNamespace()` accepts only
  `/^test_[a-z0-9]+_[a-z0-9_]+$/u`. The seven unsafe values in the brief are rejected synchronously,
  before constructing a PostgreSQL pool.
- `cleanupPostgresNamespace()` uses one client, one transaction, local five-second statement and
  lock timeouts, a fixed Phase 1 table allowlist, and `driver_namespace = $1` for every delete. It
  does not modify `tego_schema_migrations` or any global schema object.
- Fault-test and E2E namespaces now use the destructive-test prefix. Cleanup covers state,
  coordination, artifacts, and `tego_artifact_namespace_usage` while preserving every row of a
  neighboring namespace byte-for-byte.

## TDD evidence

### RED

The process tests were written first and failed at module instantiation because the scoped owner
did not exist:

```text
SyntaxError: The requested module '../support/managed-process.mjs' does not provide an export named
'usingManagedProcess'
```

The namespace guard and isolation tests were written before the helper and failed with:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'tests/support/postgres-namespace.mjs'
```

### GREEN

The process regression proves both the direct PID and a real grandchild PID are dead after a
readiness timeout, that `cleanup.json` is finalized while the workspace still exists, and that the
workspace is removed afterward. A second regression makes the readiness predicate throw and proves
the same tree cleanup while preserving the predicate error as the primary failure.

The PostgreSQL test seeds two unique namespaces, snapshots all known Phase 1 tables as JSON text,
cleans one namespace, proves it is empty, and compares the untouched namespace snapshot exactly.

## Disposable PostgreSQL environment

Verification used Homebrew PostgreSQL 16 in a validated `mktemp` root:

```text
root: /tmp/tego-task6-pg16.aVWkgu
URL:  postgresql://127.0.0.1:55461/postgres
```

The cluster used its own data directory, socket directory, and non-default TCP port. Port 5432 and
Docker were not contacted.

## Verification

Fresh focused verification:

```sh
node --test tests/integration/process-harness.test.mjs
node --test tests/e2e/single-main-process-helpers.test.mjs
TEGO_POSTGRES_URL=postgresql://127.0.0.1:55461/postgres \
  node --test tests/integration/runtime-fault-injection.test.mjs
TEGO_POSTGRES_URL=postgresql://127.0.0.1:55461/postgres npm run test:e2e:multi-main
npx biome check tests/support/managed-process.mjs tests/support/postgres-namespace.mjs \
  tests/support/single-main-process.mjs tests/integration/process-harness.test.mjs \
  tests/integration/runtime-fault-injection.test.mjs tests/e2e/single-main-process.test.mjs
git diff --check
```

Observed results: process harness 16/16, helper suite 5/5, runtime fault suite 15/15, and real
multi-Main E2E 1/1 passed.

## Self-review

- Primary errors are first; cleanup continues across all steps and aggregates failures.
- Whole-tree stop preserves the established escalation and stream-finalization paths.
- No callback can receive a process without the scoped helper already owning it.
- PostgreSQL values are never interpolated. Only fixed source-code table names are interpolated.
- Artifacts are checked before database cleanup; database cleanup precedes workspace removal.
- Migration metadata and global schema are untouched.

No Critical, Important, or Minor findings remain.

## Follow-up ownership and deadline hardening

A follow-up review identified three boundaries not covered by the first implementation: Windows
whole-tree termination, a direct parent exiting while its process group remains live, and
JavaScript-side PostgreSQL promises that ignore server timeouts.

### Follow-up RED

New process tests initially failed because `assertClean()` returned successfully with a live
grandchild and the injected Windows strategy was never called:

```text
Missing expected rejection: /PROCESS_TREE_STILL_RUNNING/
Expected Windows terminate/probe events; actual: []
```

The injected PostgreSQL tests initially showed neither aggregation nor late-client destruction:

```text
assert.ok(error instanceof AggregateError) was false
Expected release calls [true]; actual []
```

### Follow-up GREEN

- Every `ManagedProcess` now retains one tree-ownership object. POSIX owns the detached PGID until
  `ESRCH` proves it gone; Windows uses the same `taskkill /PID ... /T` strategy shape as
  `scripts/run-ci-test.mjs` and refuses to treat an unproven tree as clean.
- `assertClean()` probes retained ownership after the leader exits. A real parent-exits test proves
  it rejects while a grandchild remains, then `stop()` removes the group.
- Platform-injected tests prove Windows descendants are targeted and tree cleanup fails closed when
  termination cannot be proven. Real Windows execution remains covered by the later Windows CI
  task.
- POSIX has no durable kernel process-group handle. The implementation minimizes the unavoidable
  numeric PGID reuse window by keeping probe/signal operations adjacent, closing ownership only
  after termination proof, and never signaling a cached negative PID after closure.
- PostgreSQL cleanup has one end-to-end deadline covering connect, BEGIN, SET, every DELETE,
  COMMIT, ROLLBACK, release, and `pool.end()`. Pool query/connection timeouts reinforce the outer
  deadline. A timed-out client is destroyed, including one acquired after the caller deadline.
- Cleanup preserves errors in exact order: primary operation, rollback, release, pool end. No
  rollback rejection is discarded and no `finally` failure overwrites the primary error.

Follow-up verification on isolated Homebrew PostgreSQL 16 root
`/tmp/tego-task6-followup-pg16.vReFtP`, port 55462:

```text
process harness: 19/19 passed
single-Main helpers: 5/5 passed
runtime fault suite: 18/18 passed
real multi-Main E2E: 1/1 passed
Biome: clean
git diff --check: clean
```

## Final ownership re-review

The final re-review required stable identities for every platform and retention of late PostgreSQL
acquisition cleanup errors.

New RED tests initially proved the missing contracts:

```text
createWindowsTreeStrategy was not exported
unsafe child PID validation did not exist
late client release error was not returned in AggregateError
```

The process harness now uses a bounded tree adapter with immutable identity tokens:

- Child PIDs are validated as positive safe integers before strategy capture or any OS call.
- Windows snapshots `ProcessId`, `ParentProcessId`, and `CreationDate` recursively via bounded
  PowerShell/CIM. It caches descendant tokens before stdin EOF, uses `taskkill /T` while the exact
  leader remains live, and validates each cached token before terminating a descendant after the
  leader exits. Same-PID/different-creation-time processes are never targeted.
- POSIX snapshots PID, PGID, state, and start time through bounded `ps`. A group signal is sent only
  while the original leader token or a cached exact member token remains live. A reused leader PID
  with a different start token fails closed. Zombie identities are excluded from live ownership.
- Every snapshot, probe, terminate, PowerShell, `ps`, and `taskkill` call receives an absolute
  deadline. Helper timeout sends SIGKILL and waits for close before rejecting.
- Default-Windows semantic tests prove a graceful leader exit can leave a cached descendant which
  is then terminated and proven gone without a test-only post-exit override. Injected never-settling
  adapters and a real hanging helper prove bounded failure.

PostgreSQL acquisition remains an observed resource through a bounded cleanup grace. `pool.end()`
starts after the main deadline, then cleanup waits for a late acquisition within that grace. A late
client is destroyed synchronously (or an injected promise-returning release is observed), and its
release failure is aggregated after the connect timeout and before the pool-end error. A permanently
pending acquisition has an observed rejection path and cannot create an unhandled future failure.

Final isolated PostgreSQL 16 verification used
`/tmp/tego-task6-rereview-pg16.4iDrW5` on port 55463:

```text
process harness: 24/24 passed
single-Main helpers: 5/5 passed
runtime fault suite: 19/19 passed
real multi-Main E2E: 1/1 passed
Biome and git diff --check: clean
```

## Final lifecycle re-review

The final review found four narrower ownership gaps. New RED tests demonstrated each before the
implementation changed:

```text
fast exit during capture: PROCESS_STILL_RUNNING
late Windows descendant: expected [101, 202], actual [101]
helper kill false/no close: promise did not settle boundedly
never-settling release: primary error returned without release timeout
post-return acquisition: client.release(true) was never called
```

The final implementation now constructs `ManagedProcess` immediately after `spawn()` and installs
the spawn/error/exit/close and stream listeners synchronously. Identity capture is an instance-owned
promise. A capture failure uses the same managed stream finalization and bounded reap path, and a
fast exit during capture is retained and finalized rather than lost.

Windows ownership refreshes and merges recursive PID + CreationDate tokens before stdin EOF, on
every termination, and on every proof. When the original leader has exited, each still-live owned
descendant becomes a discovery root, so a later grandchild is either discovered and terminated or
a failed snapshot/proof rejects cleanup. Every reached descendant PID is validated as a positive
safe integer before it can become a helper argument. PID 0 may remain in the unrelated system-wide
CIM snapshot but can never become owned or targeted.

The accepted Windows limitation for Task 9 documentation is explicit: this implementation uses
`taskkill /T` plus repeatedly refreshed CIM PID + CreationDate ownership tokens; it does not use a
native Job Object launcher. There remains a theoretical validate-to-numeric-termination PID reuse
TOCTOU window. The human approved this as a non-blocking Phase 1 limitation to verify empirically in
Windows CI. The implementation minimizes the window, never targets an unvalidated descendant PID,
and fails closed whenever tree discovery or termination proof cannot complete.

All PowerShell, CIM, `taskkill`, and `ps` helpers remain bounded by an absolute deadline. After a
helper deadline, SIGKILL is attempted and only a small reap grace is awaited; even `kill()` returning
false with no later `close` cannot hang cleanup. Stdio/listeners are detached safely and eventual
error/close events remain observed.

PostgreSQL client release is now an owned cleanup operation for both ordinary and late clients.
Synchronous and promise-returning injectable releases are awaited through the global cleanup
deadline, with timeout/error ordering preserved as primary, rollback, release, then pool end. If
acquisition settles only after cleanup returns, its client is still destroyed and all rejection
paths are observed. Such truly post-return errors cannot be retroactively added to the already
returned `AggregateError`; they are delivered to the injected `onLateCleanupError` diagnostic sink.

### Final RED to GREEN verification

Disposable Homebrew PostgreSQL 16 root `/tmp/tego-task6-final-pg16.yOw1i9`, port 55464, was created
with `mktemp`, stopped after verification, and removed after validating its exact prefix. Port 5432
and Docker were untouched.

```text
process harness: 31/31 passed
single-Main helpers: 5/5 passed
runtime fault suite with real PostgreSQL: 21/21 passed
real multi-Main E2E: 1/1 passed
focused combined unit/integration run: 49 passed, 3 environment-gated skipped
Biome and git diff --check: clean
```

Self-review found no remaining Critical, Important, or Minor issue within the approved practical
Windows scope.

## Capture-failure and connect-rejection follow-up

A subsequent review found that failure to capture the normal ownership token could degrade cleanup
to killing only the direct child. A new real regression spawned a parent and grandchild, deliberately
failed ownership capture after observing the grandchild, and initially proved the grandchild stayed
alive. The failure path now establishes a fail-safe owner while the stable leader is still live:
POSIX targets the newly created detached process group; Windows snapshots the exact leader and
recursive PID + CreationDate descendants, invokes `taskkill /T` only for that live leader, and
requires every cached token to disappear. Failure to terminate or prove the tree is aggregated
after the primary capture error. The direct child and real grandchild regression now proves both
dead and diagnostic artifacts finalized.

An immediate PostgreSQL `connect()` rejection was also incorrectly classified as a timeout and the
same rejected acquisition was appended twice. Cleanup now enables late-acquisition ownership only
for the explicit connect-timeout diagnostic. A regression verifies `Error("connect boom")` returns
as the exact original error unless a distinct cleanup operation fails.

The injected Windows fail-closed test now uses a 200 ms deadline rather than a 20 ms scheduling
race. Ten consecutive full process-harness runs completed with 32/32 passing each.

The approved non-Job-Object limitation is narrower than complete ownership proof: a Windows
descendant created after the final successful snapshot, followed by all currently owned parents
exiting before the next refresh, may no longer be discoverable. This implementation must not be
described as making that scenario impossible. Windows CI is the empirical gate for the practical
`taskkill /T` plus continuously refreshed CIM-token strategy.
