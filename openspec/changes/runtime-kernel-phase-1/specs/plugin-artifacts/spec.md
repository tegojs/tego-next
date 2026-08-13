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

### Requirement: Immutable artifact ingress
A multi-Main node MAY admit content-addressed immutable artifact bytes through its trusted local endpoint without fenced semantic-write authority. Admitted bytes consume the configured namespace quota but SHALL NOT by themselves create or change installation, deployment, operation, or task state.

#### Scenario: Follower admits artifact bytes only
- **WHEN** a follower receives a valid plugin artifact from a trusted local client
- **THEN** it may add the immutable content-addressed bytes to shared artifact storage without creating installation, deployment, operation, or task state

### Requirement: Bounded artifact storage
Every artifact store SHALL enforce a finite positive-safe-integer `maxArtifactBytes` and
`maxNamespaceBytes`, with `maxNamespaceBytes >= maxArtifactBytes`. The default limits SHALL be
256 MiB per artifact and 4 GiB per namespace. Construction-time partial overrides SHALL merge with
those defaults. A duplicate digest SHALL consume no additional committed capacity; a rejected,
failed, cancelled, or closed write SHALL release every non-durable reservation.

#### Scenario: Artifact exceeds its configured limit
- **WHEN** a streamed artifact crosses `maxArtifactBytes`
- **THEN** the store rejects it with `ARTIFACT_SIZE_LIMIT_EXCEEDED` before publication

#### Scenario: Concurrent distinct artifacts exceed namespace capacity
- **WHEN** concurrent distinct writes would make committed plus reserved bytes exceed `maxNamespaceBytes`
- **THEN** admission serializes so at most the writes within capacity commit and every rejected write reports `ARTIFACT_NAMESPACE_QUOTA_EXCEEDED`

#### Scenario: Filesystem store reconstructs local usage
- **WHEN** one filesystem artifact store instance restarts
- **THEN** it reconstructs committed capacity from canonical stable artifact files and enforces committed plus in-process reserved bytes for that instance

#### Scenario: PostgreSQL stores share durable quota
- **WHEN** independent PostgreSQL stores write to the same PostgreSQL namespace
- **THEN** one locked `tego_artifact_namespace_usage` row admits bytes transactionally with artifact insertion and prevents cross-process overcommit

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
