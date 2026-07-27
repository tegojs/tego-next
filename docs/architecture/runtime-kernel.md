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

The phase-one Node host composition root currently lives in `@tegojs/cli`.
That package owns the runtime commands and local control adapter as well as the
current wiring of public kernel, driver, executor, and transport packages. It
is therefore not a packaging-only shell, but it is also not a privileged back
door into the kernel. Moving the composition code into a future
`@tegojs/node-host` package is non-blocking packaging cleanup; it is not a
phase-one behavioral or deployment prerequisite.

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
drivers. PostgreSQL `clock_timestamp()` is also the authoritative clock for
reconciliation availability and retry deadlines. One canonical UTC timestamp
is sampled for a reconciliation batch and carried through planning, outbox
availability, retry evaluation, and retry persistence. A database-clock read
occurs before the batch's fenced state transactions; those transactions reuse
the immutable sample instead of observing different instants mid-batch. When
PostgreSQL makes an outbox message newly claimable during the batch, its
database-stamped `claimedAt` may advance that claim's lower-bound timestamp;
this prevents a due claim from being evaluated against an older batch sample
without introducing another process-clock read. A database-clock read failure
fails reconciliation closed; it never falls back to a process clock.
`single-main` keeps its injected local clock, so embedded tests and deployments
remain deterministic and require no distributed-time service. Every Main can
report diagnostics. Exactly the Main holding the current leadership epoch
performs mutations, reconciliation, Worker registration, and assignment. See
[Deployment topologies](../operations/deployment-topologies.md) for the
operator view.

Components execute through one request/result contract:

- `thread` uses `node:worker_threads`;
- `process` uses an authenticated child-process channel;
- `remote` uses the versioned WebSocket Worker protocol.

A Worker Thread has its own JavaScript thread and event loop. It shares the
Main operating-system process, address space, privileges, and process-wide
resources; it does not run on the Main JavaScript event loop and is not a
process isolation boundary.

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
plugin. Its public status is `blocked`, `degraded`, `disabled`, `failed`,
`ready`, `reconciling`, or `suspended`. Unavailable or inconsistent internal
evidence is reported through structured diagnostics and maps to a safe public
observation instead of widening the status contract. Compatibility, artifact,
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

Capability routing performs its revocable authority check after every
asynchronous route and binding validation. The check and the exact-provider
request reservation/send are one synchronous, no-yield admission step across
thread, process, and remote transports. If authority is lost before that step,
no provider command is created. Once the request has been reserved/sent, it is
already admitted work and may settle after authority loss even when isolated or
remote plugin code begins later; this does not authorize another dispatch.

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

Before any local or remote component materialization, the reconciler persists
the exact execution binding in the component instance checkpoint. That binding,
not current deployment or Worker state, is the authority for every later
drain/stop. After Main restart or authority transfer, an obsolete, disabled, or
partially terminating instance is reconstructed from its historical
installation plus that immutable binding as a non-accepting teardown session.
It cannot accept new tasks or capability calls.

Remote teardown restoration may adopt an exact Worker activation only from the
Main's durable target and binding fingerprint. The adopted entry is never
published as active and is never replayed to another Worker. Drain and stop are
idempotent: an authenticated Worker response that the exact target is already
absent satisfies the teardown postcondition only for this Main-authorized
termination path.

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
terminal -> expired
```

The state unknown remains a non-terminal reconciliation state and does not
directly expire. It means the Main cannot yet prove what happened after session
loss. Reconnect inventory reconciles running attempts, buffered terminal
results, attempt revisions, and the Worker's persistence availability.
Acknowledged terminal results become `expired` retention tombstones after the
configured retention period.

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
timestamp, payload, and a correlation ID. The correlation ID is mandatory:
one-way messages and requests self-correlate to their own message ID, while
responses correlate to the triggering request's message ID. Binary metadata is
optional. Unsupported versions fail with `PROTOCOL_VERSION_UNSUPPORTED`; there
is no version negotiation or compatibility downgrade.

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

Reconnect reconciliation also exchanges exact component activation lifecycle
state. A replacement Worker materializes Main-retained active or draining
bindings before admission; a replacement Main may retain a Worker-reported
draining binding only as a non-transferable teardown candidate. That candidate
is never replayed to another Worker and accepts stop only when the Main supplies
the matching durable target and binding fingerprint. Both sides validate a
complete inventory before lifecycle mutation or materialization. Neither
direction may promote `draining` back to `active`. Worker connect mode rotates
through its bounded URL set when an authenticated follower rejects registration
as non-authoritative, while authentication failures remain terminal.

An unfinished task remains recoverable after its component stops. Main creates
a target-scoped, non-admitting recovery executor from the task's durable target
and execution binding. That executor may observe, resume, or cancel the existing
attempt; it cannot submit a new attempt or invoke component capabilities.

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
