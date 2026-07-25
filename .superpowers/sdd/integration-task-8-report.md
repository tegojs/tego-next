# Integration Task 8 Report

## Outcome

Task 8 delivers a real WebSocket transport and an independently runnable
Worker process for both supported connection directions:

- Main connects to a Worker listener.
- Worker connects to a Main listener.

The Worker prepares immutable `.tego` artifacts before advertising readiness,
publishes its prepared artifact inventory and local executor capabilities, and
executes admitted assignments through the existing thread or process executor.
Worker attempt state is persisted in the local state store with revision and
epoch compare-and-swap checks.

## SDD/TDD evidence

The behavior was introduced test-first in these RED commits:

- `5f0c86f test: specify real websocket adapters`
- `01eb571 test: specify network worker recovery`
- `ec0f6ce test: specify websocket listener failures`
- `134d3c7 test: bound pre-consumer session messages`
- `c29a25e test: specify usable worker composition`

The transport implementation was added in:

- `0d3c65f feat: add real websocket adapters`

The final Worker composition tests cover:

- parsing mutually exclusive `--connect` and `--listen` modes;
- exactly one structured readiness event;
- durable SQLite attempt recovery and compare-and-swap conflict handling;
- rejection before acknowledgement when no unique prepared artifact is
  available;
- real listener-direction handshake, inventory advertisement, assignment, and
  thread execution;
- real connector-direction attachment before readiness;
- bounded Worker identity and complete shutdown cleanup.

## Verification

Run with Node.js 26.5.0:

```text
npm run test:unit --workspace @tegojs/cli
108 passed, 1 platform-specific skipped, 0 failed

npm run test:unit --workspace @tegojs/cli
108 passed, 1 platform-specific skipped, 0 failed

npm run test:unit --workspace @tegojs/transport-websocket
126 passed, 0 failed

npm run typecheck --workspace @tegojs/cli
passed

npm run typecheck --workspace @tegojs/transport-websocket
passed

npm run format:check
passed

npm run lint
passed

npm run build
passed
```

## Phase-one boundary

Artifact admission intentionally requires exactly one prepared digest for a
plugin ID. Version resolution, rollout selection, artifact distribution, and
Main-process remote-executor composition remain later-phase responsibilities.
The Worker grants only the selected local executor kind to an admitted
component; manifest-declared secrets and other resources are not implicitly
granted.
