## ADDED Requirements

### Requirement: Local runtime operations
The CLI SHALL start, inspect, and stop a local runtime and SHALL return machine-readable output and non-zero exit codes for failed operations. Each status request SHALL read current durable installation, deployment, and typed deployment-observation records for the configured application and SHALL compute counts and essential readiness from those records rather than a startup snapshot. Leaders and followers SHALL expose the same typed observation fields and status semantics.

#### Scenario: Inspect an empty runtime
- **WHEN** an operator requests JSON status from a running empty runtime
- **THEN** the CLI returns runtime identity, mode, liveness, readiness, driver health, deployment counts, Worker counts, and task counts

#### Scenario: Runtime status reflects live durable deployment observations on leaders and followers
- **WHEN** durable deployment observations change after runtime startup or are read by a multi-Main follower
- **THEN** the next status response reports current typed deployment identities, generations, statuses, diagnostics, timestamps, counts, and essential readiness without recreating the runtime

### Requirement: Plugin development operations
The CLI SHALL validate, pack, inspect, install, deploy, and report status for a plugin using the same contracts as the kernel. In multi-Main mode, a follower MAY admit immutable content-addressed artifact bytes from a trusted local `plugin install` request, but it SHALL NOT create or change installation, deployment, operation, or task state without fenced leader authority.

#### Scenario: Validate before pack
- **WHEN** an invalid plugin project is passed to `tego plugin pack`
- **THEN** the command fails with manifest and build diagnostics and creates no artifact

#### Scenario: Follower receives immutable artifact ingress
- **WHEN** a trusted local client sends `plugin install <path>` to a multi-Main follower
- **THEN** content-addressed artifact bytes may be ingested, installation and deployment records do not change, and the operation returns a not-leader diagnostic

### Requirement: Task operations
The CLI SHALL run, inspect, wait for, and cancel tasks while preserving structured outputs and terminal error details.

#### Scenario: Run example task
- **WHEN** an operator runs the installed echo component with JSON input
- **THEN** the CLI waits for a terminal result and prints the echoed output

#### Scenario: Inspect an indeterminate task
- **WHEN** an operator inspects a task whose persistence boundary could not prove its authoritative outcome
- **THEN** the CLI/API and audit output report `indeterminate`, omit task output, preserve the non-retryable diagnostic, and do not present it as an ordinary failure

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

### Requirement: CI-authoritative system acceptance
GitHub Actions SHALL be the authoritative phase-one acceptance environment and SHALL execute real process-level single-Main and multi-Main system tests plus a real Windows local-control security gate. The CI workflow SHALL run automatically for pull requests targeting `main` and pushes to `main`, while retaining manual dispatch. Its required quality, Windows control, PostgreSQL integration, system-E2E, and deterministic package-reproducibility gates SHALL be structurally validated as active, ordered, bounded steps and SHALL fail acceptance if disabled, moved outside the required job, commented out, configured to continue on error, or able to succeed without executing its target test.

#### Scenario: Real single-Main executor parity
- **WHEN** CI starts one Main and an independent Worker process, connects them through a real WebSocket socket, and deploys the echo plugin
- **THEN** the same plugin component executes successfully through thread, process, and remote executors without executor-specific plugin code

#### Scenario: Durable restart recovery
- **WHEN** CI stops and restarts Main after deployment and task execution
- **THEN** Main reconstructs installed artifacts, desired deployments, observed instances, operations, and task results before reporting recovery complete

#### Scenario: Real multi-Main takeover
- **WHEN** CI starts two Main processes against one PostgreSQL database and terminates the fenced leader during an active topology
- **THEN** the follower becomes leader, the stale leader cannot commit control-plane state, the Worker reconnects, and the task has exactly one authoritative terminal result

#### Scenario: Actionable system-test failure
- **WHEN** a system test fails, times out, or leaks a process
- **THEN** CI fails the job and preserves per-process logs, structured diagnostics, and test results as workflow artifacts

#### Scenario: CI required gates cannot be disabled or made continue-on-error
- **WHEN** a required verification or deterministic package-reproducibility step is disabled, moved outside its required job, commented out, or configured with `continue-on-error`
- **THEN** the CI contract check fails with `ci_contract_incomplete` before the workflow can serve as phase-one acceptance evidence

#### Scenario: Real Windows control boundary
- **WHEN** the `windows-control` job runs on `windows-2025`
- **THEN** it uses exact Node.js 26.5.0 and npm 11.13.0, applies and inspects the named-pipe descriptor, completes a current-user status request, proves cleanup, and cannot pass by skipping or selecting no tests

### Requirement: Fail-closed local control access
The built-in local control endpoint SHALL dispatch no request until its operating-system boundary is
verified. Unix SHALL require an owner-private parent directory, runtime-user ownership, and exact
mode `0600`. On Windows, a dedicated broker process SHALL own the public named pipe from creation
through shutdown and create every instance with the current user as owner, a protected DACL, and
explicit full pipe access only for the current user, LocalSystem, and Administrators, with no
inherited, deny, broad, duplicate, or unexpected ACE. The alpha SHALL support `win32-x64` only and
deliver auditable PowerShell plus embedded C# source. The broker SHALL validate its live
server-handle descriptor before `READY`, bind cleanup to a stable synchronization handle for the
exact parent process, and provide no fallback to an unhardened Node named pipe.

#### Scenario: Windows descriptor cannot be proven safe
- **WHEN** creating or reading back the Windows named-pipe descriptor, decoding or validating the broker `READY` descriptor, or broker startup fails or times out
- **THEN** startup rolls back, every queued socket closes, and no control request is dispatched

### Requirement: Deterministic readiness and test cleanup
Process-harness ownership SHALL be established immediately after spawn and SHALL use bounded
platform process-tree capture, termination, and proof before readiness can return or fail. Test
cleanup SHALL preserve the primary error before cleanup errors. PostgreSQL test namespace cleanup
SHALL accept only the destructive-test namespace shape, use one bounded transaction, delete only
the fixed Phase 1 table allowlist with parameterized exact namespace predicates, preserve migration
metadata, and leave every neighboring namespace unchanged.

#### Scenario: Readiness fails after descendants start
- **WHEN** a managed process times out or its readiness predicate rejects after creating descendants
- **THEN** cleanup terminates and proves the owned process tree gone, finalizes diagnostics, and reports the readiness failure before any cleanup failure

#### Scenario: One disposable PostgreSQL namespace is cleaned
- **WHEN** cleanup receives a namespace matching `^test_[a-z0-9]+_[a-z0-9_]+$`
- **THEN** it deletes only rows whose `driver_namespace = $1` in the fixed Phase 1 tables, including `tego_artifact_namespace_usage`, without changing `tego_schema_migrations` or neighboring namespaces

### Requirement: Public alpha package channel
The nine public runtime packages SHALL use exact version `2.0.0-alpha.1` and exact-version internal
dependencies. Publication SHALL target only `https://registry.npmjs.org/` with public access and the
`alpha` dist-tag. Verification SHALL require `alpha -> 2.0.0-alpha.1` and `latest -> absent`; an
unqualified install SHALL NOT resolve to this alpha. npm publication SHALL remain separate from Git
tagging and GitHub prerelease creation.

#### Scenario: Consumer opts into the runtime alpha
- **WHEN** a consumer runs `npm install @tego/runtime@alpha`
- **THEN** npm may resolve `2.0.0-alpha.1` without changing the stable `latest` channel

### Requirement: Resumable release verification
The release command SHALL expose separate preflight, pack, publish, and registry-verification
modes. A release manifest SHALL bind all nine exact packages, dependency topology, target Git SHA,
official registry, tarball paths, and SHA-512 integrities. Publish SHALL require a single-use
successful preflight receipt for the same immutable inputs and SHALL resume only across already
published packages whose complete registry identity, dependency metadata, integrity, `alpha` tag,
and absent `latest` tag match.

#### Scenario: Publication is interrupted after some packages
- **WHEN** the operator reruns publication from the unchanged verified source and the same `targetSha`
- **THEN** the command repacks the current source tree into the current invocation's artifact directory, compares the new local integrities with registry state, skips exact matching packages, continues missing packages in dependency order, and fails closed on any conflict or incomplete evidence

### Requirement: Layer-one dependency boundary
The first-layer packages SHALL NOT import Tego 1.x code or define frontend, HTTP routing, authentication, ACL, database-resource, cache, scheduler, workflow, or business-domain APIs.

#### Scenario: Architecture dependency check
- **WHEN** CI scans package imports and public exports
- **THEN** it fails if a forbidden layer-two, layer-three, frontend, or Tego 1.x dependency crosses into the kernel
