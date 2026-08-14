# Phase 1 Security, Concurrency, Recovery, and Release Review

## Review record

The dated SHAs and GitHub run below are historical Phase 1 evidence. The current
`2.0.0-alpha.1` closure adds quotas, deterministic cleanup, Windows ACL hardening, and release
engineering. The broker implementation's real Windows gate is complete; Task 5 records the fresh
final release-evidence chain.

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
- Artifact ingress is bounded by 256 MiB per artifact and 4 GiB per namespace by default, with
  validated partial overrides. Duplicate, failure, close, restart, and concurrent admission paths
  are covered for the local and PostgreSQL stores.
- On Windows, a dedicated broker process owns the public named pipe from creation through shutdown.
  Every instance has a protected owner DACL granting full pipe access only to the current user,
  LocalSystem, and Administrators; the live descriptor is validated before `READY` and request
  dispatch.

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

The final broker implementation commit `ae83ef4c303842a7f4567fbdd4b3ebb19435329b`
passed all four jobs in authoritative
[run 31837308587](https://github.com/tegojs/tego-next/actions/runs/31837308587).
The [Windows job](https://github.com/tegojs/tego-next/actions/runs/31837308587/job/94886355643)
ran the packed `@tego/cli` consumer, live descriptor/status checks, malformed and crash cleanup,
stable parent-handle cleanup, reconnect rejection, and 20 leak-free lifecycle rounds.

The CI structure itself is tested. Required jobs and ordered steps cannot be disabled, moved,
duplicated, changed to no-ops, or marked `continue-on-error`; actions are pinned to reviewed commit
SHAs; PostgreSQL health settings, bounded reporters, always-upload diagnostics, deterministic
packaging, pull-request triggers, and `main` push triggers are enforced.

## Current limitations and remaining gates

- Readiness ownership now begins immediately after spawn. PostgreSQL test cleanup accepts only
  `^test_[a-z0-9]+_[a-z0-9_]+$`, deletes exact `driver_namespace = $1` rows from the fixed Phase 1
  allowlist including `tego_artifact_namespace_usage`, preserves `tego_schema_migrations`, and
  proves neighboring namespaces unchanged.
- Windows process-tree cleanup uses bounded `taskkill /T` and refreshed PID + CreationDate tokens;
  it does not use a native Windows Job Object launcher. The theoretical PID-reuse and final-snapshot
  orphan limitations remain accepted for this alpha. This general harness boundary is separate
  from the broker cleanup evidence below.
- The alpha supports `win32-x64` only and delivers auditable PowerShell plus embedded C# source.
  The broker opens a stable synchronization handle to the exact parent process and has no fallback
  to an unhardened Node named pipe. Windows ARM64 support and a signed precompiled broker are
  deferred.
- A trusted local client may still consume its finite artifact namespace quota through follower
  ingress. This remains a trusted-boundary denial-of-service consideration, not a fencing bypass.
- Fresh exact-SHA local and four-job release evidence is recorded by Task 5. npm publication, Git
  tag, GitHub prerelease, and OpenSpec archive remain pending Task 11.

## Verdict

Phase 1 is security-, concurrency-, and recovery-ready for final alpha verification. No blocking
local finding remains. Production use remains gated on Node.js 26 entering LTS and a fresh review;
`2.0.0-alpha.1` is not yet claimed published or archived.
