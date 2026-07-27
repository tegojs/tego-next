## ADDED Requirements

### Requirement: Versioned capability identity
The runtime SHALL identify a capability by stable name and protocol version. Every manifest capability provision SHALL name its provider component, declare a canonical non-empty method set, and contain inline request and response schemas. In phase one, only a task component MAY implement the provision's capability invocation handler; service-component hosting remains deferred.

#### Scenario: Incompatible protocol version
- **WHEN** a consumer requires a protocol version outside a provider's compatible range
- **THEN** that provider is excluded from resolution

### Requirement: Deterministic provider selection
The resolver SHALL use an explicit compatible binding first, auto-select exactly one compatible ready provider, and block an unbound requirement when multiple compatible providers remain. Once persisted, an automatic binding SHALL remain authoritative across provider loss and Main restart until desired deployment state changes it.

#### Scenario: One compatible provider
- **WHEN** exactly one ready provider satisfies an unbound required capability
- **THEN** the resolver binds the consumer to that provider

#### Scenario: Ambiguous providers
- **WHEN** multiple ready providers satisfy an unbound required capability
- **THEN** the consumer deployment becomes `blocked` with the candidate provider identities

#### Scenario: Automatic binding survives provider loss and restart
- **WHEN** a ready consumer was automatically bound to the only compatible provider and that provider becomes unavailable or Main restarts
- **THEN** the persisted binding remains authoritative and the consumer does not silently rebind to another provider

### Requirement: Required and optional dependencies
The resolver SHALL block a missing required capability and SHALL resolve a missing optional capability to `undefined`.

#### Scenario: Optional provider absent
- **WHEN** no compatible provider exists for an optional requirement
- **THEN** the consumer remains startable and receives no capability binding

### Requirement: Dependency ordering and cycle rejection
The resolver SHALL start providers before their consumers and SHALL reject cycles formed by required dependencies.

#### Scenario: Required dependency cycle
- **WHEN** deployment A requires a capability from B and B requires a capability from A
- **THEN** both deployments are blocked with a dependency-cycle diagnostic before either component starts

### Requirement: Provider loss propagation
The runtime SHALL apply each consumer requirement's declared `degrade`, `suspend`, or `fail` loss policy when its persisted provider stops being ready. `degrade` SHALL change the current activation's lifecycle observation, while `suspend` and `fail` SHALL drain and stop the current activation before publishing the corresponding deployment observation. The reconciler SHALL merge simultaneous and sequential losses into one durable loss decision and SHALL select `fail` before `suspend` before `degrade` without replacing an escalated action with a weaker action during the same loss episode. A durable logical binding SHALL identify the provider independently of its deployment generation; recovery MAY use a compatible, ready higher generation of that same provider identity after transaction-time generation, provision, readiness, binding-revision, and provider-component evidence is fenced.

#### Scenario: Provider loss suspends deployment after activation stops
- **WHEN** a ready consumer declares `suspend` and its provider becomes unavailable
- **THEN** the reconciler transitions the current activation through `draining`, `stopping`, and `stopped`, then records the deployment observation as `suspended` until the provider recovers

#### Scenario: Multiple provider losses use deterministic precedence
- **WHEN** one ready consumer simultaneously loses requirements declaring `degrade`, `suspend`, and `fail`
- **THEN** the reconciler applies only `fail`, transitions the current activation through `draining`, `stopping`, and `stopped`, and records the deployment observation as `failed`, independent of requirement order

#### Scenario: Sequential loss escalates to the strongest currently lost policy
- **WHEN** a consumer already affected by one provider loss observes another lost requirement with a stronger policy in a later reconciliation, including after restart
- **THEN** the reconciler atomically merges the losses, applies the strongest currently lost policy using `fail` before `suspend` before `degrade`, and does not replace the escalated action with a weaker action during that loss episode

#### Scenario: Degraded provider recovers
- **WHEN** a consumer degraded for provider loss observes its persisted provider ready again
- **THEN** the same component activation returns to `ready` and application readiness is recomputed

#### Scenario: Suspended deployment starts next activation
- **WHEN** a deployment observed as `suspended` sees its persisted provider become ready again
- **THEN** the reconciler creates and starts the next activation in the same desired generation while the prior activation remains `stopped`

#### Scenario: Same provider identity may recover through a compatible higher provider generation
- **WHEN** a consumer degraded or suspended by provider loss observes a compatible ready higher deployment generation of the same durably bound provider identity
- **THEN** recovery fences the current provider evidence and restores the consumer without changing its logical provider binding

#### Scenario: Failed deployment requires a new generation
- **WHEN** a deployment observed as `failed` for provider loss sees its provider become ready without a desired deployment change
- **THEN** its prior activation remains `stopped` and the deployment observation remains `failed` until a higher desired generation is persisted

### Requirement: Runtime-owned capability invocation
The runtime SHALL authorize a capability call against the consumer's permission grant and durable binding, resolve the exact ready provider deployment, activation, provision, component, and method, validate the request before provider code runs, dispatch to the phase-one task component's capability invocation handler through an internal exact-target execution using the provider's immutable execution binding, and validate the response before returning it. The exact consumer identity and caller invocation ID SHALL derive one durable invocation operation identity that persists the canonical fingerprint and terminal or indeterminate evidence across memory eviction, Main restart, and authority transfer. Main SHALL send an exact immutable activation binding before a remote component becomes ready and SHALL mediate remote consumer and provider calls; a Worker SHALL NOT resolve providers or grant permissions locally.

#### Scenario: Capability calls route to the exact ready provider and validate request/response schemas
- **WHEN** an authorized consumer invokes a declared capability method through a durable binding whose exact provider activation is ready
- **THEN** the runtime validates the request, dispatches only to that provider component and activation with its immutable execution binding, validates the response, and rejects any changed, unavailable, or schema-invalid target

#### Scenario: Capability invocation replays after Main restart
- **WHEN** the same exact consumer repeats a completed invocation ID and canonical payload after memory eviction or Main restart
- **THEN** the runtime returns the durable terminal result without executing provider code again

#### Scenario: Capability invocation is uncertain across an executing restart
- **WHEN** a replacement Main observes durable executing evidence without a terminal result for the same invocation ID and fingerprint
- **THEN** it reports the invocation as indeterminate and does not execute provider code again

#### Scenario: Capability invocation identity cannot equivocate
- **WHEN** the same exact consumer reuses an invocation ID with a different canonical payload
- **THEN** the runtime rejects it as an idempotency conflict before provider dispatch
