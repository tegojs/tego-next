# Task 7 Report: Capability Resolution and Permission Envelopes

## Delivered

- Added deterministic capability resolution with:
  - deployment identity as `(applicationId, pluginId)`;
  - strict protocol version/range validation with no vacuous alternatives;
  - explicit binding precedence and distinct missing, incompatible, and unready diagnostics;
  - unique ready-provider auto-selection;
  - optional absence;
  - provider-first ordering, including acyclic optional edges;
  - Tarjan required-cycle and self-cycle detection;
  - deterministic duplicate-input diagnostics;
  - `degrade`, `suspend`, and `fail` provider-loss decisions.
- Extracted the tested version-range implementation from `ArtifactService` so artifact and
  capability compatibility cannot diverge.
- Replaced string permissions with seven JSON-safe discriminated permission categories:
  capability, executor, network, filesystem, secret, environment, and Worker.
- Added grant subset validation and pre-dispatch call gates with canonical DNS, HTTP method,
  logical POSIX path, portable-name, selector, and resource-ceiling handling.
- Added request/response JSON Schema gates that clone and validate boundary data without invoking
  getters, accepting exotic prototypes, mutating caller data, or leaking schema exceptions.
- Migrated the echo example and testkit fixture to structured executor permissions. Explicit empty
  manifest and deployment permission arrays remain valid; legacy permission strings are rejected.

The permission API is a policy gate. It does not claim that trusted Worker Threads or Node APIs
provide an operating-system sandbox.

## TDD Evidence

RED commits:

- `df84695` — missing capability resolver, permission contracts, and gate APIs.
- `5ba2c25` — duplicate capability identities, SemVer prerelease ordering, and accessor-backed
  permission calls reproduced failures.
- `18f2334` — acyclic optional providers were ordered after consumers.
- `5ec92e9` — exotic boundary arrays were accepted.
- `1b2ea68` — echo fixture still used an unstructured empty permission declaration.

GREEN commits:

- `621e21a` — initial capability resolver, contracts, permission canonicalization, gates, and
  payload validation.
- `d632732` — duplicate capability rejection, strict prerelease handling, and safe call cloning.
- `870b1de` — provider-first optional ordering without turning optional cycles into required
  cycles.
- `ca79318` — exotic boundary array rejection.
- `a43ef2e` — structured echo fixture and example migration.

Cleanup:

- `43b8c4e` — removed an unused resolver helper after lint verification.

## Verification

All successful verification below used the pinned Node.js `26.5.0` through Volta:

- contracts: 16/16 tests passed;
- runtime: 99/99 tests passed;
- CLI/artifact fixtures and reproducibility: 37/37 tests passed;
- testkit: 3/3 tests passed;
- local drivers and SQLite regressions: 66/66 tests passed;
- architecture boundary suite: 18/18 tests passed;
- affected package typechecks passed for contracts, runtime, CLI, testkit, and drivers-local;
- Biome format check, lint, and `git diff --check` passed.

The root `npm run typecheck` remains unavailable because four future-stage placeholder packages
(`drivers-postgres`, `executor-node`, `plugin-sdk`, and `transport-websocket`) do not yet contain
their declared `tsconfig.json`. Their absence predates Task 7; the complete affected-package
typecheck passed.
