---
change: runtime-kernel-phase-1
design-doc: docs/superpowers/specs/2026-07-23-runtime-kernel-phase-1-design.md
base-ref: c81e8ab496c3a4d68443ebf9f825abee0f924fd4
---

# Tego Runtime Kernel Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a bootable, durable, testable Tego runtime kernel that packages and deploys a TypeScript plugin and executes the same task through thread, process, and remote Worker executors in single-Main and fenced multi-Main deployments.

**Architecture:** The runtime consumes explicit driver and executor interfaces from `@tegojs/contracts`. Local and PostgreSQL driver bundles implement durable state, artifact storage, and authority semantics; a reconciler converges plugin deployment intent into component instances and task attempts. All component execution uses one versioned ComponentHost protocol so executor placement does not affect plugin code.

**Tech Stack:** Node.js 26.5.0, npm 11.13.0 workspaces, TypeScript 7.0.2 ESM, Biome 2.5.5, `node:test`, `node:sqlite`, Ajv 8.20.0, `semver` 7.8.5, `tar` 7.5.21, `ws` 8.21.1, `pg` 8.22.0, Docker PostgreSQL.

## Global Constraints

- Runtime development uses exactly Node.js 26.5.0; production release remains blocked until the Node.js 26 line becomes LTS.
- Type checking and emit use the TypeScript 7.0.2 CLI; production code MUST NOT import the TypeScript compiler API.
- Source and runtime artifacts use ESM only. Plugin artifacts contain JavaScript, declarations, JSON schemas, and metadata, never executable TypeScript.
- Runtime packages MUST NOT expose or import HTTP routing, authentication, business ACL, database-resource, cache, scheduler, workflow, frontend, CommonJS-loader, or Tego 1.x APIs.
- Every production behavior starts with an OpenSpec-linked failing test. Preserve the red test commit and the subsequent green implementation commit.
- Use stable diagnostic codes and serializable errors across every process and WebSocket boundary.
- Use decimal strings for revisions, generations, sequences, and fencing epochs at public and wire boundaries.
- Never use real-time sleeps in tests. Use fake clocks, explicit barriers, or event-driven eventual assertions.
- Every spawned thread, process, socket, database connection, iterator, and temporary directory must be closed by the test that owns it.

---

## File Map

| Path | Responsibility |
| --- | --- |
| `package.json` | Root workspace scripts and pinned dependencies |
| `tsconfig.json` | TypeScript 7 project references and shared strict options |
| `biome.json` | Formatting and static checks without TypeScript Compiler API |
| `packages/contracts/src/` | Public data contracts, interfaces, schemas, errors |
| `packages/runtime/src/` | Bootstrap, operations, dependency graph, reconciliation, scheduling |
| `packages/drivers-local/src/` | Memory/SQLite state, local authority, filesystem artifacts |
| `packages/drivers-postgres/src/` | PostgreSQL state, artifacts, leadership, leases, fencing, watch |
| `packages/executor-node/src/` | ComponentHost, process executor, thread executor |
| `packages/transport-websocket/src/` | Worker protocol, sessions, Worker runtime, remote executor |
| `packages/plugin-sdk/src/` | Functional component-definition and context API |
| `packages/testkit/src/` | Public conformance suites and deterministic fakes |
| `packages/cli/src/` | Local control protocol and operator commands |
| `examples/echo-plugin/` | Executor-independent example plugin and artifact fixture |
| `tests/e2e/` | Single-Main, multi-Main, CLI, packaging, and recovery flows |

## Task 1: Pin the workspace and prove dependency boundaries

**Files:**
- Create: `.node-version`
- Create: `.npmrc`
- Create: `.gitignore`
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `biome.json`
- Create: `scripts/check-boundaries.mjs`
- Create: `tests/architecture/workspace-boundaries.test.mjs`
- Create: `packages/{contracts,runtime,drivers-local,drivers-postgres,executor-node,transport-websocket,plugin-sdk,testkit,cli}/package.json`

**Interfaces:**
- Produces: root commands `npm run build`, `npm run typecheck`, `npm test`, `npm run verify`, and nine named workspaces.
- Produces: dependency rule `contracts ← runtime/drivers/executors/transport/sdk/testkit ← cli`.

- [x] **Step 1: Write and commit the failing architecture test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { checkWorkspaceBoundaries } from "../../scripts/check-boundaries.mjs";

test("@spec:runtime-operations/layer-one-dependency-boundary/architecture-dependency-check", async () => {
  const violations = await checkWorkspaceBoundaries(new URL("../../", import.meta.url));
  assert.deepEqual(violations, []);
});
```

Run: `node --test tests/architecture/workspace-boundaries.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/check-boundaries.mjs`.

Commit: `git add tests/architecture && git commit -m "test: define workspace dependency boundary"`

- [x] **Step 2: Add pinned workspace configuration**

Use these exact root fields:

```json
{
  "name": "@tegojs/root",
  "private": true,
  "type": "module",
  "packageManager": "npm@11.13.0",
  "engines": { "node": ">=26.5.0 <27" },
  "workspaces": ["packages/*", "examples/*"],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test:unit": "npm run test:unit --workspaces --if-present",
    "test:integration": "npm run test:integration --workspaces --if-present",
    "test:e2e": "node --test tests/e2e/*.test.mjs",
    "test": "npm run test:unit && node --test tests/architecture/*.test.mjs",
    "format:check": "biome format .",
    "lint": "biome lint .",
    "verify": "npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:integration && npm run build && npm run test:e2e"
  }
}
```

Pin development dependencies to TypeScript `7.0.2`, Biome `2.5.5`, and Node types `26.1.1`. Add runtime dependencies only to the workspace that imports them.

- [x] **Step 3: Implement the boundary checker**

`checkWorkspaceBoundaries(root)` reads every `packages/*/package.json`, creates a package-name graph, and returns sorted strings such as `@tegojs/contracts -> @tegojs/runtime`. Reject:

- any dependency from contracts to another workspace;
- runtime dependencies on concrete drivers, CLI, SDK, examples, or testkit;
- any first-layer package whose name or import contains `tego/`, `frontend`, `http`, `acl`, `cache`, `workflow`, or `datasource`.

- [x] **Step 4: Verify and commit the green workspace**

Run:

```bash
npm install --package-lock-only
node --test tests/architecture/workspace-boundaries.test.mjs
npm run format:check
```

Expected: all commands exit `0`.

Commit: `git add . && git commit -m "build: initialize Node 26 TypeScript 7 workspace"`

## Task 2: Establish public identities, errors, schemas, and wire serialization

**Files:**
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/identity.ts`
- Create: `packages/contracts/src/json.ts`
- Create: `packages/contracts/src/diagnostic.ts`
- Create: `packages/contracts/src/runtime.ts`
- Create: `packages/contracts/src/plugin.ts`
- Create: `packages/contracts/src/capability.ts`
- Create: `packages/contracts/src/execution.ts`
- Create: `packages/contracts/src/worker.ts`
- Create: `packages/contracts/src/schema.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Produces: branded string identities, `RuntimeDiagnostic`, `RuntimeConfiguration`, `PluginManifest`, `PluginInstallation`, `PluginDeployment`, `ExecutionRequest`, `ExecutionResult`, and `WorkerEnvelope`.
- Produces: `parseSchema<T>(schema, input): T` and `serializeWireValue(value): JsonValue`.

- [x] **Step 1: Write and commit failing contract tests**

Cover:

```ts
test("@spec:plugin-artifacts/runtime-compatibility-validation/unsupported-commonjs-artifact", () => {
  assert.throws(
    () => parsePluginManifest(commonJsManifest),
    (error: unknown) => diagnosticCode(error) === "ARTIFACT_MODULE_FORMAT_UNSUPPORTED",
  );
});

test("@spec:worker-protocol/versioned-reliable-message-envelope/unsupported-protocol-version", () => {
  assert.throws(
    () => parseWorkerEnvelope({ protocol: "2.0" }),
    (error: unknown) => diagnosticCode(error) === "WORKER_PROTOCOL_UNSUPPORTED",
  );
});
```

Run: `npm run build -w @tegojs/contracts && node --test packages/contracts/dist/test/contracts.test.js`

Expected: FAIL because the package exports do not exist.

Commit: `git add packages/contracts && git commit -m "test: define runtime wire contracts"`

- [x] **Step 2: Implement identities and diagnostics**

Use `type Brand<T, Name extends string> = T & { readonly __brand: Name }`.
Construct identities through validating functions; do not export unsafe casts.
Implement:

```ts
class DiagnosticError extends Error {
  constructor(readonly diagnostic: RuntimeDiagnostic) {
    super(diagnostic.message);
  }
}
```

The required top-level diagnostic groups are `BOOTSTRAP`, `ARTIFACT`,
`DEPLOYMENT`, `CAPABILITY`, `PERMISSION`, `LIFECYCLE`, `EXECUTOR`, `WORKER`,
`COORDINATION`, `STATE`, and `PROTOCOL`.

- [x] **Step 3: Implement Ajv-backed runtime validators**

Create one Ajv 2020 instance with strict mode and format support. Compile schemas
once at module initialization. `parsePluginManifest`, `parseExecutionRequest`,
and `parseWorkerEnvelope` must translate Ajv issues into deterministic
`RuntimeDiagnostic.details.issues`, sorted by instance path and keyword.

- [x] **Step 4: Verify round trips and commit**

Run:

```bash
npm run build -w @tegojs/contracts
node --test packages/contracts/dist/test/contracts.test.js
npm run typecheck -w @tegojs/contracts
```

Expected: PASS with no warning output.

Commit: `git add packages/contracts && git commit -m "feat: add validated runtime contracts"`

## Task 3: Build public conformance-test infrastructure and the memory state store

**Files:**
- Create: `packages/testkit/tsconfig.json`
- Create: `packages/testkit/src/fake-clock.ts`
- Create: `packages/testkit/src/eventually.ts`
- Create: `packages/testkit/src/state-store-suite.ts`
- Create: `packages/testkit/src/index.ts`
- Create: `packages/testkit/test/testkit.test.ts`
- Create: `packages/drivers-local/tsconfig.json`
- Create: `packages/drivers-local/src/memory-state-store.ts`
- Create: `packages/drivers-local/test/memory-state-store.test.ts`

**Interfaces:**
- Consumes: `StateStore`, `StateTransaction`, `Revision`, and `Clock` from contracts.
- Produces: `stateStoreConformance(factory, options)` and `MemoryStateStore`.

- [x] **Step 1: Write and commit a failing public conformance suite**

The suite must verify:

- atomic commit and rollback;
- expected-revision conflicts;
- monotonically increasing decimal revisions;
- namespaces;
- watch from a supplied cursor;
- idempotency-key replay;
- fenced transaction rejection;
- close and iterator cleanup.

Run: `npm run build -w @tegojs/testkit`

Expected: FAIL because the contracts do not yet export `StateStore`.

Commit: `git add packages/testkit && git commit -m "test: define state store conformance"`

- [x] **Step 2: Add the StateStore interfaces to contracts**

Define the interfaces exactly as documented in the technical design. A
transaction exposes `get`, `scan`, `put`, `delete`, `appendOperation`, and
`enqueueOutbox`; all writes accept an expected revision.

- [x] **Step 3: Implement MemoryStateStore minimally**

Use immutable snapshots per transaction and one serialized commit queue.
Watchers receive committed changes only. Abort replaces no state and consumes
no revision.

- [x] **Step 4: Run conformance and commit**

Run:

```bash
npm run build -w @tegojs/contracts -w @tegojs/testkit -w @tegojs/drivers-local
node --test packages/testkit/dist/test/testkit.test.js packages/drivers-local/dist/test/memory-state-store.test.js
```

Expected: PASS and process exits without open-handle delay.

Commit: `git add packages/contracts packages/testkit packages/drivers-local && git commit -m "feat: add state store contract and memory driver"`

## Task 4: Add durable SQLite state, local authority, and filesystem artifacts

**Files:**
- Create: `packages/drivers-local/src/sqlite/migrations.ts`
- Create: `packages/drivers-local/src/sqlite/sqlite-state-store.ts`
- Create: `packages/drivers-local/src/local-coordination.ts`
- Create: `packages/drivers-local/src/filesystem-artifact-store.ts`
- Create: `packages/drivers-local/src/create-local-drivers.ts`
- Create: `packages/drivers-local/src/index.ts`
- Create: `packages/drivers-local/test/sqlite-state-store.test.ts`
- Create: `packages/drivers-local/test/local-drivers.test.ts`

**Interfaces:**
- Produces: `createLocalDrivers({ dataDirectory }): Promise<RuntimeDrivers>`.
- Produces: `SqliteStateStore`, `LocalCoordinationProvider`, and `FilesystemArtifactStore`.

- [x] **Step 1: Write and commit failing restart and artifact tests**

Include:

```ts
test("@spec:runtime-bootstrap/durable-restart-recovery/restart-after-an-interrupted-operation", async () => {
  const first = await openSqliteStore(path);
  await recordInterruptedOperation(first);
  await first.close();
  const second = await openSqliteStore(path);
  assert.deepEqual(await readOperation(second, operationId), expectedOperation);
});
```

Also verify digest mismatch, atomic artifact publish, local immediate authority,
database migration idempotency, and Windows-safe file replacement behavior.

Run: `npm run test:unit -w @tegojs/drivers-local`

Expected: FAIL with missing local driver exports.

Commit: `git add packages/drivers-local/test && git commit -m "test: define durable local drivers"`

- [x] **Step 2: Implement SQLite migrations and state semantics**

Create schema version table plus `records`, `changes`, `operations`, `outbox`,
and `idempotency` tables. Use `BEGIN IMMEDIATE`, database-generated revisions,
and WAL mode. Store canonical JSON text and validate decoded values.

- [x] **Step 3: Implement local coordination and artifact storage**

Local leadership returns epoch `"1"`. Leases use the injected clock.
Artifact writes stream to a temporary file, hash bytes, fsync, rename into
`artifacts/<first-two-digest-chars>/<digest>.tego`, and reject digest mismatch.

- [x] **Step 4: Run public conformance, restart tests, and commit**

Run:

```bash
npm run build -w @tegojs/drivers-local
node --test packages/drivers-local/dist/test/*.test.js
```

Expected: all local driver tests and shared conformance cases PASS.

Commit: `git add packages/drivers-local && git commit -m "feat: add durable local runtime drivers"`

## Task 5: Boot, recover, inspect, and stop an empty runtime

**Files:**
- Modify: `packages/contracts/src/state.ts`
- Modify: `packages/contracts/src/runtime.ts`
- Modify: `packages/drivers-local/src/memory-state-store.ts`
- Modify: `packages/drivers-local/src/sqlite/sqlite-state-store.ts`
- Create: `packages/runtime/tsconfig.json`
- Create: `packages/runtime/src/runtime-state.ts`
- Create: `packages/runtime/src/driver-supervisor.ts`
- Create: `packages/runtime/src/recovery.ts`
- Create: `packages/runtime/src/readiness.ts`
- Create: `packages/runtime/src/runtime-operations.ts`
- Create: `packages/runtime/src/create-runtime.ts`
- Create: `packages/runtime/src/index.ts`
- Create: `packages/runtime/test/bootstrap.test.ts`

**Interfaces:**
- Consumes: `RuntimeDrivers`.
- Produces: a public operation-journal query used by runtime recovery; storage
  implementations remain private.
- Produces: `createRuntime(configuration, drivers): Runtime`.
- Produces: `Runtime.start`, `Runtime.status`, `Runtime.stop`, and `Runtime.events`.

- [x] **Step 1: Write and commit failing bootstrap scenarios**

Cover empty lifecycle, reverse cleanup after partial open, multi-Main rejection
with local coordination, recovery-before-accepting-operations, essential
readiness, repeated `start`, repeated `stop`, and deterministic enumeration of
non-terminal operation-journal entries after restart.

Run: `npm run test:unit -w @tegojs/runtime`

Expected: FAIL because `createRuntime` is not exported.

Commit: `git add packages/runtime && git commit -m "test: define runtime bootstrap lifecycle"`

- [x] **Step 2: Implement pure runtime transition and readiness functions**

The transition function returns a new state or `LIFECYCLE_TRANSITION_INVALID`.
Readiness returns false only when runtime is not running, drivers are unhealthy,
or an essential desired deployment is not ready.

- [x] **Step 3: Implement bootstrap and recovery ordering**

Open the drivers present in the phase-one runtime contract in dependency order;
recover state by using only public state-store queries; obtain authority; start
operations and reconciliation; then set `acceptingOperations=true`. Close in
reverse order. `ProcessHost` and `SecretProvider` join the bootstrap contract in
Tasks 10 and 9 respectively, when their real consumers and conformance tests
exist; placeholder providers are forbidden.

- [x] **Step 4: Run focused and local integration tests, then commit**

Run:

```bash
npm run build -w @tegojs/runtime
node --test packages/runtime/dist/test/bootstrap.test.js
```

Expected: PASS.

Commit: `git add packages/runtime && git commit -m "feat: boot and recover an empty runtime"`

## Task 6: Validate, pack, sign, and register immutable plugin artifacts

**Files:**
- Create: `packages/runtime/src/artifacts/manifest-reader.ts`
- Create: `packages/runtime/src/artifacts/artifact-service.ts`
- Create: `packages/cli/src/plugin/build-plugin.ts`
- Create: `packages/cli/src/plugin/pack-plugin.ts`
- Create: `packages/cli/src/plugin/sign-plugin.ts`
- Create: `packages/testkit/src/plugin-fixture.ts`
- Create: `packages/runtime/test/artifacts.test.ts`
- Create: `packages/cli/test/plugin-pack.test.ts`
- Create: `examples/echo-plugin/manifest.json`
- Create: `examples/echo-plugin/src/component.ts`
- Create: `examples/echo-plugin/tsconfig.json`
- Create: `examples/echo-plugin/package.json`

**Interfaces:**
- Produces: `ArtifactService.validate`, `ArtifactService.install`, `packPlugin`, and `signArtifact`.
- Produces: deterministic `.tego` archive and immutable `PluginInstallation`.

- [x] **Step 1: Write and commit failing artifact security tests**

Test invalid-manifest side effects, traversal, absolute path, link/device entry,
duplicate path, undeclared file, CommonJS, incompatible Node/Tego range, digest
mismatch, tampered signature, and repeatable archive digest.

Run: `npm run test:unit -w @tegojs/runtime -w @tegojs/cli`

Expected: FAIL because artifact services do not exist.

Commit: `git add packages/runtime/test packages/cli/test examples/echo-plugin && git commit -m "test: define secure plugin artifacts"`

- [x] **Step 2: Implement data-only archive preflight**

Read the tar header and only `manifest.json` plus `metadata/files.json` during
preflight. Reject unsafe entries before extraction. Validate manifest before
resolving any component entry.

- [x] **Step 3: Implement deterministic packing and Ed25519 signatures**

Invoke `npm exec tsc -- -p <plugin-tsconfig>` as a child process. Sort entries,
normalize tar metadata, hash final bytes, and sign the digest with
`crypto.sign(null, digestBytes, privateKey)`.

- [x] **Step 4: Register installations and verify**

Persist installation under `(pluginId, version, digest)`. A conflicting digest
never overwrites an existing installation.

Run:

```bash
npm run build
node --test packages/runtime/dist/test/artifacts.test.js packages/cli/dist/test/plugin-pack.test.js
```

Expected: PASS and two unchanged packs have identical digests.

Commit: `git add packages/runtime packages/cli packages/testkit examples/echo-plugin && git commit -m "feat: package and install immutable plugins"`

## Task 7: Resolve capabilities and enforce permission envelopes

**Files:**
- Create: `packages/runtime/src/capabilities/version.ts`
- Create: `packages/runtime/src/capabilities/graph.ts`
- Create: `packages/runtime/src/capabilities/resolver.ts`
- Create: `packages/runtime/src/permissions/permission-set.ts`
- Create: `packages/runtime/src/permissions/gate.ts`
- Create: `packages/runtime/test/capability-resolution.test.ts`
- Create: `packages/runtime/test/permission-gate.test.ts`

**Interfaces:**
- Produces: `resolveCapabilities(input): ResolutionResult`.
- Produces: `validatePermissionGrant(requested, granted): PermissionDecision`.

- [x] **Step 1: Write and commit failing table-driven resolver tests**

Cover explicit binding, exactly one provider, no required provider, absent
optional provider, ambiguous providers, incompatible versions, provider-first
ordering, required cycle, and provider-loss policy.

Run: `node --test packages/runtime/dist/test/capability-resolution.test.js`

Expected: FAIL with missing resolver module.

Commit: `git add packages/runtime/test && git commit -m "test: define capability and permission resolution"`

- [x] **Step 2: Implement pure graph resolution**

Sort every candidate by provider deployment identity before producing
diagnostics. Use Tarjan strongly connected components for required cycles.
Return a binding graph only when all required nodes resolve.

- [x] **Step 3: Implement permission subset and call gates**

Canonicalize hosts, paths, environment names, methods, and selectors before
comparison. Reject any grant outside the manifest request and any call outside
the grant before module import or RPC dispatch.

- [x] **Step 4: Run tests and commit**

Run: `npm run build -w @tegojs/runtime && node --test packages/runtime/dist/test/capability-resolution.test.js packages/runtime/dist/test/permission-gate.test.js`

Expected: PASS.

Commit: `git add packages/runtime && git commit -m "feat: resolve capabilities and gate permissions"`

## Task 8: Reconcile deployments into kernel-owned component lifecycles

**Files:**
- Modify: `packages/contracts/src/state.ts`
- Modify: `packages/drivers-local/src/memory-state-store.ts`
- Modify: `packages/drivers-local/src/sqlite/sqlite-state-store.ts`
- Create: `packages/runtime/src/reconcile/component-lifecycle.ts`
- Create: `packages/runtime/src/reconcile/plan.ts`
- Create: `packages/runtime/src/reconcile/placement.ts`
- Create: `packages/runtime/src/reconcile/reconciler.ts`
- Create: `packages/runtime/src/reconcile/retry.ts`
- Create: `packages/runtime/test/component-lifecycle.test.ts`
- Create: `packages/runtime/test/reconciler.test.ts`

**Interfaces:**
- Produces: `planReconcile(snapshot): ReconcilePlan`.
- Produces: `Reconciler.start`, `Reconciler.wake`, and `Reconciler.stop`.
- Produces: public outbox claim/acknowledgement operations with stable message
  identity, fencing, retry visibility, and idempotent acknowledgement.

- [x] **Step 1: Write and commit failing lifecycle and convergence tests**

Cover legal transitions, illegal transition diagnostic, generation change,
duplicate reconcile, enable, disable, upgrade, drain, rollback, non-essential
failure, essential readiness, retry timing, and restart during one external
action. Also cover concurrent outbox claims, claim expiry, stale-fence rejection,
duplicate acknowledgement, and restart before acknowledgement.

Run: `node --test packages/runtime/dist/test/component-lifecycle.test.js packages/runtime/dist/test/reconciler.test.js`

Expected: FAIL with missing reconcile exports.

Commit: `git add packages/runtime/test && git commit -m "test: define deployment reconciliation"`

- [x] **Step 2: Implement pure lifecycle, placement, and plan functions**

Plans contain one bounded external effect per step and stable operation,
instance, and generation identities. Retry delay is capped exponential backoff
with deterministic jitter derived from operation ID.

- [x] **Step 3: Implement journaled reconciler execution**

Persist the step before performing the effect. Conditionally commit observed
state using expected revision and fencing epoch. Re-read after conflicts rather
than mutating stale snapshots.

- [x] **Step 4: Verify restart convergence and commit**

Run: `npm run build -w @tegojs/runtime && node --test packages/runtime/dist/test/component-lifecycle.test.js packages/runtime/dist/test/reconciler.test.js`

Expected: PASS with one live instance after interrupted reconcile replay.

Commit: `git add packages/runtime && git commit -m "feat: reconcile plugin deployments"`

## Task 9: Define the SDK and versioned ComponentHost protocol

**Files:**
- Create: `packages/contracts/src/secrets.ts`
- Create: `packages/drivers-local/src/development-secret-provider.ts`
- Modify: `packages/drivers-local/src/create-local-drivers.ts`
- Create: `packages/plugin-sdk/tsconfig.json`
- Create: `packages/plugin-sdk/src/component.ts`
- Create: `packages/plugin-sdk/src/context.ts`
- Create: `packages/plugin-sdk/src/disposables.ts`
- Create: `packages/plugin-sdk/src/index.ts`
- Create: `packages/executor-node/tsconfig.json`
- Create: `packages/executor-node/src/host/protocol.ts`
- Create: `packages/executor-node/src/host/component-loader.ts`
- Create: `packages/executor-node/src/host/component-host.ts`
- Create: `packages/plugin-sdk/test/component.test.ts`
- Create: `packages/executor-node/test/component-host.test.ts`

**Interfaces:**
- Produces: `defineComponent(definition): PluginComponentDefinition`.
- Produces: ComponentHost commands `prepare`, `import`, `start`, `health`, `run`, `drain`, `stop`, and `cancel`.
- Produces: `SecretProvider` and an explicit development-only local
  implementation; secret values never enter plugin manifests or persisted
  deployment configuration.

- [x] **Step 1: Write and commit failing SDK and host tests**

Verify functional definitions, disposable reverse cleanup, rejected decorator or
class assumptions, manifest entry confinement, ESM import, serialized hook
errors, capability request/response schema checks, cancellation delivery, secret
permission checks, redacted diagnostics, and idempotent secret-provider close.

Run: `npm run test:unit -w @tegojs/plugin-sdk -w @tegojs/executor-node`

Expected: FAIL because SDK and host exports are absent.

Commit: `git add packages/plugin-sdk packages/executor-node/test && git commit -m "test: define plugin SDK and component host"`

- [x] **Step 2: Implement the minimal SDK**

Freeze component definitions and contexts. The context exposes only identity,
config reader, logger, events, capability client, cancellation signal, runtime
information, and disposables.

- [x] **Step 3: Implement ComponentHost in-process protocol handling**

Validate every command and result with contracts. Import only a previously
prepared digest and declared entry. Convert all thrown values into
`RuntimeDiagnostic`.

- [x] **Step 4: Run tests and commit**

Run: `npm run build -w @tegojs/plugin-sdk -w @tegojs/executor-node && node --test packages/plugin-sdk/dist/test/component.test.js packages/executor-node/dist/test/component-host.test.js`

Expected: PASS.

Commit: `git add packages/plugin-sdk packages/executor-node && git commit -m "feat: add plugin SDK and component host"`

## Task 10: Certify ProcessExecutor

**Files:**
- Create: `packages/contracts/src/process-host.ts`
- Create: `packages/drivers-local/src/node-process-host.ts`
- Modify: `packages/drivers-local/src/create-local-drivers.ts`
- Create: `packages/testkit/src/executor-suite.ts`
- Create: `packages/executor-node/src/process/process-entry.ts`
- Create: `packages/executor-node/src/process/process-executor.ts`
- Create: `packages/executor-node/src/selection.ts`
- Create: `packages/executor-node/src/index.ts`
- Create: `packages/executor-node/test/process-executor.test.ts`

**Interfaces:**
- Produces: `executorConformance(factory, fixture)`.
- Produces: `ProcessExecutor` implementing the public `Executor`.
- Produces: `ProcessHost`; after this task `createLocalDrivers` satisfies the
  complete phase-one `RuntimeDrivers` contract without placeholder members.

- [x] **Step 1: Write and commit failing executor conformance**

Cover probe, echo, duplicate attempt, cancellation, deadline, crash, replacement,
drain, health, input limit, output limit, no leaked child process, spawn failure,
and idempotent process-host shutdown.

Run: `node --test packages/executor-node/dist/test/process-executor.test.js`

Expected: FAIL because `ProcessExecutor` is not exported.

Commit: `git add packages/testkit packages/executor-node/test && git commit -m "test: define process executor behavior"`

- [x] **Step 2: Implement IPC framing and attempt registry**

Fork one ComponentHost entry per active slot. Track attempts by
`taskId/attemptId`. A duplicate returns the current handle or cached terminal
result. Reject oversized frames before JSON parsing.

- [x] **Step 3: Implement cancellation, deadlines, crash replacement, and selection**

Send cooperative cancel, wait on fake-clock-compatible grace timer, then kill.
Record a structured process-exit result before returning capacity. Selection
filters support, permissions, resources, and health before applying preference.

- [x] **Step 4: Run conformance and commit**

Run: `npm run build -w @tegojs/testkit -w @tegojs/executor-node && node --test packages/executor-node/dist/test/process-executor.test.js`

Expected: PASS and active child count returns to zero.

Commit: `git add packages/testkit packages/executor-node && git commit -m "feat: add certified process executor"`

## Task 11: Certify ThreadExecutor with parity

**Files:**
- Create: `packages/executor-node/src/thread/thread-entry.ts`
- Create: `packages/executor-node/src/thread/thread-executor.ts`
- Create: `packages/executor-node/test/thread-executor.test.ts`

**Interfaces:**
- Produces: `ThreadExecutor` implementing the same `Executor`.

- [x] **Step 1: Write and commit the same conformance invocation for threads**

Add thread-specific assertions for transferable `ArrayBuffer`, worker exit, and
documentation metadata declaring `securityIsolation: false`.

Run: `node --test packages/executor-node/dist/test/thread-executor.test.js`

Expected: FAIL because `ThreadExecutor` is not exported.

Commit: `git add packages/executor-node/test/thread-executor.test.ts && git commit -m "test: require thread executor parity"`

- [x] **Step 2: Implement MessagePort transport and transferable payloads**

Reuse the ComponentHost protocol codec and attempt registry. Transfer owned
buffers only when the execution request marks them transferable.

- [x] **Step 3: Implement worker exit replacement and drain**

Resolve every inflight attempt before replacing a dead Worker. Drain refuses new
submissions, waits for terminal attempts, then terminates idle Workers.

- [x] **Step 4: Run both executor suites and commit**

Run: `npm run build -w @tegojs/executor-node && node --test packages/executor-node/dist/test/process-executor.test.js packages/executor-node/dist/test/thread-executor.test.js`

Expected: both suites PASS with matching logical echo results.

Commit: `git add packages/executor-node && git commit -m "feat: add certified thread executor"`

## Task 12: Establish authenticated reconnectable Worker sessions

**Files:**
- Create: `packages/testkit/src/worker-suite.ts`
- Create: `packages/transport-websocket/tsconfig.json`
- Create: `packages/transport-websocket/src/codec.ts`
- Create: `packages/transport-websocket/src/authentication.ts`
- Create: `packages/transport-websocket/src/session.ts`
- Create: `packages/transport-websocket/src/main-endpoint.ts`
- Create: `packages/transport-websocket/src/worker-endpoint.ts`
- Create: `packages/transport-websocket/test/session.test.ts`

**Interfaces:**
- Produces: `workerSessionConformance(mainFactory, workerFactory)`.
- Produces: direction-neutral Main and Worker endpoint APIs.

- [x] **Step 1: Write and commit failing protocol/session tests**

Cover invalid credential, unsupported version, sequence replay, message
deduplication, correlation, Worker-initiated connection, Main-initiated
connection, heartbeat expiry, replacement session, inflight limits, and close.

Run: `node --test packages/transport-websocket/dist/test/session.test.js`

Expected: FAIL because session factories do not exist.

Commit: `git add packages/testkit packages/transport-websocket && git commit -m "test: define Worker session protocol"`

- [x] **Step 2: Implement codec, authentication, and negotiation**

Use JSON control frames and correlated binary frames. Authenticate before
registration. Bound message bytes, pending correlations, binary buffer bytes,
and sequence gaps.

- [x] **Step 3: Implement liveness and direction-neutral endpoints**

Both endpoints adapt an accepted or initiated WebSocket into the same
`WorkerSession`. Heartbeat expiry marks unavailable and stops assignments before
closing the transport.

- [x] **Step 4: Run conformance and commit**

Run: `npm run build -w @tegojs/testkit -w @tegojs/transport-websocket && node --test packages/transport-websocket/dist/test/session.test.js`

Expected: PASS for both connection directions.

Commit: `git add packages/testkit packages/transport-websocket && git commit -m "feat: add authenticated Worker sessions"`

## Task 13: Certify RemoteExecutor and orphan recovery

**Files:**
- Create: `packages/transport-websocket/src/worker-runtime.ts`
- Create: `packages/transport-websocket/src/remote-executor.ts`
- Create: `packages/transport-websocket/src/result-buffer.ts`
- Create: `packages/transport-websocket/src/index.ts`
- Create: `packages/transport-websocket/test/remote-executor.test.ts`
- Create: `packages/transport-websocket/test/reconnect.test.ts`

**Interfaces:**
- Produces: `RemoteExecutor` implementing `Executor`.
- Produces: Worker runtime backed by local process/thread executors.

- [x] **Step 1: Write and commit failing remote conformance and reconnect tests**

Invoke the complete executor suite. Add disconnect during assignment,
disconnect while running, duplicate assignment, `cancel`,
`finish-and-buffer`, `finish-and-persist`, result acknowledgement, and reconnect
inventory.

Run: `node --test packages/transport-websocket/dist/test/remote-executor.test.js packages/transport-websocket/dist/test/reconnect.test.js`

Expected: FAIL because `RemoteExecutor` is absent.

Commit: `git add packages/transport-websocket/test && git commit -m "test: define remote execution recovery"`

- [x] **Step 2: Implement assignment, progress, cancellation, and result flow**

Persist Main assignment state before send and Worker acknowledgement before
execution. Cache terminal results until correlated acknowledgement.

- [x] **Step 3: Implement orphan policies and reconnect reconciliation**

Worker reports running, acknowledged, terminal-unacknowledged, and prepared
artifact identities. Main resolves the existing attempt before any retry creates
a new attempt ID.

- [x] **Step 4: Run all three executor suites and commit**

Run:

```bash
npm run build -w @tegojs/executor-node -w @tegojs/transport-websocket
node --test packages/executor-node/dist/test/*executor.test.js packages/transport-websocket/dist/test/*.test.js
```

Expected: thread, process, and remote conformance PASS.

Commit: `git add packages/transport-websocket && git commit -m "feat: add recoverable remote executor"`

## Task 14: Implement fenced PostgreSQL shared drivers

**Files:**
- Create: `compose.yaml`
- Create: `packages/testkit/src/coordination-suite.ts`
- Create: `packages/drivers-postgres/tsconfig.json`
- Create: `packages/drivers-postgres/src/migrations.ts`
- Create: `packages/drivers-postgres/src/postgres-state-store.ts`
- Create: `packages/drivers-postgres/src/postgres-artifact-store.ts`
- Create: `packages/drivers-postgres/src/postgres-coordination.ts`
- Create: `packages/drivers-postgres/src/create-postgres-drivers.ts`
- Create: `packages/drivers-postgres/src/index.ts`
- Create: `packages/drivers-postgres/test/postgres-drivers.test.ts`
- Create: `packages/drivers-postgres/test/leadership-faults.test.ts`

**Interfaces:**
- Produces: `coordinationConformance(factory)`.
- Produces: `createPostgresDrivers({ connectionString, namespace })`.

- [ ] **Step 1: Write and commit failing PostgreSQL conformance and fault tests**

Cover shared state, artifact uniqueness, exclusive leadership, monotonic epoch,
database-time lease expiry, concurrent CAS, namespace isolation, watch catch-up,
leader-connection death, notification pause, stale fenced write, and cleanup.

Run: `docker compose up -d postgres && npm run test:integration -w @tegojs/drivers-postgres`

The PostgreSQL integration tests default to the Compose endpoint
`postgresql://tego_test:tego_test@127.0.0.1:55432/tego_next_test`. Set
`TEGO_POSTGRES_URL` to run them against another disposable PostgreSQL database.

Expected: FAIL because PostgreSQL driver exports are absent.

Commit: `git add compose.yaml packages/testkit packages/drivers-postgres && git commit -m "test: define PostgreSQL runtime drivers"`

- [ ] **Step 2: Implement migrations, state, and artifact transactions**

Use one migration lock, `bigint` revisions returned as strings, JSONB records,
bytea artifacts, durable changes, operations, outbox, and conditional epoch
checks in every leader-owned transaction.

- [ ] **Step 3: Implement leadership, leases, CAS, and lossless watch**

Hold advisory leadership on a dedicated client. Increment epoch transactionally
after lock acquisition. Use database time for lease predicates. Treat
`LISTEN/NOTIFY` as wake-up only and scan changes from the last revision.

- [ ] **Step 4: Run integration and fault suites, then commit**

Run:

```bash
docker compose up -d postgres
npm run build -w @tegojs/drivers-postgres
npm run test:integration -w @tegojs/drivers-postgres
docker compose down -v
```

Expected: PASS; stale leader writes are rejected and all connections close.

Commit: `git add packages/testkit packages/drivers-postgres compose.yaml && git commit -m "feat: add fenced PostgreSQL runtime drivers"`

## Task 15: Add the local control protocol and CLI operations

**Files:**
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/control/protocol.ts`
- Create: `packages/cli/src/control/server.ts`
- Create: `packages/cli/src/control/client.ts`
- Create: `packages/cli/src/commands/runtime.ts`
- Create: `packages/cli/src/commands/plugin.ts`
- Create: `packages/cli/src/commands/task.ts`
- Create: `packages/cli/src/commands/worker.ts`
- Create: `packages/cli/src/main.ts`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/test/control.test.ts`
- Create: `packages/cli/test/commands.test.ts`

**Interfaces:**
- Produces: executable `tego`.
- Produces: foreground/detached runtime, JSON status, plugin, task, and Worker commands.

- [ ] **Step 1: Write and commit failing protocol and command tests**

Test malformed request, unsupported protocol, socket permission, repeated stop,
JSON status shape, failed exit code, invalid pack creates no artifact, plugin
install/deploy/status, task run/status/wait/cancel, Worker connection direction,
and detached startup recovery barrier.

Run: `npm run test:unit -w @tegojs/cli`

Expected: FAIL because CLI entry and control protocol are absent.

Commit: `git add packages/cli/test && git commit -m "test: define runtime CLI operations"`

- [ ] **Step 2: Implement NDJSON control server and client**

Validate each line as a versioned request, cap line length, correlate one result,
and close idle connections. Use Unix socket mode `0600`; use the current-user
named pipe on Windows.

- [ ] **Step 3: Implement commands with util.parseArgs**

Every command returns one typed result and supports `--json`. Human rendering
must not alter operation semantics. Foreground start is default; detached start
waits for `running` or a structured bootstrap failure.

- [ ] **Step 4: Run command tests and commit**

Run: `npm run build -w @tegojs/cli && node --test packages/cli/dist/test/*.test.js`

Expected: PASS and every spawned CLI/runtime process exits.

Commit: `git add packages/cli && git commit -m "feat: add local runtime CLI"`

## Task 16: Prove the complete vertical slices and release gate

**Files:**
- Create: `tests/e2e/helpers/runtime-process.mjs`
- Create: `tests/e2e/single-main.test.mjs`
- Create: `tests/e2e/executors.test.mjs`
- Create: `tests/e2e/multi-main.test.mjs`
- Create: `scripts/verify-release.mjs`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/plugin-development.md`
- Create: `docs/deployment/single-main.md`
- Create: `docs/deployment/multi-main.md`
- Create: `CHANGELOG.md`

**Interfaces:**
- Produces: `npm run verify` and `node scripts/verify-release.mjs`.
- Produces: documented, reproducible `0.1.0-alpha.1` evidence.

- [ ] **Step 1: Write and commit failing end-to-end tests**

`single-main.test.mjs` must start empty, pack/install/deploy echo, execute,
restart, and inspect recovered state. `executors.test.mjs` must run identical
input through thread, process, and remote and compare logical output.
`multi-main.test.mjs` must start two Mains, kill the leader connection, observe a
higher epoch, reject the stale writer, and record one terminal task result.

Run: `npm run test:e2e`

Expected: FAIL until CLI composition and root fixtures are connected.

Commit: `git add tests/e2e && git commit -m "test: define runtime acceptance flows"`

- [ ] **Step 2: Connect root compositions and finish the echo plugin**

Add the executable entry, local and PostgreSQL configuration loaders, echo
manifest, built component, runtime control directory, and Worker bootstrap
configuration needed by the tests. Do not add HTTP or business APIs.

- [ ] **Step 3: Add documentation and CI**

CI uses Node 26.5.0 and pinned PostgreSQL. Document the layer boundary, runtime
states, plugin artifact, TDD contribution rule, embedded single-Main operation,
multi-Main fencing, and the Node 26 LTS production gate.

- [ ] **Step 4: Run the clean release verifier**

`scripts/verify-release.mjs` creates a temporary clean Git worktree at current
HEAD and runs:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
docker compose up -d postgres
npm run test:integration
npm run build
npm run test:e2e
docker compose down -v
```

Expected: every command exits `0`; the verifier prints package versions, test
counts, artifact digest, executor parity result, and multi-Main fencing epoch.

- [ ] **Step 5: Commit the green phase-one implementation**

Commit: `git add . && git commit -m "feat: complete runtime kernel phase 1"`

## OpenSpec Task Closure

After each implementation task passes, mark the corresponding items in
`openspec/changes/runtime-kernel-phase-1/tasks.md`:

| Plan task | OpenSpec task groups |
| --- | --- |
| 1 | 1.1, 1.2 |
| 2 | 2.1–2.5 |
| 3 | 3.1, 3.2 |
| 4 | 3.3, 3.5 |
| 5 | 4.1–4.5 |
| 6 | 5.1–5.6 |
| 7 | 6.1–6.6 |
| 8 | 7.1–7.6 |
| 9 | 10.1, 10.2 |
| 10 | 8.1, 8.3–8.6 |
| 11 | 8.2, 8.6 |
| 12 | 9.1–9.3 |
| 13 | 9.4–9.7 |
| 14 | 3.4, 3.6, 3.7 |
| 15 | 11.1–11.5 |
| 16 | 1.3, 1.4, 10.3–10.5, 11.6, 11.7, 12.1–12.6 |

Before leaving Build phase:

```bash
rg '^- \[ \]' openspec/changes/runtime-kernel-phase-1/tasks.md
npm run verify
git status --short
```

Expected: `rg` prints nothing, verification exits `0`, and the worktree is
clean after the final tracking commit.
