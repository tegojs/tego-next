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
The protocol SHALL reconcile running attempts, buffered terminal results, Worker attempt-persistence availability, and exact component activation lifecycle state after a session reconnect. Main SHALL send every Main-originated active or draining binding so a replacement Worker can validate and materialize it with the same admission state. Worker SHALL report every retained binding and lifecycle state so a replacement Main can recover an exact draining teardown candidate without trusting a Worker-reported binding as transferable Main activation authority. Worker-originated candidates SHALL NOT be replayed to another Worker and SHALL authorize stop only when the Main supplies the matching durable target and binding fingerprint. A replacement Main MAY adopt a Worker-retained active activation only as a non-accepting, non-transferable teardown candidate when the Main supplies the complete matching durable activation and binding fingerprint. Each side SHALL validate the complete activation inventory before committing lifecycle state or invoking materialization callbacks. A higher transport epoch SHALL NOT by itself clear a persistence-unavailable latch or promote a draining activation back to active. A Main-authorized teardown SHALL treat an authenticated `not active` response for the same exact target as an idempotent success without weakening ordinary active-component drain validation.

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
- **THEN** the Worker reports that exact non-accepting state and the Main retains a non-transferable teardown candidate that accepts only an exact stop with the Main-derived durable target and binding fingerprint

#### Scenario: Replacement Main terminates a pre-drain active activation
- **WHEN** authority transfers after an old component binding is durably retained but before its Worker activation enters draining
- **THEN** the replacement Main adopts the complete exact durable activation only for teardown, rejects task and capability admission, and sends the exact binding fingerprint on drain and stop

#### Scenario: Concurrent teardown already removed the exact activation
- **WHEN** a Main-authorized termination retry reaches an authenticated Worker after the exact activation was already stopped
- **THEN** the missing exact target satisfies the teardown postcondition while a missing or mismatched target still fails ordinary active-component lifecycle operations

#### Scenario: Historical task result survives component teardown
- **WHEN** a buffered remote attempt completes while its historical component activation is being stopped
- **THEN** Main observes or resumes that existing exact attempt through a non-admitting recovery executor without submitting a new attempt or exposing capability admission

#### Scenario: Rejected inventory has no lifecycle side effects
- **WHEN** either peer receives an activation inventory containing a later duplicate, conflict, invalid target, or invalid lifecycle state
- **THEN** it rejects the complete inventory without retaining earlier entries or invoking their materialization callbacks

#### Scenario: Worker rotates away from a follower endpoint
- **WHEN** a Worker connect list reaches an authenticated Main that rejects registration because it is not authoritative
- **THEN** the session reports a retryable endpoint-unavailable outcome, the Worker tries the next bounded URL, and authentication failures remain terminal

### Requirement: Bounded durable attempt recovery
The attempt store SHALL expose a bounded recovery inventory containing only non-expired attempts plus a durable highest-session-epoch watermark. Main and Worker SHALL request at most one item beyond their configured active-inventory limit, reject an oversized or expired recovery response before adopting any record, and validate every returned record and revision before recovery. Expired identity tombstones SHALL remain available to exact attempt lookup without consuming active restart inventory. A conditional-commit conflict SHALL be authoritative only when the reloaded record has the same immutable identity and a revision strictly greater than the caller's prior revision.

#### Scenario: Historical tombstones do not exhaust restart
- **WHEN** a Worker has more expired identity tombstones than its active recovery limit and only a bounded number of non-expired attempts
- **THEN** restart recovers the non-expired attempts and epoch watermark without loading the tombstones into active inventory

#### Scenario: Nonconforming recovery response fails closed
- **WHEN** an attempt store returns more recovery records than requested or includes an expired record in active recovery
- **THEN** Main or Worker rejects recovery before parsing or adopting any attempt

#### Scenario: Conditional-conflict reload must advance
- **WHEN** a conditional attempt commit reports a conflict and reload returns an equal or lower revision
- **THEN** Main or Worker rejects the stale record without adopting its state, cancellation, epoch, or terminal result

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
