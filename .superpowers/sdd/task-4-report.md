# Task 4 Report: Durable SQLite State, Local Coordination, and Filesystem Artifacts

## Status

Complete.

Task 4 now provides:

- `SqliteStateStore` on Node 26.5.0 `node:sqlite`;
- idempotent private SQLite migrations with WAL and full synchronous durability;
- durable records, changes, operations, outbox, idempotency, fences, and
  database-generated revisions;
- immutable transaction snapshots with `BEGIN IMMEDIATE` commit serialization;
- durable cursor replay and in-process cross-instance watch delivery;
- immediate local authority with fencing epoch `"1"` and injected-clock leases;
- SHA-256-addressed filesystem artifacts with staged writes, digest verification,
  file and directory fsync, and atomic publication;
- deterministic Windows collision handling without claiming a Windows system test
  was executed on macOS;
- `createLocalDrivers({ dataDirectory, clock? })`.

All commands in this report used Volta Node 26.5.0.

## Commits

### Initial RED/GREEN

- RED `327689c` — `test: define durable local drivers`
- GREEN `01bc02c` — `feat: add durable local runtime drivers`

### Lifecycle race follow-up

- RED `05d6ea1` — `test: cover local driver open close races`
- GREEN `39b202e` — `fix: close local driver lifecycle races`

### SQLite review follow-up

- RED `3e94a68` — `test: cover SQLite review boundaries`
- GREEN `7a3b5b4` — `fix: harden SQLite transaction boundaries`

### Mutable artifact source follow-up

- RED `f850d2f` — `test: cover mutable artifact source race`
- GREEN `44bcc77` — `fix: stabilize streamed artifact chunks`

### Artifact directory durability follow-up

- RED `81634fb` — `test: define artifact directory durability policy`
- GREEN `f6e6556` — `fix: persist artifact directory entries`

### Private migration boundary follow-up

- RED `d167455` — `test: keep SQLite schema internals private`
- GREEN `8ac705c` — `refactor: keep SQLite migrations private`

## RED Evidence

### Initial durable local driver contract

Command:

```text
volta run --node 26.5.0 npm run build -w @tegojs/drivers-local
```

Result: exit 126 with the expected missing public exports:

```text
Module '"../src/index.js"' has no exported member 'createLocalDrivers'.
Module '"../src/index.js"' has no exported member 'FilesystemArtifactStore'.
Module '"../src/index.js"' has no exported member 'LocalCoordinationProvider'.
Module '"../src/index.js"' has no exported member 'publishTempFileAtomically'.
Module '"../src/index.js"' has no exported member 'SqliteStateStore'.
```

### Open/close lifecycle races

Command:

```text
node --test --test-name-pattern="close racing with open" \
  packages/drivers-local/dist/test/*.test.js
```

Result: 2 failures. Both SQLite and filesystem artifact drivers were resurrected
by an `open()` that completed after `close()`.

### SQLite boundary review

Command:

```text
node --test \
  --test-name-pattern="database-generated revisions remain exact|transaction reads use one immutable|failed SQLite open can be retried" \
  packages/drivers-local/dist/test/sqlite-state-store.test.js
```

Result: 3 failures:

- revision `9007199254740993` lost precision through `lastInsertRowid` and caused
  a foreign-key failure;
- a transaction's second read observed a concurrent commit rather than its initial
  snapshot;
- an initial `mkdir` failure left the store stuck in `"opening"` and retry returned
  `STATE_CLOSED`.

### Mutable artifact source race

Command:

```text
node --test \
  --test-name-pattern="artifact publish cannot accept bytes mutated" \
  packages/drivers-local/dist/test/local-drivers.test.js
```

Result: 1 failure. A 64 MiB caller-owned buffer was changed while
`FileHandle.write()` was pending. `put()` accepted the original digest while the
published file had a different digest.

### Artifact directory durability policy

Command:

```text
volta run --node 26.5.0 npm run build -w @tegojs/drivers-local
```

Result: exit 126 because `artifactPublishSyncDirectories` did not exist. This
locked the policy that a new shard publication fsyncs both the shard and its
`artifacts/` parent, while an existing shard only requires the shard fsync.

### Private migration boundary

Command:

```text
node --test \
  --test-name-pattern="storage-specific migration machinery" \
  packages/drivers-local/dist/test/sqlite-state-store.test.js
```

Result: 1 failure because `applySqliteMigrations` and `sqliteSchemaVersion` were
still visible from the public package root.

## GREEN Evidence

### Focused build

Command:

```text
volta run --node 26.5.0 npm run build \
  -w @tegojs/contracts \
  -w @tegojs/testkit \
  -w @tegojs/drivers-local
```

Result: exit 0 for all three workspaces.

### Conformance, restart, crash, coordination, and artifact tests

Command:

```text
volta run --node 26.5.0 node --test \
  packages/testkit/dist/test/testkit.test.js \
  packages/drivers-local/dist/test/*.test.js
```

Result:

```text
tests 55
suites 2
pass 55
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 529.112167
```

The final suite includes:

- all 15 unchanged public `StateStore` conformance cases against
  `MemoryStateStore`;
- the same 15 unchanged conformance cases against `SqliteStateStore`;
- database restart and abrupt child-process exit recovery;
- WAL mode and repeated migration application;
- idempotency replay/fingerprint rejection after restart;
- persistent fences and exact bigint revisions above
  `Number.MAX_SAFE_INTEGER`;
- durable watch replay and immutable transaction snapshots;
- decoded-value validation;
- idempotent close, pending watcher cleanup, file-handle release, and
  open/close race cleanup;
- immediate local authority and injected-clock lease timestamps;
- digest mismatch cleanup and digest verification before reads yield bytes;
- atomic publish visibility;
- caller-buffer mutation during asynchronous artifact writes;
- deterministic Windows publish-collision behavior and POSIX hard-error
  propagation;
- shard and parent-directory fsync policy;
- private migration internals;
- deterministic testkit clock/eventual assertions without real-time sleeps.

### Focused typecheck

Command:

```text
volta run --node 26.5.0 npm run typecheck \
  -w @tegojs/contracts \
  -w @tegojs/testkit \
  -w @tegojs/drivers-local
```

Result: exit 0 for all three workspaces.

### Root architecture gate

Command:

```text
volta run --node 26.5.0 node --test tests/architecture/*.test.mjs
```

Result:

```text
tests 18
pass 18
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 170.522
```

### Root format and lint

Commands:

```text
volta run --node 26.5.0 npm run format:check
volta run --node 26.5.0 npm run lint
git diff --check
```

Result:

```text
Checked 47 files. No formatting fixes required.
Checked 47 files. No lint fixes required.
```

`git diff --check` exited 0.

## Files

### Shared contracts

- `packages/contracts/src/drivers.ts`
- `packages/contracts/src/index.ts`

### SQLite state

- `packages/drivers-local/src/sqlite/migrations.ts`
- `packages/drivers-local/src/sqlite/sqlite-state-store.ts`

### Local coordination and artifacts

- `packages/drivers-local/src/local-coordination.ts`
- `packages/drivers-local/src/filesystem-artifact-store.ts`
- `packages/drivers-local/src/create-local-drivers.ts`
- `packages/drivers-local/src/index.ts`

### Tests

- `packages/drivers-local/test/sqlite-state-store.test.ts`
- `packages/drivers-local/test/local-drivers.test.ts`

The prior `MemoryStateStore` implementation and shared conformance suite were not
modified.

## Implementation Notes

### SQLite state semantics

- Migrations execute transactionally and record schema version `1`.
- Connections enable foreign keys, WAL, `synchronous=FULL`, and zero busy timeout.
- Each transaction captures one immutable decoded record snapshot.
- Commits use `BEGIN IMMEDIATE`, re-check expected revisions and durable
  idempotency/fencing state, and roll back all writes on failure.
- A mutating commit obtains its revision from an AUTOINCREMENT row with
  `{ readBigInts: true }`; no JavaScript `number` handles public revisions.
- Record and change payloads use canonical JSON text and are validated again on
  decode.
- Idempotency results and fingerprints are durable; same-instance re-entrant
  callers share the in-flight result.
- Watches first read the durable change log after the supplied cursor, then receive
  commits from all store instances using the same database path in the process.
- `close()` coalesces concurrent calls, waits for accepted work, closes pending
  watches, and cannot be undone by an in-flight `open()`.

### Artifact semantics

- The final path is
  `artifacts/<first-two-hex-characters>/<sha256-hex>.tego`, avoiding the
  Windows-invalid colon from the public `sha256:<hex>` identity.
- Each yielded chunk is copied before hashing and asynchronous writing, preventing
  caller mutation from invalidating the accepted digest.
- The temporary file is exclusively created in the destination shard, fully
  written, fsynced, and closed before publication.
- Digest mismatch removes the temporary file and leaves no final artifact.
- Publication uses same-directory rename. On Windows collision-style errors, an
  already complete matching target is retained and the temporary file is removed.
  Hard errors propagate.
- POSIX durability syncs the shard directory after rename and also syncs
  `artifacts/` when the shard directory was newly created. Creating `artifacts/`
  syncs its data-directory parent.
- Reads collect and hash all chunks before yielding any bytes, so corrupt content
  never reaches a component consumer.

### Coordination and factory

- Local campaigns and epochs return the single-main fencing epoch `"1"`
  immediately.
- Lease timestamps are calculated only from the injected clock.
- `createLocalDrivers()` creates the data directory and returns unopened state,
  coordination, and artifact drivers plus the selected clock.

## Self-Review

An independent read-only code review found no Critical issues. Its Important
implementation findings were all reproduced before correction:

- unsafe SQLite `lastInsertRowid` conversion;
- live rather than immutable transaction reads;
- unrecoverable directory-creation failure;
- missing parent-directory fsync for a new artifact shard;
- caller-owned artifact buffer mutation during asynchronous writes.

Each finding received a failing regression test and a separate GREEN commit. A
local self-review additionally found the `open()`/`close()` resurrection race and
the public migration export; both also received RED/GREEN follow-ups.

Fresh final build, focused tests, typecheck, architecture, format, lint, and diff
checks all pass.

## Concerns and Staged Interfaces

No blocking Task 4 concern remains.

The following interfaces are intentionally staged rather than represented by fake
or optional placeholders:

- Task 4's `RuntimeDrivers` bundle is scoped to state, coordination, artifacts, and
  clock. `ProcessHost` will be defined and implemented with Task 10
  `ProcessExecutor`; `SecretProvider` will be defined with Task 9
  `ComponentHost`/context. Final runtime-driver composition will be completed when
  those concrete semantics exist.
- The stable Task 3 `StateStore` contract does not yet expose operation listing or
  outbox claim/ack APIs. Task 5 recovery will add operation read/list semantics
  test-first. Task 8 reconciliation will add outbox ordering, ownership, retry,
  claim, and acknowledgement semantics test-first.

Known bounded trade-offs:

- Artifact reads buffer a complete verified artifact before yielding it. This
  enforces the design requirement that no unverified bytes escape, but a future
  artifact-size limit or verified staging reader should bound memory use.
- Live watch wakeups are process-local. Durable changes are replayed from the
  SQLite log after restart; external cross-process notification is outside the
  single-main local-driver scope.
- Windows behavior is covered through a factored deterministic collision policy.
  No macOS run is presented as a Windows filesystem integration test.
