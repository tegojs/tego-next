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

## RED Evidence

- Initial focused tests failed because `component-lifecycle`, `plan`, and `reconciler` modules and
  StateStore outbox methods were missing.
- Boundary regression run: 70/73 passed; malformed lifecycle diagnostics and failed/converging/ready
  observations failed.
- Stale-effect regression run: 17/19 passed; queued startup replay and installation-free shutdown
  failed.
- Canonical-identity regression run: 21/22 passed; a retargeted prepare reached the effect executor
  before the common validation path was added.
- Each RED group was committed before its corresponding implementation fix.

## GREEN Evidence

Fresh verification at the final implementation boundary:

- `npm run format:check` — PASS, 88 files.
- `npm run lint` — PASS, 88 files.
- Affected workspace typecheck (`contracts`, `testkit`, `drivers-local`, `runtime`) — PASS.
- Focused runtime plus Memory/SQLite state tests — PASS, 81/81.
- `npm test` — PASS:
  - CLI: 37/37
  - Runtime: 144/144
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
- Every claimed effect recomputes its canonical identities and must match the persisted
  application/plugin/component/generation/artifact/executor/worker tuple before journaling.
- Disabled deployments may drain from observed instance data even when installation metadata has
  already been removed.

## Remaining Concerns

- The aggregate root typecheck has the unrelated placeholder-workspace gap described above.
- Runtime scheduling/watch integration is a later bootstrap concern; this task exposes deterministic
  `start`, `wake`, and `stop` reconciliation entry points and durable retry visibility.
