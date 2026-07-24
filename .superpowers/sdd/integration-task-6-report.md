# Integration Completion Task 6 Report

## Status

`DONE_WITH_CONCERNS`

Task 6 is implemented and locally verified. The only validation concern is that
the configured PostgreSQL integration service at `127.0.0.1:55432` was not
available in this environment, so PostgreSQL-dependent integration tests could
not run successfully. The non-PostgreSQL integration suite passed.

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
