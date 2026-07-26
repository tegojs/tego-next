## ADDED Requirements

### Requirement: Versioned capability identity
The runtime SHALL identify a capability by stable name and protocol version and SHALL validate provider and consumer payloads against runtime schemas.

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
The runtime SHALL apply each consumer requirement's declared `degrade`, `suspend`, or `fail` loss policy when its persisted provider stops being ready. When simultaneous provider losses require different deployment actions, the reconciler SHALL apply exactly one action using `fail` before `suspend` before `degrade`.

#### Scenario: Suspend on provider loss
- **WHEN** a ready consumer declares `suspend` and its provider becomes unavailable
- **THEN** the reconciler drains the consumer and marks it `suspended` until the provider recovers

#### Scenario: Multiple provider losses use deterministic precedence
- **WHEN** one ready consumer simultaneously loses requirements declaring `degrade`, `suspend`, and `fail`
- **THEN** the reconciler applies one deployment action using `fail` before `suspend` before `degrade`, independent of requirement order

#### Scenario: Degraded provider recovers
- **WHEN** a consumer degraded for provider loss observes its persisted provider ready again
- **THEN** the same component activation returns to `ready` and application readiness is recomputed

#### Scenario: Suspended provider recovers
- **WHEN** a suspended consumer's persisted provider becomes ready again
- **THEN** the reconciler starts a new activation in the same desired generation after the prior activation has drained and stopped

#### Scenario: Failed provider recovers
- **WHEN** a consumer failed for provider loss and the provider becomes ready without a desired deployment change
- **THEN** the consumer remains failed and stopped until a higher desired generation is persisted
