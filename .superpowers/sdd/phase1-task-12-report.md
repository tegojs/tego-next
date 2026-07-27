# Phase 1 Task 12 Report

## Outcome

Task 12 adds a fail-closed `npm run verify:release` entry point and normalizes
the authoritative GitHub Actions jobs to `quality`, `integration`, and
`system-e2e`.

The release verifier requires:

- a clean working tree;
- exactly Node.js 26.5.0 and npm 11.13.0;
- a non-empty `TEGO_POSTGRES_URL`;
- all required CI contract markers;
- successful clean install, format, lint, build, typecheck, unit/architecture,
  integration, deterministic plugin packaging, single-Main, multi-Main, and
  strict OpenSpec commands.

It emits structured JSON diagnostics and never invokes `verify:release`
recursively.

## TDD Evidence

### RED

Command:

```text
node --test tests/architecture/system-ci.test.mjs tests/architecture/project-ci.test.mjs
```

Result before implementation: exit 1, 6 tests, 2 passed, 4 failed. The failures
proved the absence of the normalized `integration`/`system-e2e` jobs,
`verify:release`, the release command plan, and strict preflight validation.

Commit:

```text
8507933 test: specify system ci gates
```

A second focused RED covered command-failure conversion:

```text
node --test --test-name-pattern="command failures" tests/architecture/system-ci.test.mjs
```

Result: exit 1 because `runReleaseCommand` was not yet exported.

### GREEN

Command:

```text
node --test tests/architecture/system-ci.test.mjs tests/architecture/project-ci.test.mjs
```

Result after implementation: exit 0, 7 tests, 7 passed, 0 failed.

Implementation commit:

```text
fa7f46a ci: enforce runtime system acceptance
```

## Verification Evidence

- `npm run verify:release -- --preflight` — expected exit 1 with structured
  `dirty_worktree`, `npm_version_mismatch`, and `postgres_url_missing`
  diagnostics. The local Node version is the required `v26.5.0`; local npm is
  `11.17.0`.
- `npm run lint` — exit 0, 230 files checked.
- `npm run build && npm run typecheck` — exit 0 for every workspace.
- `npm test` — exit 0, including all workspace unit tests and 43/43 root
  architecture tests.
- `openspec validate runtime-kernel-phase-1 --strict --no-interactive` — exit 0;
  change is valid.
- `git diff --check` — exit 0 before the implementation commit.

## Deferred Full Release Run

The default `npm run verify:release` was not weakened or bypassed for this
worktree. Its full GREEN run is deferred to the final orchestrator on a clean
branch with npm 11.13.0 and live PostgreSQL.

Local PostgreSQL verification could not run because the Docker daemon was
unavailable. The root integration portion passed 67/67 before the PostgreSQL
workspace failed to connect to `127.0.0.1:55432` (`ECONNREFUSED`; 62 expected
database-backed failures).

The existing single-Main process scenario was also run twice and failed both
times at its pre-existing managed-process cleanup boundary with
`PROCESS_STILL_RUNNING:main`. No Task 12 file owns that process harness. The new
release command and `system-e2e` CI gate correctly treat this as a blocking
failure instead of suppressing it.
