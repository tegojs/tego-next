## ADDED Requirements

### Requirement: Versioned capability identity
The runtime SHALL identify a capability by stable name and protocol version and SHALL validate provider and consumer payloads against runtime schemas.

#### Scenario: Incompatible protocol version
- **WHEN** a consumer requires a protocol version outside a provider's compatible range
- **THEN** that provider is excluded from resolution

### Requirement: Deterministic provider selection
The resolver SHALL use an explicit compatible binding first, auto-select exactly one compatible ready provider, and block an unbound requirement when multiple compatible providers remain.

#### Scenario: One compatible provider
- **WHEN** exactly one ready provider satisfies an unbound required capability
- **THEN** the resolver binds the consumer to that provider

#### Scenario: Ambiguous providers
- **WHEN** multiple ready providers satisfy an unbound required capability
- **THEN** the consumer deployment becomes `blocked` with the candidate provider identities

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
The runtime SHALL apply the consumer's declared loss policy when a bound provider stops being ready.

#### Scenario: Suspend on provider loss
- **WHEN** a ready consumer declares `suspend` and its provider becomes unavailable
- **THEN** the reconciler drains the consumer and marks it `suspended` until the provider recovers
