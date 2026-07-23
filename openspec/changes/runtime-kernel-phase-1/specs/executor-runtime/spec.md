## ADDED Requirements

### Requirement: Uniform executor contract
Thread, process, and remote executors SHALL implement the same probe, submit, observe, cancel, drain, and health behavior for one execution request and result contract.

#### Scenario: Run one component on every executor
- **WHEN** the same echo component and input are submitted to thread, process, and remote executors
- **THEN** each returns the same successful logical output with executor-specific metadata only

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
