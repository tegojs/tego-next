# Phase 1 Contract Repair — Task 2 Review Fix Report

## Outcome

Closed the durable capability-binding review findings without exposing binding persistence as a
public runtime API.

- A capability-binding revision conflict now returns an internal pass-abort signal. The current
  reconciliation pass cannot persist or perform lifecycle work from the losing resolution.
- The next pass reloads desired state and the winning binding before resolving again.
- A canonical authority-fenced, revision-fenced cleanup runs over loaded binding records before
  deployment gates.
- Cleanup deletes records for absent consumers and records whose deployment generation is
  provably stale, including when the current deployment later fails an installation or artifact
  gate.
- Current-generation records remain intact when a failed gate prevents proving that the
  capability requirement was removed. Successful gates retain the existing requirement-removal
  cleanup.
- `PersistedCapabilityBinding` and `capabilityBindingKey()` are internal implementation details.
  Tests observe the `capability-bindings` collection through the state-store contract and make no
  package export promise.

## Commits

- RED: `6f1bb1ecc8d79b4b6ac60275ab8e832462a9547b` —
  `test(runtime): cover binding conflicts and cleanup`
- GREEN: `ec20d5e7ef75c2465efd045df060315f89acbaa2` —
  `fix(runtime): abort stale binding reconciliation`

## RED Evidence

### Deterministic binding race

The RED commit was checked in a detached worktree against the pre-fix reconciler:

```sh
npm run build --workspace @tegojs/runtime
node --test --test-name-pattern='losing automatic binding CAS' \
  packages/runtime/dist/test/reconciler.test.js
```

Result: exit 1. The losing pass persisted one lifecycle outbox record (`1 !== 0`) after provider B
won the binding CAS.

### Canonical cleanup

```sh
npm run build --workspace @tegojs/runtime
node --test --test-name-pattern='capability binding cleanup' \
  tests/integration/reconciler-state-stores.test.mjs
```

Result: exit 1. Memory and SQLite both retained the absent-consumer record. The combined regression
also covers generation change despite an early installation gate failure and preservation of a
current-generation record when requirement removal cannot be proven.

## GREEN Evidence

### Focused race and cleanup

```sh
npm run build --workspace @tegojs/runtime
node --test --test-name-pattern='losing automatic binding CAS|capability binding cleanup' \
  packages/runtime/dist/test/reconciler.test.js \
  tests/integration/reconciler-state-stores.test.mjs
```

Result: exit 0; 4 tests passed, 0 failed. The race records zero lifecycle outbox/effects in the
losing pass, then reloads and retains provider B. Cleanup passed for Memory and SQLite.

### Runtime unit suite

```sh
npm run test:unit --workspace @tegojs/runtime
```

Result: exit 0; 306 tests passed, 0 failed.

### Dual-store integration suite

```sh
node --test tests/integration/reconciler-state-stores.test.mjs
```

Result: exit 0; 43 tests passed, 0 failed.

### Workspace typecheck

```sh
npm run typecheck
```

Result: exit 0 across all workspaces.

### Scoped Biome and diff check

```sh
npx biome check \
  packages/runtime/src/reconcile/reconciler.ts \
  packages/runtime/test/reconciler.test.ts \
  tests/integration/reconciler-state-stores.test.mjs
git diff --check
```

Result: Biome checked 3 files with no fixes; `git diff --check` exited 0.

## Concerns

No blocking concerns.
