# Task 2 Report — Package Contracts

## Scope delivered

- Added the root Apache-2.0 license and exact, regular-file copies in all nine public workspaces.
- Added package descriptions, Apache-2.0/license metadata, public npm alpha publish configuration, repository directories, homepage, bugs URL, and Node engine bounds.
- Restricted each package `files` allowlist to compiled `dist/src` JavaScript/declaration assets plus `README.md` and `LICENSE`.
- Added package READMEs with the public alpha install command and explicit experimental, non-production status.
- Added `scripts/package-contract.mjs`, exporting:
  - `inspectWorkspacePackages(root)`
  - `packWorkspaceSet(root, outputDirectory)`
  - `verifyPackedConsumer(packedWorkspaces, consumerDirectory)`
- The package contract packs all nine workspaces with npm JSON output, rejects raw TypeScript, build info, test content, and non-allowlisted files, then installs the tarballs in a clean temporary consumer, imports every package root, and executes the packed CLI help command.
- Added the package-contract release stage and architecture coverage.

## RED evidence

Command:

```sh
node --test tests/architecture/package-release.test.mjs
```

Before implementation it exited 1 with two expected failures: `root LICENSE must exist`, and `ERR_MODULE_NOT_FOUND` for the missing `scripts/package-contract.mjs`. After metadata and initial packing support, the test also exposed the tarball-interface details that required correction: the npm JSON file list is relative to the package root, and declaration files must remain allowed while raw `.ts` files are rejected.

## GREEN evidence

All commands used Node 26.5.0 and npm 11.13.0 via Volta where npm was invoked.

```sh
volta run --node 26.5.0 --npm 11.13.0 npm run build
node --test tests/architecture/package-release.test.mjs
node scripts/package-contract.mjs --verify
volta run --node 26.5.0 --npm 11.13.0 npm run lint
volta run --node 26.5.0 --npm 11.13.0 npm run typecheck
volta run --node 26.5.0 --npm 11.13.0 npm test
```

Results:

- Build passed for every workspace.
- Package architecture test passed: 11/11 tests, including all nine metadata subtests.
- Direct package verification passed, reporting all nine public packages.
- Lint and typecheck passed.
- Full test suite passed: 256 architecture tests; workspace unit suites passed, with the expected Windows-only test skipped.

## Concern

The repository-wide `npm run format:check` remains failing on five pre-existing files outside this task: `packages/drivers-postgres/src/create-postgres-drivers.ts`, `packages/plugin-sdk/src/disposables.ts`, `packages/transport-websocket/test/capability-rpc.test.ts`, `packages/transport-websocket/test/reconnect.test.ts`, and `tests/architecture/workspace-boundaries.test.mjs`. Focused formatting for every Task 2 changed file passes. No publish, registry, tag, or credential mutation was performed.

## Review hardening follow-up

The review findings were addressed with focused contract tests before implementation:

- Inspection initially accepted duplicate/misversioned public manifests.
- Package validation initially accepted an emitted `__tests__/contract.spec.d.ts.map` path and a tarball without its advertised `index.d.ts` declaration.
- Clean-consumer verification initially accepted a broad caller path and recursively removed it before attempting the smoke test.

The focused RED command was:

```sh
node --test tests/architecture/package-release.test.mjs
```

It exited 1 with the expected three failures: missing manifest rejection, missing emitted-test/declaration rejection, and a broad consumer target proceeding into a failed CLI call instead of rejecting before deletion.

The remediation makes packing sequential, resolves the output directory once, validates the fixed nine-name set and `2.0.0-alpha.1` identities, verifies npm pack JSON identity and each tarball's `package/package.json`, checks exact public metadata/root exports/types/CLI bin/internal dependency edges, requires every root declaration target, and rejects test/testS/`__tests__` layouts plus test/spec JS, declarations, and maps. The consumer smoke now only creates and removes a unique `tego-packed-consumer-*` child under an existing temporary parent; broad paths including the system temp root and workspace root are rejected before any removal.

Fresh GREEN evidence:

```sh
node --test tests/architecture/package-release.test.mjs
node scripts/package-contract.mjs --verify
volta run --node 26.5.0 --npm 11.13.0 npm run build
volta run --node 26.5.0 --npm 11.13.0 npm test
volta run --node 26.5.0 --npm 11.13.0 npm run lint
volta run --node 26.5.0 --npm 11.13.0 npm run typecheck
volta run --node 26.5.0 --npm 11.13.0 npx biome format scripts/package-contract.mjs tests/architecture/package-release.test.mjs
```

All listed commands exited 0. The focused package suite passed 14/14 tests; direct verification packed, installed, imported, and exercised all nine public packages. The full test and lint/typecheck commands also passed; focused formatting checked both changed files without fixes.
