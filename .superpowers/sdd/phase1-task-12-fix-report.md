# Phase 1 Task 12 Review Fix Report

## Outcome

The Task 12 release and CI contract now distinguishes local verification from
release verification, produces mandatory machine-readable CI evidence, invokes
the pinned OpenSpec CLI without a global installation, validates each CI job
slice structurally, and uses Node plus the active npm CLI for cross-platform
child-process execution.

OpenSpec task 12.3 remains checked because its focused architecture and
reporter tests pass. The full `verify:release` evidence gap remains intentionally
open for the orchestrated clean-tree PostgreSQL run.

## Finding-to-Fix Map

### Important 1: `npm run verify` required PostgreSQL and multi-Main

- Regression: `release verification is strict, complete, and non-recursive`
  asserts the exact local-only command graph.
- Fix: added `test:integration:local`; `verify` now runs root/local integration
  plus `test:e2e:single-main` only.
- Release/CI preservation: `test:integration` still adds workspace PostgreSQL
  integration, while `verify:release` and CI retain full integration and
  multi-Main takeover.

### Important 2: CI evidence could be empty or absent

- Regression: `CI reporter always writes nonempty JSON metadata and process
  logs` exercises both exit 0 and a child exiting 7 and asserts the child exit
  code is preserved.
- Fix: `scripts/run-ci-test.mjs` tees live stdout/stderr to the console and a
  nonempty `*-process.log`, then writes `*-result.json` with command, arguments,
  timestamps, actual invocation, exit code, signal, and spawn error metadata.
- CI contract: integration, single-Main, and multi-Main steps use the reporter
  under `if: always()`. Upload steps also use `if: always()` and
  `if-no-files-found: error`.
- Expected filenames:
  `integration-{result.json,process.log}`,
  `single-main-{result.json,process.log}`, and
  `multi-main-{result.json,process.log}`.

### Important 3: release verification used a global `openspec`

- Regression: the release command plan and workflow contract require
  `npm run openspec:validate` and reject direct `npx` use in the CI job.
- Fix: repository script `openspec:validate` delegates to
  `verify-release.mjs --openspec`, which uses the active npm CLI to execute the
  exact `@fission-ai/openspec@1.4.1` package. CI and `verify:release` both invoke
  that script. A clean checkout needs no global OpenSpec installation.

### Important 4: workflow validation used whole-file substrings

- Regression: `CI workflow validation rejects evidence and commands placed in
  the wrong job` mutates the OpenSpec and single-Main anchors and proves the
  validator fails closed.
- Fix: `parseWorkflowJobs` extracts exact `quality`, `integration`, and
  `system-e2e` slices. `validateWorkflowContract` checks job identity, commands,
  conditions, environment, services, upload policy, and step ordering within
  the owning slice.
- Stale system-E2E anchors in `project-ci.test.mjs` now target the current
  single-Main and multi-Main reporter commands.

### Conditional Windows minor: bare npm/npx child shims

- Regression: release command assertions require `process.execPath`; reporter
  behavior is exercised as a direct Node process.
- Fix: `resolveNpmCli` prefers `process.env.npm_execpath` and otherwise selects
  a deterministic platform-specific npm CLI path. Both release verification and
  reporter-wrapped npm commands spawn `process.execPath` with that CLI path.
  Pinned OpenSpec runs through the repository npm script.

## TDD Evidence

### RED

```text
node --test tests/architecture/system-ci.test.mjs tests/architecture/project-ci.test.mjs
```

Initial result: exit 1; 9 tests, 3 passed, 6 failed. Failures covered the
missing structural parser, local-only verify graph, repository OpenSpec script,
job-local workflow validation, and reporter artifacts.

Two narrower RED cycles then proved that direct `npx` remained in the
repository script and that an integration upload changed from `always()` to
`success()` could evade the first job-slice validator. Both focused tests failed
before their respective fixes and passed afterward.

### GREEN

```text
node --test tests/architecture/system-ci.test.mjs tests/architecture/project-ci.test.mjs
```

Result: exit 0; 9 tests, 9 passed, 0 failed. The reporter test includes a child
that exits 7 and verifies the wrapper also exits 7 after writing both evidence
files.

```text
npm run format:check
npm run lint
```

Results: exit 0; Biome checked 231 files with no fixes and no diagnostics.

## Broader Verification and Known Gap

`npm run verify` completed format, lint, build, typecheck, all unit and
architecture tests, and all 67 root/local integration tests without requiring
`TEGO_POSTGRES_URL`. Its final single-Main smoke reached the process-cleanup
assertion but failed twice at the existing immediate post-`SIGKILL`
`ManagedProcess.assertClean()` race:

```text
PROCESS_STILL_RUNNING:main:<pid>
tests/e2e/single-main-process.test.mjs:395
```

This failure is outside Task 12 ownership and is not hidden as passing evidence.
The parent integration lane must rerun the complete local verification after
the system-harness cleanup fix is integrated.

The clean-tree PostgreSQL `npm run verify:release` run remains deferred to the
orchestrator exactly as requested.
