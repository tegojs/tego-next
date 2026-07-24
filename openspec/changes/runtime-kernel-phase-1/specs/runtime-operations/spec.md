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

### Requirement: Layer-one dependency boundary
The first-layer packages SHALL NOT import Tego 1.x code or define frontend, HTTP routing, authentication, ACL, database-resource, cache, scheduler, workflow, or business-domain APIs.

#### Scenario: Architecture dependency check
- **WHEN** CI scans package imports and public exports
- **THEN** it fails if a forbidden layer-two, layer-three, frontend, or Tego 1.x dependency crosses into the kernel
