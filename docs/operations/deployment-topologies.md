# Deployment topologies

Phase one supports exactly two runtime modes: embedded `single-main` and
PostgreSQL-backed `multi-main`. Read the
[architecture](../architecture/runtime-kernel.md) for state semantics and the
[threat model](../security/threat-model.md) before exposing a Worker listener
or database.

## Current support boundary

The packages are unpublished alpha-stage workspace packages. The CLI can start
Main processes and operate their private local control endpoints. It can start
a Worker process, but it does not yet configure the Main side of a Worker
connection. The process-level system harness composes that listener through
the exported `runNodeMainProcess` API.

This guide distinguishes runnable CLI operations from the connectivity proven
by the system tests. It does not claim a turnkey production deployment.

## Embedded single-Main

### Topology and local storage

```text
operator CLI -> private control socket -> Main
                                      |-> state.sqlite
                                      |-> immutable artifact files
                                      |-> prepared artifact cache
                                      |-> Worker Threads
                                      `-> child processes
```

`@tegojs/drivers-local` creates:

- SQLite state at `<data-dir>/state.sqlite`;
- a filesystem artifact store under the data directory;
- local single-owner coordination;
- the Node process host;
- a development-only secret provider.

The in-memory state store is a test double and is not crash-durable.

### Start, inspect, and stop

Build first, then start a detached Main with explicit paths and identities:

```sh
npm run build
node packages/cli/dist/src/bin.js runtime start \
  --detach \
  --mode single-main \
  --runtime-id runtime-local \
  --application-id application-default \
  --node-id node-local \
  --data-dir .tego/main \
  --endpoint .tego/main/control.sock \
  --json
```

Inspect liveness, readiness, driver health, authority, and counts:

```sh
node packages/cli/dist/src/bin.js runtime status \
  --endpoint .tego/main/control.sock --json
node packages/cli/dist/src/bin.js runtime snapshot \
  --endpoint .tego/main/control.sock --json
```

Stop through the control endpoint:

```sh
node packages/cli/dist/src/bin.js runtime stop \
  --endpoint .tego/main/control.sock --json
```

Use the same `runtime-id`, `application-id`, and data directory on restart.
Recovery loads installations, deployments, operation journals, and task
records before the control endpoint reports the process ready.

### Artifact and deployment lifecycle

The lifecycle is:

```text
manifest -> deterministic .tego artifact -> immutable installation
         -> mutable deployment generation -> reconciled component instances
         -> task records and terminal results
```

Validate and package before starting the Main when convenient:

```sh
node packages/cli/dist/src/bin.js plugin validate ./path/to/plugin --json
node packages/cli/dist/src/bin.js plugin pack ./path/to/plugin \
  --output /tmp/example.tego --json
node packages/cli/dist/src/bin.js plugin inspect /tmp/example.tego --json
```

Install, deploy, wait for `plugin status` to report `ready`, and then run the
task. The exact commands and manifest are in
[Contributing and plugin authoring](../guides/contributing-and-plugins.md).

An artifact is addressed by its SHA-256 digest. Installing another byte stream
with the same plugin ID and version does not overwrite the first installation.
Changing desired deployment state increments its generation. SQLite revisions,
operation IDs, and stable component instance IDs make restart reconciliation
idempotent.

## Multi-Main with PostgreSQL

### Topology and shared state

```text
                         +-> Main A (leader) -> reconcile / assign
operator control sockets |
                         +-> Main B (follower) -> status / diagnostics
                                |
                                v
                    PostgreSQL 16 shared state,
                    artifacts, leadership, leases,
                    CAS revisions, watch, fencing epoch

Worker <--- authenticated WebSocket ---> current leader
```

All Mains for one runtime use the same PostgreSQL URL, `runtime-id`, and
`application-id`, with unique `node-id`, data directory, and control endpoint.
Local directories still hold process-local files and caches; PostgreSQL is
authoritative for state, artifacts, and coordination.

PostgreSQL leadership uses a dedicated advisory-lock connection and database
time. The leader owns a monotonically increasing fencing epoch. Followers
remain running and diagnosable but have no `authority` field and reject
mutating operations.

### Start two Mains

Start PostgreSQL 16 and set the connection string:

```sh
export TEGO_POSTGRES_URL=postgresql://tego_test:tego_test@127.0.0.1:55432/tego_next_test
```

Start two detached Mains:

```sh
node packages/cli/dist/src/bin.js runtime start \
  --detach --mode multi-main \
  --runtime-id runtime-cluster \
  --application-id application-default \
  --node-id node-a \
  --data-dir .tego/main-a \
  --endpoint .tego/main-a/control.sock \
  --postgres-url "$TEGO_POSTGRES_URL" --json

node packages/cli/dist/src/bin.js runtime start \
  --detach --mode multi-main \
  --runtime-id runtime-cluster \
  --application-id application-default \
  --node-id node-b \
  --data-dir .tego/main-b \
  --endpoint .tego/main-b/control.sock \
  --postgres-url "$TEGO_POSTGRES_URL" --json
```

### Leader and follower operations

Query both endpoints:

```sh
node packages/cli/dist/src/bin.js runtime status \
  --endpoint .tego/main-a/control.sock --json
node packages/cli/dist/src/bin.js runtime status \
  --endpoint .tego/main-b/control.sock --json
```

Exactly one healthy Main should report `authority.resource` equal to
`runtime:runtime-cluster`; that endpoint is the leader. Send `plugin install`,
`plugin deploy`, `task run`, and `task cancel` to the leader. Status and
snapshot remain available on the follower.

Do not load-balance mutating CLI requests across both control sockets. The
fencing check rejects stale or follower authority, but clients should discover
the leader from status and retry only definite `COORDINATION_NOT_LEADER`
failures.

Path-based installation on a follower admits content-addressed immutable
artifact bytes before the semantic installation crosses the leadership fence.
The subsequent installation is rejected with `COORDINATION_NOT_LEADER`, so the
follower cannot change installations, deployments, or other semantic state.
Because the local control endpoint is trusted, an authorized local client can
still consume shared artifact capacity this way. Operators must treat repeated
follower ingress as a storage denial of service risk even though fencing
protects semantic state.

### Worker connectivity

The Worker CLI supports both directions:

```sh
TEGO_WORKER_CREDENTIAL=replace-me \
  node packages/cli/dist/src/bin.js worker start \
  --connect ws://127.0.0.1:9000 \
  --worker-id worker-1 \
  --prepare /tmp/example.tego \
  --data-dir .tego/worker-1 --json
```

```sh
TEGO_WORKER_CREDENTIAL=replace-me \
  node packages/cli/dist/src/bin.js worker start \
  --listen 127.0.0.1:9001 \
  --worker-id worker-1 \
  --prepare /tmp/example.tego \
  --data-dir .tego/worker-1 --json
```

Current `runtime start` options do not expose Main-side Worker credentials,
listener addresses, or outbound Worker connections. Therefore the commands
above require a Main composed through the public Node API or the repository
system harness; the two detached Main commands alone cannot attach a remote
Worker.

Only the authoritative Main may publish Worker registration and allocate its
session epoch. On takeover, reconnect the Worker to the promoted Main's
configured endpoint. A higher transport epoch does not restore scheduling
until attempt persistence reconciliation succeeds.

### Takeover and recovery

When leadership is lost:

1. The old Main drops mutation, reconciliation, assignment, and Worker
   authority.
2. PostgreSQL allows a follower to acquire leadership with a higher fencing
   epoch.
3. Stale writes from the old epoch fail.
4. The new leader recovers shared deployments, operations, tasks, Worker
   session epochs, and remote attempts.
5. The Worker reconnects and reports running attempts, buffered results, and
   persistence availability.
6. Assignment resumes only after reconciliation; duplicate terminal results
   collapse to one authoritative task result.

Observe takeover by polling both `runtime status` endpoints and comparing
`authority.epoch`. Do not use fixed sleeps as a readiness check. If a task is
`unknown`, wait for Worker reconciliation or the orphan-policy timeout. If it
is terminal `indeterminate`, investigate possible side effects before creating
a new attempt.

Stop each surviving Main through its own endpoint:

```sh
node packages/cli/dist/src/bin.js runtime stop \
  --endpoint .tego/main-a/control.sock --json
node packages/cli/dist/src/bin.js runtime stop \
  --endpoint .tego/main-b/control.sock --json
```

## Production gate and deferred deployment capabilities

Production release remains blocked until Node.js 26 enters LTS. Phase one also
defers:

- container images, Docker Compose application topology, and Kubernetes
  orchestration;
- an HTTP control plane or load-balanced leader routing;
- Main-side Worker network configuration in the CLI;
- automatic Worker redirection to a promoted leader;
- additional coordination providers such as etcd or Consul;
- OS-grade plugin sandboxing and production secret-manager drivers.

Use `npm run verify:release` and the authoritative GitHub Actions
`quality`, `integration`, and `system-e2e` jobs as release evidence, not as a
production-readiness claim.
