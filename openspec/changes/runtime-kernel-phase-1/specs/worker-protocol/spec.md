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
Every protocol message SHALL include protocol version, message ID, session ID, sequence, type, and correlation identity, and the receiver SHALL reject unsupported protocol versions or a missing correlation identity. A one-way or request envelope SHALL self-correlate, and a response SHALL correlate to its request.

#### Scenario: Unsupported protocol version
- **WHEN** a peer sends an envelope with an unsupported major protocol version
- **THEN** the session closes with a structured incompatibility reason

#### Scenario: One-way message self-correlates
- **WHEN** either peer sends a one-way or request envelope
- **THEN** `correlationId` equals that envelope's `messageId`

#### Scenario: Response correlates to request
- **WHEN** a peer sends a response to a received request
- **THEN** the response `correlationId` equals the request `messageId`

#### Scenario: Missing correlation identity
- **WHEN** a peer sends a protocol-1.0 envelope without `correlationId`
- **THEN** the receiver rejects the envelope as an invalid protocol message

### Requirement: Worker liveness and capabilities
The Worker SHALL register labels, resources, executors, and prepared artifacts and SHALL renew liveness through heartbeat messages.

#### Scenario: Heartbeat expires
- **WHEN** a Worker misses the configured heartbeat deadline
- **THEN** the Main marks it unavailable and stops assigning new tasks

### Requirement: Reconnect reconciliation
The protocol SHALL reconcile running attempts, buffered terminal results, and Worker attempt-persistence availability after a session reconnect. A higher transport epoch SHALL NOT by itself clear a persistence-unavailable latch.

#### Scenario: Result completes while disconnected
- **WHEN** a task using `finish-and-buffer` completes after its session disconnects
- **THEN** the Worker sends the buffered result after reconnect and the Main records it once

#### Scenario: Persistence-latched Worker reconnects
- **WHEN** the same Worker runtime reconnects at a higher session epoch while its attempt persistence remains unavailable
- **THEN** Main keeps its remote executor degraded and unavailable for scheduling

#### Scenario: Recovered Worker runtime reconnects
- **WHEN** a higher-epoch Worker reconciliation explicitly reports attempt persistence available
- **THEN** Main may clear the prior persistence latch and advertise the remote executor as available

### Requirement: Orphan policy
The runtime SHALL apply `cancel`, `finish-and-buffer`, or `finish-and-persist` when a Worker loses its Main session.

#### Scenario: Cancel orphaned work
- **WHEN** a session is lost for a task whose orphan policy is `cancel`
- **THEN** the Worker cancels the attempt and reports the terminal state on reconnect

### Requirement: Real process transport acceptance
The certified WebSocket transport SHALL pass black-box system tests with Main and Worker running as independent operating-system processes.

#### Scenario: Independent Worker process
- **WHEN** a Worker process connects to a Main process through a real WebSocket TCP endpoint
- **THEN** authentication, registration, heartbeat, assignment, acknowledgement, execution, and terminal-result delivery cross only the public transport and runtime boundaries

#### Scenario: Network disconnect and reconnect
- **WHEN** the system test interrupts the real WebSocket connection while an attempt is running
- **THEN** the configured orphan policy is applied and reconnect reconciliation produces no duplicate authoritative result
