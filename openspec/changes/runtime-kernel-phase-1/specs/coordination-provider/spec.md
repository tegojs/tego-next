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
