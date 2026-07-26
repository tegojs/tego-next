# Phase 1 Task 1 Shared Harness Fix Report

Status: **DONE**

OpenSpec task 1.3 remains checked. The review findings were genuine gaps in the
already-delivered shared harness, and the focused regressions and fixes below
close them without changing the task's scope or adding dependencies.

## Commits

- `b2824a2` — `test: expose shared harness cleanup gaps`
- `940a074` — `fix: harden shared process and workspace harnesses`
- `4f6b164` — `test: bound managed process regressions`
- Report: the commit containing this file

## Finding Remediation

### 1. Bounded, authoritative managed-process cleanliness

Regressions:

- `managed process reports spawn failure without waiting for exit`
- `managed process reports a live child without waiting for exit`

The assertions themselves have a 200 ms regression deadline, so reintroducing
an unresolved exit wait fails rather than hanging the suite. Replaying the
focused tests against the old `managed-process.mjs` produced:

```text
spawn failure: ASSERT_CLEAN_TIMEOUT
live child: ASSERT_CLEAN_TIMEOUT
3 focused tests, 0 passed, 3 failed
```

Fix:

- model `spawned`, `spawn-error`, live, and exited states explicitly;
- report `PROCESS_SPAWN_ERROR` for a failed spawn;
- report `PROCESS_STILL_RUNNING` for a successfully spawned child with no exit;
- bound spawn-state and stream-finalization checks;
- use the child `exit` event as authoritative and remove PID probing, avoiding
  false leak reports after PID reuse.

### 2. Phased stop escalation

Regression:

- `managed process gives stdin EOF a bounded graceful stop phase`

Against the old implementation it failed because the cleanup actions were:

```text
["stdin:end", "signal:SIGTERM"]
```

Fix:

`stop({ timeoutMs })` now gives each phase a bounded wait in this order:

1. end stdin and wait for graceful exit;
2. send `SIGTERM` and wait;
3. send `SIGKILL` and wait, then report `PROCESS_STOP_TIMEOUT` if necessary.

The EOF fixture exits during phase one. Its cleanup artifact contains only
`["stdin:end"]`, proving no signal was requested.

### 3. Workspace path confinement

Regressions:

- traversal through `..`;
- an absolute path;
- traversal through an in-workspace directory symlink to another workspace.

The pre-fix temp-workspace run failed both escape assertions and the symlink
assertion.

Fix:

`workspace.path()` resolves lexically beneath the workspace root, rejects
absolute or escaping inputs, and walks every existing path component with
`lstatSync` to reject symbolic-link traversal.

### 4. Exact removal assertion

Regressions:

- a regular file left at the workspace path;
- a directory symlink left at the workspace path;
- a dangling symlink left at the workspace path.

The pre-fix run missed the regular file and surfaced `ELOOP` rather than the
workspace leak diagnostic for the dangling link.

Fix:

`assertRemoved()` now uses `lstat`. Only `ENOENT` means absent; any existing
filesystem entry reports `TEMP_WORKSPACE_LEAK`, and other filesystem errors are
propagated.

### 5. Dependency-aware cleanup ordering

Regression:

- `registered cleanup stops a child before removing its workspace`

The fixture intentionally fails readiness while the child still owns the
workspace. On stdin EOF the child synchronously writes into that workspace
before exiting. If workspace removal runs first, the child exits non-zero and
managed-process cleanup fails.

Fix:

`registerTestCleanup()` installs one test-context cleanup coordinator and runs
registered cleanup functions in LIFO order while aggregating errors. A
workspace registers disposal first and its dependent child registers teardown
later, so the child is always stopped and checked before the workspace is
removed. The initial RED commit failed at module load because this explicit
shared cleanup mechanism did not exist.

## RED Evidence

Initial commands:

```text
node --test tests/integration/process-harness.test.mjs
exit 1: temp-workspace.mjs did not export registerTestCleanup

node --test tests/integration/temp-workspace.test.mjs
7 tests: 3 passed, 4 failed
```

The temp-workspace failures were the missing traversal rejection, missing
symlink rejection, missed residual regular file, and incorrect dangling-link
diagnostic.

After backporting only the cleanup registry into a disposable worktree and
replaying the current process regressions against the old managed-process
implementation:

```text
node --test --test-name-pattern="spawn failure|live child|stdin EOF" \
  tests/integration/process-harness.test.mjs
3 tests: 0 passed, 3 failed
```

The failures were two bounded `ASSERT_CLEAN_TIMEOUT` diagnostics and the
unwanted immediate `SIGTERM` action.

## Final Verification

Run with Node.js `26.5.0`:

```text
node --test tests/integration/process-harness.test.mjs \
  tests/integration/temp-workspace.test.mjs
21 tests, 21 passed, 0 failed

node --check tests/support/managed-process.mjs
node --check tests/support/temp-workspace.mjs
node --check tests/integration/process-harness.test.mjs
node --check tests/integration/temp-workspace.test.mjs
all exit 0

npx biome check tests/support/managed-process.mjs \
  tests/support/temp-workspace.mjs \
  tests/integration/process-harness.test.mjs \
  tests/integration/temp-workspace.test.mjs
4 files checked, no fixes required

git diff --check
exit 0
```

No production dependency, fixed polling sleep, debug output, or temporary test
fixture remains.
