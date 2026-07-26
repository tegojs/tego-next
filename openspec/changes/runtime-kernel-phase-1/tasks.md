## 1. Repository and Test Harness

- [x] 1.1 Pin Node.js 26, npm, TypeScript 7, workspace metadata, ESM compiler settings, formatting, linting, and deterministic install configuration
- [x] 1.2 Add the package dependency graph and an architecture test that rejects forbidden layer-two, frontend, and Tego 1.x imports
- [x] 1.3 Add shared Node test-runner helpers, fake clock, temporary workspace, event-driven eventual assertions, real child-process orchestration, per-process logs, and leak detection
- [x] 1.4 Add separate GitHub Actions quality, integration, and system-E2E jobs using the exact pinned Node 26 version, PostgreSQL 16 service health checks, bounded timeouts, and diagnostic artifact upload

## 2. Runtime Contracts

- [x] 2.1 Write failing contract tests and implement branded identities, revisions, generations, task IDs, attempt IDs, operation IDs, and structured runtime errors
- [x] 2.2 Write failing schema tests and implement runtime validators for bootstrap configuration and driver health
- [x] 2.3 Write failing schema tests and implement manifest, installation, deployment, component, capability, permission, and placement contracts
- [x] 2.4 Write failing schema tests and implement execution request/result and Worker message-envelope contracts
- [x] 2.5 Write serialization round-trip and protocol-compatibility tests for every public wire contract

## 3. State and Coordination Drivers

- [x] 3.1 Define the state-store conformance suite from restart, transaction, revision, journal, and namespace scenarios
- [x] 3.2 Implement the in-memory state store test double until it passes the conformance suite
- [x] 3.3 Implement the SQLite state store and numbered migrations until it passes conformance and process-restart tests
- [x] 3.4 Define the coordination-provider conformance suite for leadership, leases, fencing, CAS, watch, namespaces, idempotency, and close
- [x] 3.5 Implement the local single-Main coordination provider until it passes all applicable conformance scenarios
- [x] 3.6 Implement PostgreSQL schema migrations, leadership, lease, fencing, CAS, watch catch-up, and cleanup test-first
- [x] 3.7 Run PostgreSQL takeover and stale-leader fault tests against a pinned PostgreSQL 16 GitHub Actions service container

## 4. Runtime Bootstrap and Recovery

- [x] 4.1 Write bootstrap state-machine tests and implement explicit driver construction, startup ordering, health aggregation, and cleanup on failure
- [x] 4.2 Write empty-runtime tests and implement independent start, status, readiness, and stop behavior
- [x] 4.3 Write restart tests and implement replay of installations, deployments, operation journals, and unfinished tasks before the local control endpoint reports recovery complete
- [x] 4.4 Write real two-Main process tests and implement fenced leader-only reconciliation, task assignment, takeover, and follower diagnostics
- [x] 4.5 Write essential-readiness tests and implement separate kernel liveness and application readiness

## 5. Plugin Artifacts

- [x] 5.1 Write side-effect detection tests and implement data-only manifest reading and validation
- [x] 5.2 Write compatibility tests and implement Tego, Node.js, ESM, platform, and architecture checks
- [x] 5.3 Write digest and immutability tests and implement artifact registration plus installation records
- [x] 5.4 Write reproducibility tests and implement normalized deterministic `.tego` archive creation and inspection
- [x] 5.5 Write signing tests and implement Ed25519 signing and configured trust-key verification
- [x] 5.6 Add negative fixtures for path traversal, duplicate entries, digest mismatch, invalid schemas, and executable pre-validation side effects

## 6. Capability and Permission Resolution

- [x] 6.1 Write resolver tests and implement capability token identity and protocol-version compatibility
- [x] 6.2 Write binding tests and implement explicit, unique automatic, ambiguous, required, and optional resolution
- [x] 6.3 Write graph tests and implement provider-first ordering plus required-cycle diagnostics
- [x] 6.4 Write provider-loss tests and implement degrade, suspend, and fail propagation policies
- [x] 6.5 Write permission-envelope tests and implement pre-import checks for capability, executor, network, filesystem, secret, environment, and Worker-selector grants
- [x] 6.6 Write payload validation tests and implement runtime request and response schema enforcement at capability boundaries

## 7. Plugin Deployment and Reconciliation

- [x] 7.1 Write desired/observed state tests and implement deployment generations and instance observed generations
- [x] 7.2 Write lifecycle transition tests and implement the kernel-owned component lifecycle state machine
- [x] 7.3 Write reconciliation idempotency tests and implement stable instance identity, placement, retry scheduling, and convergence
- [x] 7.4 Write enable, disable, upgrade, drain, and rollback plan tests and implement their reconciliation steps
- [x] 7.5 Write failure-isolation tests and implement structured blocked, failed, degraded, unavailable, and inconsistent states
- [x] 7.6 Write restart-during-reconcile tests and implement operation-journal recovery without duplicate component instances

## 8. Local Executors

- [x] 8.1 Define and run an executor conformance suite for probe, submit, observe, deduplicate, cancel, deadline, drain, health, and replacement
- [x] 8.2 Write Worker Thread fixture tests and implement `ThreadExecutor` with transferable binary support
- [x] 8.3 Write child-process fixture tests and implement `ProcessExecutor` with IPC framing and crash replacement
- [x] 8.4 Write executor-selection tests and implement support, permission, resource, availability, preference, and fallback evaluation
- [x] 8.5 Write task journal tests and implement stable task/attempt identity, terminal result recording, and retry policy
- [x] 8.6 Run the same echo, cancellation, timeout, crash, duplicate, and drain scenarios against thread and process executors

## 9. Remote Worker and WebSocket Transport

- [x] 9.1 Write message-codec tests and implement the versioned, sequenced, correlated Worker envelope
- [x] 9.2 Write authentication and handshake tests and implement Worker-initiated and Main-initiated sessions
- [x] 9.3 Write liveness tests and implement registration, capability advertisement, heartbeat, expiry, and session replacement
- [x] 9.4 Write remote executor conformance tests and implement assignment acknowledgement, progress, result, cancellation, and backpressure
- [x] 9.5 Write disconnect tests and implement unknown-state handling plus `cancel`, `finish-and-buffer`, and `finish-and-persist` orphan policies
- [x] 9.6 Write reconnect tests and implement running-attempt and buffered-result reconciliation with deduplication
- [x] 9.7 Run the complete executor echo, cancellation, timeout, crash, duplicate, and drain scenarios against `RemoteExecutor`

## 10. Plugin SDK and TestKit

- [x] 10.1 Write SDK type and runtime tests and implement functional component-definition APIs with no base class or decorator requirement
- [x] 10.2 Write context tests and implement minimal identity, config, logger, event, capability, lifecycle, runtime-info, and disposable access
- [x] 10.3 Implement public manifest, lifecycle, executor, Worker, state-store, and coordination-provider conformance test kits
- [x] 10.4 Write testkit self-tests proving third-party implementations can use only public exports
- [x] 10.5 Add the TypeScript echo plugin with no executor-specific code and lifecycle/test fixtures

## 11. CLI and Usable Vertical Slice

- [x] 11.1 Write CLI parser and exit-code tests and implement JSON and human-readable output contracts
- [x] 11.2 Write runtime command tests and implement local start, status, stop, and recovery commands
- [x] 11.3 Write plugin command tests and implement validate, pack, inspect, install, deploy, and status commands
- [x] 11.4 Write task command tests and implement run, status, wait, and cancel commands
- [x] 11.5 Write Worker command tests and implement independent-process remote Worker startup in both connection directions over real WebSocket sockets
- [x] 11.6 Build and run a real-process single-Main flow that packs, installs, deploys, executes the same echo plugin through all three executors, restarts Main, and verifies durable recovery
- [x] 11.7 Build and run a real-process two-Main PostgreSQL flow that proves leader-only work, takeover, stale-leader fencing, Worker reconnection, and final result uniqueness

## 12. Documentation, Review, and Release Evidence

- [ ] 12.1 Document architecture boundaries, package graph, state machines, protocol compatibility, threat model, and failure semantics
- [ ] 12.2 Document contributor setup, strict red-green-refactor workflow, plugin authoring, embedded deployment, and multi-Main deployment
- [x] 12.3 Add an executable release-verification command and authoritative GitHub Actions gates covering clean install, format, lint, typecheck, tests, integration, build, package reproducibility, single-Main smoke, and multi-Main takeover
- [ ] 12.4 Run mutation or fault-injection checks on lifecycle, fencing, deduplication, and permission gates and close material test gaps
- [ ] 12.5 Perform API, architecture, security, concurrency, and failure-recovery review and resolve all blocking findings
- [ ] 12.6 Produce `0.1.0-alpha.1` release notes with Node.js 26 LTS production gate and explicitly deferred capabilities
