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
