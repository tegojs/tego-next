# Phase 1 Alpha Release and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the completed Phase 1 runtime kernel as nine public `@tego/*@2.0.0-alpha.1` packages while closing the four accepted hardening gaps and archiving the verified OpenSpec change.

**Architecture:** Four independently testable implementation tracks cover artifact quotas, process/PostgreSQL cleanup, Windows control-endpoint security, and package/release engineering. They converge in one exact-toolchain release verification; irreversible npm, Git, GitHub, and OpenSpec operations occur only after the final commit passes local and authoritative CI gates.

**Tech Stack:** Node.js 26.5.0, npm 11.13.0 workspaces, TypeScript 7.0.2, Node test runner, SQLite, PostgreSQL 16, GitHub Actions, PowerShell 7/Windows security descriptors, OpenSpec 1.4.1, Volta 2.

## Global Constraints

- The design source is `docs/superpowers/specs/2026-08-13-phase-1-alpha-release-and-hardening-design.md`.
- Public package names use `@tego/*`; active code, tests, examples, generated declarations, and current documentation must contain no `@tegojs/*` import or install instruction.
- All nine public packages use exact version `2.0.0-alpha.1`; internal published dependencies use exact `2.0.0-alpha.1`.
- `@tego/core` and `@tego/server` are not modified or published.
- Every npm upload explicitly uses `--registry https://registry.npmjs.org/ --access public --tag alpha`; this release must not create or update `latest`.
- The release toolchain is exactly Node.js 26.5.0 and npm 11.13.0, pinned through Volta, `.node-version`, `engines`, and `packageManager`.
- Implementation uses test-first red-green-refactor. A production behavior change is not written before its focused test has failed for the expected reason.
- Phase 2/3 capabilities and a new `@tego/node-host` package remain out of scope.
- No npm publish, Git tag push, GitHub release, or OpenSpec archive occurs before Task 11.

## File and Responsibility Map

- `packages/contracts/src/artifact-limits.ts`: public quota types, defaults, and validation.
- `packages/testkit/src/artifact-store-suite.ts`: reusable artifact quota conformance scenarios.
- `packages/drivers-local/src/artifact-quota.ts`: filesystem committed/reserved byte accounting.
- `packages/drivers-postgres/src/migrations.ts`: durable, transactional namespace quota accounting.
- `packages/cli/src/control/windows-pipe-security.ts`: fail-closed Windows ACL policy adapter.
- `scripts/windows-pipe-security.ps1`: native Windows security descriptor application and inspection.
- `tests/support/postgres-namespace.mjs`: exact-namespace test cleanup with destructive-target guards.
- `scripts/package-contract.mjs`: tarball creation, allowlist inspection, and clean consumer smoke tests.
- `scripts/publish-alpha.mjs`: release preflight, topology, resumable publish, and registry verification.
- `tests/architecture/package-release.test.mjs`: executable package and publish-policy contract.
- `.github/workflows/ci.yml`: Linux quality/integration/E2E plus real Windows control-security gate.

---

### Task 1: Migrate the Public Namespace and Version Metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/*/package.json`
- Modify: `examples/echo-plugin/package.json`
- Modify: every active source, test, example, OpenSpec delta, README, architecture, guide, operation, security, review, and release file containing `@tegojs/`
- Test: `tests/architecture/workspace-boundaries.test.mjs`
- Test: `tests/architecture/readme.test.mjs`

**Interfaces:**
- Consumes: the existing nine-workspace dependency graph.
- Produces: workspace identities `@tego/<name>@2.0.0-alpha.1`, exact internal dependency edges, and root Volta metadata used by every later task.

- [ ] **Step 1: Add failing namespace and release-identity assertions**

Add a test that reads the root and all public manifests and asserts this exact set:

```js
const expected = new Set([
  "@tego/cli",
  "@tego/contracts",
  "@tego/drivers-local",
  "@tego/drivers-postgres",
  "@tego/executor-node",
  "@tego/plugin-sdk",
  "@tego/runtime",
  "@tego/testkit",
  "@tego/transport-websocket",
]);
assert.deepEqual(new Set(manifests.map(({ name }) => name)), expected);
for (const manifest of manifests) assert.equal(manifest.version, "2.0.0-alpha.1");
assert.deepEqual(rootManifest.volta, { node: "26.5.0", npm: "11.13.0" });
```

Also scan active paths and fail on `@tegojs/`, excluding immutable historical execution reports under `.superpowers/sdd/`.

- [ ] **Step 2: Run the focused architecture tests and verify RED**

Run:

```sh
node --test tests/architecture/workspace-boundaries.test.mjs tests/architecture/readme.test.mjs
```

Expected: FAIL because manifests still use `@tegojs/*`, versions are `0.0.0`, and root Volta metadata is absent.

- [ ] **Step 3: Apply the mechanical namespace migration and exact versions**

Set the root identity to `@tego/root`, add:

```json
"volta": {
  "node": "26.5.0",
  "npm": "11.13.0"
}
```

Set each public manifest name/version and replace every internal dependency value with:

```json
"@tego/contracts": "2.0.0-alpha.1"
```

using the corresponding exact internal package name. Update imports, docs, examples, architecture checks, and lockfile consistently. Preserve historical prose that discusses `@tego/core` or `@tego/server`.

- [ ] **Step 4: Reinstall and verify the migrated graph**

Run:

```sh
volta run --node 26.5.0 --npm 11.13.0 npm install --package-lock-only
volta run --node 26.5.0 --npm 11.13.0 npm run build
volta run --node 26.5.0 --npm 11.13.0 npm run typecheck
node --test tests/architecture/workspace-boundaries.test.mjs tests/architecture/readme.test.mjs
```

Expected: all commands exit 0 and the active-path namespace scan finds zero `@tegojs/*` references.

- [ ] **Step 5: Commit the namespace migration**

```sh
git add package.json package-lock.json packages examples tests docs README.md openspec
git commit -m "feat(packages): move phase one runtime to tego scope"
```

### Task 2: Add License, Public Metadata, READMEs, and Tarball Contracts

**Files:**
- Create: `LICENSE`
- Create: `packages/cli/LICENSE`
- Create: `packages/contracts/LICENSE`
- Create: `packages/drivers-local/LICENSE`
- Create: `packages/drivers-postgres/LICENSE`
- Create: `packages/executor-node/LICENSE`
- Create: `packages/plugin-sdk/LICENSE`
- Create: `packages/runtime/LICENSE`
- Create: `packages/testkit/LICENSE`
- Create: `packages/transport-websocket/LICENSE`
- Create: `packages/cli/README.md`
- Create: `packages/contracts/README.md`
- Create: `packages/drivers-local/README.md`
- Create: `packages/drivers-postgres/README.md`
- Create: `packages/executor-node/README.md`
- Create: `packages/plugin-sdk/README.md`
- Create: `packages/runtime/README.md`
- Create: `packages/testkit/README.md`
- Create: `packages/transport-websocket/README.md`
- Create: `scripts/package-contract.mjs`
- Create: `tests/architecture/package-release.test.mjs`
- Modify: `packages/*/package.json`
- Modify: `package.json`
- Modify: `scripts/verify-release.mjs`

**Interfaces:**
- Consumes: Task 1 package names and versions.
- Produces: `inspectWorkspacePackages(root): Promise<PackageInspection[]>` and `packWorkspaceSet(root, outputDirectory): Promise<PackedWorkspace[]>`, reused by Task 7.

- [ ] **Step 1: Write failing metadata and tarball allowlist tests**

The new architecture test must assert for each public manifest:

```js
assert.equal(manifest.license, "Apache-2.0");
assert.equal(manifest.homepage, "https://github.com/tegojs/tego-next#readme");
assert.deepEqual(manifest.bugs, { url: "https://github.com/tegojs/tego-next/issues" });
assert.deepEqual(manifest.engines, { node: ">=26.5.0 <27" });
assert.deepEqual(manifest.publishConfig, {
  access: "public",
  registry: "https://registry.npmjs.org/",
  tag: "alpha",
});
assert.equal(manifest.repository.directory, `packages/${directory}`);
```

Pack all workspaces and reject paths matching:

```js
/\.tsbuildinfo$|(^|\/)test\/|\.test\.[cm]?js$|\.ts$/u
```

while requiring `package/package.json`, `package/README.md`, `package/LICENSE`, compiled entry points, and CLI executable mode `0o755`.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```sh
node --test tests/architecture/package-release.test.mjs
```

Expected: FAIL on missing root license, package READMEs/metadata, and `.tsbuildinfo` present in tarballs.

- [ ] **Step 3: Implement package metadata and content allowlists**

Add the Apache License 2.0 text at the root. In every public manifest add the exact common metadata plus a package-specific non-empty description and repository directory. Narrow `files` from `dist` to consumer files, for example:

```json
"files": [
  "dist/src/**/*.js",
  "dist/src/**/*.js.map",
  "dist/src/**/*.d.ts",
  "dist/src/**/*.d.ts.map",
  "README.md",
  "LICENSE"
]
```

Copy the exact root Apache-2.0 text to `LICENSE` in each public workspace so npm always packs
`package/LICENSE` without a prepack mutation or symlink. Each README must show:

```sh
npm install @tego/<package>@alpha
```

and explicitly call the release experimental and non-production.

- [ ] **Step 4: Implement tarball inspection and clean-consumer smoke tests**

Export from `scripts/package-contract.mjs`:

```js
export async function inspectWorkspacePackages(root) {}
export async function packWorkspaceSet(root, outputDirectory) {}
export async function verifyPackedConsumer(packedWorkspaces, consumerDirectory) {}
```

Use `npm pack --json --pack-destination <dir> --workspace <name>`, parse its JSON, enforce the file allowlist, create a temporary consumer whose dependencies point to the tarball paths, run `npm install --ignore-scripts`, import every package root, and run the packed CLI with `--help`.

- [ ] **Step 5: Run RED/GREEN package verification**

Run:

```sh
volta run --node 26.5.0 --npm 11.13.0 npm run build
node --test tests/architecture/package-release.test.mjs
node scripts/package-contract.mjs --verify
```

Expected: exit 0; nine tarballs pass; clean consumer imports nine entry points; CLI help exits 0.

- [ ] **Step 6: Commit package quality changes**

```sh
git add LICENSE package.json packages scripts/package-contract.mjs scripts/verify-release.mjs tests/architecture/package-release.test.mjs
git commit -m "feat(release): define public alpha package contracts"
```

### Task 3: Define Artifact Quota Contracts and Conformance Tests

**Files:**
- Create: `packages/contracts/src/artifact-limits.ts`
- Create: `packages/testkit/src/artifact-store-suite.ts`
- Modify: `packages/contracts/src/drivers.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/testkit/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/testkit/test/public-suites.test.ts`

**Interfaces:**
- Consumes: `ArtifactStore`, `DiagnosticError`, and `ArtifactDigest`.
- Produces:

```ts
export interface ArtifactStorageLimits {
  readonly maxArtifactBytes: number;
  readonly maxNamespaceBytes: number;
}
export const DEFAULT_ARTIFACT_STORAGE_LIMITS: ArtifactStorageLimits;
export function parseArtifactStorageLimits(input?: Partial<ArtifactStorageLimits>): ArtifactStorageLimits;
export interface ArtifactStoreOptions { readonly namespace: string; readonly limits?: Partial<ArtifactStorageLimits>; }
export function defineArtifactStoreSuite(factory: ArtifactStoreSuiteFactory): void;
```

- [ ] **Step 1: Write failing public-contract tests**

Cover finite defaults, override merging, and rejection of zero, negative, fractional, infinite, and unsafe integers. Add conformance cases for:

```ts
await assert.rejects(
  store.put(largeDigest, chunks(5)),
  diagnosticWithCode("ARTIFACT_SIZE_LIMIT_EXCEEDED"),
);
await store.put(firstDigest, chunks(4));
await assert.rejects(
  store.put(secondDigest, chunks(4)),
  diagnosticWithCode("ARTIFACT_NAMESPACE_QUOTA_EXCEEDED"),
);
await store.put(firstDigest, chunks(4)); // duplicate is free
```

Add concurrent writes whose combined reservation exceeds the namespace limit, and a failed digest write followed by a successful write proving reservation release.

- [ ] **Step 2: Run contract/testkit tests and verify RED**

Run:

```sh
npm run build --workspace @tego/contracts --workspace @tego/testkit
node --test packages/contracts/dist/test/contracts.test.js packages/testkit/dist/test/public-suites.test.js
```

Expected: FAIL because quota exports and `defineArtifactStoreSuite` do not exist.

- [ ] **Step 3: Implement the minimal public quota contract**

Use finite defaults:

```ts
export const DEFAULT_ARTIFACT_STORAGE_LIMITS = Object.freeze({
  maxArtifactBytes: 256 * 1024 * 1024,
  maxNamespaceBytes: 4 * 1024 * 1024 * 1024,
});
```

Validation returns a frozen complete object and requires `maxNamespaceBytes >= maxArtifactBytes`. Keep `put/read` unchanged so existing third-party store APIs remain source-compatible; namespace and limits are construction-time driver configuration.

- [ ] **Step 4: Implement and self-test the reusable suite**

Define a factory that supplies a fresh bounded store and disposal callback. Export the suite from `@tego/testkit`. Run the public-import compatibility fixture so third-party adapters consume only package exports.

- [ ] **Step 5: Verify GREEN and commit**

```sh
npm run build --workspace @tego/contracts --workspace @tego/testkit
node --test packages/contracts/dist/test/contracts.test.js packages/testkit/dist/test/public-suites.test.js
npm run typecheck --workspace @tego/contracts --workspace @tego/testkit
git add packages/contracts packages/testkit
git commit -m "feat(artifacts): define storage quota contract"
```

### Task 4: Enforce Filesystem Artifact Quotas Atomically

**Files:**
- Create: `packages/drivers-local/src/artifact-quota.ts`
- Modify: `packages/drivers-local/src/filesystem-artifact-store.ts`
- Modify: `packages/drivers-local/src/create-local-drivers.ts`
- Modify: `packages/drivers-local/test/local-drivers.test.ts`

**Interfaces:**
- Consumes: `ArtifactStorageLimits`, `parseArtifactStorageLimits`, and Task 3 conformance suite.
- Produces:

```ts
export class LocalArtifactQuota {
  reserve(digest: ArtifactDigest, bytes: number): Promise<ArtifactQuotaReservation>;
  committedBytes(): Promise<number>;
}
export interface ArtifactQuotaReservation {
  commit(): Promise<void>;
  release(): Promise<void>;
}
```

- [ ] **Step 1: Bind the conformance suite and add restart/race tests**

Instantiate `FilesystemArtifactStore` with namespace `test-runtime` and tiny limits. Add focused tests proving startup scans existing `.tego` files, simultaneous distinct writes cannot overcommit, duplicate digest collision is free, and failed/closed writes leave no temporary file or reservation.

- [ ] **Step 2: Run local-driver tests and verify RED**

```sh
npm run build --workspace @tego/drivers-local
node --test packages/drivers-local/dist/test/local-drivers.test.js
```

Expected: FAIL because options do not accept namespace/limits and writes can exceed the tested quota.

- [ ] **Step 3: Implement byte counting and serialized reservation decisions**

Count stable artifact files during `open()`. Stream a candidate to its mode-0600 temporary file while rejecting once `maxArtifactBytes` is crossed. After digest verification, enter one in-process serialized reservation section keyed by the store instance:

```ts
if (existingDigest) return duplicateReservation;
if (committed + reserved + bytes > limits.maxNamespaceBytes) throw quotaError;
reserved += bytes;
```

Commit the reservation only after atomic rename and directory synchronization. Release in every failure path. Recheck the target inside the serialized section to make same-digest races free.

- [ ] **Step 4: Verify conformance, restart, and corruption behavior**

```sh
npm run build --workspace @tego/drivers-local
node --test packages/drivers-local/dist/test/local-drivers.test.js
npm run typecheck --workspace @tego/drivers-local
```

Expected: all tests pass; over-limit failures use the two stable diagnostic codes; existing corruption checks remain green.

- [ ] **Step 5: Commit local quota enforcement**

```sh
git add packages/drivers-local
git commit -m "feat(storage): enforce filesystem artifact quotas"
```

### Task 5: Enforce PostgreSQL Artifact Quotas Transactionally

**Files:**
- Modify: `packages/drivers-postgres/src/migrations.ts`
- Modify: `packages/drivers-postgres/src/postgres-artifact-store.ts`
- Modify: `packages/drivers-postgres/src/create-postgres-drivers.ts`
- Modify: `packages/drivers-postgres/test/postgres-drivers.test.ts`
- Modify: `packages/drivers-postgres/test/artifact-boundaries.test.ts`

**Interfaces:**
- Consumes: Task 3 quota contracts and conformance suite.
- Produces: migration table `tego_artifact_namespace_usage(driver_namespace PRIMARY KEY, committed_bytes BIGINT NOT NULL)` and atomic quota admission in the same transaction as artifact insertion.

- [ ] **Step 1: Bind conformance and add two-store concurrency tests**

Create two `PostgresArtifactStore` instances for the same unique namespace and tiny limit. Hold concurrent transactions so both observe initial capacity, then release them together and assert exactly one distinct artifact commits. Add restart, duplicate digest, rollback, and namespace-isolation assertions.

- [ ] **Step 2: Run PostgreSQL tests and verify RED**

```sh
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" npm run build --workspace @tego/drivers-postgres
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" node --test packages/drivers-postgres/dist/test/postgres-drivers.test.js packages/drivers-postgres/dist/test/artifact-boundaries.test.js
```

Expected: FAIL because the usage table and transactional quota decision do not exist.

- [ ] **Step 3: Add the numbered quota migration**

Create the usage table with non-negative checks. Backfill each existing namespace from artifact byte lengths using an idempotent `INSERT ... SELECT ... ON CONFLICT DO NOTHING`. Preserve the numbered migration ordering and checksum rules.

- [ ] **Step 4: Implement the transactional write path**

Buffer only up to `maxArtifactBytes + 1` while hashing. In one transaction:

1. insert-or-lock the namespace usage row with `SELECT ... FOR UPDATE`;
2. check whether the digest already exists in that namespace;
3. reject if `committed_bytes + candidate_bytes` exceeds the limit;
4. insert immutable bytes and update usage;
5. commit.

Any digest mismatch, query failure, cancellation, or close rolls back both bytes and accounting.

- [ ] **Step 5: Verify PostgreSQL conformance and commit**

```sh
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" npm run test:integration --workspace @tego/drivers-postgres
npm run typecheck --workspace @tego/drivers-postgres
git add packages/drivers-postgres
git commit -m "feat(storage): enforce postgres artifact quotas"
```

### Task 6: Make Readiness-Failure and PostgreSQL Test Cleanup Deterministic

**Files:**
- Create: `tests/support/postgres-namespace.mjs`
- Modify: `tests/support/managed-process.mjs`
- Modify: `tests/support/single-main-process.mjs`
- Modify: `tests/integration/process-harness.test.mjs`
- Modify: `tests/e2e/single-main-process.test.mjs`
- Modify: `tests/integration/runtime-fault-injection.test.mjs`

**Interfaces:**
- Consumes: existing `ManagedProcess`, `settleWithCleanup`, and PostgreSQL test schema.
- Produces:

```js
export function assertDisposablePostgresNamespace(namespace) {}
export async function cleanupPostgresNamespace({ connectionString, namespace }) {}
export async function usingManagedProcess(operation, { artifacts, command, args, env, name }) {}
```

- [ ] **Step 1: Write failing process-tree ownership tests**

Spawn a fixture that creates a grandchild and never emits readiness. Register cleanup before `ready()`, assert timeout, then assert both PIDs are gone and cleanup evidence was written before workspace removal. Add the same assertion for a readiness predicate that throws.

- [ ] **Step 2: Write failing namespace guard and cleanup tests**

Reject these exact unsafe inputs without opening PostgreSQL:

```js
["", "tego", "public", "*", "%", "../x", "runtime-default"]
```

Accept only `/^test_[a-z0-9]+_[a-z0-9_]+$/u`. Seed two namespaces, clean one, and prove the other remains byte-for-byte unchanged.

- [ ] **Step 3: Run focused integration tests and verify RED**

```sh
node --test tests/integration/process-harness.test.mjs
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" node --test --test-name-pattern="namespace cleanup" tests/integration/runtime-fault-injection.test.mjs
```

Expected: new imports/functions are absent and the E2E harness registers Main only after readiness.

- [ ] **Step 4: Implement immediate process registration**

Refactor spawn sites so cleanup owns the returned `ManagedProcess` before the first readiness await. Keep diagnostic capture first, process stop second, and workspace deletion last. Aggregate primary and cleanup errors without hiding the readiness cause.

- [ ] **Step 5: Implement guarded exact-namespace PostgreSQL cleanup**

Use parameterized deletes for the known tables and `driver_namespace = $1`; never interpolate the namespace into SQL identifiers or predicates. Run deletes inside one bounded transaction. Call the helper in `finally` after artifact capture for multi-Main E2E and PostgreSQL fault tests.

- [ ] **Step 6: Verify cleanup behavior and commit**

```sh
node --test tests/integration/process-harness.test.mjs
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" node --test tests/integration/runtime-fault-injection.test.mjs
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" npm run test:e2e:multi-main
git add tests
git commit -m "test(system): make failure cleanup deterministic"
```

### Task 7: Harden Windows Named-Pipe Access and Add a Real Windows Gate

**Files:**
- Create: `packages/cli/src/control/windows-pipe-security.ts`
- Create: `scripts/windows-pipe-security.ps1`
- Modify: `packages/cli/src/control/server.ts`
- Modify: `packages/cli/test/control.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/verify-release.mjs`
- Modify: `tests/architecture/project-ci.test.mjs`
- Modify: `tests/architecture/system-ci.test.mjs`

**Interfaces:**
- Consumes: `startControlServer` initialization admission queue.
- Produces:

```ts
export interface WindowsPipeSecurityDescriptor {
  readonly ownerSid: string;
  readonly accessSids: readonly string[];
  readonly protectedDacl: boolean;
}
export interface WindowsPipeSecurityAdapter {
  harden(endpoint: string, signal?: AbortSignal): Promise<WindowsPipeSecurityDescriptor>;
}
export function validateWindowsPipeSecurityDescriptor(value: unknown, currentUserSid: string): WindowsPipeSecurityDescriptor;
```

- [ ] **Step 1: Write failing platform-independent policy tests**

Inject an adapter into `startControlServer`. Assert pending connections receive no dispatch until hardening completes; allowed descriptor is protected and contains only current user SID, `S-1-5-18` (SYSTEM), and `S-1-5-32-544` (Administrators); missing owner, inherited/unprotected DACL, Everyone, Anonymous, or Authenticated Users causes `PROTOCOL_CONTROL_ENDPOINT_UNSAFE`, closes queued sockets, and rolls back listener startup.

- [ ] **Step 2: Strengthen the Windows-only real named-pipe test**

On Windows, call the production adapter, query the resulting descriptor, run a current-user status request, close the server, and prove reconnect fails. The test must not skip on Windows and must fail if PowerShell or ACL inspection is unavailable.

- [ ] **Step 3: Run policy tests and verify RED**

```sh
npm run build --workspace @tego/cli
node --test packages/cli/dist/test/control.test.js
```

Expected on macOS/Linux: injected policy tests FAIL because there is no adapter hook. Expected on Windows before implementation: real ACL test FAILS because the endpoint is considered ready without descriptor validation.

- [ ] **Step 4: Implement fail-closed descriptor application and validation**

Keep external sockets paused in `pendingAdmissionSockets`. Invoke `pwsh -NoProfile -NonInteractive -File scripts/windows-pipe-security.ps1 -Endpoint <name>` with an AbortSignal and bounded timeout. The script uses .NET/Win32 security descriptor APIs to set a protected DACL and emits one JSON descriptor line. Parse strictly, validate the SID allowlist, destroy all connections accepted before hardening, then mark the endpoint ready so every dispatched client has passed the OS ACL.

Do not inspect Node private fields such as `socket._handle`. The operating-system DACL is the per-connection identity enforcement mechanism. Any helper absence, timeout, malformed JSON, disallowed ACE, or ACL application error fails startup.

- [ ] **Step 5: Add the Windows CI job and workflow contract**

Add `windows-control` on `windows-2025` with pinned checkout/setup-node actions, exact Node/npm checks, `npm ci`, build, typecheck, and the Windows-only control test. Give it a bounded 15-minute timeout. Extend workflow validation so removing, skipping, or marking the step `continue-on-error` fails architecture tests.

- [ ] **Step 6: Verify locally and through GitHub Windows CI**

Run locally:

```sh
npm run build --workspace @tego/cli
node --test packages/cli/dist/test/control.test.js
node --test tests/architecture/project-ci.test.mjs tests/architecture/system-ci.test.mjs
```

Then push the implementation branch and require the real `windows-control` job to pass. If Windows cannot apply and inspect the intended descriptor reliably, stop the release and retain the documented alpha limitation.

- [ ] **Step 7: Commit Windows hardening**

```sh
git add packages/cli scripts/windows-pipe-security.ps1 .github/workflows/ci.yml scripts/verify-release.mjs tests/architecture
git commit -m "fix(cli): harden windows control pipe access"
```

### Task 8: Build a Resumable Alpha Release Command

**Files:**
- Create: `scripts/publish-alpha.mjs`
- Create: `tests/architecture/publish-alpha.test.mjs`
- Modify: `package.json`
- Modify: `scripts/verify-release.mjs`
- Modify: `tests/architecture/package-release.test.mjs`

**Interfaces:**
- Consumes: Task 2 packed workspace records.
- Produces:

```js
export const ALPHA_VERSION = "2.0.0-alpha.1";
export const NPM_REGISTRY = "https://registry.npmjs.org/";
export function releaseOrder(manifests) {}
export function validateRegistryState(expected, actual) {}
export async function preflightRelease(adapters) {}
export async function publishAlpha(adapters) {}
export async function verifyRegistryRelease(adapters) {}
```

- [ ] **Step 1: Write failing pure release-policy tests**

Use fake command/registry adapters to prove:

- topology begins with contracts and ends with CLI;
- wrong Node/npm, dirty Git, mirror registry, missing identity/scope, existing mismatched version, or failed release evidence stops before upload;
- every publish invocation includes official registry, public access, and alpha tag;
- matching existing integrity/tag is skipped on resume;
- mismatched integrity or `latest` presence fails;
- Git/GitHub operations are not invoked by the npm publish function.

- [ ] **Step 2: Run the release tests and verify RED**

```sh
node --test tests/architecture/publish-alpha.test.mjs tests/architecture/package-release.test.mjs
```

Expected: FAIL because `scripts/publish-alpha.mjs` and release scripts do not exist.

- [ ] **Step 3: Implement explicit modes and adapters**

Support:

```sh
npm run release:alpha -- --preflight
npm run release:alpha -- --pack
npm run release:alpha -- --publish
npm run release:alpha -- --verify-registry
```

All external commands use argument arrays, not shell interpolation. Query registry state with explicit `--registry`. Store the packed release manifest beneath a `mktemp` directory or a caller-supplied artifact directory, including SHA-512 integrity and Git SHA. Never write credentials or npm configuration.

- [ ] **Step 4: Implement resumable registry verification**

Before upload, `npm view <name>@2.0.0-alpha.1 dist.integrity dist-tags --json`. A 404 means publish. An existing version is skipped only when integrity equals the local packed tarball and `alpha` points to it. After all uploads, require exact names, versions, internal dependencies, integrity, `alpha`, and absence of `latest` for all nine packages.

- [ ] **Step 5: Verify dry-run behavior and commit**

```sh
npm run release:alpha -- --pack
npm publish --dry-run --workspaces --registry https://registry.npmjs.org/ --access public --tag alpha
node --test tests/architecture/publish-alpha.test.mjs tests/architecture/package-release.test.mjs
git add package.json scripts/publish-alpha.mjs scripts/verify-release.mjs tests/architecture
git commit -m "feat(release): add resumable alpha publisher"
```

### Task 9: Update Specifications, Documentation, and Release Evidence Contracts

**Files:**
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/plugin-artifacts/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/runtime-operations/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/tasks.md`
- Modify: `README.md`
- Modify: `docs/architecture/runtime-kernel.md`
- Modify: `docs/guides/contributing-and-plugins.md`
- Modify: `docs/operations/deployment-topologies.md`
- Modify: `docs/security/threat-model.md`
- Rename/Modify: `docs/releases/0.1.0-alpha.1.md` to `docs/releases/2.0.0-alpha.1.md`
- Modify: `docs/reviews/phase-1-api-architecture-review.md`
- Modify: `docs/reviews/phase-1-security-concurrency-recovery-review.md`
- Modify: `tests/architecture/documentation.test.mjs`
- Modify: `tests/architecture/readme.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–8 implemented behavior.
- Produces: executable documentation claims and updated delta specs for OpenSpec sync.

- [ ] **Step 1: Write failing documentation-contract assertions**

Require documents to name all nine packages, `2.0.0-alpha.1`, `npm install @tego/runtime@alpha`, no `latest`, quota defaults/overrides, exact namespace cleanup behavior, hardened Windows boundary, Windows CI, and remaining Node 26 LTS production gate. Reject `0.1.0-alpha.1`, active `@tegojs/*`, and the statement that Windows ACL hardening is unimplemented.

- [ ] **Step 2: Run documentation tests and verify RED**

```sh
node --test tests/architecture/documentation.test.mjs tests/architecture/readme.test.mjs
```

Expected: FAIL on old release identity and accepted limitations.

- [ ] **Step 3: Update delta specs and Phase 1 task evidence**

Add requirements/scenarios for bounded artifact admission, exact quota behavior, fail-closed Windows control access, deterministic readiness cleanup, package alpha channel, and resumable release verification. Add completed Phase 1 closure tasks only when their executable evidence exists; do not mark npm/GitHub publication or archive complete yet.

- [ ] **Step 4: Update user and operator documentation**

Document opt-in Alpha installation, package responsibilities, configuration limits, supported Windows control security, test namespace cleanup, official-registry requirement, and recovery from partial publication. Preserve the non-production declaration and Phase 2/3 deferrals.

- [ ] **Step 5: Verify documentation and strict OpenSpec**

```sh
node --test tests/architecture/documentation.test.mjs tests/architecture/readme.test.mjs
npm run openspec:validate
```

Expected: exit 0 with strict OpenSpec validation.

- [ ] **Step 6: Commit documentation and spec updates**

```sh
git add README.md docs openspec tests/architecture
git commit -m "docs: prepare phase one alpha release evidence"
```

### Task 10: Run Final Local and Authoritative Verification

**Files:**
- Modify only if a test reveals a defect: files owned by Tasks 1–9, with a new failing regression test first.
- Create: `openspec/changes/runtime-kernel-phase-1/verification-report.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/.comet.yaml`

**Interfaces:**
- Consumes: all reversible implementation tasks.
- Produces: exact final commit SHA, local release report, and authoritative CI URL required by Task 11 preflight.

- [ ] **Step 1: Provision the exact local toolchain and PostgreSQL**

```sh
volta install node@26.5.0 npm@11.13.0
volta pin node@26.5.0 npm@11.13.0
docker compose up -d postgres
export TEGO_POSTGRES_URL='postgresql://tego_test:tego_test@127.0.0.1:55432/tego_next_test'
node --version
npm --version
```

Expected: `v26.5.0`, `11.13.0`, and PostgreSQL health succeeds.

- [ ] **Step 2: Run clean full release verification**

```sh
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" npm run verify:release
```

Expected: every stage exits 0, including clean install, format, lint, build, typecheck, unit/architecture, local/PostgreSQL integration, package contracts, single/two-Main E2E, and strict OpenSpec.

- [ ] **Step 3: Run focused stress verification**

Run readiness failure cleanup repeatedly, simultaneous filesystem/PostgreSQL quota admission repeatedly, and foreground shutdown stress 20 times. Expected: zero leaked processes, namespaces, reservations, or duplicate terminal results.

- [ ] **Step 4: Record the local verification report**

Write exact commands, versions, counts, timestamps, Git SHA, PostgreSQL version, and artifact paths. Set Comet verification fields to `local-passed` while leaving publication/archive state pending.

- [ ] **Step 5: Commit evidence and push the release branch**

```sh
git add openspec/changes/runtime-kernel-phase-1
git commit -m "docs: record phase one alpha verification"
git push origin HEAD
```

- [ ] **Step 6: Require authoritative GitHub Actions**

Wait for quality, PostgreSQL integration, system E2E, and Windows control jobs on the exact evidence commit. Record workflow/job URLs and counts in the verification report, amend with a follow-up evidence commit, push it, and require that exact follow-up commit to pass the documentation/quality gates as well.

### Task 11: Publish, Tag, Release, Sync, and Archive

**Files:**
- Modify: `openspec/specs/*/spec.md` through intelligent delta sync
- Move: `openspec/changes/runtime-kernel-phase-1` to `openspec/changes/archive/2026-08-13-runtime-kernel-phase-1`
- Modify: archived `.comet.yaml` and `verification-report.md` with immutable publication evidence before the final archive commit

**Interfaces:**
- Consumes: Task 10 exact-SHA green evidence and `scripts/publish-alpha.mjs`.
- Produces: nine public npm Alpha packages, `v2.0.0-alpha.1`, GitHub prerelease, synchronized main specs, and archived Phase 1 change.

- [ ] **Step 1: Authenticate explicitly against the official npm registry**

```sh
npm login --registry https://registry.npmjs.org/
npm whoami --registry https://registry.npmjs.org/
npm access list packages @tego --json --registry https://registry.npmjs.org/
```

Expected: authenticated user is shown and has publish access to the `@tego` scope. If npm requires 2FA, keep the interactive OTP available for each publish or use an approved granular token/session; do not store it in the repository.

- [ ] **Step 2: Run immutable release preflight**

```sh
npm run release:alpha -- --preflight
```

Expected: clean tree, exact tools, official registry, green exact-SHA CI evidence, absent/matching target versions, no conflicting Git tag/release, and no `latest` tags.

- [ ] **Step 3: Publish the nine packages resumably**

```sh
npm run release:alpha -- --publish
npm run release:alpha -- --verify-registry
```

Expected: all nine exact versions exist publicly; every `alpha` tag points to `2.0.0-alpha.1`; every `latest` tag is absent; registry integrity equals the packed release manifest.

- [ ] **Step 4: Create and push the annotated Git tag**

```sh
git tag -a v2.0.0-alpha.1 -m "Tego runtime kernel 2.0.0-alpha.1"
git push origin v2.0.0-alpha.1
```

Expected: remote tag resolves to the exact verified release commit.

- [ ] **Step 5: Create the GitHub prerelease**

```sh
gh release create v2.0.0-alpha.1 \
  --repo tegojs/tego-next \
  --prerelease \
  --title "Tego 2.0.0-alpha.1" \
  --notes-file docs/releases/2.0.0-alpha.1.md
```

Expected: GitHub reports a prerelease URL attached to the pushed tag.

- [ ] **Step 6: Sync Phase 1 delta specs into main specs**

Run OpenSpec status for `runtime-kernel-phase-1`, read each delta and destination, then intelligently create/update these main specs idempotently:

```text
openspec/specs/capability-resolution/spec.md
openspec/specs/coordination-provider/spec.md
openspec/specs/executor-runtime/spec.md
openspec/specs/plugin-artifacts/spec.md
openspec/specs/plugin-deployment/spec.md
openspec/specs/runtime-bootstrap/spec.md
openspec/specs/runtime-operations/spec.md
openspec/specs/worker-protocol/spec.md
```

Run strict validation twice; the second sync must produce no diff.

- [ ] **Step 7: Finalize Comet metadata and archive the change**

Record npm package URLs/integrities, dist-tags, Git tag, GitHub prerelease URL, final SHA, CI URLs, and main spec sync result. Set verification/result/branch fields to completed values and `archived: true`. Move the complete change directory to the date-prefixed archive path without losing `.openspec.yaml` or `.comet.yaml`.

- [ ] **Step 8: Verify archive and commit closure**

```sh
npm run openspec:validate
npm run release:alpha -- --verify-registry
git diff --check
git add openspec docs/releases/2.0.0-alpha.1.md
git commit -m "docs: archive phase one alpha release"
git push origin main
```

Expected: strict specs pass, registry remains correct, active change is absent, archive exists, and `main` is clean and synchronized.

## Final Requirement Trace

- Namespace/version strategy: Tasks 1, 2, 8, 11.
- Public metadata, licensing, tarball cleanliness, consumer install: Task 2.
- Resumable dependency-ordered publishing and no `latest`: Tasks 8 and 11.
- Readiness process cleanup and PostgreSQL namespace cleanup: Task 6.
- Windows named-pipe fail-closed security and real Windows CI: Task 7.
- Filesystem/PostgreSQL artifact quotas and concurrency: Tasks 3–5.
- Exact Node/npm/PostgreSQL release evidence: Task 10.
- npm Alpha, Git tag, GitHub prerelease: Task 11.
- Spec sync, Comet completion, and OpenSpec archive: Task 11.
