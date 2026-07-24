# Project Documentation and Continuous Integration Design

Date: 2026-07-24

## Objective

Make Tego Next understandable and safely contributable without introducing a
release pipeline before the package and compatibility contracts are stable.

This change adds:

- a root README that explains the product, architecture, packages, local
  development, testing, and contribution workflow;
- Conventional Commits enforcement locally and in GitHub;
- GitHub Actions checks for static validation, unit tests, builds, and
  PostgreSQL integration tests.

The current delivery boundary is continuous integration only. It does not
publish npm packages, create GitHub Releases, deploy services, or change branch
protection settings.

## Design Principles

1. Local feedback and GitHub enforcement use the same commitlint
   configuration.
2. PostgreSQL integration tests run against an isolated disposable database.
3. Fast deterministic checks and database integration tests are separate jobs
   so their results are independently visible.
4. Tool versions and action major versions are explicit.
5. The checked-in lockfile remains the dependency source of truth.
6. The project does not add a general-purpose release abstraction before a
   release target exists.

## README

The root `README.md` will contain:

1. Tego Next's purpose as the first-layer runtime kernel.
2. The three-layer architecture and the scope of this repository.
3. Implemented first-layer capabilities:
   - application and plugin lifecycle;
   - capability resolution;
   - local and PostgreSQL state/coordination drivers;
   - thread, process, and remote worker execution;
   - WebSocket worker transport;
   - plugin packaging and signing.
4. A workspace package map.
5. Requirements: Node.js 26.5.0 and npm 11.
6. Installation, build, typecheck, test, and verification commands.
7. Local PostgreSQL startup and integration-test commands.
8. A minimal echo-plugin path for plugin developers.
9. Conventional Commit contribution rules.
10. The current stability and release status.

The README must describe only capabilities present in the repository. It must
not claim package publication, API stability, production readiness, or a
compatibility layer.

## Commit Policy

### Configuration

The repository will use:

- `husky` for Git hook installation;
- `@commitlint/cli` for message validation;
- `@commitlint/config-conventional` as the shared rule set;
- an ECMAScript module commitlint configuration at the repository root.

Dependencies use exact versions, consistent with the existing package policy.

### Local Hook

`npm install` and `npm ci` will run a `prepare` script that installs Husky
hooks. `.husky/commit-msg` will validate the message file passed by Git using
the root commitlint configuration.

The hook will not run the complete test suite. Commit message validation is
fast and belongs in `commit-msg`; source validation remains available through
normal npm scripts and GitHub checks.

### Accepted Format

Messages follow:

```text
<type>(optional-scope): <description>
```

The Conventional Commits default type set is accepted, including `build`,
`chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`,
and `test`. Merge and automatic revert messages retain commitlint's standard
ignore behavior.

### GitHub Enforcement

GitHub Actions will validate every commit introduced by a pull request. Pushes
to `main` will validate commits in the pushed range. A small repository script
will normalize GitHub event ranges so the same npm command can be tested
locally without embedding complex shell conditionals in workflow YAML.

## Continuous Integration

### Triggers and Permissions

The workflow runs on:

- pull requests targeting `main`;
- pushes to `main`;
- manual dispatch.

It uses `contents: read` permissions and cancels obsolete runs for the same
pull request or branch.

### Quality Job

The `quality` job runs on Ubuntu and performs:

1. checkout with complete commit history;
2. Node.js setup from `.node-version` with npm caching;
3. `npm ci`;
4. commit-range validation;
5. formatting check;
6. lint;
7. build workspace dependencies;
8. TypeScript typecheck;
9. unit and architecture tests.

These commands remain separate workflow steps so GitHub identifies the failing
gate directly.

### PostgreSQL Integration Job

The `postgres-integration` job runs in parallel with `quality` on Ubuntu. It
starts `postgres:16.14-alpine` as a service with:

- a dedicated test user, password, and database;
- port 5432 exposed to the runner;
- `pg_isready` health checks.

The job installs dependencies with `npm ci` and runs the root integration test
script with `TEGO_POSTGRES_URL` pointing to the service database. The tests are
responsible for their existing namespace isolation and cleanup behavior.

Credentials are non-secret, disposable CI-only values and will be defined in
the workflow rather than GitHub Secrets.

### Continuous Delivery Boundary

For this phase, a commit is deliverable when both jobs pass. Repository
administrators may select these jobs as required branch checks. The workflow
does not mutate external systems or publish artifacts.

## Test Strategy

Implementation follows a red-green sequence.

### Tooling Contract Tests

A root Node test will initially assert the intended repository contract and
fail while files are absent. It will verify:

- the README includes the required developer entry points;
- the root package exposes commitlint and preparation scripts;
- the commitlint configuration extends the conventional rules;
- the Husky `commit-msg` hook invokes the repository script;
- the workflow declares the required triggers, permissions, jobs, Node setup,
  PostgreSQL service, and integration-test environment.

Assertions will focus on stable contractual markers rather than formatting the
files byte-for-byte.

### Behavioral Commitlint Tests

After dependencies and configuration exist, executable tests will demonstrate:

- `feat(runtime): add lifecycle` is accepted;
- `added lifecycle support` is rejected;
- the committed `commit-msg` hook accepts and rejects the same examples.

### CI Validation

Local verification will run:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
TEGO_POSTGRES_URL=postgresql://tego_dev:tego_dev@127.0.0.1:5432/tego_next_test \
  npm run test:integration
```

The workflow YAML will also be syntax-checked locally when a compatible
validator is available. The first pull request or `main` push provides
GitHub's authoritative workflow execution result.

## Failure Behavior

- Invalid local commit messages stop before the commit is created.
- Invalid pull request commits fail the `quality` job even if hooks were
  bypassed.
- PostgreSQL startup or connectivity failures fail only the integration job
  and preserve its logs.
- Static validation failures do not suppress the separately running database
  result.
- Installation uses `npm ci`, so manifest and lockfile drift fails early.

## Acceptance Criteria

1. A new contributor can identify the project scope and run local checks from
   the root README.
2. Valid Conventional Commit messages pass locally; invalid messages fail.
3. GitHub checks cover commit messages, formatting, lint, typecheck, unit and
   architecture tests, builds, and PostgreSQL integration tests.
4. CI uses Node.js 26.5.0 and PostgreSQL 16.14.
5. The full existing local test suite remains green.
6. No npm package, GitHub Release, or deployment is produced.
