# Comet Design Handoff

- Change: runtime-kernel-phase-1
- Phase: design
- Mode: full
- Context hash: 195b0851f04a8a71be48e025758464ef1e60341fc2cb4b86cf3da2f3b0d4446a

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/runtime-kernel-phase-1/proposal.md

- Source: openspec/changes/runtime-kernel-phase-1/proposal.md
- Lines: 1-42
- SHA256: 9229c1794434c7af54409b05002a2961e417646db304e14e087f944a3fd76096

```md
## Why

Tego needs a new backend runtime whose kernel can boot, run plugins, dispatch work, and recover failures without importing HTTP, security, database, cache, frontend, or Tego 1.x concepts. Building this as an independent repository establishes a testable foundation for embedded single-Main deployments and future highly available multi-Main deployments without carrying forward the coupling of the existing implementation.

## What Changes

- Create a Node.js 26 and TypeScript 7 ESM workspace for a clean-room Tego runtime.
- Define stable, runtime-validated contracts for applications, runtime drivers, plugins, capabilities, workers, executors, tasks, and lifecycle state.
- Implement a bootable `single-main` runtime with local coordination and durable local state.
- Implement desired-state reconciliation for plugin installation and deployment.
- Implement capability dependency resolution, permission gating, essential-plugin readiness, and structured diagnostics.
- Implement interchangeable thread, child-process, and remote-worker executors behind one task protocol.
- Implement the WebSocket Main/Worker protocol, including registration, heartbeats, task execution, cancellation, reconnect, and orphan-result recovery.
- Define and certify the multi-Main coordination contract, including leadership, leases, compare-and-set, watch, and fencing epochs, with one production external provider.
- Provide a plugin SDK, contract-test kit, CLI, example plugin, and a reproducible plugin package format so the first layer is directly usable.
- **BREAKING**: This repository exposes only Tego Next contracts. It intentionally provides no Tego 1.x compatibility API, CommonJS loader, frontend loader, HTTP API, database abstraction, ACL, cache, workflow engine, or business capability.

## Capabilities

### New Capabilities

- `runtime-bootstrap`: Boot, inspect, stop, and recover a Tego Main using explicit runtime drivers in `single-main` or `multi-main` mode.
- `plugin-artifacts`: Validate manifests without executing plugin code and register immutable, digest-addressed plugin installations.
- `plugin-deployment`: Persist desired plugin deployments, resolve their dependencies and permissions, reconcile component instances, and report observed state.
- `capability-resolution`: Register versioned capability providers and resolve required or optional capability bindings deterministically.
- `executor-runtime`: Submit, observe, cancel, drain, and retry tasks through interchangeable thread, process, and remote executors.
- `worker-protocol`: Connect remote workers to a Main over WebSocket and preserve task identity and results across reconnects.
- `coordination-provider`: Provide local coordination for one Main and a contract-tested external coordination provider for multi-Main leadership, leases, CAS, watch, and fencing.
- `runtime-operations`: Operate the kernel through a CLI, diagnostics, structured events, an example plugin, and reusable conformance test kits.

### Modified Capabilities

None. This is a new repository with no existing product specifications.

## Impact

- Creates a new public repository at `tegojs/tego-next`; the existing `tegojs/tego` repository is unchanged.
- Introduces an npm workspace containing runtime contracts, kernel, local and external drivers, executor implementations, WebSocket transport, plugin SDK, plugin test kit, CLI, and examples.
- Requires Node.js 26 during development and TypeScript 7 for type checking and declarations.
- Uses JavaScript ESM as the production runtime and plugin artifact ABI.
- Adds Docker-backed integration tests for the selected external coordination provider while keeping unit and single-Main integration tests runnable without Docker.
- Establishes the behavioral contract that later platform-capability and business-plugin repositories or packages will consume.
```

## openspec/changes/runtime-kernel-phase-1/design.md

- Source: openspec/changes/runtime-kernel-phase-1/design.md
- Lines: 1-210
- SHA256: 7096674ff46890289dc2c060fd5b95fc651f58719d5f0987070a23cac660e44f

```md
## Context

Tego Next starts from an empty repository. The existing Tego implementation and its frontend, database, cache, ACL, resource, and CommonJS conventions are reference material only; they are not dependencies of the new kernel.

The first deliverable must be useful on an embedded device with one Main, yet must not make a later highly available control plane a rewrite. It must also prove that a task component can move between a worker thread, child process, and remote Worker without changing plugin code.

The development baseline is Node.js 26 Current, TypeScript 7, and ESM. Production release is blocked until Node.js 26 enters LTS. TypeScript source is a development format; runtime and plugin artifacts contain JavaScript ESM.

## Goals / Non-Goals

**Goals:**

- Boot the kernel without any platform-capability or business plugin.
- Make `single-main` useful without an external coordinator.
- Make `multi-main` safe through an explicit external coordination contract.
- Keep plugin manifests, installation records, and deployment intent separate.
- Validate manifests, permissions, dependencies, and compatibility before plugin code runs.
- Execute one plugin component through thread, process, or remote executors using one request contract.
- Preserve stable task identity, cancellation, diagnostics, and result recovery across failures.
- Provide repeatable CLI, SDK, packaging, example, and conformance-test workflows.

**Non-Goals:**

- Tego 1.x API or CommonJS compatibility.
- HTTP routing, authentication, authorization policy, database abstraction, cache, scheduler, workflow, frontend assets, or browser loading.
- Arbitrary-language plugins.
- Container or Kubernetes orchestration.
- A new consensus algorithm.
- Sandboxing untrusted native code. Thread execution is explicitly not a security boundary.
- Production support before Node.js 26 becomes LTS.

## Decisions

### 1. Use an npm workspace with small public package boundaries

The repository will contain:

```text
packages/
  contracts/               @tegojs/contracts
  runtime/                 @tegojs/runtime
  drivers-local/           @tegojs/drivers-local
  drivers-postgres/        @tegojs/drivers-postgres
  executor-node/           @tegojs/executor-node
  transport-websocket/     @tegojs/transport-websocket
  plugin-sdk/              @tegojs/plugin-sdk
  testkit/                 @tegojs/testkit
  cli/                     @tegojs/cli
examples/
  echo-plugin/
```

`contracts` contains only data contracts, runtime validators, and error codes. `runtime` depends on contracts and driver interfaces but not on concrete drivers. Driver and executor packages depend inward on contracts. The CLI composes packages without becoming a privileged runtime API.

Alternatives considered:

- One package would make the first prototype faster but would hide dependency violations and make second-layer extraction difficult.
- Many packages per domain object would maximize separation but create unnecessary release and navigation overhead.

### 2. Treat drivers as bootstrap dependencies, not ordinary plugins

`CoordinationProvider`, `StateStore`, `ArtifactStore`, `NodeTransport`, `ProcessHost`, `SecretProvider`, and `Clock` are loaded by `TegoRuntime.bootstrap()`. They cannot register business capabilities. Ordinary plugin execution starts only after bootstrap and desired state recovery.

This avoids the circular requirement where the plugin system needs a plugin in order to initialize the services required to load plugins.

### 3. Support exactly two deployment modes

`single-main` has one authoritative Main and uses local drivers. It needs no leader election and supports all executor types.

`multi-main` requires an external `CoordinationProvider`. Only the current fenced leader performs reconciliation and task assignment; followers retain diagnostics and can take over after lease expiry.

There is no separate “strict one OS process” product mode. Thread and child-process execution are executor choices, not deployment modes.

### 4. Use a local driver set for durable single-Main state

`@tegojs/drivers-local` supplies a `node:sqlite` state store, local coordination, a filesystem artifact store, process hosting, system clock, and development secret source. Writes are transactional and records carry a monotonically increasing revision. Runtime restart reconstructs installations, deployments, operation journals, and unfinished tasks before accepting new work.

An in-memory implementation remains available for unit tests. It is not advertised as crash-durable.

JSON files were rejected because multi-record transitions, revisions, and crash recovery would require rebuilding transaction semantics.

### 5. Use PostgreSQL as the first certified multi-Main driver set

`@tegojs/drivers-postgres` provides shared state, artifact bytes, and coordination so a multi-Main deployment never relies on node-local control-plane state. Its coordination implementation provides:

- leadership with a dedicated advisory-lock connection;
- a transactional, monotonically increasing fencing epoch;
- expiring leases stored against database time;
- versioned compare-and-set values;
- `LISTEN`/`NOTIFY` as a wake-up signal plus revision-based catch-up;
- namespaced operation state.

The kernel depends only on the provider contract. PostgreSQL is optional and is never required by `single-main`.

PostgreSQL was selected over implementing Raft and over coupling directly to Kubernetes. An etcd or Consul driver can later pass the same conformance suite.

### 6. Use three immutable plugin records

- `PluginManifest` is author-supplied pure data inside an artifact.
- `PluginInstallation` is generated after validation, digesting, and optional signature verification.
- `PluginDeployment` is mutable desired state for one application and carries a generation.

Manifest loading reads and validates data before importing any component module. Artifacts are content-addressed by SHA-256. A `.tego` artifact is a deterministic tar archive containing `manifest.json`, built JavaScript components, schemas, and metadata. Optional Ed25519 signatures cover the final artifact digest.

### 7. Reconcile desired state into observed component instances

The kernel does not directly “start a plugin” as a one-shot command. Deployment writes desired state. A reconciler:

1. validates compatibility, dependency bindings, permissions, and artifact availability;
2. computes component placements and executor choices;
3. advances instances through kernel-owned lifecycle transitions;
4. records observed generation, health, diagnostics, and retry timing;
5. drains obsolete instances and converges after restart.

Non-essential plugin failure does not stop the kernel. An essential plugin prevents application readiness while preserving kernel diagnostics and recovery commands.

### 8. Use explicit capability tokens and deterministic dependency resolution

A capability identity is `(name, protocolVersion)`. Providers register runtime schemas for requests and responses. Deployments may bind a requirement to a provider explicitly.

Without an explicit binding:

- zero compatible providers blocks required dependencies;
- one compatible provider is selected;
- multiple compatible providers block as ambiguous;
- an absent optional capability resolves to `undefined`.

Required dependency cycles are rejected before code execution. A provider must be ready before its dependents start.

### 9. Keep permissions as pre-execution grants

Manifests request a maximum permission envelope. Deployments grant a subset. The kernel checks capability calls, executor use, network targets, filesystem roots, secrets, environment names, and Worker selectors before loading plugin code.

This phase establishes enforcement points and tests. It does not attempt operating-system-grade isolation for worker threads. Process and remote executors are the isolation choices for higher-risk plugins.

### 10. Use one task protocol across all executors

An execution request contains stable `taskId`, `attemptId`, artifact digest, component ID, input, deadline, cancellation token identity, permission grant, and artifact references. Results contain a terminal status, structured error, output, timing, and the same identities.

The Node executor package supplies:

- `ThreadExecutor` using `node:worker_threads`;
- `ProcessExecutor` using `node:child_process` IPC.

The WebSocket package supplies `RemoteExecutor` plus the Worker runtime. Large payloads use artifact references or transferable binary frames instead of repeated JSON copies.

Default selection prefers process execution for plugin components unless the deployment explicitly chooses another supported executor.

### 11. Make WebSocket transport reconnectable and direction-neutral

Either Worker or Main may initiate the WebSocket connection. After authentication by a bootstrap token supplied through the driver boundary, both directions enter the same logical session protocol.

Messages use an envelope with protocol version, message ID, session ID, sequence, correlation ID, type, and payload. Registration and heartbeat advertise Worker labels, resources, executors, and prepared artifact digests.

Task assignment is acknowledged before execution. Duplicate assignments are deduplicated by `(taskId, attemptId)`. On reconnect, the Worker reports running and buffered terminal results. The Main then resumes, cancels, or acknowledges them according to the task’s orphan policy.

### 12. Make observability a kernel contract, not an HTTP dependency

The kernel emits typed runtime events and stores structured diagnostics with stable error codes. The CLI reads those contracts directly from a local control channel in the first phase. A future HTTP plugin may expose the same operations without changing the kernel.

Required CLI flows are:

```text
tego runtime start
tego runtime status
tego runtime stop
tego plugin validate
tego plugin pack
tego plugin install
tego plugin deploy
tego plugin status
tego task run
tego task status
tego worker start
```

### 13. Enforce SDD and TDD in repository workflow

Every implementation slice starts from an approved OpenSpec scenario and a failing automated test. The repository uses Node’s test runner for behavior and contract tests, TypeScript for static contracts, and Docker-backed integration tests for PostgreSQL.

CI verifies formatting, linting, type checking, unit tests, package tests, integration tests, a clean package build, artifact reproducibility, and the end-to-end echo-plugin flow.

## Failure and Recovery Model

- Invalid manifest, incompatible runtime, missing permission, missing capability, ambiguity, and dependency cycle become structured pre-execution diagnostics.
- A JavaScript exception fails only the current component instance or task attempt.
- A crashed thread or process is replaced after its result is recorded.
- A disconnected Worker leaves tasks `unknown` until reconnect or policy timeout; it does not silently create a second attempt.
- A stale multi-Main leader cannot commit state because all control-plane writes include its fencing epoch.
- Restart replays durable operations idempotently using operation, task, attempt, deployment-generation, and message identities.

## Risks / Trade-offs

- **[Risk] Node.js 26 and TypeScript 7 are new development baselines.** → Pin exact versions, run runtime contract tests in CI, and prohibit production release before Node.js 26 LTS.
- **[Risk] The first phase spans control plane, execution, and transport.** → Deliver capability slices in dependency order and require a passing vertical echo-plugin flow after each executor is added.
- **[Risk] SQLite and PostgreSQL can diverge semantically.** → Run the same state and coordination conformance suites against every implementation.
- **[Risk] WebSocket disconnects create ambiguous task state.** → Use explicit acknowledgements, stable attempt IDs, deduplication, orphan policies, and result resynchronization.
- **[Risk] Thread execution may be mistaken for security isolation.** → Document it as a performance isolation mechanism and default ordinary plugin execution to child processes.
- **[Risk] Plugin packaging can become a build-system project.** → Limit phase one to TypeScript-to-JavaScript ESM, deterministic archives, digest, and Ed25519 signatures; defer arbitrary bundler plugins and SEA.
- **[Risk] PostgreSQL leadership depends on a live session.** → Use a dedicated connection, database time, fencing epochs, and takeover tests that kill the leader connection.

## Delivery and Rollback

Development occurs on `codex/runtime-kernel-phase-1`. Each capability is committed only after its focused test suite passes. The initial public release is `0.1.0-alpha.1`; no production stability promise is made.

Rollback before the first release is a Git revert to the last passing capability slice. Runtime state schemas use forward-only numbered migrations and keep the previous binary’s compatibility range in release metadata. Plugin deployment rollback changes desired state to a previously installed immutable artifact and increments the deployment generation.

## Open Questions

None block phase one. Additional external coordinators, OS-level sandboxing, container executors, HTTP control APIs, and Tego 1.x compatibility are explicitly later changes.
```

## openspec/changes/runtime-kernel-phase-1/tasks.md

- Source: openspec/changes/runtime-kernel-phase-1/tasks.md
- Lines: 1-105
- SHA256: 822e1b4dd8427e6c493e75c7029007ad9b7b02b64d62f61f7cc078c30cb5ae64

```md
## 1. Repository and Test Harness

- [ ] 1.1 Pin Node.js 26, npm, TypeScript 7, workspace metadata, ESM compiler settings, formatting, linting, and deterministic install configuration
- [ ] 1.2 Add the package dependency graph and an architecture test that rejects forbidden layer-two, frontend, and Tego 1.x imports
- [ ] 1.3 Add shared Node test-runner helpers, fake clock, temporary workspace, eventual assertions, and leak detection
- [ ] 1.4 Add CI jobs for Node 26 static checks, unit tests, package tests, PostgreSQL integration tests, build, and smoke verification

## 2. Runtime Contracts

- [ ] 2.1 Write failing contract tests and implement branded identities, revisions, generations, task IDs, attempt IDs, operation IDs, and structured runtime errors
- [ ] 2.2 Write failing schema tests and implement runtime validators for bootstrap configuration and driver health
- [ ] 2.3 Write failing schema tests and implement manifest, installation, deployment, component, capability, permission, and placement contracts
- [ ] 2.4 Write failing schema tests and implement execution request/result and Worker message-envelope contracts
- [ ] 2.5 Write serialization round-trip and protocol-compatibility tests for every public wire contract

## 3. State and Coordination Drivers

- [ ] 3.1 Define the state-store conformance suite from restart, transaction, revision, journal, and namespace scenarios
- [ ] 3.2 Implement the in-memory state store test double until it passes the conformance suite
- [ ] 3.3 Implement the SQLite state store and numbered migrations until it passes conformance and process-restart tests
- [ ] 3.4 Define the coordination-provider conformance suite for leadership, leases, fencing, CAS, watch, namespaces, idempotency, and close
- [ ] 3.5 Implement the local single-Main coordination provider until it passes all applicable conformance scenarios
- [ ] 3.6 Implement PostgreSQL schema migrations, leadership, lease, fencing, CAS, watch catch-up, and cleanup test-first
- [ ] 3.7 Run PostgreSQL takeover and stale-leader fault tests against a pinned Docker image

## 4. Runtime Bootstrap and Recovery

- [ ] 4.1 Write bootstrap state-machine tests and implement explicit driver construction, startup ordering, health aggregation, and cleanup on failure
- [ ] 4.2 Write empty-runtime tests and implement independent start, status, readiness, and stop behavior
- [ ] 4.3 Write recovery tests and implement replay of installations, deployments, operation journals, and unfinished tasks
- [ ] 4.4 Write multi-Main leadership tests and implement fenced leader-only reconciliation with follower diagnostics
- [ ] 4.5 Write essential-readiness tests and implement separate kernel liveness and application readiness

## 5. Plugin Artifacts

- [ ] 5.1 Write side-effect detection tests and implement data-only manifest reading and validation
- [ ] 5.2 Write compatibility tests and implement Tego, Node.js, ESM, platform, and architecture checks
- [ ] 5.3 Write digest and immutability tests and implement artifact registration plus installation records
- [ ] 5.4 Write reproducibility tests and implement normalized deterministic `.tego` archive creation and inspection
- [ ] 5.5 Write signing tests and implement Ed25519 signing and configured trust-key verification
- [ ] 5.6 Add negative fixtures for path traversal, duplicate entries, digest mismatch, invalid schemas, and executable pre-validation side effects

## 6. Capability and Permission Resolution

- [ ] 6.1 Write resolver tests and implement capability token identity and protocol-version compatibility
- [ ] 6.2 Write binding tests and implement explicit, unique automatic, ambiguous, required, and optional resolution
- [ ] 6.3 Write graph tests and implement provider-first ordering plus required-cycle diagnostics
- [ ] 6.4 Write provider-loss tests and implement degrade, suspend, and fail propagation policies
- [ ] 6.5 Write permission-envelope tests and implement pre-import checks for capability, executor, network, filesystem, secret, environment, and Worker-selector grants
- [ ] 6.6 Write payload validation tests and implement runtime request and response schema enforcement at capability boundaries

## 7. Plugin Deployment and Reconciliation

- [ ] 7.1 Write desired/observed state tests and implement deployment generations and instance observed generations
- [ ] 7.2 Write lifecycle transition tests and implement the kernel-owned component lifecycle state machine
- [ ] 7.3 Write reconciliation idempotency tests and implement stable instance identity, placement, retry scheduling, and convergence
- [ ] 7.4 Write enable, disable, upgrade, drain, and rollback plan tests and implement their reconciliation steps
- [ ] 7.5 Write failure-isolation tests and implement structured blocked, failed, degraded, unavailable, and inconsistent states
- [ ] 7.6 Write restart-during-reconcile tests and implement operation-journal recovery without duplicate component instances

## 8. Local Executors

- [ ] 8.1 Define and run an executor conformance suite for probe, submit, observe, deduplicate, cancel, deadline, drain, health, and replacement
- [ ] 8.2 Write Worker Thread fixture tests and implement `ThreadExecutor` with transferable binary support
- [ ] 8.3 Write child-process fixture tests and implement `ProcessExecutor` with IPC framing and crash replacement
- [ ] 8.4 Write executor-selection tests and implement support, permission, resource, availability, preference, and fallback evaluation
- [ ] 8.5 Write task journal tests and implement stable task/attempt identity, terminal result recording, and retry policy
- [ ] 8.6 Run the same echo, cancellation, timeout, crash, duplicate, and drain scenarios against thread and process executors

## 9. Remote Worker and WebSocket Transport

- [ ] 9.1 Write message-codec tests and implement the versioned, sequenced, correlated Worker envelope
- [ ] 9.2 Write authentication and handshake tests and implement Worker-initiated and Main-initiated sessions
- [ ] 9.3 Write liveness tests and implement registration, capability advertisement, heartbeat, expiry, and session replacement
- [ ] 9.4 Write remote executor conformance tests and implement assignment acknowledgement, progress, result, cancellation, and backpressure
- [ ] 9.5 Write disconnect tests and implement unknown-state handling plus `cancel`, `finish-and-buffer`, and `finish-and-persist` orphan policies
- [ ] 9.6 Write reconnect tests and implement running-attempt and buffered-result reconciliation with deduplication
- [ ] 9.7 Run the complete executor echo, cancellation, timeout, crash, duplicate, and drain scenarios against `RemoteExecutor`

## 10. Plugin SDK and TestKit

- [ ] 10.1 Write SDK type and runtime tests and implement functional component-definition APIs with no base class or decorator requirement
- [ ] 10.2 Write context tests and implement minimal identity, config, logger, event, capability, lifecycle, runtime-info, and disposable access
- [ ] 10.3 Implement public manifest, lifecycle, executor, Worker, state-store, and coordination-provider conformance test kits
- [ ] 10.4 Write testkit self-tests proving third-party implementations can use only public exports
- [ ] 10.5 Add the TypeScript echo plugin with no executor-specific code and lifecycle/test fixtures

## 11. CLI and Usable Vertical Slice

- [ ] 11.1 Write CLI parser and exit-code tests and implement JSON and human-readable output contracts
- [ ] 11.2 Write runtime command tests and implement local start, status, stop, and recovery commands
- [ ] 11.3 Write plugin command tests and implement validate, pack, inspect, install, deploy, and status commands
- [ ] 11.4 Write task command tests and implement run, status, wait, and cancel commands
- [ ] 11.5 Write Worker command tests and implement remote Worker startup in both connection directions
- [ ] 11.6 Build and run an end-to-end single-Main flow that packs, installs, deploys, and executes the echo plugin through all three executors
- [ ] 11.7 Build and run a two-Main PostgreSQL flow that proves leader takeover, fencing, Worker continuity, and final result uniqueness

## 12. Documentation, Review, and Release Evidence

- [ ] 12.1 Document architecture boundaries, package graph, state machines, protocol compatibility, threat model, and failure semantics
- [ ] 12.2 Document contributor setup, strict red-green-refactor workflow, plugin authoring, embedded deployment, and multi-Main deployment
- [ ] 12.3 Add an executable release-verification command covering clean install, format, lint, typecheck, tests, integration, build, package reproducibility, and smoke flows
- [ ] 12.4 Run mutation or fault-injection checks on lifecycle, fencing, deduplication, and permission gates and close material test gaps
- [ ] 12.5 Perform API, architecture, security, concurrency, and failure-recovery review and resolve all blocking findings
- [ ] 12.6 Produce `0.1.0-alpha.1` release notes with Node.js 26 LTS production gate and explicitly deferred capabilities
```

## openspec/changes/runtime-kernel-phase-1/specs/capability-resolution/spec.md

- Source: openspec/changes/runtime-kernel-phase-1/specs/capability-resolution/spec.md
- Lines: 1-40
- SHA256: f4e62ebd745fd0b275a2b4f518e566fce5e1345cab63d3083aada167ecf1f7d3

```md
## ADDED Requirements

### Requirement: Versioned capability identity
The runtime SHALL identify a capability by stable name and protocol version and SHALL validate provider and consumer payloads against runtime schemas.

#### Scenario: Incompatible protocol version
- **WHEN** a consumer requires a protocol version outside a provider's compatible range
- **THEN** that provider is excluded from resolution

### Requirement: Deterministic provider selection
The resolver SHALL use an explicit compatible binding first, auto-select exactly one compatible ready provider, and block an unbound requirement when multiple compatible providers remain.

#### Scenario: One compatible provider
- **WHEN** exactly one ready provider satisfies an unbound required capability
- **THEN** the resolver binds the consumer to that provider

#### Scenario: Ambiguous providers
- **WHEN** multiple ready providers satisfy an unbound required capability
- **THEN** the consumer deployment becomes `blocked` with the candidate provider identities

### Requirement: Required and optional dependencies
The resolver SHALL block a missing required capability and SHALL resolve a missing optional capability to `undefined`.

#### Scenario: Optional provider absent
- **WHEN** no compatible provider exists for an optional requirement
- **THEN** the consumer remains startable and receives no capability binding

### Requirement: Dependency ordering and cycle rejection
The resolver SHALL start providers before their consumers and SHALL reject cycles formed by required dependencies.

#### Scenario: Required dependency cycle
- **WHEN** deployment A requires a capability from B and B requires a capability from A
- **THEN** both deployments are blocked with a dependency-cycle diagnostic before either component starts

### Requirement: Provider loss propagation
The runtime SHALL apply the consumer's declared loss policy when a bound provider stops being ready.

#### Scenario: Suspend on provider loss
- **WHEN** a ready consumer declares `suspend` and its provider becomes unavailable
- **THEN** the reconciler drains the consumer and marks it `suspended` until the provider recovers
```

## openspec/changes/runtime-kernel-phase-1/specs/coordination-provider/spec.md

- Source: openspec/changes/runtime-kernel-phase-1/specs/coordination-provider/spec.md
- Lines: 1-43
- SHA256: bb383db0aaf8f7beea194deb7fd48061705fbee82c42c164bcc79d57ddd42ad3

```md
## ADDED Requirements

### Requirement: Local single-Main coordination
The local coordination provider SHALL support one authoritative Main without requiring an external service.

#### Scenario: Start without external coordinator
- **WHEN** a single-Main runtime starts with the local coordination provider
- **THEN** it owns reconciliation and task assignment immediately

### Requirement: Provider conformance contract
Every external coordination provider SHALL pass the same conformance suite for namespace isolation, leadership, leases, fencing epochs, compare-and-set, watch, idempotency, and resource cleanup.

#### Scenario: Run conformance against PostgreSQL
- **WHEN** the suite runs against a clean supported PostgreSQL instance
- **THEN** every mandatory coordination behavior passes without provider-specific test exclusions

### Requirement: Fenced leadership
The external provider SHALL issue a monotonically increasing fencing epoch to each new leader, and control-plane writes SHALL reject a stale epoch.

#### Scenario: Stale leader resumes
- **WHEN** leader A loses its lease, leader B acquires a higher epoch, and A later attempts a write
- **THEN** the write from A is rejected and B remains authoritative

### Requirement: Expiring exclusive leases
The external provider SHALL use provider time to grant, renew, release, and expire exclusive leases.

#### Scenario: Lease owner disappears
- **WHEN** an owner stops renewing a lease
- **THEN** another contender can acquire it only after its recorded expiry

### Requirement: Atomic compare-and-set
The provider SHALL atomically replace a value only when its expected revision matches and SHALL return the resulting revision.

#### Scenario: Concurrent writers
- **WHEN** two writers compare-and-set the same revision
- **THEN** exactly one succeeds and the other observes a revision conflict

### Requirement: Lossless watch recovery
Watch notifications SHALL be treated as wake-up signals, and consumers SHALL resume from a persisted revision so reconnects do not lose committed changes.

#### Scenario: Watch connection reconnects
- **WHEN** committed changes occur while a watcher is disconnected
- **THEN** the watcher resumes from its last revision and receives every later committed change in order
```

## openspec/changes/runtime-kernel-phase-1/specs/executor-runtime/spec.md

- Source: openspec/changes/runtime-kernel-phase-1/specs/executor-runtime/spec.md
- Lines: 1-40
- SHA256: f4d52bb875b0997c3fbf841b2345c5cdab11d426dc6b2cdf8fcc2aa2f9a086f8

```md
## ADDED Requirements

### Requirement: Uniform executor contract
Thread, process, and remote executors SHALL implement the same probe, submit, observe, cancel, drain, and health behavior for one execution request and result contract.

#### Scenario: Run one component on every executor
- **WHEN** the same echo component and input are submitted to thread, process, and remote executors
- **THEN** each returns the same successful logical output with executor-specific metadata only

### Requirement: Stable task and attempt identity
Every execution SHALL use a stable task ID and a unique attempt ID, and duplicate submission of the same pair SHALL NOT execute component logic twice.

#### Scenario: Duplicate assignment
- **WHEN** an executor receives the same task ID and attempt ID more than once
- **THEN** it returns or waits for the existing attempt result without starting a duplicate

### Requirement: Cancellation and deadline
Every executor SHALL accept cancellation and enforce execution deadlines with a structured terminal result.

#### Scenario: Cancel a running task
- **WHEN** a caller cancels an acknowledged running task
- **THEN** the executor requests cooperative cancellation, terminates it after the grace period if necessary, and reports `cancelled`

### Requirement: Executor failure containment
An executor runtime SHALL record task failure and restore executor capacity after a thread exit, child-process crash, or remote-session loss.

#### Scenario: Child process crashes
- **WHEN** a plugin component terminates its child process
- **THEN** the attempt becomes `failed` with a process-exit diagnostic and a later task can run in a replacement process

### Requirement: Executor selection
The runtime SHALL select only an executor supported by the component, allowed by the permission grant, and capable of satisfying declared resource constraints.

#### Scenario: Preferred executor unavailable
- **WHEN** a preferred executor is unavailable but another declared supported executor satisfies all constraints
- **THEN** the runtime selects the compatible fallback

#### Scenario: No executor satisfies constraints
- **WHEN** no registered executor satisfies a component's support, permission, and resource constraints
- **THEN** the task is rejected before plugin code runs with candidate diagnostics
```

## openspec/changes/runtime-kernel-phase-1/specs/plugin-artifacts/spec.md

- Source: openspec/changes/runtime-kernel-phase-1/specs/plugin-artifacts/spec.md
- Lines: 1-36
- SHA256: f10aa57e54e0a4760229ae29a941a8e58d637755a2a1ec3ecd9c2418b9c85feb

```md
## ADDED Requirements

### Requirement: Data-only manifest validation
The runtime SHALL parse and validate `manifest.json` without importing or evaluating plugin component code.

#### Scenario: Invalid manifest has executable component
- **WHEN** an artifact contains a component module with observable top-level behavior and an invalid manifest
- **THEN** validation rejects the artifact and the component behavior is never observed

### Requirement: Runtime compatibility validation
The runtime SHALL reject artifacts whose schema version, Tego contract range, Node.js range, module format, or architecture constraints are incompatible.

#### Scenario: Unsupported CommonJS artifact
- **WHEN** a manifest declares a CommonJS runtime artifact
- **THEN** validation returns an unsupported-module-format diagnostic

### Requirement: Immutable content-addressed installation
The runtime SHALL compute a SHA-256 digest over the final artifact and SHALL store installation metadata keyed by plugin ID, version, and digest.

#### Scenario: Artifact bytes change without version change
- **WHEN** two artifacts have the same plugin ID and version but different bytes
- **THEN** they receive different digests and the second cannot overwrite the first installation

### Requirement: Reproducible plugin package
The CLI SHALL build a deterministic `.tego` archive from validated JavaScript ESM output and declared metadata.

#### Scenario: Pack unchanged inputs twice
- **WHEN** the same normalized plugin inputs are packed twice
- **THEN** the resulting archives have identical SHA-256 digests

### Requirement: Optional artifact signature
The CLI and runtime SHALL support Ed25519 signatures over an artifact digest and SHALL reject a required signature that cannot be verified by a configured trust key.

#### Scenario: Tampered signed artifact
- **WHEN** bytes in a signed artifact change after signing
- **THEN** installation fails before any plugin code runs
```

## openspec/changes/runtime-kernel-phase-1/specs/plugin-deployment/spec.md

- Source: openspec/changes/runtime-kernel-phase-1/specs/plugin-deployment/spec.md
- Lines: 1-40
- SHA256: 7e58876bf5070ae998870a4203ca0e46c4aa651738f2e238dde018316175e37d

```md
## ADDED Requirements

### Requirement: Separate desired and observed plugin state
The runtime SHALL persist mutable `PluginDeployment` desired state separately from immutable manifests and installations, and SHALL track an observed generation for every component instance.

#### Scenario: Deployment generation changes
- **WHEN** an administrator changes a deployment
- **THEN** its generation increments and old instances remain out of date until they report the new observed generation

### Requirement: Pre-execution deployment gate
The reconciler SHALL validate artifact availability, runtime compatibility, capability bindings, permission grants, dependency cycles, placement, and executor support before loading plugin code.

#### Scenario: Granted permissions exceed request
- **WHEN** a deployment grants a permission that the manifest did not request
- **THEN** the deployment becomes `blocked` with a permission-envelope diagnostic before component import

#### Scenario: Required capability is missing
- **WHEN** a deployment requires a capability with no compatible ready provider
- **THEN** the deployment becomes `blocked` and its component is not started

### Requirement: Kernel-owned component lifecycle
The kernel SHALL enforce legal transitions through `created`, `preparing`, `starting`, `ready`, `degraded`, `draining`, `stopping`, `stopped`, and `failed`.

#### Scenario: Plugin attempts an illegal transition
- **WHEN** a component or driver requests a transition not allowed from its current state
- **THEN** the runtime rejects it and records a lifecycle diagnostic

### Requirement: Reconciliation convergence
The reconciler SHALL repeatedly converge observed instances to desired deployment state and SHALL make reconciliation operations idempotent.

#### Scenario: Reconcile the same generation twice
- **WHEN** the same deployment generation is reconciled after an interrupted reconcile
- **THEN** the runtime does not create a duplicate live component instance

### Requirement: Failure isolation
A non-essential plugin failure SHALL NOT terminate the kernel, while an essential plugin failure SHALL only prevent application readiness.

#### Scenario: Component start throws
- **WHEN** a non-essential component throws during start
- **THEN** its instance becomes `failed`, diagnostics identify the plugin and component, and the kernel remains running
```

## openspec/changes/runtime-kernel-phase-1/specs/runtime-bootstrap/spec.md

- Source: openspec/changes/runtime-kernel-phase-1/specs/runtime-bootstrap/spec.md
- Lines: 1-37
- SHA256: 0fe1eadaa1e6eb153a67c66fd19f8b66d18585b259d5626d9745f0ddd8a4488c

```md
## ADDED Requirements

### Requirement: Explicit runtime bootstrap
The kernel SHALL bootstrap from explicit mode, identity, and runtime-driver configuration without loading an ordinary plugin.

#### Scenario: Boot a standalone Main
- **WHEN** a caller bootstraps a valid `single-main` runtime with local drivers
- **THEN** the runtime reaches `running` and exposes its identity, mode, driver health, and readiness

#### Scenario: Reject missing distributed coordination
- **WHEN** a caller bootstraps `multi-main` without an external coordination provider
- **THEN** bootstrap fails with a structured configuration error before application recovery begins

### Requirement: Independent kernel lifecycle
The kernel SHALL start, report diagnostics, and stop without HTTP, security, database-capability, cache, frontend, or business plugins.

#### Scenario: Empty runtime lifecycle
- **WHEN** a new runtime has no plugin installations or deployments
- **THEN** it can start, become ready, report status, and stop cleanly

### Requirement: Durable restart recovery
The single-Main runtime SHALL recover persisted installations, deployments, operation journals, and unfinished task records before accepting new tasks.

#### Scenario: Restart after an interrupted operation
- **WHEN** the runtime stops after persisting an operation but before recording its terminal state
- **THEN** the next start reconstructs the operation and resumes or terminates it idempotently

### Requirement: Essential readiness
The kernel SHALL distinguish kernel liveness from application readiness.

#### Scenario: Essential plugin unavailable
- **WHEN** an essential deployment cannot become ready
- **THEN** the kernel remains running and diagnosable while application readiness is false

#### Scenario: Non-essential plugin unavailable
- **WHEN** a non-essential deployment cannot become ready
- **THEN** kernel and application readiness remain true if all essential deployments are ready
```

## openspec/changes/runtime-kernel-phase-1/specs/runtime-operations/spec.md

- Source: openspec/changes/runtime-kernel-phase-1/specs/runtime-operations/spec.md
- Lines: 1-43
- SHA256: a10386ff048f0f94066e92cb0f3e9865e17336d34120cfadedeab113669079b4

```md
## ADDED Requirements

### Requirement: Local runtime operations
The CLI SHALL start, inspect, and stop a local runtime and SHALL return machine-readable output and non-zero exit codes for failed operations.

#### Scenario: Inspect an empty runtime
- **WHEN** an operator requests JSON status from a running empty runtime
- **THEN** the CLI returns runtime identity, mode, liveness, readiness, driver health, deployment counts, Worker counts, and task counts

### Requirement: Plugin development operations
The CLI SHALL validate, pack, inspect, install, deploy, and report status for a plugin using the same contracts as the kernel.

#### Scenario: Validate before pack
- **WHEN** an invalid plugin project is passed to `tego plugin pack`
- **THEN** the command fails with manifest and build diagnostics and creates no artifact

### Requirement: Task operations
The CLI SHALL run, inspect, wait for, and cancel tasks while preserving structured outputs and terminal error details.

#### Scenario: Run example task
- **WHEN** an operator runs the installed echo component with JSON input
- **THEN** the CLI waits for a terminal result and prints the echoed output

### Requirement: Reusable conformance test kits
The repository SHALL expose test kits for manifests, plugin lifecycle, executors, Workers, state stores, and coordination providers.

#### Scenario: Third-party provider adopts test kit
- **WHEN** a provider factory is passed to its matching conformance suite
- **THEN** the suite executes the complete public behavioral contract without importing provider internals

### Requirement: Reproducible development environment
The repository SHALL pin Node.js, package-manager, TypeScript, dependency lockfile, formatting, linting, build, and test commands.

#### Scenario: Clean checkout verification
- **WHEN** a contributor uses the pinned toolchain on a clean checkout
- **THEN** one documented verification command installs from the lockfile, checks formatting and types, runs tests, builds packages, and runs the echo-plugin smoke test

### Requirement: Layer-one dependency boundary
The first-layer packages SHALL NOT import Tego 1.x code or define frontend, HTTP routing, authentication, ACL, database-resource, cache, scheduler, workflow, or business-domain APIs.

#### Scenario: Architecture dependency check
- **WHEN** CI scans package imports and public exports
- **THEN** it fails if a forbidden layer-two, layer-three, frontend, or Tego 1.x dependency crosses into the kernel
```

## openspec/changes/runtime-kernel-phase-1/specs/worker-protocol/spec.md

- Source: openspec/changes/runtime-kernel-phase-1/specs/worker-protocol/spec.md
- Lines: 1-40
- SHA256: a97bfa10dcfdf38e7587086f86e4408856d07ccc6a7d3eebdca1953c8d8a17af

```md
## ADDED Requirements

### Requirement: Direction-neutral authenticated session
The transport SHALL establish the same authenticated logical Worker session whether the Worker connects to Main or Main connects to Worker.

#### Scenario: Worker-initiated connection
- **WHEN** a Worker reaches a Main through an outbound WebSocket and presents a valid bootstrap credential
- **THEN** it registers a session and advertises its identity and capabilities

#### Scenario: Invalid bootstrap credential
- **WHEN** either endpoint presents an invalid bootstrap credential
- **THEN** the peer closes the session before accepting registration or task messages

### Requirement: Versioned reliable message envelope
Every protocol message SHALL include protocol version, message ID, session ID, sequence, type, and correlation identity, and the receiver SHALL reject unsupported protocol versions.

#### Scenario: Unsupported protocol version
- **WHEN** a peer sends an envelope with an unsupported major protocol version
- **THEN** the session closes with a structured incompatibility reason

### Requirement: Worker liveness and capabilities
The Worker SHALL register labels, resources, executors, and prepared artifacts and SHALL renew liveness through heartbeat messages.

#### Scenario: Heartbeat expires
- **WHEN** a Worker misses the configured heartbeat deadline
- **THEN** the Main marks it unavailable and stops assigning new tasks

### Requirement: Reconnect reconciliation
The protocol SHALL reconcile running attempts and buffered terminal results after a session reconnect.

#### Scenario: Result completes while disconnected
- **WHEN** a task using `finish-and-buffer` completes after its session disconnects
- **THEN** the Worker sends the buffered result after reconnect and the Main records it once

### Requirement: Orphan policy
The runtime SHALL apply `cancel`, `finish-and-buffer`, or `finish-and-persist` when a Worker loses its Main session.

#### Scenario: Cancel orphaned work
- **WHEN** a session is lost for a task whose orphan policy is `cancel`
- **THEN** the Worker cancels the attempt and reports the terminal state on reconnect
```

