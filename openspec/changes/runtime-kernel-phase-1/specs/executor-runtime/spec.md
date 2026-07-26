## ADDED Requirements

### Requirement: Uniform executor contract
Thread, process, and remote executors SHALL implement the same probe, submit, observe, cancel, drain, and health behavior for one execution request and result contract. At task admission, the runtime SHALL construct, canonicalize, fingerprint, and persist one immutable execution binding containing the target configuration, effective permission grants, capability definitions, and durable capability bindings. Restart dispatch SHALL reuse that binding, every executor boundary SHALL validate it against the target generation and artifact digest, and Workers SHALL consume it verbatim without synthesizing topology-specific configuration or grants.

#### Scenario: Run one component on every executor
- **WHEN** the same echo component and input are submitted to thread, process, and remote executors
- **THEN** each returns the same successful logical output with executor-specific metadata only

#### Scenario: Thread, process, and remote receive one identical immutable execution binding
- **WHEN** one component is admitted with the same target and deployment evidence for execution through thread, process, and remote executors
- **THEN** every executor receives the identical persisted configuration, grants, capability definitions, capability bindings, and fingerprint, and rejects a binding that does not match the target generation or artifact digest

### Requirement: Stable task and attempt identity
Every execution SHALL use a stable task ID and a unique attempt ID, and duplicate submission of the same pair SHALL NOT execute component logic twice.

#### Scenario: Duplicate assignment
- **WHEN** an executor receives the same task ID and attempt ID more than once
- **THEN** it returns or waits for the existing attempt result without starting a duplicate

### Requirement: Cancellation and deadline
Every executor SHALL accept cancellation and enforce execution deadlines with a structured terminal result.

#### Scenario: Cancel a running task
- **WHEN** a caller cancels an acknowledged running task
- **THEN** the executor requests cooperative cancellation, terminates it after the grace period if necessary, and reports `cancelled`

### Requirement: Indeterminate terminal observation
An executor SHALL report `indeterminate` when execution or terminal persistence may have completed but the authoritative result cannot be proven. An indeterminate result SHALL contain no output, SHALL include a structured diagnostic with `retryable: false`, and SHALL NOT authorize automatic retry.

#### Scenario: Terminal persistence completes after timeout
- **WHEN** a remote terminal persistence operation exceeds its timeout and may later become visible
- **THEN** the caller and `observe` receive one frozen `indeterminate` result without output and a later durable result is treated only as explicit recovery evidence

#### Scenario: Automatic retry considers an indeterminate result
- **WHEN** retry policy evaluates an `indeterminate` attempt
- **THEN** it does not create a replacement attempt unless an operator or explicit policy advances to a new attempt ID after accounting for possible prior side effects

### Requirement: Executor failure containment
An executor runtime SHALL record task failure and restore executor capacity after a thread exit, child-process crash, or remote-session loss.

#### Scenario: Child process crashes
- **WHEN** a plugin component terminates its child process
- **THEN** the attempt becomes `failed` with a process-exit diagnostic and a later task can run in a replacement process

### Requirement: Executor selection
The runtime SHALL select only an executor supported by the component, allowed by the permission grant, and capable of satisfying declared resource constraints.

#### Scenario: Preferred executor unavailable
- **WHEN** a preferred executor is unavailable but another declared supported executor satisfies all constraints
- **THEN** the runtime selects the compatible fallback

#### Scenario: No executor satisfies constraints
- **WHEN** no registered executor satisfies a component's support, permission, and resource constraints
- **THEN** the task is rejected before plugin code runs with candidate diagnostics
