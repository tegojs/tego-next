# Phase 1 Documentation Report

## Outcome

OpenSpec tasks 12.1 and 12.2 are complete.

The documentation now has four maintained entry points:

- `docs/architecture/runtime-kernel.md` — first-layer boundaries, package
  direction, deployment/runtime/component/task/Worker state machines,
  persistence, fencing, protocol compatibility, and failure semantics;
- `docs/security/threat-model.md` — trust boundaries, permission enforcement
  and limits, executor isolation, secrets, network exposure, and deferred
  security work;
- `docs/guides/contributing-and-plugins.md` — exact toolchain, strict
  OpenSpec-linked red-green-refactor, verification, and the current plugin
  manifest/package/sign/install/deploy/run workflow;
- `docs/operations/deployment-topologies.md` — embedded SQLite/artifact
  lifecycle and PostgreSQL leader/follower/Worker/takeover operations.

`README.md` contains navigation links only. The canonical OpenSpec task list now
marks 12.1 and 12.2 complete.

## Source cross-check

The documentation was checked against:

- the proposal, design, task list, and all eight delta specifications under
  `openspec/changes/runtime-kernel-phase-1/`;
- every workspace `package.json`, public `src/index.ts` export surface, and the
  enforced dependency graph in `scripts/check-boundaries.mjs`;
- `.node-version`, root package scripts, the lockfile toolchain metadata, and
  `.github/workflows/ci.yml`;
- the CLI parser, help text, control dispatch, runtime composition, and plugin,
  task, Worker, packaging, and signing implementations;
- runtime lifecycle, reconciliation, task persistence, SQLite/PostgreSQL
  drivers, fencing, Worker session, remote attempt, protocol codec, permission,
  secret, and executor implementations;
- the example plugin and the real single-Main/two-Main system test topology.

This cross-check corrected the runtime placement order to process, thread, then
remote. It also kept two implementation gaps explicit:

1. Signing is integrated into `plugin pack`, but local `plugin install` does not
   accept the signature envelope or trust-key configuration.
2. `worker start` supports connect and listen, but `runtime start` does not
   expose Main-side Worker listener, credential, or outbound connection
   options. The process system harness composes that boundary through the
   exported Node API.

## TDD evidence

### RED

Command:

```text
node --test tests/architecture/documentation.test.mjs
```

Result before documentation: exit 1; 8 tests, 0 passed, 8 failed because the
required documents and README links did not exist.

Commit:

```text
42f4e2fcf21974920cf5c7b6cc73fc534bc5c419
test(docs): specify phase one documentation
```

### GREEN

Focused command:

```text
node --test tests/architecture/documentation.test.mjs
```

Result: exit 0; 8 tests, 8 passed, 0 failed.

Documentation commit:

```text
7f8053528c96bf705ab812be00140cc35fa10973
docs: document phase one architecture and operations
```

## Verification evidence

- `node --test tests/architecture/*.test.mjs` — exit 0; 56 tests passed.
  This includes 8 documentation contract tests, README coverage, local-link
  resolution, forbidden false-claim checks, package boundary checks, and CI
  contract checks.
- `npm run test:unit --workspace=@tegojs/cli` — exit 0; 139 tests passed and 1
  Windows-only test skipped. Coverage includes pack/sign, plugin operations,
  task operations, runtime lifecycle parsing, and Worker connect/listen.
- `npm run test:e2e:single-main` — exit 0; the real process flow packed,
  installed, deployed, ran thread/process/remote tasks, restarted Main, and
  verified durable recovery.
- `npm run format:check` — exit 0; 234 files checked.
- `npm run lint` — exit 0; 234 files checked.
- `npm run openspec:validate` — exit 0; strict
  `runtime-kernel-phase-1` validation passed.
- `git diff --check` — exit 0 before the GREEN commit.

## Known documentation limits

- The local machine runs Node.js 26.5.0 but npm 11.17.0. The documented
  `npm install --global npm@11.13.0` command and exact version check match the
  repository pin and authoritative CI workflow; this slice did not mutate the
  machine's global npm installation.
- A PostgreSQL multi-Main system run was not repeated in this documentation
  slice. The topology was checked against its current real-process system test,
  PostgreSQL drivers, runtime composition, and required CI gate.
- Full `npm run verify:release` was not run because it requires a clean tree,
  npm 11.13.0, and a live PostgreSQL URL. The requested documentation-focused
  verification passed.
- The packages remain unpublished, APIs remain alpha-stage, and production
  release remains blocked until Node.js 26 enters LTS.
