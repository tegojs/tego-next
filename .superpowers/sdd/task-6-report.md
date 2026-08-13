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
