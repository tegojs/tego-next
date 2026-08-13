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
