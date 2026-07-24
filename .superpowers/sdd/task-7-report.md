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

## Formal Review Remediation

The formal review requested changes were handled in additional RED/GREEN slices:

- `e2f2b03` / `e25cf00`
  - resolver inputs are cloned as safe JSON before use;
  - binding lookup uses own enumerable data properties only, so names such as `constructor` and
    `toString` cannot resolve through `Object.prototype`;
  - accessor, symbol, exotic-prototype, and non-JSON binding maps fail with stable diagnostics;
  - duplicate providers use `(name, protocolVersion)`, allowing one deployment to expose distinct
    protocol versions;
  - Worker selectors may be safely narrowed by adding exact labels while resource ceilings may
    only decrease;
  - runtime logical paths use the same portable-segment grammar as the public schema.
- `a0f7647` / `5187537`
  - capability definitions are cloned, parsed, frozen, and compiled during explicit registry
    registration;
  - structurally identical schemas reuse validators, including schemas with `$id`;
  - a reused `$id` with different canonical schema content is rejected deterministically;
  - request/response hot paths clone and validate payloads only;
  - registry cache lifetime is explicit through `CapabilitySchemaRegistry.clear()`, and no payload
    values are cached.
- `42e9a29` / `1676d72`
  - static compatible dependency edges are built before readiness checks, so unready required
    cycles are still diagnosed;
  - missing, unavailable, and explicit-unready conditions remain distinct;
  - `previousBindings` drives deterministic `providerLossActions` in the resolution result for
    required/optional and explicit/automatic bindings;
  - initial unavailability produces no false loss action, and recovery clears prior loss actions.
- `c5a9b37` / `914b49f`
  - the dependency-free version matcher now documents and implements its strict supported subset;
  - top-level and partial wildcards, partial comparator bounds, zero-major caret ranges, exact
    prerelease comparators, prerelease opt-in, and arbitrary-length numeric prerelease identifiers
    have explicit tests;
  - unsupported and hyphen syntax is invalid and cannot match;
  - ArtifactService continues to use the same matcher and has direct regression coverage.
- `9ca4031` / `b48a7f9`
  - the public filesystem schema now rejects leading and nested `.`/`..` segments exactly as the
    runtime canonicalizer does.

`3f0ebae` is the final lint-only simplification after these changes.

## Final Re-review Remediation

- RED `9830919` reproduced the remaining findings:
  - multi-segment top-level wildcards such as `x.x`, `x.x.x`, and `*.*` were accepted as valid
    ranges but did not behave universally;
  - duplicate deployment validation depended on which identical deployment appeared first;
  - a consumer already marked unready still received a provider-loss action.
- GREEN `0b02c34` closes them with narrow changes:
  - only single-token `x`, `X`, and `*` are universal; multi-segment top-level wildcards are
    consistently invalid and never match, including through ArtifactService;
  - duplicate identities are diagnosed while every grouped deployment is still validated, making
    diagnostics independent of duplicate input order;
  - provider-loss propagation requires the consumer itself to be ready.

Focused RED was observed with three failing resolver assertions; the artifact cases already
rejected the malformed ranges and therefore confirmed the inconsistency was specifically in
`isValidVersionRange`. Focused GREEN passed 94/94 artifact and capability tests.
