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

### Requirement: Trusted local control endpoint
Access to the local control endpoint SHALL be treated as trusted. On Unix, the endpoint SHALL be an owner-only `0600` socket under an owner-private directory. Built-in Windows named pipes SHALL have no implemented ACL hardening in phase one.

#### Scenario: Unix local endpoint permissions
- **WHEN** a Main exposes its local control endpoint on Unix
- **THEN** the socket has mode `0600` and resides under an owner-private directory

#### Scenario: Windows local endpoint trust
- **WHEN** a Main exposes its built-in local control endpoint as a Windows named pipe
- **THEN** clients are treated as trusted and no implemented ACL hardening is claimed

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
