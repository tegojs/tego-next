# Reconciliation Second Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five Important findings from the second formal Task 8 review without regressing
claim fencing, provider ordering, canonical instance boundaries, or Memory/SQLite parity.

**Architecture:** Reconciliation will quarantine an already-persisted lifecycle effect before it
tries to enqueue a replacement with the same stable identity. Startup effects remain gated by the
current manifest and placement, while teardown effects use the immutable executor/worker tuple
persisted with the old instance. A single context-validation predicate will control planning,
capability readiness, execution-time gates, and application readiness. Both local state drivers will
deduplicate staged outbox messages before commit.

**Tech Stack:** TypeScript, Node.js test runner, MemoryStateStore, node:sqlite SqliteStateStore,
shared `@tegojs/testkit` state-store conformance.

## Global Constraints

- Every finding receives a committed failing test before production changes.
- Runtime store-level regressions use real MemoryStateStore and SqliteStateStore where persistence
  semantics are part of the finding.
- Driver-contract behavior lives in the shared conformance suite and runs against both drivers.
- No new dependency or unrelated refactor.
- Keep claim epoch, authority fencing, provider-first ordering, and prior canonical JSON/key checks.

---

### Task 1: Quarantine stale stable-identity placement before replacement

**Files:**
- Modify: `packages/runtime/test/reconciler.test.ts`
- Modify: `packages/runtime/src/reconcile/reconciler.ts`

**Interfaces:**
- Consumes: `StateStore.claimOutbox`, retry acknowledgement replacement semantics.
- Produces: one-pass handling that claims an existing lifecycle message before planning a different
  payload under the same stable `messageId`.

- [ ] **Step 1: Write the failing real-driver regression**

Run the same scenario through MemoryStateStore and SqliteStateStore: persist a pending `process`
prepare, change supported placement to `thread`, wake reconciliation, and prove no
`STATE_IDEMPOTENCY_CONFLICT` escapes and the corrected effect eventually executes.

- [ ] **Step 2: Verify RED and commit**

Run the focused runtime test after rebuilding. Expected: both driver cases reject the planning
transaction with `STATE_IDEMPOTENCY_CONFLICT`.

- [ ] **Step 3: Implement minimal pre-plan claim quarantine**

Claim at most one already-persisted lifecycle message before plan persistence. If a claim existed,
execute/retry it, reload state, plan a replacement, and defer the newly planned effect to the next
wake. If no message existed, retain the existing plan-then-claim behavior.

- [ ] **Step 4: Verify GREEN and commit**

Run both real-driver cases plus the full reconciler test file.

### Task 2: Teardown removed old-generation components

**Files:**
- Modify: `packages/runtime/test/reconciler.test.ts`
- Modify: `packages/runtime/src/reconcile/reconciler.ts`

**Interfaces:**
- Consumes: the persisted instance `artifactDigest`, `executor`, and optional `workerId`.
- Produces: drain/stop execution independent of the current manifest or removed installation.

- [ ] **Step 1: Write failing upgrade and rollback regressions**

Persist an old ready instance whose component is absent from the new manifest. Prove drain executes;
then wake again and prove stop executes and reaches `stopped`, for both upgrade and rollback.

- [ ] **Step 2: Verify RED and commit**

Expected: the old effect is acknowledged without invoking the executor.

- [ ] **Step 3: Restrict current-manifest placement checks to prepare/start**

Keep exact persisted effect tuple checks for every effect. Use current component lookup and
`planPlacement` only for startup; old-generation teardown relies on the immutable persisted tuple.

- [ ] **Step 4: Verify GREEN and commit**

Run the upgrade/rollback regressions and full reconciler suite.

### Task 3: Retry failed prepare after retryAt

**Files:**
- Modify: `packages/runtime/test/reconciler.test.ts`
- Modify: `packages/runtime/src/reconcile/reconciler.ts`

**Interfaces:**
- Consumes: persisted `lifecycle: "failed"`, `retryEffect`, `retryAt`, and outbox retry visibility.
- Produces: a legal retryable `failed -> prepare -> preparing` attempt and eventual `ready`.

- [ ] **Step 1: Write a failing executor retry regression**

Make prepare fail once, advance the manual clock beyond `retryAt`, wake until convergence, and assert
prepare is invoked twice, start runs once, retry metadata clears, and the instance becomes ready.

- [ ] **Step 2: Verify RED and commit**

Expected: the second prepare is planned but completed-acknowledged by the pre-lifecycle matrix.

- [ ] **Step 3: Admit only matching due failed retries**

Permit `failed` before an effect only when `retryEffect` equals the effect kind and `retryAt` is due.
Leave ordinary stale/corrupt failed messages rejected. The existing lifecycle transition table
already permits `failed -> preparing`.

- [ ] **Step 4: Verify GREEN and commit**

Run the retry regression and full reconciler suite.

### Task 4: Validate current instance deployment context

**Files:**
- Modify: `packages/runtime/test/reconciler.test.ts`
- Modify: `packages/runtime/src/reconcile/reconciler.ts`

**Interfaces:**
- Consumes: current deployment generation and artifact digest.
- Produces: one canonical/context predicate used by planning, capability gates, execution, and
  readiness.

- [ ] **Step 1: Write failing artifact and observed-generation regressions**

Persist canonical current-generation ready instances with either the wrong `artifactDigest` or
wrong `observedGeneration`. Prove they cannot make an essential deployment ready or satisfy a
consumer capability and that the provider receives durable `DEPLOYMENT_INSTANCE_INCONSISTENT`.

- [ ] **Step 2: Verify RED and commit**

Expected: mismatched instances are accepted as ready providers/current ready instances.

- [ ] **Step 3: Add exact current-context validation**

For a record matching the desired application/plugin/current generation, require
`artifactDigest === deployment.artifactDigest` and
`observedGeneration === deployment.generation`. Exclude failures from every readiness input and
record them as inconsistent; do not classify older generation teardown records as inconsistent.

- [ ] **Step 4: Verify GREEN and commit**

Run focused context/capability/readiness tests and full reconciler suite.

### Task 5: Deduplicate same-transaction outbox identities

**Files:**
- Modify: `packages/testkit/src/state-store-suite.ts`
- Modify: `packages/drivers-local/src/memory-state-store.ts`
- Modify: `packages/drivers-local/src/sqlite/sqlite-state-store.ts`

**Interfaces:**
- Consumes: canonical `sameOutboxMessage` comparison.
- Produces: first-occurrence ordering, one stored row for identical staged content, and
  `STATE_IDEMPOTENCY_CONFLICT` for changed operation/topic/payload.

- [ ] **Step 1: Add shared failing conformance cases**

Within one transaction, enqueue the same canonical message twice and assert one claim. In separate
transactions, enqueue duplicate IDs whose second staged message changes operation, topic, or payload
and assert atomic `STATE_IDEMPOTENCY_CONFLICT`.

- [ ] **Step 2: Verify RED against Memory and SQLite and commit**

Expected: identical duplicates are last-wins/upserted, while conflicting duplicates are not rejected
inside the transaction.

- [ ] **Step 3: Deduplicate staged messages before persistence**

Build an insertion-ordered map by `messageId`; keep the first identical message and reject any
different staged message before revision/fence mutation. Reuse the same canonical comparator in
both drivers.

- [ ] **Step 4: Verify GREEN and commit**

Run shared conformance through both drivers, including claim and authority-fence cases.

### Task 6: Closure

**Files:**
- Modify: `.superpowers/sdd/task-8-report.md`

- [ ] Run focused runtime plus Memory/SQLite tests.
- [ ] Run affected workspace typechecks, `npm test`, and `npm run test:integration`.
- [ ] Run `npm run format:check`, `npm run lint`, and `git diff --check`.
- [ ] Request an independent read-only review of all five findings.
- [ ] Append RED/GREEN commit hashes, exact test counts, review result, and known root aggregate
  typecheck baseline to the existing Task 8 report.
- [ ] Commit the report and verify a clean worktree.
