# Runtime kernel architecture

This document describes the implemented phase-one kernel. It complements the
[deployment guide](../operations/deployment-topologies.md) and
[threat model](../security/threat-model.md).

## Scope and forbidden APIs

Tego Next implements layer one: runtime contracts, plugin artifacts and desired
state, reconciliation, execution, coordination, persistence, and Worker
transport. Drivers are bootstrap dependencies. They do not register business
capabilities, and ordinary plugin code does not run until bootstrap and
recovery complete.

The kernel intentionally has no Tego 1.x compatibility surface. First-layer
packages must not define or import layer-two or layer-three APIs, including
frontend assets, HTTP routing, authentication, ACL, cache, workflow, scheduler,
datasource or database-resource abstractions, and business-domain APIs. The
architecture check also rejects outward workspace edges, undeclared computed
imports, and forbidden import fragments. The WebSocket transport has one
confined `node:http` import for its upgrade listener; that exception does not
create an HTTP application API.

The CLI composes public packages. It is an operator and development surface,
not a privileged back door into the kernel.

## Package graph and dependency direction

Production dependencies point inward:

```text
examples/echo-plugin -> @tegojs/plugin-sdk -> @tegojs/contracts

@tegojs/runtime -------------> @tegojs/contracts
@tegojs/drivers-local -------> @tegojs/contracts
@tegojs/drivers-postgres ----> @tegojs/contracts
@tegojs/transport-websocket -> @tegojs/contracts
@tegojs/testkit -------------> @tegojs/contracts
@tegojs/executor-node -------> @tegojs/contracts
            |
            +---------------> @tegojs/plugin-sdk

@tegojs/cli -> all first-layer implementation packages
```

`@tegojs/contracts` exports data contracts, validators, driver interfaces, and
diagnostics. It has no dependency on another Tego workspace. `@tegojs/runtime`
owns lifecycle, reconciliation, artifact validation, capability resolution,
permission decisions, and task persistence while depending only on contracts
at runtime. Local and PostgreSQL drivers implement contract interfaces.
Executors and transport implement execution boundaries. `@tegojs/testkit`
provides public conformance suites.

The executor-to-SDK edge is narrowly allowed for loading the component
definition protocol. Test-only dependencies on `@tegojs/testkit` are also
allowed. Other first-layer packages may depend on `@tegojs/contracts`, but not
on sibling implementations. `@tegojs/cli` is the composition root and may
depend on first-layer packages, but not on examples.

## Runtime topology

A Main owns the control plane. It opens explicit drivers, recovers durable
records, campaigns for authority, reconciles desired deployments, and assigns
tasks only while authoritative.

In `single-main`, local coordination grants authority immediately. SQLite
stores control-plane state, the filesystem stores immutable artifacts, and the
local process host runs child executors.

In `multi-main`, PostgreSQL replaces local state, artifact, and coordination
drivers. Every Main can report diagnostics. Exactly the Main holding the
current leadership epoch performs mutations, reconciliation, Worker
registration, and assignment. See
[Deployment topologies](../operations/deployment-topologies.md) for the
operator view.

Components execute through one request/result contract:

- `thread` uses `node:worker_threads`;
- `process` uses an authenticated child-process channel;
- `remote` uses the versioned WebSocket Worker protocol.

The runtime placement preference is process, then thread, then remote. Selection
still requires manifest support, an explicit permission grant, healthy
capacity, and sufficient declared resources.

## State machines

### Deployment state

A manifest is immutable author data. An installation is immutable and keyed by
plugin ID, version, and SHA-256 artifact digest. A deployment is mutable desired
state for one application.

`PluginDeployment.state` is either `active` or `disabled`. Each accepted change
increments `generation`. Component instances record `deploymentGeneration` and
`observedGeneration`; an instance is current only when these match. Reconcile
effects are `prepare`, `start`, `drain`, and `stop`.

The persisted deployment observation is derived rather than directly set by a
plugin. Its status is `blocked`, `converging`, `degraded`, `failed`,
`inconsistent`, `ready`, or `unavailable`. Compatibility, artifact,
capability, permission, placement, and executor checks run before component
import. Repeating reconciliation for the same generation uses stable instance,
operation, and message identities so it converges without a duplicate live
instance.

### Runtime lifecycle

The normal start path is:

```text
created -> opening -> recovering -> electing -> running
```

The normal stop path is:

```text
running -> draining -> stopping -> stopped
```

Stopping may also begin from `created`, `opening`, `recovering`, or `electing`.
Operational failures may move any active start/run/stop state to `failed`;
`failed` may then move to `stopping`. `stopped` is terminal. Illegal
transitions produce `LIFECYCLE_TRANSITION_INVALID`.

The runtime opens mutations only while it holds authority. A multi-Main
follower can remain `running` and diagnosable without an `authority` field in
status.

### Component lifecycle

The normal component path is:

```text
created -> preparing -> starting -> ready
ready <-> degraded
ready|degraded -> draining -> stopping -> stopped
```

`created`, `preparing`, and `starting` may drain during supersession or
shutdown. Active states may fail. A failed instance may retry preparation or
start, or continue through drain/stop. The kernel owns every transition; a
plugin cannot set its own lifecycle state.

A non-essential component failure does not stop the kernel. An essential
deployment that is not ready makes application readiness false while kernel
liveness and diagnostics remain available.

### Task lifecycle

The persisted task record normally moves through:

```text
accepted -> running -> terminal
    `----------------> terminal
```

One `taskId` identifies the logical task and one `attemptId` identifies the
attempt. Reusing the pair with a different request is an idempotency conflict;
reusing it with the same request observes the existing attempt.

Terminal execution statuses are `succeeded`, `failed`, `cancelled`,
`timed-out`, `rejected`, and `indeterminate`. Cancellation records durable
intent before calling the executor. Deadlines and forced cancellation yield
structured terminal results.

### Worker session and remote attempt lifecycle

A Worker session starts as `authenticating`. Successful mutual proof,
registration, and epoch allocation move it to `ready`. Heartbeat expiry or
replacement moves it to `unavailable`; transport closure, protocol error, or
explicit close moves it to `closed`. Closed and unavailable sessions accept no
new assignments.

A remote attempt uses the more detailed states:

```text
assigned -> acknowledged -> running -> terminal
                    \-> unknown
unknown -> assigned|acknowledged|running|terminal
unknown -> expired
```

`unknown` is non-terminal. It means the Main cannot yet prove what happened
after session loss. Reconnect inventory reconciles running attempts, buffered
terminal results, attempt revisions, and the Worker's persistence
availability.

## Persistence, revisions, and fencing

State keys contain a namespace, collection, and ID. Stored values carry
monotonically increasing revisions. Transactions support expected-revision
compare-and-set, optional idempotency keys and fingerprints, operation journal
entries, and an outbox. Watch notifications are wake-up signals; consumers
resume from a persisted revision and scan committed changes instead of relying
on notification delivery.

Single-Main state is stored in `state.sqlite`. On restart the runtime recovers
installations, deployments, non-terminal operation journal entries, and task
records before accepting mutations or new tasks. Prepared artifact files are a
cache; the immutable artifact store and state records are authoritative.

Multi-Main control-plane writes include `{resource, epoch}` fencing. PostgreSQL
allocates a monotonically increasing epoch when leadership changes. A stale
leader cannot commit a fenced state transaction after a newer leader takes
over. Worker session epochs and remote attempt revisions separately fence
replaced sessions and conditional attempt updates.

## Worker protocol compatibility and recovery

The only implemented Worker protocol version is `1.0`. Every control envelope
contains the protocol version, message ID, session ID, sequence, type,
timestamp, payload, and optional correlation and binary metadata. Unsupported
versions fail with `PROTOCOL_VERSION_UNSUPPORTED`; there is no version
negotiation or compatibility downgrade.

The session authenticates a Worker identity with a bootstrap credential before
registration or task messages. Either endpoint may initiate the TCP/WebSocket
connection, but the logical handshake and session behavior are the same.
Sequence, replay-retention, frame, binary, pending-correlation, and in-flight
limits bound protocol state.

On disconnect, the configured orphan policy applies:

- `cancel` requests cancellation and reports the result after reconnect;
- `finish-and-buffer` lets work finish and retains the terminal result in the
  Worker process for reconnect;
- `finish-and-persist` requires the Worker's durable attempt/result boundary.

A higher session epoch does not by itself clear a persistence-unavailable
latch. The Main schedules on that Worker again only after reconciliation
explicitly reports persistence available. Duplicate assignments and results
deduplicate by `(taskId, attemptId)`.

## Failure, indeterminate, and recovery semantics

Validation failures are definite pre-execution outcomes: invalid artifacts,
incompatible runtime ranges, missing or ambiguous capabilities, cycles,
permission-envelope violations, and impossible placement block before plugin
code loads.

Plugin exceptions and executor crashes affect the current instance or attempt,
not the kernel. Thread and child-process capacity can be replaced after the
terminal failure is recorded. A Worker disconnect moves unfinished remote work
to `unknown`; it does not silently create a second attempt.

`indeterminate` is a terminal observation used only when execution or a
durable state transition may have completed but the persistence boundary
cannot prove the authoritative result. It has no output, carries a structured
diagnostic with `retryable: false`, and never authorizes automatic retry. An
operator or explicit policy may create a new attempt ID only after accounting
for possible prior side effects.

If a durable terminal record appears later, it is explicit recovery evidence.
It does not rewrite the historical `indeterminate` result already delivered to
a caller. Recovery replays durable work idempotently using operation, task,
attempt, deployment-generation, message, revision, and fencing identities.
