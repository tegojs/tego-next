# Phase 1 API and Architecture Review

## Review record

- Review date: 2026-07-27
- Baseline: `436b1d7b4c2e14259e9a8146555f7d675c637c1a`
- Reviewed implementation: `a7c4949905a0ff2f9d4988c68cb9bd421ddadde1`
- Authoritative CI candidate: `626fd2a4d1c0695c91b4b38b22140104aac912fe`
- Candidate delta: `626fd2a` changes only the CLI foreground-process readiness test so it
  retries bounded Unix socket startup errors. It does not change a public or runtime contract.
- Runtime toolchain: Node.js 26.5.0, npm 11.13.0, TypeScript 7.0.2
- PostgreSQL acceptance versions: PostgreSQL 16.14 locally and PostgreSQL 16.14 Alpine in CI

Independent API/protocol and architecture review lanes approved the implementation. Their final
verdicts contained no Critical or Important findings. Focused API review of the final durable
attempt-store changes also returned `APPROVE` with no findings.

## Public API and protocol conclusions

The phase-one public surface is topology-neutral:

- `@tegojs/contracts` owns branded identities, strict JSON wire contracts, plugin manifests,
  execution bindings, runtime operations, capability definitions, and Worker envelopes.
- `@tegojs/runtime` owns bootstrap, durable recovery, reconciliation, task admission, capability
  routing, authority fencing, and live observed status.
- Node-specific thread, process, WebSocket, SQLite, PostgreSQL, and host composition remain outside
  the topology-neutral contracts.
- The CLI is the phase-one Node composition and command/control adapter. Extracting that composition
  into a future `@tegojs/node-host` package is packaging cleanup, not a runtime prerequisite.

The final review confirmed these contract properties:

- Generations, revisions, epochs, sequence numbers, message IDs, and attempt revisions remain
  canonical strings at public and durable boundaries.
- Worker protocol correlation is mandatory. Requests and one-way messages self-correlate; responses
  correlate to the triggering request; replay equivocation closes the session.
- A task receives one immutable execution binding. Thread, process, and remote executors validate
  the same configuration, permissions, capability definitions, target, digest, and fingerprint.
- Capability invocation is admitted only against the exact durable provider activation. Request and
  response schemas, permission grants, authority, binding identity, and secret boundaries are
  checked before a result crosses the boundary.
- Runtime status is typed and recomputed from durable installation, deployment, and observed-state
  records on both leaders and followers.
- Public testkit suites are consumable through package exports and cover manifest, lifecycle,
  executor, Worker, state-store, and coordination-provider contracts.

## Architecture findings resolved

The review cycle found and closed the following blocking classes of issue:

1. Provider loss now survives restart, escalates deterministically as
   `fail > suspend > degrade`, and permits a compatible higher generation of the same provider
   identity to recover where policy allows it.
2. Durable `starting`, draining, and stopping checkpoints reconstruct exact bindings before replay
   and remain fenced by current authority and instance revision.
3. Execution binding data is selected and persisted once instead of being reconstructed differently
   by each executor topology.
4. Capability routing now reaches task providers through local and remote component sessions instead
   of stopping at a schema-only abstraction.
5. Remote activation provenance, teardown, assignment ownership, durable attempts, and result
   tombstones are validated at persistence and transport boundaries.
6. Multi-Main retry scheduling and claim evaluation use authoritative PostgreSQL time rather than a
   process-local clock.
7. Main shutdown retains Worker lifecycle transport until reconciliation and durable teardown have
   converged.

## Verification evidence

Local full release verification passed on the reviewed implementation with the real PostgreSQL 16.14
service:

```text
TEGO_POSTGRES_URL=postgresql://tego_test:tego_test@127.0.0.1:5432/tego_next_test npm run verify:release
```

The candidate then passed the Quality-equivalent local gate and a 20-iteration focused foreground
runtime shutdown stress run. GitHub run
[`30259537251`](https://github.com/tegojs/tego-next/actions/runs/30259537251) is the authoritative
exact-SHA evidence:

| Gate | Result | Evidence |
| --- | --- | --- |
| Quality | Passed; 1,202 tests, 1,201 passed, 1 platform skip, 0 failed | [job 89955930336](https://github.com/tegojs/tego-next/actions/runs/30259537251/job/89955930336) |
| PostgreSQL integration | Passed; 136 local integration and 65 PostgreSQL tests | [job 89955930399](https://github.com/tegojs/tego-next/actions/runs/30259537251/job/89955930399) |
| Main and Worker process E2E | Passed; single-Main and two-Main takeover flows | [job 89955930323](https://github.com/tegojs/tego-next/actions/runs/30259537251/job/89955930323) |

The CI run also validated conventional commits, formatting, lint, build, deterministic plugin
packaging, type checking, architecture constraints, and strict OpenSpec.

## Non-blocking limitations

- Service components are not a phase-one execution target; the production capability provider hook
  is intentionally limited to task components.
- The Node composition root still lives in `@tegojs/cli`; a separate Node host package can be
  introduced without changing the reviewed contracts.
- Layer-two HTTP, application authentication/authorization, datasource, cache, resource, workflow,
  and frontend modules remain outside this release.

## Verdict

Phase 1 is API- and architecture-ready for the `0.1.0-alpha.1` evaluation release. No blocking
finding remains in the reviewed scope.
