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

`unknown` remains a non-terminal reconciliation state. `indeterminate` is a
distinct terminal observation used only when execution or a durable state
transition may have completed but the persistence boundary cannot prove the
authoritative result. An indeterminate result has no output, requires a
non-retryable structured diagnostic, and never authorizes automatic retry.
Task inspection and audit surfaces preserve that distinction. A later restart
may recover a durable terminal record as explicit recovery evidence, but it
does not rewrite the historical result already delivered to a caller.

The Node executor package supplies:

- `ThreadExecutor` using `node:worker_threads`;
- `ProcessExecutor` using `node:child_process` IPC.

The WebSocket package supplies `RemoteExecutor` plus the Worker runtime. Large payloads use artifact references or transferable binary frames instead of repeated JSON copies.

Default selection prefers process execution for plugin components unless the deployment explicitly chooses another supported executor.

### 11. Make WebSocket transport reconnectable and direction-neutral

Either Worker or Main may initiate the WebSocket connection. After authentication by a bootstrap token supplied through the driver boundary, both directions enter the same logical session protocol.

Messages use an envelope with protocol version, message ID, session ID, sequence, correlation ID, type, and payload. Registration and heartbeat advertise Worker labels, resources, executors, and prepared artifact digests.

Task assignment is acknowledged before execution. Duplicate assignments are deduplicated by `(taskId, attemptId)`. On reconnect, the Worker reports running and buffered terminal results plus whether its attempt-state persistence boundary is available. The Main then resumes, cancels, or acknowledges them according to the task’s orphan policy. A higher transport epoch alone does not clear persistence unavailability; Main advertises the Worker as healthy again only after reconciliation explicitly proves a recovered persistence boundary.

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
