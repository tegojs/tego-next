# Task 5 Report: Runtime Bootstrap and Recovery

## Outcome

Implemented the first usable runtime bootstrap boundary:

- public, storage-agnostic recovery queries for non-terminal operation-journal
  entries;
- deterministic `(revision, operationId)` ordering and exclusive cursor
  pagination without converting decimal revisions to JavaScript `number`;
- Memory and SQLite implementations, including durable SQLite restart
  recovery;
- pure runtime lifecycle transition and readiness functions;
- `createRuntime(configuration, drivers)` with `start`, `status`, `stop`,
  `operations`, and leak-free lifecycle event iterators;
- driver open order `state -> coordination -> artifacts` and reverse cleanup;
- state recovery before authority acquisition and operation acceptance;
- structural `CoordinationProvider.scope` validation for multi-Main startup;
- safe, idempotent concurrent/repeated start and stop behavior.

No `ProcessHost`, `SecretProvider`, layer-two capability, or concrete-driver
dependency was added to `@tegojs/runtime`.

## TDD Evidence

### Operation journal

- RED `814f4e7` — `test: define recoverable operation journal query`
  - failed because the public query, persisted entry, cursor, and comparator did
    not exist.
- GREEN `2bcd1e6` — `feat: query recoverable operation journal entries`
  - Memory and SQLite conformance passed, including restart and revisions above
    `Number.MAX_SAFE_INTEGER`.

### Runtime bootstrap

- RED `0f1910b` — `test: define runtime bootstrap lifecycle`
  - failed because `createRuntime` and runtime implementation exports did not
    exist.
- GREEN `62fb9be` — `feat: boot and recover an empty runtime`
  - focused runtime bootstrap suite passed.

## Verification

Passed:

```text
npm run typecheck -w @tegojs/contracts \
  -w @tegojs/testkit \
  -w @tegojs/drivers-local \
  -w @tegojs/runtime

node --test \
  packages/contracts/dist/test/contracts.test.js \
  packages/testkit/dist/test/testkit.test.js \
  packages/drivers-local/dist/test/*.test.js \
  packages/runtime/dist/test/bootstrap.test.js \
  tests/architecture/*.test.mjs

npm run format:check
npm run lint
git diff --check
```

Result: 102 tests passed, 0 failed; affected-package type checks, architecture
checks, formatting, lint, and diff checks passed.

The root `npm run build` remains unavailable because phase-one packages not yet
implemented by their later tasks (`cli`, `drivers-postgres`, `executor-node`,
`plugin-sdk`, and `transport-websocket`) still lack `tsconfig.json`. All
packages changed or consumed by Task 5 build successfully.

## Design Decisions

- Coordination suitability is declared through the public structural
  `scope: "local" | "distributed"` contract. Runtime contains no
  `instanceof`, driver-name check, or `drivers-local` import.
- Recovery enumeration exposes only current `planned` and `executing`
  operations. `completed` and `failed` entries are terminal and excluded.
- Journal pages are ordered numerically by decimal revision, then by portable
  operation ID using code-unit order. The cursor is exclusive and includes
  both fields so multiple operations committed at one revision cannot be
  skipped.
- Runtime recovery uses public `StateStore.scan` and
  `scanRecoverableOperations` only. The former SQLite-only `readOperation`
  escape hatch was removed.
- Degraded driver health remains live and ready; an explicitly unhealthy
  driver blocks readiness. Only desired, essential, unready deployments block
  application readiness.
- Runtime operation inspection is rejected with `BOOTSTRAP_NOT_READY` until
  recovery and authority acquisition complete.
- Event subscribers are independent. Stop closes all subscribers, resolves
  pending waiters, allows already queued lifecycle events to drain, and makes
  late iterators terminate immediately.

## Remaining Concerns

- Task 5 reconstructs the startup snapshot and recoverable operation list; the
  operation-specific resume/terminal handlers arrive with their owning
  installation, deployment, reconciliation, and task slices.
- `StopOptions.deadlineMs` is part of the public lifecycle shape but deadline
  enforcement depends on cancellable executor/process resources introduced by
  later tasks.
- Full root build verification becomes meaningful after the placeholder
  workspaces receive their task-specific TypeScript projects.
