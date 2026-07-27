# Phase 1 Task 13 Fault Review Fix Report

## Disposition

Both Important review findings are resolved in the Task 13 fault-injection test
and release checklist.

OpenSpec task 12.4 remains unchecked for now. Its executable four-scenario
implementation is green, but Task 13's final gate also requires completed review
documentation and authoritative GitHub Actions evidence. The final
documentation/evidence task will re-check 12.4 after those artifacts exist.

## Corrections

### Permission-before-import marker read

The marker count now maps only `ENOENT` to zero. Every other filesystem error is
re-thrown so an unreadable marker cannot be mistaken for proof that the plugin
was not imported.

The existing permission-before-import scenario includes a regression that
injects `EACCES` and asserts that the exact error escapes.

### Runtime teardown and evidence retention

The permission fault test no longer suppresses `runtime.stop()` failures.
Teardown completion is asserted before the temporary evidence tree is deleted.
If the test body and runtime teardown both fail, the cleanup path throws an
`AggregateError` containing the primary failure followed by the teardown
failure. If teardown fails, evidence deletion does not run, preserving the tree
for diagnosis.

The existing scenario includes a regression that injects both a primary failure
and a stop failure, asserts both errors and their order, and proves that the
remove operation was not called.

## TDD evidence

| Phase | Command | Result |
| --- | --- | --- |
| RED | `node --test --test-name-pattern="permission-before-import-fault" tests/integration/runtime-fault-injection.test.mjs` | Exit 1: `ReferenceError: readMarkerLoadCount is not defined`; 0 passed, 1 failed. |
| GREEN | `node --test --test-name-pattern="permission-before-import-fault" tests/integration/runtime-fault-injection.test.mjs` | Exit 0: 1 passed, 0 failed. |

## Final verification

The requested verification gate completed with exit 0:

```text
node --test tests/integration/runtime-fault-injection.test.mjs
# 4 passed, 0 failed

node --check tests/integration/runtime-fault-injection.test.mjs
# exit 0

npx biome check \
  tests/integration/runtime-fault-injection.test.mjs \
  openspec/changes/runtime-kernel-phase-1/tasks.md \
  .superpowers/sdd/phase1-task-13-fault-fix-report.md
# Checked 1 file in 67ms. No fixes applied.
# (Markdown files are outside the repository's Biome inputs.)

git diff --check
# exit 0

npm run openspec:validate
# [verify:release] strict OpenSpec validation
# Change 'runtime-kernel-phase-1' is valid
```
