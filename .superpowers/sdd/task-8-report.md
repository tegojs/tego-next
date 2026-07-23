# Task 8 Report: Deployment Reconciliation

## Outcome

Implemented kernel-owned plugin deployment reconciliation across the public state contract,
local state drivers, runtime planning/execution, and reusable conformance tests.

The implementation now provides:

- legal component lifecycle transitions and application readiness evaluation;
- pure deterministic placement, retry, and enable/disable/upgrade/rollback planning;
- application-scoped stable instance, operation, and message identities;
- durable outbox claim, lease, retry, fencing, topic filtering, and idempotent acknowledgement;
- journal-before-effect execution with conditional observed-state commits;
- restart recovery before acknowledgement without duplicate external effects or instances;
- execution-time revalidation of desired state, artifact, capability, permission, and placement gates;
- structured blocked, failed, degraded, unavailable, inconsistent, converging, and ready observations;
- failure isolation for non-essential deployments and readiness blocking for essential deployments.

## Auditable TDD Commit Sequence

1. `8609921 test: define deployment reconciliation`
   - Initial RED lifecycle, convergence, outbox, fencing, retry, and restart tests.
   - Expected failure: reconcile modules/exports and outbox contract methods did not exist.
2. `ea7770d feat: add journaled deployment reconciliation`
   - Core GREEN implementation, including four self-review RED/GREEN cases:
     partial placement leakage, stable identity collisions, diagnostic retention across wakes,
     and failed-effect conditional commit conflicts.
3. `489b4f4 test: cover reconciliation recovery boundaries`
   - RED coverage for malformed lifecycle messages and durable deployment observations.
   - Added provider bootstrap and outbox ordering regression coverage.
4. `3976633 test: cover stale effects and installation-free shutdown`
   - RED coverage proving queued startup work could survive desired-state changes and disabled
     deployments could be blocked by missing installation metadata.
5. `ebd9a67 fix: harden reconciliation recovery boundaries`
   - GREEN for message decoding, desired/gate revalidation, durable completed-operation history,
     installation-free shutdown, observation progression, and stale retry metadata cleanup.
6. `2360149 fix: persist structured deployment observations`
   - GREEN for durable unavailable/inconsistent/degraded classifications and capability binding
     history input.
7. `f393ce3 test: reject retargeted lifecycle effects`
   - RED coverage for structurally valid prepare/start/drain/stop messages whose canonical instance
     identity was changed to target another persisted instance.
8. `aab50aa fix: validate canonical lifecycle effect identity`
   - GREEN by recomputing canonical message/operation/instance identities and matching the loaded
     instance tuple and current desired state before every external effect.
9. `31faedc test: cover execution-time reconciliation gates`
   - RED for changed executor placement, stale pre-lifecycle state, and non-canonical persisted
     instance identities; focused reconciliation was 22/25.
10. `da65749 fix: revalidate claimed lifecycle effects`
    - GREEN for exact current executor/worker placement, the effect/pre-lifecycle matrix, and durable
      inconsistent observation of non-canonical records.
11. `3926a73 test: require provider-first reconciliation order`
    - RED for an optional capability edge whose consumer sorts lexically before its provider;
      focused reconciliation was 25/26.
12. `254ded0 fix: reconcile deployments in provider-first order`
    - GREEN for application-scoped resolver order with deterministic fallback, while preserving
      provider bootstrap and serialized drain-before-stop behavior.
13. `e894d8b test: define canonical outbox boundaries and ordering`
    - RED for canonical JSON/accessor rejection, topic/payload bounds, same-transaction enqueue
      order, and SQLite restart/migration behavior; local state verification was 54/61.
14. `0339b86 fix: canonicalize and sequence durable outbox data`
    - GREEN for shared wire serialization, one-MiB payload and 128-character topic limits,
      retry-superseded stable messages, Memory enqueue sequencing, and SQLite migration v3.
15. `1435baf test: cover noncanonical instance storage boundaries`
    - RED for a canonical instance value stored under a non-canonical state key and a non-canonical
      provider record satisfying a queued consumer's execution-time capability gate.
16. `4971feb fix: validate persisted instance storage identity`
    - GREEN by retaining state-record keys, requiring key/value/derived identity agreement, and
      filtering planning, execution-time gates, and readiness through the same canonical boundary.

## RED Evidence

- Initial focused tests failed because `component-lifecycle`, `plan`, and `reconciler` modules and
  StateStore outbox methods were missing.
- Boundary regression run: 70/73 passed; malformed lifecycle diagnostics and failed/converging/ready
  observations failed.
- Stale-effect regression run: 17/19 passed; queued startup replay and installation-free shutdown
  failed.
- Canonical-identity regression run: 21/22 passed; a retargeted prepare reached the effect executor
  before the common validation path was added.
- Formal-review execution-gate regression run: 22/25 passed; changed placement, stale lifecycle, and
  non-canonical persisted identity tests failed.
- Provider-order regression run: 25/26 passed; a lexical-first optional consumer executed before its
  provider.
- State boundary/order regression run: 54/61 passed; Memory accepted non-wire values and both stores
  lacked bounds/retry replacement, while SQLite lost same-transaction enqueue order across restart.
- Supplemental retry-replacement run: 86/90 passed before invalid/replanned messages stopped using
  terminal acknowledgement semantics.
- Independent-review storage-boundary regression run: 0/2 passed; the queued consumer effect ran and
  an essential deployment was marked ready from a canonical value stored under the wrong state key.
- Each RED group was committed before its corresponding implementation fix.

## GREEN Evidence

Fresh verification at the final implementation boundary:

- `npm run format:check` — PASS, 88 files.
- `npm run lint` — PASS, 88 files.
- Affected workspace typecheck (`contracts`, `testkit`, `drivers-local`, `runtime`) — PASS.
- Focused lifecycle/reconciler plus Memory/SQLite state tests — PASS, 96/96.
- `npm test` — PASS:
  - CLI: 37/37
  - Runtime: 151/151
  - Testkit: 3/3
  - Architecture: 18/18
- `npm run test:integration` — PASS, 5/5.

Root `npm run typecheck` reaches and passes every implemented affected workspace, but the aggregate
command remains non-green because four future placeholder workspaces do not contain `tsconfig.json`:
`drivers-postgres`, `executor-node`, `plugin-sdk`, and `transport-websocket`. This is pre-existing and
outside Task 8.

## Main Files

- `packages/contracts/src/state.ts`
- `packages/drivers-local/src/memory-state-store.ts`
- `packages/drivers-local/src/sqlite/migrations.ts`
- `packages/drivers-local/src/sqlite/sqlite-state-store.ts`
- `packages/testkit/src/state-store-suite.ts`
- `packages/runtime/src/reconcile/component-lifecycle.ts`
- `packages/runtime/src/reconcile/placement.ts`
- `packages/runtime/src/reconcile/plan.ts`
- `packages/runtime/src/reconcile/reconciler.ts`
- `packages/runtime/src/reconcile/retry.ts`
- `packages/runtime/test/component-lifecycle.test.ts`
- `packages/runtime/test/reconciler.test.ts`

## Design Decisions

- One outbox message represents exactly one bounded external lifecycle effect.
- Stable identities escape ambiguous delimiter characters and hash overlength identities.
- Application identity is persisted on every component instance and included in every effect.
- Completed operation history is stored with the instance so a later lifecycle step cannot erase
  replay protection for an older unacknowledged step.
- Control-plane commit or acknowledgement errors are not classified as component-effect failures.
- Claimed startup effects recheck desired generation/state and all pre-import gates before execution.
- Claimed effects relocate the current manifest component and require exact executor and worker
  placement before the executing journal entry.
- Durable completed-operation identity is checked before the explicit prepare/start/drain/stop
  pre-lifecycle matrix.
- Every claimed effect recomputes its canonical identities and must match the persisted
  application/plugin/component/generation/artifact/executor/worker tuple before journaling.
- Persisted instance records retain their state key, and only records whose key, value, and derived
  identity agree may affect planning, capability readiness, effect execution, or application
  readiness.
- Capability resolver order drives application-scoped deployment planning; lexical order is only a
  deterministic fallback for unordered, blocked, or disabled deployments.
- Memory and SQLite share sorted wire-value semantics, explicit outbox bounds, and retry replacement
  for corrected stable messages.
- SQLite migration v3 persists enqueue sequence so equal-availability messages retain transaction
  order after restart.
- Disabled deployments may drain from observed instance data even when installation metadata has
  already been removed.

## Remaining Concerns

- The aggregate root typecheck has the unrelated placeholder-workspace gap described above.
- Runtime scheduling/watch integration is a later bootstrap concern; this task exposes deterministic
  `start`, `wake`, and `stop` reconciliation entry points and durable retry visibility.

## Independent Review

The initial read-only review returned **PASS** for `aab50aa`, confirming canonical identity
recomputation and complete persisted-instance tuple validation.

Formal review then identified six execution/order/driver-contract findings, all addressed through
the RED/GREEN commits above. A final storage-boundary review found two additional key-retention and
execution-time filtering gaps; after `4971feb`, the independent re-review returned **PASS**. The
reviewer independently confirmed state-key identity validation, canonical-only execution-time
capability inputs, a fresh 29/29 reconciler run, and `git diff --check`.
