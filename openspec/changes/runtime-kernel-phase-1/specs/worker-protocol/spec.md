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
Every protocol message SHALL include protocol version, message ID, session ID, sequence, type, and correlation identity, and the receiver SHALL reject unsupported protocol versions or a missing correlation identity. A one-way or request envelope SHALL self-correlate, and a response SHALL correlate to its request. Replay retention SHALL associate each accepted message ID with a canonical content fingerprint: an identical replay MAY be ignored or return the existing outcome, while reuse of that message ID with different canonical envelope content SHALL close the session with a structured protocol violation.

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

#### Scenario: Same-message-ID replay with different content is rejected
- **WHEN** a peer reuses an accepted message ID in the same session with different canonical envelope content
- **THEN** the receiver rejects the equivocation and closes the session with a structured protocol violation while an identical replay remains deduplicated

### Requirement: Worker liveness and capabilities
The Worker SHALL register labels, resources, executors, and prepared artifacts and SHALL renew liveness through heartbeat messages.

#### Scenario: Heartbeat expires
- **WHEN** a Worker misses the configured heartbeat deadline
- **THEN** the Main marks it unavailable and stops assigning new tasks

### Requirement: Reconnect reconciliation
The protocol SHALL reconcile running attempts, buffered terminal results, Worker attempt-persistence availability, and exact component activation lifecycle state after a session reconnect. Main SHALL send every locally retained active or draining binding so a replacement Worker can validate and materialize it with the same admission state. Worker SHALL report every retained binding and lifecycle state so a replacement Main can recover exact draining teardown authority without trusting a Worker-reported active binding as a new Main activation. A higher transport epoch SHALL NOT by itself clear a persistence-unavailable latch or promote a draining activation back to active.

#### Scenario: Result completes while disconnected
- **WHEN** a task using `finish-and-buffer` completes after its session disconnects
- **THEN** the Worker sends the buffered result after reconnect and the Main records it once

#### Scenario: Persistence-latched Worker reconnects
- **WHEN** the same Worker runtime reconnects at a higher session epoch while its attempt persistence remains unavailable
- **THEN** Main keeps its remote executor degraded and unavailable for scheduling

#### Scenario: Recovered Worker runtime reconnects
- **WHEN** a higher-epoch Worker reconciliation explicitly reports attempt persistence available
- **THEN** Main may clear the prior persistence latch and advertise the remote executor as available

#### Scenario: Replacement Worker restores exact active component bindings
- **WHEN** a replacement Worker runtime reconnects while Main retains exact active component bindings for that Worker
- **THEN** reconciliation validates and materializes those bindings before Main accepts assignments for them

#### Scenario: Draining component replay cannot become active
- **WHEN** a higher-epoch session encounters a retained draining activation or Main retries that same activation
- **THEN** reconciliation preserves the non-accepting binding, the Worker rejects an active promotion, and Main does not publish the component as active

#### Scenario: Replacement Worker completes draining teardown
- **WHEN** Main retains a draining component binding and a replacement Worker runtime reconnects
- **THEN** the Worker materializes that exact binding as non-accepting so a later exact stop can release it

#### Scenario: Replacement Main completes retained Worker teardown
- **WHEN** a Worker retains a draining component binding and reconnects to a replacement authoritative Main
- **THEN** the Worker reports that exact non-accepting state and the Main hydrates enough lifecycle identity to issue the exact stop without restarting the Worker

#### Scenario: Worker rotates away from a follower endpoint
- **WHEN** a Worker connect list reaches an authenticated Main that rejects registration because it is not authoritative
- **THEN** the session reports a retryable endpoint-unavailable outcome, the Worker tries the next bounded URL, and authentication failures remain terminal

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
