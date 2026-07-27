# Single-Main External SIGKILL Cleanup Fix

## Outcome

`ManagedProcess.assertClean({ timeoutMs })` now waits up to the explicitly requested timeout for
the managed child's authoritative `exit` event. Calling `assertClean()` without a timeout preserves
the existing immediate `PROCESS_STILL_RUNNING` diagnostic for a genuinely live child.

The two external `SIGKILL` cleanup assertions in the single-Main E2E suite opt into this bounded
wait with `processDeadlineMs`.

## Root Cause and Reproduction

`process.kill(pid, "SIGKILL")` reports that the signal was sent; it does not wait for Node's child
process object to emit `exit`. The externally killed child exited cleanly 1–4 ms later, but
`assertClean()` synchronously inspected the still-unsettled exit state and reported a transient
`PROCESS_STILL_RUNNING` leak.

The original investigation reproduced the E2E failure 4/4 times and the minimal race 20/20 times.
The committed regression makes the ordering deterministic by waiting for a ready live child,
sending external `SIGKILL`, and immediately requesting a bounded cleanup assertion.

RED command:

```text
node --test --test-name-pattern="wait boundedly for an externally killed child" tests/integration/process-harness.test.mjs
```

RED result:

```text
tests 1; pass 0; fail 1
Error: PROCESS_STILL_RUNNING:externally-killed-child:<pid>
```

## TDD Commits

- RED `77e3c94698defe4efde53d517e9135b012a9f863` —
  `test(ci): reproduce external kill cleanup race`
- GREEN `819ac68859a1a0f38c6030ffea468335098e4263` —
  `fix(ci): wait boundedly for external process exit`

The GREEN implementation does not inspect PIDs or probe process liveness, avoiding PID-reuse
ambiguity. Spawn failures remain checked before the optional exit wait, and cleanup, non-zero exit,
stream, and event-processing diagnostics retain their existing authoritative checks.

An explicit timeout that expires still rejects with `PROCESS_STILL_RUNNING`; the process harness
locks this contract alongside the immediate no-timeout behavior.

## Verification

Fresh verification after the GREEN change:

- `node --test tests/integration/process-harness.test.mjs`
  - PASS: 15/15 tests.
- `npm run test:e2e:single-main`
  - PASS run 1: 1/1, single-Main flow 34,039.784 ms.
- `npm run test:e2e:single-main`
  - PASS run 2: 1/1, single-Main flow 34,370.059 ms.
- `node --check tests/support/managed-process.mjs && node --check tests/integration/process-harness.test.mjs && node --check tests/e2e/single-main-process.test.mjs`
  - PASS.
- `npx --no-install biome check tests/support/managed-process.mjs tests/integration/process-harness.test.mjs tests/e2e/single-main-process.test.mjs`
  - PASS: checked 3 files, no fixes applied.
- `git diff --check`
  - PASS.

The PostgreSQL multi-Main test was intentionally left to the final release-closure orchestrator as
requested.
