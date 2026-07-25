# Integration Completion Task 7 Report

## Outcome

Implemented the complete phase-one plugin and task CLI surface:

- `plugin validate|pack|inspect|install|deploy|status`
- `task run|status|wait|cancel`

Local plugin validation and inspection do not execute plugin code. Packaging
reuses the existing deterministic builder, packer, and optional Ed25519 signer.
Installation sends a real, canonical absolute artifact path through
`plugin.install-path`; archive bytes never enter NDJSON.

Task input is bounded before JSON parsing and normalized through the public
operation contracts. `task run` waits by default and supports `--no-wait`.
Unknown status remains `null`; a terminal `indeterminate` record preserves its
non-retryable diagnostic and has no output. Human and JSON modes serialize the
same typed result. Direct injected control responses pass through the same
protocol validation and sanitization boundary as real socket responses.

Plugin packaging rejects artifact, signature, and private-key output collisions
before writing. The preflight covers lexical paths, symlinked parents, dangling
symlinks, hard links, and a conservative NFC/case-folded portable path identity.
Controlled plugin and task responses are correlated back to their request,
deployment, artifact, task, and attempt identities.

## TDD commits

- `28705c8` — `test: specify plugin and task commands`
- `0a75045` — `test: cover complete plugin and task cli surface`
- `2ce97db` — `test: reject unsafe plugin and task inputs`
- `5d5c5b4` — `test: bound plugin and task command inputs`
- `946257f` — `test: verify cli control parity and build reuse`
- `3e53464` — `feat: add plugin and task cli commands`
- `a0a272f` — `style: format task command test`
- `09efd31` — `test: expose cli protocol boundary gaps`
- `12f5f32` — `test: strengthen cli response correlations`
- `681850d` — `test: cover dangling artifact path aliases`
- `123c59d` — `fix: harden plugin and task cli boundaries`
- `9157c27` — `test: expose portable cli identity aliases`
- `0aee6f2` — `fix: normalize cli correlation identities`
- `d9bbbbc` — `test: expose sanitized task request mismatch`
- `a0ed254` — `fix: correlate sanitized task requests`

Every behavioral test commit was observed failing against the unsupported or
incomplete command behavior before the production implementation passed it.
The review-fix RED suite produced ten deterministic failures, followed by two
additional portable-identity failures, before their respective GREEN commits.
The final request-correlation RED proved that both direct injection and a real
control socket rejected diagnostic-shaped business input after response
sanitization; its GREEN compares both sides after the same sanitization and JSON
wire normalization.

## Verification

- `npm run test:unit --workspace @tegojs/cli`
  - 102 tests: 101 passed, 1 Windows-only skip, 0 failed.
- `npm run build`
  - all workspaces passed.
- `npm run typecheck`
  - all workspaces passed.
- `npm test`
  - 643 tests: 642 passed, 1 Windows-only skip, 0 failed.
- `npm run format:check`
  - 195 files checked, no changes required.
- `npm run lint`
  - 195 files checked, no diagnostics.
- `npm run commitlint:ci`
  - passed.
- `git diff --check`
  - passed.
- Worktree was clean after removing the generated echo-plugin build output.

The CLI suite also proves identical typed JSON output through an injected
control call and a real local control socket, rejects success frames with a
missing `result`, preserves explicit `null`, sanitizes nested diagnostics, uses
one monotonic run/wait timeout budget, and accepts requests that are equivalent
on the JSON wire. Diagnostic-shaped business input is correlated after the same
sanitization through both direct and socket run/wait paths, while task,
component, and attempt mismatches remain rejected.

## Deliberate bounds

- Runtime-operation JSON input is capped at the public one-mebibyte limit before
  parsing.
- Task deadlines must be in the future.
- Explicit timer delays above Node's `2^31 - 1` millisecond limit are rejected;
  deadline-derived waits are capped at that limit rather than silently clamping
  to approximately one millisecond.
- `task wait` defaults to five minutes and accepts a bounded `--timeout-ms`.

## Remaining risks

- Human rendering intentionally remains the same compact typed JSON
  serialization; a future presentation-only renderer may improve readability
  without changing command semantics.
- Very long task waits beyond Node's maximum single timer interval require the
  caller to resume waiting after the bounded control timeout.

No Task 7 blocker remains.
