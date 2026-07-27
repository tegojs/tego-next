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
GitHub Actions SHALL be the authoritative phase-one acceptance environment and SHALL execute real process-level single-Main and multi-Main system tests. The CI workflow SHALL run automatically for pull requests targeting `main` and pushes to `main`, while retaining manual dispatch. Its required quality, PostgreSQL integration, system-E2E, and deterministic package-reproducibility gates SHALL be structurally validated as active, ordered, bounded steps and SHALL fail acceptance if disabled, moved outside the required job, commented out, or configured to continue on error.

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

### Requirement: Layer-one dependency boundary
The first-layer packages SHALL NOT import Tego 1.x code or define frontend, HTTP routing, authentication, ACL, database-resource, cache, scheduler, workflow, or business-domain APIs.

#### Scenario: Architecture dependency check
- **WHEN** CI scans package imports and public exports
- **THEN** it fails if a forbidden layer-two, layer-three, frontend, or Tego 1.x dependency crosses into the kernel
