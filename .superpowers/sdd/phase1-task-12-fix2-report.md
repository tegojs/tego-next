# Phase 1 Task 12 Fix 2 Report

## Outcome

The two remaining Important release-closure findings are fixed.

- CI-reported integration and system-E2E commands now have explicit internal
  deadlines below their GitHub Actions step deadlines.
- A reporter timeout terminates the child process tree, escalates from
  `SIGTERM` to forced termination, preserves the incremental process log, and
  writes final structured JSON with timeout, command, timestamp, duration,
  child exit, and signal details before returning exit code 124.
- Workflow validation ignores comment-only lines and validates exact commands,
  conditions, timeouts, actions, and ordering inside the owning named step.

Implementation commit:
`6e0e0b1ee4da87bcc7f9f50ca82c8e223f1ebee0`
(`fix(ci): enforce reporter timeout contracts`).

## Finding 1: Reporter Timeout and Final Evidence

`scripts/run-ci-test.mjs` accepts `--timeout-ms`. On POSIX it starts the child
in its own process group and signals the group; on Windows it uses normal
termination followed by `taskkill /T /F` for forced tree cleanup. The timeout
artifact includes:

- `timedOut`, `timeoutMs`, and nonzero `exitCode`
- `childExitCode`, `childSignal`, and `terminationSignal`
- `startedAt`, `finishedAt`, and `durationMs`
- requested and actual command/argument metadata plus `childPid`

The workflow uses 540,000 ms inside the 10-minute integration step and 420,000
ms inside each 8-minute system-E2E step.

The focused regression starts a child that installs a `SIGTERM` handler and
never exits naturally. It asserts bounded wrapper completion, a nonzero status,
final JSON and log artifacts, timeout/exit/signal metadata, and that the child
PID no longer exists.

## Finding 2: Active Workflow Contract

`scripts/verify-release.mjs` removes comment-only lines before extracting jobs.
It parses active step blocks and requires exact fields in the named integration,
single-Main, multi-Main, and upload steps. Ordering checks operate on exact
active lines.

Mutation coverage proves validation rejects:

- commented OpenSpec validation
- commented single-Main reporter command
- commented multi-Main reporter command
- commented upload `if: always()` condition
- misplaced OpenSpec, stale single-Main, and `if: success()` upload mutations

## TDD Evidence

### RED

```text
node --test --test-name-pattern="comments|times out" tests/architecture/system-ci.test.mjs
```

Exit 1: 2 tests, 0 passed, 2 failed. The comment mutation was accepted by the
old substring validator, and the reporter exceeded its 5,000 ms outer bound
because it had no internal timeout.

### GREEN

```text
node --test --test-name-pattern="comments|times out" tests/architecture/system-ci.test.mjs
```

Exit 0: 2 tests, 2 passed, 0 failed. The timeout regression completed in
504.876 ms.

## Final Verification

```text
node --check scripts/run-ci-test.mjs
node --check scripts/verify-release.mjs
```

Both syntax checks exited 0.

```text
node --test tests/architecture/system-ci.test.mjs tests/architecture/project-ci.test.mjs
```

Exit 0: 11 tests, 11 passed, 0 failed. The final timeout regression completed
in 503.297 ms; the complete focused suite completed in 1,173.524 ms.

```text
npm exec -- biome check scripts/run-ci-test.mjs scripts/verify-release.mjs tests/architecture/system-ci.test.mjs
```

Exit 0: 3 files checked, no fixes applied.

```text
git diff --check
```

Exit 0 with no whitespace errors.

## Scope

No dependencies or README semantics changed. Existing unrelated untracked
review-package files were left untouched.
