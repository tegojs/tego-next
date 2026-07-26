# Phase 1 Task 9 Closure Report

## Status

**DONE_WITH_CONCERNS**

OpenSpec tasks 10.3 and 10.4 are complete with direct test evidence. Task 1.3 remains
open because the audit found only the fake clock and eventual-assertion pieces in the
shared testkit; the remaining required harness capabilities are still private or
duplicated across package tests.

## Scope and files

- `packages/testkit/test/public-suites.test.ts`
  - Imports all six conformance suites from `@tegojs/testkit`.
  - Imports their public factory/fixture contracts from the same package entry.
  - Type-checks consumer calls for manifest, lifecycle, executor, Worker,
    state-store, and coordination-provider suites.
  - Runtime-checks that the complete six-suite consumer surface is present.
- `openspec/changes/runtime-kernel-phase-1/tasks.md`
  - Checked 10.3 and 10.4 after test and build evidence.
  - Deliberately left 1.3 unchecked.
- `.superpowers/sdd/phase1-task-9-report.md`
  - Records closure evidence and remaining gaps.

No production source or echo-plugin files were changed. The audit found that all six
suite implementations and public exports already existed, so adding a production API
would not have repaired a genuine contract gap.

## Existing public-suite audit

The package entry `packages/testkit/src/index.ts` publicly re-exports:

1. `manifestConformance`
2. `lifecycleConformance`
3. `executorConformance`
4. `workerConformance`
5. `stateStoreConformance`
6. `coordinationConformance`

The suite implementations use public contracts and expose public factory types. Prior
to this change, `public-suites.test.ts` exercised only manifest, lifecycle, and Worker,
leaving executor, state-store, and coordination-provider public-entry consumption
unproved.

## RED evidence

After adding the six-suite public-entry consumer test, the three previously uncovered
root re-exports were temporarily removed from `packages/testkit/src/index.ts` to model
the missing-public-entry regression.

Command:

```text
npm run test:unit --workspace @tegojs/testkit
```

Result: **expected failure, exit 1**. TypeScript reported:

- TS2305 for `coordinationConformance`
- TS2305 for `executorConformance`
- TS2305 for `stateStoreConformance`
- TS2305/TS2724 for their public factory and fixture types

This demonstrated that the new test fails specifically when any of the previously
uncovered suites cannot be consumed through `@tegojs/testkit`. The existing re-exports
were then restored; no new production export was needed.

## GREEN and verification evidence

```text
npm run test:unit --workspace @tegojs/testkit
```

Result: **PASS, exit 0** — 14 tests passed, 0 failed. This includes the new
`all six conformance suites are consumable from the public package entry` test plus the
existing manifest, lifecycle, and Worker behavioral conformance fixtures.

```text
npm run typecheck --workspace @tegojs/testkit
```

Result: **PASS, exit 0**.

```text
npm run build --workspace @tegojs/testkit
```

Result: **PASS, exit 0**.

```text
git diff --check
```

Result: **PASS, exit 0**.

## OpenSpec disposition

- **10.3 checked:** all six suite implementations and their public exports were
  audited, and the testkit build confirms their public factory contracts.
- **10.4 checked:** the self-test now consumes all six suite APIs and contract types
  exclusively through the `@tegojs/testkit` package entry.
- **1.3 left unchecked:** direct evidence does not support completion.

## Task 1.3 concern

The shared package currently provides `FakeClock` and `eventually`, but the audit found
no shared testkit APIs for:

- temporary workspace lifecycle/cleanup;
- real child-process orchestration;
- per-process stdout/stderr log capture;
- process/resource leak detection.

Equivalent logic remains duplicated or package-private in tests such as CLI runtime
process tests, SQLite restart tests, prepared-artifact-cache tests, and executor
process tests. Closing 1.3 requires a separate scoped harness extraction with
regression coverage; expanding this Task 9 closure to invent those APIs would violate
the bounded scope.

## Commits

- `2e9084625056822615a37e41fbf10eb4d89479b4` —
  `test: cover all public conformance suites`

