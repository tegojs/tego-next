# Phase 1 Security, Concurrency, Recovery, and Release Review

## Review record

- Review date: 2026-07-27
- Baseline: `436b1d7b4c2e14259e9a8146555f7d675c637c1a`
- Reviewed implementation: `a7c4949905a0ff2f9d4988c68cb9bd421ddadde1`
- Authoritative CI candidate: `626fd2a4d1c0695c91b4b38b22140104aac912fe`
- Local database: PostgreSQL 16.14
- CI database: `postgres:16.14-alpine`

Independent security, concurrency/recovery, and fault/release review lanes approved the candidate
with no Critical or Important findings. Focused security and concurrency review of the final durable
attempt-store changes returned `APPROVE` with no findings.

## Security conclusions

The final implementation fails closed at the phase-one trust boundaries:

- Unix control sockets require an owner-private parent, an owner-owned socket identity, and exact
  `0600` mode before queued connections may dispatch. Replacement, symlink, owner, mode, and parent
  identity races abort startup and close queued sockets.
- Plugin archives are validated as data before import. Path traversal, portable/case-folded
  collisions, links, special files, undeclared files, malformed archives, digest mismatches,
  incompatible manifests, and executable pre-validation side effects are rejected.
- Deployment bindings snapshot configuration, grants, capabilities, target identity, generation,
  artifact digest, and fingerprint. Executors cannot synthesize or widen these values.
- Capability calls require the declared method, consumer permission, exact durable binding, ready
  provider activation, valid request/response schemas, and an active Main authority token.
- Secrets remain behind parent-owned RPC gates and cannot cross request, response, diagnostic,
  stdout, stderr, or replay surfaces.
- Worker authentication binds credentials to a Worker principal; replay, correlation mismatch,
  stale epoch, invalid inventory, and same-ID content equivocation are rejected.
- Local artifact path ingress is a trusted administrative boundary. A follower may ingest immutable
  content-addressed bytes, but semantic installation and deployment mutations remain leader-fenced.

## Concurrency and recovery conclusions

The review and fault matrix exercised:

- leadership loss before and after mutation or capability admission;
- stale-leader commits and PostgreSQL clock-skew takeover;
- restart during installation, deployment, starting, draining, stopping, task submission, terminal
  persistence, remote result acknowledgement, and provider-loss recovery;
- duplicate task, attempt, command, message, capability, and terminal-result delivery;
- Worker reconnect, authoritative session replacement, activation inventory replay, orphan policies,
  buffered results, and durable attempt recovery;
- cancellation/deadline races with spawn, resolver, plugin completion, cleanup, and late child exit;
- bounded capacity, backpressure, tombstone retention, revision overflow, and corrupt durable state;
- process and process-tree termination on success, timeout, external kill, and cleanup failure.

The implementation now preserves these invariants:

1. Authority loss synchronously closes new mutation and capability-provider admission. Work admitted
   before the linearization point may settle, but it cannot borrow later authority.
2. Durable reconciliation effects are reauthorized against the exact current deployment,
   activation, binding, instance revision, journal claim, and fencing epoch.
3. Task and remote-attempt terminal evidence is monotonic. A stale session or old epoch cannot
   overwrite newer durable state, and ambiguous acknowledgement never triggers blind re-execution.
4. Drain closes new task and capability admission, waits for admitted work, then runs lifecycle
   teardown. Remote session loss cannot bypass exact-target cleanup.
5. Every queue, frame, payload, outstanding request, process, replay record, tombstone, retry,
   convergence pass, timer, and shutdown path has an explicit bound.

## Fault and CI evidence

The local release gate passed with Memory, SQLite, and PostgreSQL drivers. The exact candidate SHA
passed GitHub run [`30259537251`](https://github.com/tegojs/tego-next/actions/runs/30259537251):

| Gate | Result | Diagnostic artifact |
| --- | --- | --- |
| [Quality](https://github.com/tegojs/tego-next/actions/runs/30259537251/job/89955930336) | Passed | None required |
| [PostgreSQL integration](https://github.com/tegojs/tego-next/actions/runs/30259537251/job/89955930399) | Passed | `postgres-integration-diagnostics` |
| [Main and Worker process E2E](https://github.com/tegojs/tego-next/actions/runs/30259537251/job/89955930323) | Passed | `process-e2e-diagnostics` |

The CI structure itself is tested. Required jobs and ordered steps cannot be disabled, moved,
duplicated, changed to no-ops, or marked `continue-on-error`; actions are pinned to reviewed commit
SHAs; PostgreSQL health settings, bounded reporters, always-upload diagnostics, deterministic
packaging, pull-request triggers, and `main` push triggers are enforced.

## Accepted non-blocking limitations

- The two-Main E2E harness registers a Main handle after readiness. If readiness itself times out,
  the outer managed process-group cleanup remains the authoritative cleanup path.
- Local repeated PostgreSQL E2E runs retain unique test namespaces. GitHub service containers are
  ephemeral; a future local maintenance command may compact these namespaces.
- Windows named-pipe ACL hardening is not implemented. Windows use is not considered a hardened local
  administrative boundary in this alpha.
- A trusted local client can consume artifact storage by submitting immutable bytes even when the
  contacted Main is a follower. Semantic state is fenced, but storage quotas belong to a later
  resource-management layer.

## Verdict

Phase 1 is security-, concurrency-, recovery-, and release-ready for an alpha evaluation. No blocking
finding remains. Production use remains gated on Node.js 26 entering LTS and a fresh release review.
