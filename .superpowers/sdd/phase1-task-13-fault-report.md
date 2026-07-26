# Phase 1 Task 13 Fault-Injection Evidence

## Scope

OpenSpec task 12.4 is closed by executable integration coverage in
`tests/integration/runtime-fault-injection.test.mjs`. The suite exercises only
public package exports and runtime, driver, executor, and control-plane
boundaries. The only new fixture is a deterministic `RemoteSession` test double
under `tests/fixtures/runtime-fault-session.mjs`; no production runtime API or
dependency changed.

## TDD record

| Phase | Commit | Command | Result |
| --- | --- | --- | --- |
| RED | `ca9da70` | `node --test tests/integration/runtime-fault-injection.test.mjs` | Exit 1. The first assertion failed with `FAULT_TRIGGER_UNIMPLEMENTED:lifecycle-after-effect-before-commit`; 0 passed, 1 failed. |
| GREEN | `fc49e46` | `node --test tests/integration/runtime-fault-injection.test.mjs` | Exit 0. All 4 fault scenarios passed. |

## Executable fault evidence

| Fault | Injection and invariant | Recovery and cleanup |
| --- | --- | --- |
| Lifecycle start after external effect, before durable commit | A public `StateStore` boundary rejects the completed `start` journal transaction after the external effect ran. Recovery delivers the same stable operation identity twice, while the idempotent effect records exactly one effective start and one ready component instance. | The abandoned outbox claim is recovered after advancing `FakeClock` beyond its lease. The recovered reconciler reaches ready state; the test then stops it, clears the test host's live instance, and closes the state store. |
| Stale fencing epoch | `MemoryStateStore` first commits epoch 2, then rejects an epoch 1 transaction with stable diagnostic `STATE_FENCE_STALE`. The authoritative epoch-2 value remains unchanged and the stale transaction creates no record. | The state store is closed, and a subsequent read proves cleanup through `STATE_CLOSED`. |
| Duplicate remote terminal result | A deterministic public `RemoteSession` delivers the identical terminal result twice to `RemoteExecutor`. `MemoryRemoteAttemptStore` observes exactly one terminal commit and retains exactly one authoritative terminal record. Both ACK transmissions use one unique task/attempt identity; retransmission is intentionally preserved so a lost ACK can still be recovered. | The executor and session are closed. Executor health reports non-accepting/unhealthy with zero active work. |
| Invalid permission grant before component import | A plugin whose top level writes a marker is packed and installed through public CLI/runtime operations. An invalid desired deployment is then injected through the public SQLite state-driver boundary before runtime restart. Reconciliation blocks it with `PERMISSION_GRANT_EXCEEDS_REQUEST`; the marker load count remains zero. | The real Node runtime host is stopped and the complete temporary artifact, state, prepared cache, and marker tree is removed. |

## Verification

The following combined affected-package command completed with exit 0:

```text
npm run build \
  --workspace @tegojs/runtime \
  --workspace @tegojs/transport-websocket \
  --workspace @tegojs/executor-node \
  --workspace @tegojs/drivers-local \
  --workspace @tegojs/cli

npm run typecheck \
  --workspace @tegojs/runtime \
  --workspace @tegojs/transport-websocket \
  --workspace @tegojs/executor-node \
  --workspace @tegojs/drivers-local \
  --workspace @tegojs/cli

npm run test:unit \
  --workspace @tegojs/runtime \
  --workspace @tegojs/transport-websocket \
  --workspace @tegojs/executor-node \
  --workspace @tegojs/cli
```

Observed package-test summaries included:

- `@tegojs/transport-websocket`: 153 passed, 0 failed.
- `@tegojs/executor-node`: 165 passed, 0 failed.
- `@tegojs/cli`: 139 passed, 0 failed, 1 platform skip.
- The runtime suite completed in the same exit-0 command before the remaining
  package suites.

Scoped formatting and diff validation:

```text
npx biome check --write \
  tests/integration/runtime-fault-injection.test.mjs \
  tests/fixtures/runtime-fault-session.mjs
# Checked 2 files; fixed 1 file.

git diff --check
# exit 0

npm run openspec:validate
# [verify:release] strict OpenSpec validation
# Change 'runtime-kernel-phase-1' is valid
```

## Concerns and dispositions

- The task brief's sketch used `PERMISSION_GRANT_EXCEEDED`, but the existing
  stable public permission-gate diagnostic is
  `PERMISSION_GRANT_EXCEEDS_REQUEST`. The executable test preserves the existing
  contract rather than introducing a second spelling.
- Public runtime mutation operations reject an invalid permission grant even
  earlier with `DEPLOYMENT_PERMISSION_GRANT_INVALID`. The fault suite injects
  invalid recovered desired state through the public state-driver boundary so
  it specifically proves the reconciler's before-import defense.
- Duplicate terminal delivery produces two identical ACK transmissions by
  design. Suppressing the second transmission would break recovery when the
  first ACK is lost. The authoritative terminal commit and ACK identity remain
  unique.
- PostgreSQL-specific process takeover remains covered by the existing
  multi-Main system test. This suite uses deterministic local public boundaries
  so task 12.4 runs without an external service or fixed sleeps.
