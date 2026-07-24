# Runtime Kernel Phase 1 Integration Completion Design

## Status

Approved on 2026-07-24.

This document narrows the remaining work in `runtime-kernel-phase-1`. The canonical behavioral requirements remain the OpenSpec change under `openspec/changes/runtime-kernel-phase-1/`.

## Objective

Complete Tego Next layer one as a runnable kernel rather than a collection of independently tested packages.

Completion requires a real vertical path:

```text
CLI/local control
→ runtime host
→ artifact installation and deployment intent
→ reconciliation
→ executor selection
→ thread, process, or remote execution
→ durable task result and diagnostics
```

GitHub Actions is the authoritative acceptance environment. Local commands remain available for fast feedback, but contributors do not need to reproduce the entire multi-process topology locally.

## Scope

This change completes:

- runtime composition and lifecycle ownership;
- the local control protocol and required CLI operations;
- plugin installation, deployment, reconciliation, and task dispatch;
- thread, process, and remote executor parity;
- real WebSocket Main/Worker connectivity;
- single-Main restart recovery;
- multi-Main PostgreSQL leadership, fencing, and takeover;
- process-level integration and end-to-end test infrastructure;
- GitHub Actions acceptance gates and diagnostic artifacts.

It does not add HTTP APIs, authentication policy, business ACLs, data sources, cache, scheduler, workflow, frontend loading, Docker or Kubernetes executors, external coordinators, or Tego 1.x compatibility.

## Chosen Integration Topology

The authoritative system test runs on an Ubuntu GitHub-hosted runner:

- Main and Worker run as independent Node.js processes;
- PostgreSQL 16 runs as a GitHub Actions service container;
- Main and Worker communicate through real TCP/WebSocket sockets;
- the CLI communicates through the phase-one local control endpoint;
- every long-running process writes separate stdout and stderr logs;
- the test orchestrator owns startup, readiness, fault injection, cleanup, and evidence collection.

The PostgreSQL service exposes a dynamically assigned host port to avoid collisions. Tests receive connection details through environment variables and never assume a fixed local port.

Docker Compose and Kubernetes were rejected for this phase because they would add packaging and orchestration work outside the layer-one executor contract. The black-box scenarios may later be reused against those deployment forms.

## Runtime Composition

A runtime host composes existing packages without moving concrete implementations into `@tegojs/runtime`.

The host owns:

- `TegoRuntime` bootstrap and driver lifecycle;
- `ArtifactService`;
- the executor registry and selection service;
- `Reconciler`;
- Main-side Worker registry and WebSocket endpoint;
- task submission, observation, cancellation, and durable result recording;
- the local control server;
- shutdown ordering and resource cleanup.

`@tegojs/runtime` continues to depend only on contracts and injected boundaries. Concrete local or PostgreSQL drivers, Node executors, and WebSocket adapters are selected by the executable composition layer.

Startup does not report recovery complete until drivers are healthy, durable state has been reconstructed, leadership state is known, the reconciler has performed its initial pass when this Main is authoritative, and the local control endpoint is ready.

Followers open diagnostics and control-plane inspection but do not reconcile, assign tasks, or commit leader-owned transitions.

## Local Control and CLI

The first layer does not introduce HTTP. The local control channel uses:

- a Unix domain socket on Unix;
- a named pipe on Windows;
- newline-delimited JSON request and response envelopes;
- request identity, protocol version, operation name, typed input, typed result, and structured diagnostics.

The executable CLI provides:

```text
tego runtime start|status|stop
tego plugin validate|pack|inspect|install|deploy|status
tego task run|status|wait|cancel
tego worker start
```

Every command supports structured JSON output. Human-readable output renders the same result and does not define a second behavior contract.

`runtime start` runs in the foreground by default. Detached startup waits for the local control endpoint to report recovery complete. Stop is graceful and idempotent.

## Real WebSocket Boundary

In-memory session pairs remain appropriate for protocol unit tests. They do not satisfy integration or end-to-end acceptance.

The real transport adapter must:

- listen on an operating-system assigned TCP port;
- authenticate before registration or task messages;
- adapt the public session protocol to a real WebSocket implementation;
- support Worker-initiated and Main-initiated connections;
- expose bounded readiness and shutdown behavior;
- propagate close codes and structured diagnostics;
- leave no open sockets or timers after shutdown.

The Worker is an independent Node.js process. Task input, acknowledgement, cancellation, result delivery, heartbeat, and reconnect reconciliation cross only public runtime and transport boundaries.

## Test Architecture

### Unit and conformance tests

These remain deterministic and fast. They cover schemas, state machines, selection, reconciliation plans, driver contracts, executor contracts, and protocol behavior.

### Integration tests

Integration tests use real implementation boundaries:

- SQLite files and process restart;
- real Worker Threads;
- real child processes and IPC;
- real TCP/WebSocket sockets;
- PostgreSQL 16 state, coordination, artifacts, and fault behavior.

They may use focused fixtures, but they may not replace the exercised boundary with direct method calls.

### Single-Main system test

The test:

1. starts Main with durable local drivers;
2. starts an independent remote Worker;
3. uses the CLI to pack, install, and deploy the echo plugin;
4. runs the same component through thread, process, and remote executors;
5. verifies one durable terminal result per attempt;
6. restarts Main using the same state directory;
7. verifies installations, deployments, instances, operations, and task results are recovered;
8. shuts down all processes and proves no resource leak remains.

### Multi-Main system test

The test:

1. starts two Main processes against one PostgreSQL database;
2. observes exactly one fenced leader;
3. starts an independent Worker and executes an echo task;
4. terminates the leader during the active topology;
5. observes follower takeover with a greater fencing epoch;
6. proves stale-leader writes are rejected;
7. reconnects the Worker to the authoritative Main;
8. observes exactly one authoritative terminal task result;
9. shuts down and verifies process, socket, and database cleanup.

### Timing rule

Fixed sleeps are prohibited. Tests wait for explicit protocol events, health transitions, control responses, port readiness, or durable state predicates under bounded deadlines.

## GitHub Actions Gates

The workflow contains three independent jobs.

### Quality

- clean dependency install;
- commit-message validation;
- formatting;
- lint;
- workspace build;
- type checking;
- unit and architecture tests.

### Integration

- SQLite and local runtime integration;
- thread and process executor integration;
- real WebSocket transport integration;
- PostgreSQL conformance and fault tests.

### System E2E

- build packages and the CLI;
- start PostgreSQL 16 with a health check;
- execute the single-Main system scenario;
- execute the multi-Main takeover scenario;
- run process and handle leak checks;
- upload logs and structured results on success or failure.

The workflow installs the exact version recorded in `.node-version`; it does not rely on the runner image. Jobs and long-running steps have explicit timeouts. Service readiness is distinct from process creation.

## Diagnostics and Cleanup

The test orchestrator creates one temporary run directory containing:

- process IDs and resolved ports;
- Main and Worker stdout/stderr;
- structured runtime events and diagnostics;
- CLI request and result transcripts;
- test-runner output;
- the final cleanup report.

Cleanup runs after both success and failure. It first requests graceful shutdown, then applies a bounded termination escalation. A leaked process, open handle, occupied endpoint, unhandled rejection, or missing terminal cleanup event fails acceptance.

GitHub Actions uploads the run directory as a diagnostic artifact under a bounded timeout. Artifact upload is evidence collection, not a reason to convert a failed test into success.

## Delivery Order

Implementation follows vertical TDD slices:

1. shared real-process harness and leak detection;
2. runtime host composition and recovery-complete contract;
3. local control server and runtime CLI commands;
4. artifact, deployment, and task control operations;
5. real WebSocket adapters and Worker command;
6. single-Main echo flow through all executors;
7. leader-only reconciliation and two-Main takeover flow;
8. authoritative CI gates, diagnostics, and documentation.

Each slice starts with an OpenSpec-tagged failing test and ends with focused tests plus all previously completed gates passing.

## Completion Criteria

Phase one is complete only when:

- all layer-one OpenSpec scenarios pass;
- all required CLI commands operate through public control contracts;
- the same echo plugin runs through thread, process, and remote executors;
- Main restart reconstructs durable state before accepting operations;
- two Main processes demonstrate fenced takeover and result uniqueness;
- no system test substitutes in-memory transport for real WebSocket transport;
- the root verification command succeeds on a clean checkout;
- all required GitHub Actions jobs pass and preserve actionable diagnostics;
- the Phase 1 task list and release evidence are updated to match verified behavior.
