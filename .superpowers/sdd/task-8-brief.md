## Task 8: Reconcile deployments into kernel-owned component lifecycles

**Files:**
- Modify: `packages/contracts/src/state.ts`
- Modify: `packages/drivers-local/src/memory-state-store.ts`
- Modify: `packages/drivers-local/src/sqlite/sqlite-state-store.ts`
- Create: `packages/runtime/src/reconcile/component-lifecycle.ts`
- Create: `packages/runtime/src/reconcile/plan.ts`
- Create: `packages/runtime/src/reconcile/placement.ts`
- Create: `packages/runtime/src/reconcile/reconciler.ts`
- Create: `packages/runtime/src/reconcile/retry.ts`
- Create: `packages/runtime/test/component-lifecycle.test.ts`
- Create: `packages/runtime/test/reconciler.test.ts`

**Interfaces:**
- Produces: `planReconcile(snapshot): ReconcilePlan`.
- Produces: `Reconciler.start`, `Reconciler.wake`, and `Reconciler.stop`.
- Produces: public outbox claim/acknowledgement operations with stable message
  identity, fencing, retry visibility, and idempotent acknowledgement.

- [x] **Step 1: Write and commit failing lifecycle and convergence tests**

Cover legal transitions, illegal transition diagnostic, generation change,
duplicate reconcile, enable, disable, upgrade, drain, rollback, non-essential
failure, essential readiness, retry timing, and restart during one external
action. Also cover concurrent outbox claims, claim expiry, stale-fence rejection,
duplicate acknowledgement, and restart before acknowledgement.

Run: `node --test packages/runtime/dist/test/component-lifecycle.test.js packages/runtime/dist/test/reconciler.test.js`

Expected: FAIL with missing reconcile exports.

Commit: `git add packages/runtime/test && git commit -m "test: define deployment reconciliation"`

- [x] **Step 2: Implement pure lifecycle, placement, and plan functions**

Plans contain one bounded external effect per step and stable operation,
instance, and generation identities. Retry delay is capped exponential backoff
with deterministic jitter derived from operation ID.

- [x] **Step 3: Implement journaled reconciler execution**

Persist the step before performing the effect. Conditionally commit observed
state using expected revision and fencing epoch. Re-read after conflicts rather
than mutating stale snapshots.

- [x] **Step 4: Verify restart convergence and commit**

Run: `npm run build -w @tegojs/runtime && node --test packages/runtime/dist/test/component-lifecycle.test.js packages/runtime/dist/test/reconciler.test.js`

Expected: PASS with one live instance after interrupted reconcile replay.

Commit: `git add packages/runtime && git commit -m "feat: reconcile plugin deployments"`
