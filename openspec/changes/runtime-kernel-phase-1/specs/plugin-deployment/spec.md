## ADDED Requirements

### Requirement: Separate desired and observed plugin state
The runtime SHALL persist mutable `PluginDeployment` desired state separately from immutable manifests and installations, SHALL track an observed generation and activation for every component instance, and SHALL publish deployment observations separately from component activation lifecycle. An activation SHALL be a persisted unsigned decimal string scoped within `(applicationId, pluginId, componentId, generation)` and SHALL participate in stable instance, operation, and message identities. Provider-loss `suspend` and `fail` actions SHALL transition the affected activation through `draining`, `stopping`, and `stopped`; the deployment observation, not the activation lifecycle, SHALL become `suspended` or `failed`.

#### Scenario: Deployment generation changes
- **WHEN** an administrator changes a deployment
- **THEN** its generation increments and old instances remain out of date until they report the new observed generation

#### Scenario: Activation identity is persisted
- **WHEN** the reconciler creates a component activation for a desired deployment generation
- **THEN** its unsigned decimal activation string is persisted within `(applicationId, pluginId, componentId, generation)` and is used by stable instance, operation, and message identities

#### Scenario: Suspended deployment is observed after activation stops
- **WHEN** provider loss selects `suspend` for a running activation
- **THEN** the activation transitions through `draining`, `stopping`, and `stopped`, then the deployment observation records `suspended` without changing the desired generation

### Requirement: Pre-execution deployment gate
The reconciler SHALL validate artifact availability, runtime compatibility, capability bindings, permission grants, dependency cycles, placement, and executor support before loading plugin code.

#### Scenario: Granted permissions exceed request
- **WHEN** a deployment grants a permission that the manifest did not request
- **THEN** the deployment becomes `blocked` with a permission-envelope diagnostic before component import

#### Scenario: Required capability is missing
- **WHEN** a deployment requires a capability with no compatible ready provider
- **THEN** the deployment becomes `blocked` and its component is not started

### Requirement: Kernel-owned component lifecycle
The kernel SHALL enforce legal transitions through `created`, `preparing`, `starting`, `ready`, `degraded`, `draining`, `stopping`, `stopped`, and `failed`.

#### Scenario: Plugin attempts an illegal transition
- **WHEN** a component or driver requests a transition not allowed from its current state
- **THEN** the runtime rejects it and records a lifecycle diagnostic

### Requirement: Reconciliation convergence
The reconciler SHALL repeatedly converge observed instances to desired deployment state and SHALL make reconciliation operations idempotent.

#### Scenario: Reconcile the same generation twice
- **WHEN** the same deployment generation is reconciled after an interrupted reconcile
- **THEN** the runtime does not create a duplicate live component instance

### Requirement: Failure isolation
A non-essential plugin failure SHALL NOT terminate the kernel, while an essential plugin failure SHALL only prevent application readiness.

#### Scenario: Component start throws
- **WHEN** a non-essential component throws during start
- **THEN** its instance becomes `failed`, diagnostics identify the plugin and component, and the kernel remains running
