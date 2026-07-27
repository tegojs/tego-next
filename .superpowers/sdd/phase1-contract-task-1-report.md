# Phase 1 Contract Task 1 Report

## Outcome

Restored the canonical OpenSpec contract and checklist truth for the Phase 1
release-closure repair.

The repaired contract now specifies:

- persisted automatic capability bindings that survive provider loss and Main
  restart without silent rebinding;
- deterministic simultaneous-loss precedence of `fail` before `suspend` before
  `degrade`;
- distinct degraded-activation, suspended-deployment, and failed-deployment
  provider-recovery behavior;
- persisted unsigned-decimal activation identity scoped within
  `(applicationId, pluginId, componentId, generation)`, including its use in
  stable instance, operation, and message identities;
- separate component activation lifecycle and deployment observations, with
  provider-loss suspension and failure draining the activation through
  `draining`, `stopping`, and `stopped` before the deployment is observed as
  `suspended` or `failed`;
- mandatory protocol-1.0 correlation identity for one-way, request, and
  response envelopes;
- trusted local control-endpoint scope, Unix owner-only `0600` sockets under an
  owner-private directory, and the absence of implemented Windows named-pipe
  ACL hardening in phase one;
- follower ingress of immutable content-addressed artifact bytes without
  fenced semantic-write authority, while prohibiting creation or mutation of
  installation, deployment, operation, or task state and acknowledging that
  admitted bytes consume shared artifact storage;
- a not-leader result for `plugin install <path>` sent to a multi-Main
  follower, even when immutable bytes were admitted.

## Checklist Truth

Reopened only the affected evidence items:

`2.4`, `2.5`, `4.3`, `4.4`, `4.5`, `5.3`, `6.2`, `6.4`, `7.2`, `7.3`,
`7.5`, `7.6`, `9.1`, `10.3`, `10.4`, `11.3`, `11.7`, `12.1`, and `12.2`.

Item `12.3` remains closed. Items `12.4` through `12.6` remain open.

## Verification

- `git diff --check` — PASS before the contract commit.
- `npm run openspec:validate` — PASS.
- Strict validator output:

  ```text
  [verify:release] strict OpenSpec validation
  Change 'runtime-kernel-phase-1' is valid
  ```

Repository release closure remains intentionally incomplete because the
affected checklist evidence is open.

## Commits

- Contract correction:
  `47b7292da2de45cfebc588c8bc76cbe8a119fa39`
  (`docs: repair phase one runtime contracts`)
- Contract evidence:
  `fbb13eadb84bb46e5ef836948e9e2aac9587f2a6`
  (`docs: record phase one contract repair evidence`)
