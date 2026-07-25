# Integration Completion Task 6 Report

## Status

`DONE_WITH_CONCERNS`

Task 6 and all nine review hardening items are implemented and locally
verified. PostgreSQL integration now passes against the review-provided local
database. The only remaining validation concern is platform coverage: the
Windows-runnable named-pipe access/cleanup contract is included, but this macOS
host cannot execute that conditional test.

## Commit Range

- Base: `a59c1dd` (`fix: release rejected task registrations`)
- Control RED: `e108649` (`test: specify local control protocol`)
- CLI RED: `1c2f327` (`test: specify runtime cli commands`)
- GREEN implementation: `f9fa022` (`feat: add local runtime control cli`)
- Report: the commit containing this file

## Delivered Scope

- Added the versioned local control protocol and public request/response types.
- Added real `node:net` Unix-socket/Windows-named-pipe server and client.
- Enforced one NDJSON request per connection, a 1 MiB line limit, a bounded
  global outstanding-request count, client deadlines, request-ID preservation,
  structured diagnostics, and deterministic client/socket cleanup.
- Applied owner-only `0600` permissions to Unix sockets.
- Kept local host paths at CLI-only ingress: `plugin.install-path` resolves and
  streams the artifact through `LocalArtifactIngress`, then calls the path-free
  kernel `installPlugin({ digest })` operation.
- Added `node:util.parseArgs` runtime command parsing without a command
  framework.
- Added foreground runtime start, detached Main startup through
  `main-process.js`, event-driven IPC readiness, status, graceful stop, and
  idempotent already-stopped behavior.
- Added the Node composition root with local/PostgreSQL driver selection,
  executor-node, runtime services, and transport-websocket dependency boundary.
- Added the `tego` executable export and public CLI/control/runtime exports.
- Updated CLI project references, workspace dependencies, and `package-lock.json`.
- Did not start Task 7 plugin/task command work.

## TDD Evidence

### Control RED

Command:

```text
volta run --node 26.5.0 npm run test:unit --workspace @tegojs/cli
```

Observed before implementation:

```text
TS2307 Cannot find module '../src/control/protocol.js'
TS2307 Cannot find module '../src/control/client.js'
TS2307 Cannot find module '../src/control/server.js'
```

Committed as `e108649`.

### CLI RED

The same command was rerun after adding CLI tests and failed only on the
intentionally absent control/parser/runner modules:

```text
TS2307 Cannot find module '../src/control/protocol.js'
TS2307 Cannot find module '../src/control/client.js'
TS2307 Cannot find module '../src/control/server.js'
TS2307 Cannot find module '../src/parse-command.js'
TS2307 Cannot find module '../src/run-cli.js'
```

Committed as `1c2f327`.

### Idempotent-stop RED/GREEN

A focused test was tightened to perform a second stop after endpoint removal.
It first failed `1 !== 0`, then passed after the CLI classified `ENOENT` and
`ECONNREFUSED` as an already-stopped success.

## Final Verification

All final commands used Node `26.5.0` through Volta and npm `11.13.0`.
The repository pins TypeScript `7.0.2`.

### Focused CLI

```text
volta run --node 26.5.0 npm run test:unit --workspace @tegojs/cli
48 tests, 48 passed, 0 failed

volta run --node 26.5.0 npm run typecheck --workspace @tegojs/cli
exit 0
```

### Repository gates

```text
volta run --node 26.5.0 npm run build
exit 0

volta run --node 26.5.0 npm run typecheck
exit 0

volta run --node 26.5.0 npm test
589 tests, 589 passed, 0 failed
```

The 589 tests comprise:

- CLI: 48/48
- executor-node: 136/136
- plugin-sdk: 7/7
- runtime: 244/244
- testkit: 3/3
- transport-websocket: 116/116
- architecture/tooling: 35/35

The architecture suite passed the CLI-to-first-layer dependencies while still
rejecting forbidden runtime-to-concrete edges.

### Executable and real-process smoke

```text
volta run --node 26.5.0 node packages/cli/dist/src/bin.js --help
exit 0; runtime start/status/stop usage printed
```

A real detached Main was then exercised only through the built executable and
its local socket:

- detached start returned lifecycle `running`, readiness `true`, and authority
  epoch `1`;
- Unix socket mode was `600`;
- socket-backed status returned lifecycle `running`;
- first stop returned `{"stopped":true}`;
- second stop returned `{"alreadyStopped":true,"stopped":true}`;
- the control socket was removed;
- the temporary runtime directory was removed after verification.

### Integration

```text
node --test tests/integration/*.test.mjs
52 tests, 52 passed, 0 failed
```

The full `npm run test:integration` continued into the PostgreSQL workspace and
reported 54 failures caused by `connect ECONNREFUSED 127.0.0.1:55432`; 2
database-independent PostgreSQL package tests passed. Docker and local
PostgreSQL server binaries were unavailable, so this external-service gate
could not be recovered locally. GitHub Actions remains authoritative per the
plan.

## Cleanup

- No spawned smoke-test Main process or socket remained after graceful stop.
- Temporary runtime directories and generated example build output were
  removed.
- No debug logging or temporary source files remain.

## Review Hardening Addendum

This addendum supersedes the original PostgreSQL concern and records the
REQUEST CHANGES remediation based on review commit `26c83d1`.

### Commits

- Review base: `26c83d1` (`docs: record integration task 6 evidence`)
- Control hardening RED: `a0548ee`
  (`test: expose control channel hardening gaps`)
- Runtime cleanup RED: `a8a2e77`
  (`test: expose runtime process cleanup gaps`)
- GREEN implementation: `b34058a`
  (`fix: harden local control and runtime cleanup`)
- Report addendum: the commit containing this update

### Review RED

Control-channel tests were committed before production changes and run with:

```text
volta run --node 26.5.0 npm run test:unit --workspace @tegojs/cli
54 tests: 48 passed, 6 failed
```

The six expected failures demonstrated:

- accepted incomplete connections did not reserve capacity or expire;
- fragmented reads repeatedly copied accumulated bytes (`67,527` copied);
- an unsupported operation lost its valid request ID;
- control diagnostics exposed secrets, an absolute path, and a stack;
- a Unix socket could bind beneath an owner-public parent directory;
- permission initialization failure did not roll back the listener.

Runtime/process tests were then committed separately and run against the same
unfixed implementation:

```text
volta run --node 26.5.0 npm run test:unit --workspace @tegojs/cli
60 tests: 48 passed, 11 failed, 1 skipped
```

The five additional expected failures demonstrated:

- CLI diagnostics exposed raw host error content;
- Windows default pipe identities collided and lacked the required full scope;
- a runtime stop failure skipped or failed to aggregate server cleanup;
- foreground SIGTERM exited by signal and left the endpoint behind;
- detached timeout returned before a TERM-resistant child had exited.

The skipped test is the conditional native Windows named-pipe access/cleanup
contract.

### GREEN Behavior

The implementation now:

- reserves control capacity on accept, enforces an explicit read deadline, and
  uses one bounded preallocated buffer per connection;
- extracts a valid request ID before operation validation;
- sanitizes nested control results, responses, server failures, client connect
  failures, CLI errors, and Main IPC failures through stable diagnostics;
- verifies a private, owner-controlled Unix parent before bind and performs
  type/owner/device/inode checks for stale endpoint cleanup;
- rolls back listener, accepted sockets, and endpoint state when permission
  setup fails, while retaining later server errors for close;
- attempts both runtime and control-server shutdown and aggregates failures;
- scopes foreground signal handlers around an abort-driven awaited cleanup;
- confirms detached child exit with bounded SIGTERM-to-SIGKILL escalation
  before cleanup/return and only unreferences successful live children;
- derives Windows pipe names from SHA-256 over the complete normalized data
  directory plus stable user and runtime scopes.

Focused GREEN command:

```text
volta run --node 26.5.0 npm run test:unit --workspace @tegojs/cli
60 tests: 59 passed, 0 failed, 1 Windows-only skipped

volta run --node 26.5.0 npm run typecheck --workspace @tegojs/cli
exit 0
```

### Final Review Verification

```text
volta run --node 26.5.0 npm run build
exit 0

volta run --node 26.5.0 npm run typecheck
exit 0

volta run --node 26.5.0 npm test
601 tests: 601 passed, 0 failed, 1 Windows-only skipped

volta run --node 26.5.0 npm run format:check
189 files checked, 0 errors

volta run --node 26.5.0 npm run lint
189 files checked, 0 errors

volta run --node 26.5.0 npm run commitlint:ci
0 problems, 0 warnings

git diff --check
exit 0
```

PostgreSQL integration used the review-provided database:

```text
TEGO_POSTGRES_URL=postgresql://tego_test:tego_test@127.0.0.1:5432/tego_next_test \
  volta run --node 26.5.0 npm run test:integration
108 tests: 108 passed, 0 failed
```

The 108 tests comprise 52 repository system/local-driver integration tests and
56 PostgreSQL driver integration tests.

### Real Process Evidence

The CLI test suite includes two real child-process regressions:

- foreground SIGTERM exits normally after awaited cleanup and leaves no control
  endpoint;
- detached readiness timeout escalates from SIGTERM to SIGKILL for a resistant
  fixture, proves the PID no longer exists, and leaves no endpoint.

A separate built-executable smoke run verified:

- detached start and status both reported lifecycle `running`, readiness
  `true`, and authority epoch `1`;
- the Unix control endpoint was a socket with mode `600`;
- first stop returned `{"stopped":true}`;
- second stop returned `{"alreadyStopped":true,"stopped":true}`;
- the endpoint was absent after stop.

No smoke process, socket, temporary runtime directory, generated example build
output, or debug code remained after verification.

## Finding 10 Deterministic Detached Cleanup Addendum

The controller reproduced a race in the original detached-timeout regression:
its 50 ms deadline could expire before the fixture installed its SIGTERM
handler and wrote `stubborn.pid`. Finding 10 fixes the proof without increasing
that timeout.

### Commits

- Finding 10 RED: `1535c74` (`test: expose detached readiness race`)
- Provisional gate implementation: `0a5f9c7`
  (`fix: gate detached readiness deadline`)
- Final minimal correction: `69c012e`
  (`test: stabilize detached termination regression`)
- Report addendum: the commit containing this update

The provisional implementation exposed fixture-only gate options on
`DetachedRuntimeStartOptions`. The final correction fully removes that API
expansion; `packages/cli/src/commands/runtime.ts` is byte-identical to
`b34058a` after `69c012e`.

### RED

The test-only RED changed the real resistant fixture to announce readiness only
after installing its SIGTERM handler and writing its PID, then requested a
1 ms post-readiness deadline. The unfixed implementation ignored that
handshake and started its deadline at spawn:

```text
volta run --node 26.5.0 npm run test:unit --workspace @tegojs/cli
60 tests: 58 passed, 1 failed, 1 Windows-only skipped
```

The expected failure was:

```text
ENOENT: no such file or directory, open '.../stubborn.pid'
```

This reproduced the controller's race deterministically rather than hiding it
with a larger readiness timeout.

### Final Test Design

The resistant fixture now:

1. installs its SIGTERM handler;
2. writes `stubborn.pid`;
3. sends the existing `runtime.failed` IPC message.

The real child-process regression therefore enters the existing
`catch -> terminateDetachedChild` path only after resistance and PID publication
are established. It proves SIGTERM does not end the child, bounded SIGKILL does,
`process.kill(pid, 0)` returns `ESRCH`, and the endpoint is absent.

A separate silent-child regression retains the 1 ms bounded readiness-timeout
assertion without depending on PID publication. No fixture-specific protocol
or option was added to production code.

### GREEN and Stress Evidence

```text
for tego_stress_run in {1..20}; do
  volta run --node 26.5.0 node --test \
    --test-name-pattern='detached-(failure|readiness)' \
    packages/cli/dist/test/runtime-process.test.js
done
20/20 repetitions passed

volta run --node 26.5.0 npm run test:unit --workspace @tegojs/cli
61 tests: 60 passed, 0 failed, 1 Windows-only skipped

volta run --node 26.5.0 npm run typecheck --workspace @tegojs/cli
exit 0
```

Targeted Biome checks passed for all four touched CLI source/test files, and
`git diff --check` passed.

## Findings 11–12 Capacity and Startup Abort Addendum

Final review identified two additional Task 6 lifecycle gaps: socket close
released global capacity before an asynchronous dispatch settled, and Main
startup did not observe abort while `runtime.start()` was pending.

### Commits

- Finding 11 RED: `5879d87`
  (`test: expose control dispatch capacity gap`)
- Finding 12 RED: `4cdc7af`
  (`test: expose pending startup abort gap`)
- GREEN: `b532869`
  (`fix: retain control capacity through dispatch`)
- Report addendum: the commit containing this update

### Finding 11 RED

The regression starts one pending operation with
`maxOutstandingRequests: 1`, disconnects its client, then opens another
connection. Against the unfixed server, the second operation was dispatched
instead of receiving the capacity diagnostic:

```text
volta run --node 26.5.0 npm run build --workspace @tegojs/cli
volta run --node 26.5.0 node --test \
  --test-name-pattern='disconnected-dispatch-retains-capacity' \
  packages/cli/dist/test/control.test.js
1 test: 0 passed, 1 failed
AssertionError: a disconnected pending dispatch released capacity
```

The GREEN server gives each reservation an explicit owner. Socket close
releases only a pre-dispatch reservation; accepting a complete frame transfers
ownership to dispatch, whose `finally` releases it. The regression also
resolves the operation, reserves capacity with another incomplete connection,
proves a concurrent request is still rejected, closes that connection, and
proves the next request succeeds. This catches both leaks and double-release
underflow.

### Finding 12 RED

The controlled regression holds `runtime.start()` pending, aborts after its
explicit start callback, and requires `runtime.stop()` to begin before startup
settles. It also holds stop pending to prove `runMainProcess` awaits it and
checks that the control-server factory is never called.

The real fixture installs signal handlers before writing `startup.entered`.
The test watches that explicit phase file, sends SIGTERM, and requires a normal
exit, an awaited `runtime.stopped` marker, and no control endpoint.

Against the unfixed Main process:

```text
volta run --node 26.5.0 npm run build --workspace @tegojs/cli
volta run --node 26.5.0 node --test \
  --test-name-pattern='pending-start-abort|pre-readiness-sigterm' \
  packages/cli/dist/test/runtime-process.test.js
2 tests: 0 passed, 2 failed
controlled failure: stop was not called before startup settled
real-process failure: PROCESS_EXIT_TIMEOUT
```

The GREEN Main startup races the start promise against the supplied abort
signal. An abort before readiness skips control-server creation and enters the
existing `finally`, which initiates and awaits runtime stop. A late-settling
startup promise no longer prevents process settlement.

### GREEN and Stress Evidence

```text
for tego_stress_run in {1..20}; do
  volta run --node 26.5.0 node --test \
    --test-name-pattern='disconnected-dispatch-retains-capacity' \
    packages/cli/dist/test/control.test.js
  volta run --node 26.5.0 node --test \
    --test-name-pattern='pending-start-abort|pre-readiness-sigterm' \
    packages/cli/dist/test/runtime-process.test.js
done
20/20 repetitions passed

volta run --node 26.5.0 npm run test:unit --workspace @tegojs/cli
64 tests: 63 passed, 0 failed, 1 Windows-only skipped

volta run --node 26.5.0 npm run typecheck --workspace @tegojs/cli
exit 0
```

Targeted Biome checks passed for the five affected source/test files.
`git diff --check` also passed, and no real child process, endpoint, or
temporary runtime directory remained.

## Finding 13 Complete Pre-Readiness Cancellation Addendum

Finding 13 extended the startup-abort requirement across every asynchronous
pre-readiness boundary. The earlier fix covered pending `runtime.start()` but
could still wait indefinitely in control-server creation, `runtime.status()`,
or `onReady()`, and a late status could publish readiness after abort.

### Commits

- Pipeline RED: `a9e2280`
  (`test: expose pre-readiness abort gaps`)
- Control initialization RED: `bc288dc`
  (`test: expose control initialization abort gap`)
- GREEN: `72f8a8e`
  (`fix: cancel the full main readiness pipeline`)
- Report addendum: the commit containing this update

### Pipeline RED

Three controlled tests independently held status, readiness publication, and
control-server factory promises pending:

```text
volta run --node 26.5.0 npm run build --workspace @tegojs/cli
volta run --node 26.5.0 node --test \
  --test-name-pattern='pending-status-abort|pending-on-ready-abort|pending-control-factory-abort' \
  packages/cli/dist/test/runtime-process.test.js
3 tests: 0 passed, 3 failed
```

The failures proved:

- abort during pending status did not initiate stop/close before status settled;
- a pending `onReady` callback blocked cleanup and Main settlement;
- a pending control-server factory blocked Main settlement and received no
  abort signal.

The status RED resolved its late status only for deterministic cleanup and
observed the incorrect readiness callback. The onReady RED rejected its
callback after the abort deadline, allowing the unfixed process to settle while
also proving the late rejection was the blocker.

### Control Initialization RED

The server contract test first passed an already-aborted signal, then aborted
while the owner-permission initialization hook was explicitly pending:

```text
volta run --node 26.5.0 npm run build --workspace @tegojs/cli
volta run --node 26.5.0 node --test \
  --test-name-pattern='aborted-control-initialization-rolls-back' \
  packages/cli/dist/test/control.test.js
1 test: 0 passed, 1 failed
```

The unfixed server ignored the pre-aborted signal and returned a live listener.
It also waited for the pending permission hook instead of settling the aborted
initialization transaction.

### GREEN Behavior

- `ControlServerOptions` now accepts an `AbortSignal`.
- Pre-aborted initialization performs no bind.
- Listen and permission initialization observe abort as one transaction; abort
  rejects only after listener/socket rollback, while late hook rejection remains
  observed.
- Main passes the signal into the control-server factory.
- Start, factory creation, status, and onReady each use the same pre-readiness
  abort race and check the signal before invoking the next stage.
- Abort suppresses all later readiness publication.
- A non-cooperative status or onReady promise no longer delays stop, server
  close, or Main settlement; its late rejection is consumed.
- A non-cooperative factory cannot block Main settlement. If it later returns a
  server, that late server is immediately closed; late rejection is consumed.
- Runtime stop and server close are initiated together and both results remain
  available for shutdown error aggregation.

The existing real `startup.entered` SIGTERM regression remains unchanged and
continues to prove normal process exit, awaited stop, and endpoint absence.

### GREEN and Stress Evidence

```text
for tego_stress_run in {1..20}; do
  volta run --node 26.5.0 node --test \
    --test-name-pattern='aborted-control-initialization-rolls-back' \
    packages/cli/dist/test/control.test.js
  volta run --node 26.5.0 node --test \
    --test-name-pattern='pending-status-abort|pending-on-ready-abort|pending-control-factory-abort|pre-readiness-sigterm' \
    packages/cli/dist/test/runtime-process.test.js
done
20/20 repetitions passed

volta run --node 26.5.0 npm run test:unit --workspace @tegojs/cli
68 tests: 67 passed, 0 failed, 1 Windows-only skipped

volta run --node 26.5.0 npm run typecheck --workspace @tegojs/cli
exit 0

volta run --node 26.5.0 npm test
609 tests: 608 passed, 0 failed, 1 Windows-only skipped
```

Targeted Biome checks passed for all four affected source/test files.
`git diff --check` passed, and the focused real-process repetitions left no
child process, endpoint, or temporary directory behind.
