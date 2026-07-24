---
comet_change: runtime-kernel-phase-1
role: technical-design
canonical_spec: openspec
---

# Tego Runtime Kernel Phase 1 Technical Design

## 1. Authority and Scope

The canonical product requirements are the OpenSpec change at
`openspec/changes/runtime-kernel-phase-1`. This document defines the
implementation architecture for those requirements. It does not add a second
set of requirements.

The deliverable is the first usable backend layer of Tego Next:

```text
Runtime
├── Application lifecycle
├── Plugin artifacts and deployments
├── Capability resolution
├── Reconciliation
├── Worker registry
├── Task scheduling
├── Executors
└── Coordination
```

HTTP, authentication, business ACL, data sources, cache, scheduler, workflow,
frontend resources, and Tego 1.x compatibility remain outside this change.

## 2. Toolchain

The repository uses:

```text
Runtime:          Node.js 26, pinned to an exact patch
Language:         TypeScript 7, strict ESM
Package manager:  npm workspaces, pinned through packageManager
Type checking:    TypeScript 7 CLI
Formatting/lint:  Biome
Tests:            node:test
Coverage:         Node test coverage
Integration:      Docker Compose with pinned PostgreSQL
```

TypeScript 7 is invoked only as a command-line compiler. No package imports the
TypeScript compiler or language-service API. The source subset must satisfy
`erasableSyntaxOnly`; production packages and plugin artifacts contain emitted
JavaScript ESM and declarations.

Tests execute built JavaScript for package and end-to-end behavior. Focused
development commands compile the affected workspace before running its tests.
This verifies the production module graph rather than relying on a development
loader with different resolution behavior.

## 3. Workspace and Dependency Direction

```text
@tegojs/contracts
       ▲
       ├────────────── @tegojs/plugin-sdk
       ├────────────── @tegojs/testkit
       ├────────────── @tegojs/executor-node
       ├────────────── @tegojs/transport-websocket
       ├────────────── @tegojs/drivers-local
       └────────────── @tegojs/drivers-postgres
       ▲
       │
@tegojs/runtime
       ▲
       │
@tegojs/cli
```

`@tegojs/contracts` owns serializable public contracts, runtime schemas,
interfaces, stable error codes, and compatibility helpers. It does not own
runtime orchestration.

`@tegojs/runtime` owns the control-plane mechanisms. It accepts driver and
executor implementations through constructors and never imports a concrete
driver package.

`@tegojs/drivers-local` is the usable single-Main composition:

- SQLite state store;
- local authoritative coordination;
- filesystem content-addressed artifact store;
- local process host;
- system clock;
- environment/file development secret provider.

`@tegojs/drivers-postgres` is the usable multi-Main composition:

- shared PostgreSQL state store;
- PostgreSQL coordination;
- PostgreSQL artifact storage for phase one;
- database-time clock for leases and fencing.

`@tegojs/executor-node` implements worker-thread and child-process execution.
`@tegojs/transport-websocket` implements remote Worker sessions and the remote
executor. `@tegojs/cli` is a consumer of public runtime operations, not a hidden
privileged API.

An architecture test parses workspace manifests and emitted import specifiers.
It rejects dependency edges that point outward from contracts or runtime into
CLI, concrete drivers, examples, Tego 1.x, frontend, or platform-capability
packages.

## 4. Public Composition API

The primary embedding API is a factory rather than a subclassable application:

```ts
import { createRuntime } from "@tegojs/runtime";
import { createLocalDrivers } from "@tegojs/drivers-local";

const drivers = await createLocalDrivers({
  dataDirectory: "/var/lib/tego",
});

const runtime = createRuntime({
  mode: "single-main",
  runtimeId: "medical-device-01",
  applicationId: "detector",
  nodeId: "main-01",
}, drivers);

await runtime.start();
const status = await runtime.status();
await runtime.stop({ deadlineMs: 10_000 });
```

The runtime interface is intentionally small:

```ts
interface Runtime {
  start(): Promise<void>;
  status(): Promise<RuntimeStatus>;
  stop(options?: StopOptions): Promise<void>;
  readonly operations: RuntimeOperations;
  readonly events: AsyncIterable<RuntimeEvent>;
}
```

`RuntimeOperations` exposes typed commands for installations, deployments,
tasks, Workers, and diagnostics. The same operation contract is used by the
embedded API and local CLI control protocol.

Bootstrap validates every driver, opens them in dependency order, recovers
durable state, obtains authority, starts reconciliation, then accepts
operations. Failed bootstrap closes already-opened drivers in reverse order.

## 5. Runtime Drivers

Driver interfaces are bootstrap dependencies:

```ts
interface RuntimeDrivers {
  state: StateStore;
  coordination: CoordinationProvider;
  artifacts: ArtifactStore;
  processHost: ProcessHost;
  secrets: SecretProvider;
  clock: Clock;
}
```

Each driver exposes `open`, `health`, and idempotent `close`. Driver health is
included in runtime status and never inferred from exceptions alone.

### 5.1 StateStore

The kernel requires transactions rather than storage-specific queries:

```ts
interface StateStore {
  open(): Promise<void>;
  transact<T>(
    options: StateTransactionOptions,
    work: (tx: StateTransaction) => Promise<T>,
  ): Promise<T>;
  read<T>(key: StateKey<T>): Promise<Versioned<T> | undefined>;
  scan<T>(query: StateQuery<T>): AsyncIterable<Versioned<T>>;
  watch(cursor: Revision): AsyncIterable<StateChange>;
  health(): Promise<DriverHealth>;
  close(): Promise<void>;
}
```

The transaction owns conditional revision checks, fencing validation, writes,
operation-journal entries, and outbox messages. The kernel never executes raw
SQLite or PostgreSQL statements.

### 5.2 CoordinationProvider

```ts
interface CoordinationProvider {
  campaign(request: CampaignRequest): Promise<Leadership>;
  acquireLease(request: LeaseRequest): Promise<Lease>;
  nextEpoch(resource: ResourceName): Promise<FencingEpoch>;
  compareAndSet<T>(request: CompareAndSetRequest<T>): Promise<CasResult<T>>;
  watch(request: CoordinationWatchRequest): AsyncIterable<CoordinationChange>;
  health(): Promise<DriverHealth>;
  close(): Promise<void>;
}
```

`single-main` returns immediate local authority. `multi-main` cannot start
without an external provider and shared state store.

### 5.3 ArtifactStore

Artifacts are addressed only by SHA-256 digest. Reads stream bytes and must
verify the digest before making a package available to a component host.

Phase one PostgreSQL storage uses `bytea` and a size limit suitable for runtime
plugins and tests. Large-model and object-storage drivers are later work; task
payloads may already refer to external artifact identifiers through the
generic contract.

## 6. Persistent Model

The implementation uses transactional current state plus an operation journal
and transactional outbox. It is not event sourced.

Logical records:

| Record | Identity | Purpose |
| --- | --- | --- |
| Installation | plugin ID, version, digest | Immutable verified artifact |
| Deployment | application ID, plugin ID | Desired version, state, config, grants |
| Component instance | deployment, component, placement | Observed lifecycle and generation |
| Operation | operation ID | Idempotent multi-step control-plane work |
| Task | task ID | Logical requested work |
| Attempt | task ID, attempt ID | One executor assignment |
| Worker session | Worker ID, session ID | Liveness and advertised capacity |
| Outbox item | revision, message ID | Reliable post-commit notification |
| Diagnostic | diagnostic ID | Structured operator-visible problem |

SQLite maps these to normalized tables. PostgreSQL uses the same logical
columns and constraints. Storage-specific schemas are private.

All public revisions, generations, sequence numbers, and fencing epochs are
unsigned 64-bit logical values serialized as decimal strings. JavaScript
`number` is never used for them.

Every state-changing operation contains:

- stable `operationId`;
- expected record revision where applicable;
- current fencing epoch in multi-Main mode;
- actor and reason;
- idempotency key;
- resulting revision.

## 7. Runtime State Machines

### 7.1 Runtime

```text
created → opening → recovering → electing → running → draining → stopping → stopped
                   ↘ failed      ↗             ↘ failed
```

Kernel liveness and application readiness are separate fields. An essential
deployment can make readiness false but cannot force the runtime process to
exit.

### 7.2 Component instance

```text
created → preparing → starting → ready → draining → stopping → stopped
                         │         │
                         └─────────┴→ degraded
                         └─────────┴→ failed
```

Only the kernel transition function mutates lifecycle state. Plugin hooks
return outcomes; they do not set states.

### 7.3 Task attempt

```text
created → assigned → acknowledged → running → succeeded
       │          │              ├──────────→ failed
       │          │              ├──────────→ indeterminate
       │          │              ├──────────→ cancelled
       │          │              ├──────────→ timed-out
       │          │              └──────────→ unknown
       └──────────┴─────────────────────────→ rejected
```

`unknown` is non-terminal: the remote execution state has not yet been
reconciled, so reconnect or orphan-policy timeout must resolve it.

`indeterminate` is terminal for the caller and means that an external effect or
durable state transition may have completed, but the executor could not prove
which result became authoritative before its persistence boundary timed out.
It carries no output and requires a structured diagnostic with
`retryable: false`. The scheduler MUST NOT automatically create a replacement
attempt from this result. An operator or policy may explicitly advance to a new
attempt ID only after accounting for the possible prior side effect.

`observe`, CLI/API task inspection, audit events, and stored diagnostics expose
`indeterminate` verbatim; they MUST NOT render it as ordinary `failed`.
Historical handles remain frozen. On restart, explicit durable recovery may
discover a later authoritative terminal record for the same identity, but that
recovery evidence does not rewrite the result already delivered to an earlier
caller.

State-machine transition tables are pure data and are exhaustively tested.

## 8. Plugin Artifact

A `.tego` artifact is a deterministic POSIX tar archive with normalized:

- lexicographic entry order;
- forward-slash paths;
- zero modification time;
- zero UID and GID;
- fixed file modes;
- no absolute paths, links, devices, or traversal segments.

Required layout:

```text
manifest.json
components/
schemas/
metadata/files.json
metadata/sbom.json
```

The pack command:

1. runs the plugin's declared TypeScript 7 build command in a controlled child
   process;
2. verifies emitted JavaScript ESM and rejects undeclared files;
3. validates `manifest.json` with JSON Schema;
4. produces normalized metadata;
5. creates the archive;
6. computes the final SHA-256 digest;
7. optionally writes an external Ed25519 signature record.

The runtime reads only manifest and metadata entries during preflight. It does
not import a component until installation, deployment, dependency, permission,
placement, and executor gates all pass.

## 9. Plugin Component ABI

The SDK exports explicit functions, not decorators or base classes:

```ts
export default defineComponent({
  async prepare(context) {},
  async start(context) {},
  async health(context) {
    return { status: "ready" };
  },
  async run(context, input) {
    return input;
  },
  async drain(context) {},
  async stop(context) {},
});
```

Long-running `main` and `worker` components use lifecycle hooks. `on-demand`
components use `run`. The same component may declare multiple supported
executors.

The component context contains only:

- plugin and instance identity;
- immutable deployment configuration reader;
- structured logger;
- runtime event client;
- capability client;
- cancellation/deadline signal;
- runtime information;
- disposable registry.

There is no direct `Application`, database, cache, ACL, filesystem, environment,
or socket object.

## 10. Capability RPC

A capability is identified by stable name and major protocol version:

```ts
interface CapabilityToken<Request, Response> {
  name: string;
  protocolVersion: string;
  requestSchema: JsonSchema;
  responseSchema: JsonSchema;
}
```

Providers register a component endpoint. Consumers receive a proxy. Every call
uses the component-host channel, even when both components happen to be local,
so moving a component does not change semantics.

Call flow:

```text
Consumer
→ validate granted capability
→ validate request schema
→ ComponentHost RPC
→ Provider
→ validate response schema
→ Consumer
```

Resolution is a pure function over installations, deployments, readiness,
bindings, and versions. It returns either a deterministic binding graph or
structured blocking diagnostics.

## 11. Permission Gate

Manifest requests are maximum bounds. Deployment grants must be subsets.

The pre-import gate validates:

- capability methods;
- executor types;
- network host, port, and HTTP method;
- logical filesystem roots and access modes;
- secret names;
- environment variable names;
- Worker labels and resource requests.

Runtime enforcement happens through capability and component-host channels.
Thread execution cannot prevent hostile code from reaching Node APIs, so it is
allowed only for trusted deployments. Process and remote isolation remain
policy choices; phase one does not claim an OS sandbox.

## 12. Reconciliation

Each desired-state write increments deployment generation and wakes the
reconciler through the transactional outbox.

One reconcile iteration:

1. acquire or confirm current fenced authority;
2. read a consistent desired/observed snapshot;
3. validate artifact, compatibility, dependency, permission, and placement;
4. compute a side-effect-free reconcile plan;
5. journal the plan under an idempotent operation ID;
6. perform one bounded external action;
7. conditionally commit observed state using revision and fencing epoch;
8. schedule the next step or retry.

Only one external action is performed per persisted step. A restart repeats the
step safely by querying its stable operation and instance identities.

Retry uses capped exponential backoff with deterministic jitter from operation
identity so tests can use a fake clock and reproduce timing.

## 13. Executor and ComponentHost

```ts
interface Executor {
  readonly id: ExecutorId;
  readonly type: "thread" | "process" | "remote";
  probe(): Promise<ExecutorCapabilities>;
  submit(request: ExecutionRequest): Promise<ExecutionHandle>;
  observe(taskId: TaskId, attemptId: AttemptId): Promise<AttemptStatus>;
  cancel(taskId: TaskId, attemptId: AttemptId): Promise<void>;
  drain(options: DrainOptions): Promise<void>;
  health(): Promise<ExecutorHealth>;
}
```

All executors launch the same JavaScript `ComponentHost`. Host communication is
a versioned request/response/event protocol covering:

- artifact prepare and verify;
- module import;
- lifecycle hooks;
- task execution;
- capability calls;
- logging and runtime events;
- cancellation and deadlines;
- graceful drain and forced termination.

`ThreadExecutor` uses `MessagePort` and transferable buffers.
`ProcessExecutor` uses Node IPC with length and payload limits.
`RemoteExecutor` uses the Worker session protocol.

The default selector prefers process, then remote, then thread unless a
deployment explicitly selects another supported and granted executor.

Deduplication is owned by both scheduler and executor. An executor that receives
the same `(taskId, attemptId)` returns the existing handle or terminal result.

## 14. Worker WebSocket Protocol

WebSocket is a transport, not a source of authority.

Either endpoint may initiate the TCP/WebSocket connection. After transport
authentication, both sides run the same logical handshake:

```text
hello
→ authenticate
→ negotiate protocol
→ register/resume session
→ reconcile attempts and artifacts
→ active
```

Envelope:

```ts
interface WorkerEnvelope<T> {
  protocol: "1.0";
  messageId: MessageId;
  sessionId: SessionId;
  sequence: Sequence;
  correlationId?: MessageId;
  type: WorkerMessageType;
  sentAt: string;
  payload: T;
}
```

Control messages are JSON. Artifact chunks and large task payloads use binary
frames correlated by message ID. Limits exist for message size, inflight
requests, buffered bytes, heartbeat delay, and acknowledgement time.

Workers persist terminal results for `finish-and-persist`; they retain bounded
memory/disk buffers for `finish-and-buffer`. Reconnect reports:

- running attempts;
- acknowledged but not started attempts;
- terminal results awaiting Main acknowledgement;
- prepared artifact digests;
- whether the Worker attempt-state persistence boundary is currently available.

The Main never creates a replacement attempt until the current attempt is
resolved or retry policy explicitly advances to a new attempt ID.

A transport epoch alone is not proof that a failed Worker persistence boundary
recovered. Main keeps that Worker unavailable until a higher-epoch
reconciliation explicitly reports attempt persistence available. A
`STATE_UNAVAILABLE` result from `worker-runtime` latches the current Worker
epoch unavailable. Reconnecting the same persistence-latched Worker therefore
does not briefly re-advertise healthy capacity.

## 15. Multi-Main PostgreSQL Semantics

Leadership uses a dedicated PostgreSQL session and advisory lock. Acquiring
leadership increments the resource epoch in the same takeover transaction.

Every leader-owned state transaction includes the expected epoch. PostgreSQL
rejects the transaction if it is below the stored current epoch.

Leases use database time, not Main node clocks. Compare-and-set uses a unique key
and revision predicate. Watch uses `LISTEN`/`NOTIFY` only to wake readers; readers
scan the durable change log from their last committed revision, preventing loss
during reconnects.

Tests kill the leader connection, pause notification delivery, race CAS writers,
expire leases, and resume a stale leader.

## 16. Local Control Protocol and CLI

The local control endpoint is:

- Unix domain socket on Unix;
- named pipe on Windows.

Messages are newline-delimited JSON with request ID, operation, protocol
version, input, and structured result. The endpoint is permission-restricted to
the runtime owner by the local driver.

The CLI uses Node `util.parseArgs` and does not introduce a command framework.
Every command supports JSON output. Human output is a rendering of the same
typed result.

`tego runtime start` runs in the foreground by default. `--detach` starts a
supervised child process and waits until the control endpoint reports recovery
complete. Stop is graceful and idempotent.

## 17. Error and Diagnostic Contract

Errors cross process and network boundaries as data:

```ts
interface RuntimeDiagnostic {
  code: DiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
  source: DiagnosticSource;
  retryable: boolean;
  details?: JsonValue;
  cause?: SerializedCause;
  observedAt: string;
}
```

Codes are stable and grouped by bootstrap, artifact, deployment, capability,
permission, lifecycle, executor, Worker, coordination, state, and protocol.
Stack traces are diagnostic attachments and never the only error identity.

## 18. Testing Architecture

Every OpenSpec scenario maps to one or more test identifiers:

```text
@spec:<capability>/<requirement>/<scenario>
```

Test layers:

1. **Pure model tests** — schemas, state machines, graphs, placement, selection,
   retries, and reconcile plans using fake clock and deterministic IDs.
2. **Public conformance suites** — state store, coordination, executor, Worker,
   artifact, lifecycle, and capability behavior against implementation factories.
3. **Integration tests** — real SQLite files, Worker Threads, child processes,
   WebSockets, process crashes, reconnects, and Docker PostgreSQL.
4. **End-to-end tests** — CLI packs and installs the echo plugin, deploys it,
   executes it on all three executors, restarts Main, and verifies unique results.
5. **Fault tests** — stale leader, dead Worker, interrupted reconcile, duplicate
   messages, corrupt artifact, invalid permission, and leaked resources.

Conformance suites consume only public exports. Provider-specific tests may add
coverage but cannot replace or skip mandatory conformance cases.

## 19. TDD Operating Rule

Each behavior slice follows:

```text
OpenSpec scenario selected
→ focused test written
→ expected failure executed and inspected
→ red test commit
→ minimum implementation
→ focused test passes
→ related contract suite passes
→ refactor
→ green implementation commit
```

Red and green commits remain visible on the development branch until review.
A test that passes immediately must be corrected or shown to exercise an absent
behavior before implementation proceeds.

No implementation task is complete until the linked test passes without
warnings, open handles, unhandled rejections, time-based sleeps, or leaked
processes.

## 20. Build and Verification Gates

The root verification command runs:

```text
npm ci
format check
lint
architecture boundary test
TypeScript 7 typecheck
unit and conformance tests
SQLite integration
thread/process/WebSocket integration
PostgreSQL integration
workspace build
artifact reproducibility
single-Main echo smoke
multi-Main takeover smoke
```

Fast local commands target a package or OpenSpec capability, but release evidence
always comes from the root gate on a clean checkout.

## 21. Delivery Slices

Implementation proceeds through usable vertical slices:

1. workspace, contracts, test harness;
2. local state, bootstrap, empty runtime;
3. manifest, artifact, installation;
4. deployment, capability graph, permissions, reconciliation;
5. process executor and echo plugin;
6. thread executor parity;
7. WebSocket Worker and remote executor parity;
8. PostgreSQL shared state and multi-Main fencing;
9. CLI completion, failure tests, documentation, and alpha release evidence.

Each slice ends in a green root verification state. Interfaces are not considered
complete until at least one real implementation passes their public conformance
suite.

## 22. Deferred Work

The following require later OpenSpec changes:

- HTTP control or business APIs;
- authentication and authorization policy;
- database, cache, scheduler, message, and file capability plugins;
- container/Kubernetes executors;
- external object storage;
- etcd and Consul drivers;
- OS-level sandbox profiles;
- Tego 1.x compatibility;
- frontend module and asset loading;
- production release before Node.js 26 LTS.
