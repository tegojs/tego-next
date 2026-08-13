# Phase 1 Alpha Release and Hardening Design

## Status

Approved for implementation planning on 2026-08-13.

## Objective

Close Phase 1 as a publicly consumable alpha release while preserving the existing Tego 1.x
stable channel. The release publishes the nine runtime-kernel workspaces as
`@tego/*@2.0.0-alpha.1`, completes the four accepted Phase 1 hardening items, records fresh release
evidence on the final commit, and then synchronizes and archives the Phase 1 OpenSpec change.

This release is an evaluation release. It does not claim production readiness and does not begin
Phase 2 or Phase 3 work.

## Scope

### In scope

- Rename the public workspace namespace and all active source, test, example, and current
  documentation references from `@tego/*` to `@tego/*`.
- Publish these packages at `2.0.0-alpha.1`:
  - `@tego/contracts`
  - `@tego/runtime`
  - `@tego/plugin-sdk`
  - `@tego/drivers-local`
  - `@tego/drivers-postgres`
  - `@tego/executor-node`
  - `@tego/transport-websocket`
  - `@tego/testkit`
  - `@tego/cli`
- Add complete public-package metadata, licensing, package documentation, tarball validation, and a
  resumable dependency-ordered release command.
- Complete readiness-timeout process cleanup, PostgreSQL test namespace cleanup, Windows named-pipe
  access-control hardening, and artifact storage quotas.
- Run final local and authoritative CI release gates, publish the packages under the `alpha`
  dist-tag, create and push `v2.0.0-alpha.1`, and create a GitHub prerelease.
- Synchronize Phase 1 delta specifications to the main OpenSpec tree and archive the completed
  change only after verification and publication succeed.

### Out of scope

- Publishing or changing `@tego/core` and `@tego/server`.
- Moving the Node composition root from `@tego/cli` to a new `@tego/node-host` package.
- HTTP hosting, user authentication and authorization, data sources, caching, resource management
  beyond the artifact quota described here, workflows, frontend support, container orchestration,
  or any other Phase 2 or Phase 3 capability.
- Declaring the runtime production-ready before Node.js 26 reaches LTS and a new production review
  is completed.

## Registry and Version Strategy

The prior Tego generation remains under `@tego` with stable versions through `1.6.17`. Registry
inspection on 2026-08-13 found no `2.0.x` version of `@tego/core` or `@tego/server`. The nine new
runtime-kernel package names were not present in the public npm registry.

All nine packages use the exact version `2.0.0-alpha.1`. Internal runtime dependencies use that
exact version rather than a range so a release cannot combine incompatible alpha builds.

Every publish operation explicitly supplies:

```sh
npm publish --registry https://registry.npmjs.org/ --access public --tag alpha
```

The release must not create or update `latest`. After publication, every package must satisfy:

```text
alpha -> 2.0.0-alpha.1
latest -> absent
```

Consequently, consumers opt in with `@alpha` or the exact version. An unqualified install does not
resolve to the alpha release.

The Git release identity is `v2.0.0-alpha.1`. GitHub must mark it as a prerelease.

## Public Package Metadata and Contents

Each public package declares:

- a package-specific description;
- `license: "Apache-2.0"`;
- `homepage: "https://github.com/tegojs/tego-next#readme"`;
- `bugs.url: "https://github.com/tegojs/tego-next/issues"`;
- a repository object containing the Git URL and its workspace directory;
- `engines.node: ">=26.5.0 <27"`;
- `publishConfig.access: "public"`, `publishConfig.tag: "alpha"`, and the official npm registry;
- a package README explaining purpose, alpha status, installation, and its primary entry point.

The repository root contains the authoritative Apache-2.0 `LICENSE`. npm tarballs contain only the
files needed by consumers: package metadata, README, LICENSE, compiled JavaScript, declarations,
and source maps where intentionally retained. They exclude tests, raw TypeScript sources,
`.tsbuildinfo`, temporary data, and local diagnostics.

A package-contract test builds and inspects every tarball. It verifies the name, version, metadata,
entry points, executable mode for the CLI, internal dependency versions, license inclusion, and an
allowlist of file classes. It also installs the packed tarballs in a clean temporary consumer and
imports every public entry point; the CLI tarball must execute its help path.

## Release Orchestration

The release command has separate `preflight`, `pack`, `publish`, and `verify-registry` modes. It
never silently changes the caller's npm registry configuration.

### Preflight

Preflight fails unless all of the following are true:

- the Git worktree is clean and `HEAD` is the reviewed release commit;
- Node.js is exactly `26.5.0` and npm is exactly `11.13.0`;
- the explicit registry is `https://registry.npmjs.org/`;
- `npm whoami` succeeds against the official registry;
- the authenticated account can access the `@tego` scope;
- `2.0.0-alpha.1` is absent for every target package;
- the full release verification evidence is green for the same commit;
- the tag and GitHub release do not already conflict with different content.

The local environment is managed by Volta. The root package metadata pins Node.js `26.5.0` and npm
`11.13.0` through Volta in addition to the existing `.node-version`, `engines`, and
`packageManager` declarations.

### Dependency order and resumability

The release command derives or validates a topological order from workspace dependencies. A valid
order begins with `@tego/contracts`, publishes independent leaf libraries next, and publishes
`@tego/cli` only after all of its runtime dependencies are available.

Before each upload, the command packs the workspace and records its SHA-512 integrity. If a package
version is already present during a resumed run, it is skipped only when the registry tarball's
integrity and the `alpha` tag match the expected artifact. Any mismatch terminates the release.
This makes recovery from a partial nine-package publication explicit without attempting to
unpublish immutable versions.

After all packages are present, registry verification checks package metadata, integrity, internal
dependency versions, and dist-tags. The Git tag and GitHub prerelease are created only after those
checks pass.

## Hardening Design

### Deterministic cleanup after readiness failure

The real-process E2E harness registers a managed Main process immediately after spawn, before
waiting for readiness. The same cleanup registry owns normal shutdown, readiness timeout,
readiness-parser failure, and test failure. Cleanup remains bounded, terminates the whole process
tree, captures diagnostics, and completes before temporary workspaces are removed. Tests inject a
readiness failure after the child and a grandchild exist and prove neither survives teardown.

### PostgreSQL test namespace cleanup

PostgreSQL-backed system tests allocate a unique, validated namespace for every run. A shared test
helper deletes only rows bearing that exact namespace from the known Phase 1 tables inside a
bounded cleanup path. It rejects empty, default, wildcard, or malformed namespaces. Cleanup runs in
`finally`, including readiness and takeover failures, after diagnostic artifacts are captured.

The helper is test-only; no broad production cleanup CLI is introduced. CI service containers
remain ephemeral, while repeated local runs no longer accumulate successful-run namespaces.

### Windows named-pipe access control

The local control endpoint remains a trusted administrative boundary on every supported platform.
On Windows, startup resolves the current user SID and applies a discretionary ACL that grants pipe
access only to that user and required system principals. Admission validates the connected client
identity before dispatch. If the identity or ACL cannot be established, startup fails closed with a
structured diagnostic; it does not start an unhardened administrative endpoint.

Platform-independent policy logic is covered on all CI platforms. A Windows CI job exercises real
named-pipe creation, allowed current-user access, rejection/failure behavior, shutdown, and process
tree cleanup. Documentation removes the accepted Windows-hardening limitation only after this gate
passes.

### Artifact storage quotas

Artifact admission enforces two explicit limits supplied by driver/runtime configuration:

- maximum bytes for one artifact;
- maximum committed plus reserved artifact bytes for one runtime namespace.

Defaults are finite and documented; tests use smaller injected limits. Existing deployments may
override the limits deliberately, but cannot use negative, non-integer, or unsafe values.

The content digest is computed and validated before commit. Re-registering an existing digest does
not consume quota again. Concurrent new writes atomically reserve capacity before bytes become
visible; a failed write releases its reservation. Local filesystem and PostgreSQL implementations
use the same public artifact-store contract and conformance scenarios. Over-limit operations fail
with a stable structured runtime error and do not leave bytes, metadata, or quota reservations
behind.

Follower artifact ingress is subject to the same namespace quota, closing the accepted trusted
client storage-exhaustion gap without adding general Phase 2 resource management.

## Verification and Evidence

Implementation follows test-first red-green-refactor cycles. Completion requires fresh evidence
from the final release commit:

- formatting and lint checks;
- clean build and TypeScript checks;
- all unit and architecture suites;
- local integration and real single-Main E2E;
- PostgreSQL integration and real two-Main takeover E2E using PostgreSQL 16;
- deterministic package reproduction and clean tarball-consumer installation;
- real Windows named-pipe tests in GitHub Actions;
- strict OpenSpec validation;
- full `verify:release` under Node.js 26.5.0 and npm 11.13.0;
- exact-SHA authoritative GitHub Actions success.

Release notes and review records state the package names, `2.0.0-alpha.1`, alpha opt-in commands,
dist-tag behavior, supported platforms, hardening changes, remaining non-production gates, and the
authoritative workflow URL.

## OpenSpec and Workflow Closure

The Phase 1 delta specifications are intelligently merged into
`openspec/specs/<capability>/spec.md`. The sync is idempotent and preserves all requirements and
scenarios. The active change is archived to the date-prefixed OpenSpec archive only when:

- every Phase 1 task is complete;
- implementation and documentation match the delta specs;
- local and authoritative verification are green;
- all npm packages and their `alpha` tags are verified;
- the Git tag and GitHub prerelease exist.

The Comet metadata and verification report record the final commit, commands, results, registry
package versions, Git tag, GitHub release URL, and archive path. No `pending` build or verification
state remains in the archived record.

## Failure Handling

- A missing npm login or scope permission pauses before any publication.
- A package/version collision pauses before publication unless it is a verified matching artifact
  from the same resumable release.
- A partial publish is resumed forward; published versions are never overwritten or silently
  unpublished.
- A failed registry verification prevents Git tagging, GitHub release creation, and OpenSpec
  archival.
- A failed CI or local release gate prevents publication.
- Destructive cleanup accepts only validated test namespaces and never targets an entire database,
  repository, workspace root, or registry package history.

## Success Criteria

Phase 1 is closed when all nine `@tego/*@2.0.0-alpha.1` packages are publicly installable through
the `alpha` tag, no package has a `latest` tag created by this release, the four hardening gaps are
covered by executable tests, final release evidence is green, `v2.0.0-alpha.1` and its GitHub
prerelease exist, and the synchronized Phase 1 OpenSpec change is archived with no pending state.
