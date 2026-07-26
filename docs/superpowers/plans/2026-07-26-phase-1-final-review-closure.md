# Phase 1 Final Review Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every blocking API, architecture, security, concurrency, recovery, fault-injection, and release finding so Tego Next phase one is usable across thread, process, and remote executors and can be released as `0.1.0-alpha.1`.

**Architecture:** Preserve the three-layer direction by keeping topology-neutral contracts and policy in `@tegojs/contracts` and `@tegojs/runtime`, Node-specific composition in the Node host surface, and CLI code limited to commands/control wiring. Execution requests carry an immutable, validated deployment binding; capability calls use the same task/executor transport to reach the exact active provider. Runtime status is read from durable observed state, and every authority, lifecycle, control-socket, and CI transition fails closed.

**Tech Stack:** Node.js 26.5.0, npm 11.13.0, TypeScript 7 ESM, Node test runner, AJV JSON Schema, SQLite `node:sqlite`, PostgreSQL 16, WebSocket `ws`, OpenSpec, GitHub Actions.

## Global Constraints

- Keep the phase-one layer boundary: no frontend, HTTP application server, authentication service, business ACL, cache, workflow, scheduler, datasource, or Tego 1.x compatibility layer.
- Add no runtime dependency unless the dependency is already present in the lockfile; prefer existing parsers and process runners.
- Keep generations, activations, revisions, epochs, sequences, and message identities as canonical strings.
- Use strict RED/GREEN commits and an independent review after each task.
- Use fake/manual clocks, promise gates, state revisions, process events, or bounded polling; add no fixed sleeps.
- Keep Memory, SQLite, and PostgreSQL semantics aligned; PostgreSQL acceptance uses `postgresql://tego_test:tego_test@127.0.0.1:5432/tego_next_test`.
- A follower may ingest immutable artifact bytes but may not mutate semantic installation or deployment state.
- Do not close OpenSpec review/release items until their executable and GitHub evidence exists.

---

## File Map

**Canonical truth and review evidence**

- Modify: `openspec/changes/runtime-kernel-phase-1/specs/capability-resolution/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/runtime-bootstrap/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/runtime-operations/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/task-execution/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/worker-protocol/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/tasks.md`
- Create: `docs/reviews/phase-1-api-architecture-review.md`
- Create: `docs/reviews/phase-1-security-concurrency-recovery-review.md`
- Create: `docs/releases/0.1.0-alpha.1.md`

**Security and control**

- Modify: `packages/cli/src/control/server.ts`
- Modify: `packages/cli/test/control.test.ts`

**Provider loss and lifecycle recovery**

- Modify: `packages/runtime/src/capabilities/resolver.ts`
- Modify: `packages/runtime/src/reconcile/reconciler.ts`
- Modify: `packages/runtime/src/components/component-effects.ts`
- Modify: `packages/runtime/test/capability-resolution.test.ts`
- Modify: `packages/runtime/test/reconciler.test.ts`
- Modify: `tests/integration/reconciler-state-stores.test.mjs`
- Modify: `tests/integration/runtime-fault-injection.test.mjs`

**Observed status and public contracts**

- Modify: `packages/contracts/src/operations.ts`
- Modify: `packages/contracts/src/schema.ts`
- Modify: `packages/runtime/src/create-runtime.ts`
- Modify: `packages/runtime/src/runtime-host.ts`
- Modify: `packages/runtime/src/runtime-operations.ts`
- Modify: `packages/runtime/test/runtime.test.ts`
- Modify: `tests/integration/node-runtime-host.test.mjs`

**Execution binding and capability production plane**

- Modify: `packages/contracts/src/execution.ts`
- Modify: `packages/contracts/src/plugin.ts`
- Modify: `packages/contracts/src/schema.ts`
- Modify: `packages/plugin-sdk/src/component.ts`
- Modify: `packages/runtime/src/tasks/task-service.ts`
- Create: `packages/runtime/src/capabilities/router.ts`
- Modify: `packages/cli/src/runtime/create-node-runtime-host.ts`
- Modify: `packages/cli/src/runtime/local-component-session-host.ts`
- Modify: `packages/cli/src/worker/worker-process.ts`
- Modify: `packages/executor-node/src/host/component-host.ts`
- Modify: `packages/executor-node/src/host/protocol.ts`
- Modify: `packages/transport-websocket/src/remote-executor.ts`
- Modify: `packages/transport-websocket/src/remote-protocol.ts`

**Public conformance and protocol hardening**

- Modify: `packages/testkit/src/worker-suite.ts`
- Modify: `packages/testkit/test/public-suites.test.ts`
- Modify: `packages/testkit/test/worker-session-public-adapter-compatibility.ts`
- Modify: `packages/runtime/src/reconcile/plan.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/transport-websocket/src/session.ts`
- Modify: `packages/transport-websocket/test/session.test.ts`
- Modify: `docs/superpowers/specs/2026-07-23-runtime-kernel-phase-1-design.md`

**Fault and release gates**

- Modify: `tests/integration/runtime-fault-injection.test.mjs`
- Modify: `tests/architecture/system-ci.test.mjs`
- Modify: `tests/e2e/single-main-process.test.mjs`
- Modify: `scripts/run-ci-test.mjs`
- Modify: `scripts/verify-release.mjs`
- Modify: `.github/workflows/ci.yml`

---

### Task 1: Reopen Canonical Claims and Add Final Review Scenarios

**Files:**
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/capability-resolution/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/runtime-bootstrap/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/runtime-operations/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/task-execution/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/worker-protocol/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/tasks.md`

**Interfaces:**
- Consumes: Five independent final-review reports over `436b1d7..239421d`.
- Produces: Normative scenario slugs for Tasks 2–11 and truthful open checklist items.

- [ ] **Step 1: Reopen affected claims**

Change `2.3`, `2.5`, `5.1`, `5.6`, `6.1`, `6.4`, `6.6`, `7.2`, `7.3`, `7.5`, `7.6`, `8.2`, `8.3`, `8.5`, `8.6`, `9.1`, `9.2`, `9.4`, `9.5`, `9.7`, `10.1`, `10.2`, `10.3`, `10.4`, `11.3`, `11.6`, `11.7`, `12.1`, `12.2`, `12.3`, `12.4`, `12.5`, and `12.6` to `[ ]`. Do not change unrelated boxes.

- [ ] **Step 2: Add executable review scenarios**

Add scenarios for:

```text
sequential loss escalates to the strongest currently lost policy
same provider identity may recover through a compatible higher provider generation
starting checkpoint reconstructs an exact prepared binding before start replay
runtime status reflects live durable deployment observations on leaders and followers
thread, process, and remote receive one identical immutable execution binding
capability calls route to the exact ready provider and validate request/response schemas
Unix control operations remain unavailable until owner and 0600 permissions are verified
same-message-ID replay with different content is rejected
CI required gates cannot be disabled or made continue-on-error
```

- [ ] **Step 3: Run strict OpenSpec validation**

Run:

```bash
npx -y npm@11.13.0 run openspec:validate
```

Expected: PASS with the affected checklist deliberately open.

- [ ] **Step 4: Commit canonical review truth**

```bash
git add openspec/changes/runtime-kernel-phase-1
git commit -m "docs: reopen phase one review findings"
```

### Task 2: Make Unix Control Endpoint Permissions Atomic

**Files:**
- Modify: `packages/cli/src/control/server.ts`
- Modify: `packages/cli/test/control.test.ts`

**Interfaces:**
- Consumes: `startControlServer()` and `ControlServerOptions`.
- Produces:

```ts
interface EndpointSecurityState {
  readonly ownerUid: number;
  readonly mode: 0o600;
}

async function verifyUnixControlEndpoint(path: string): Promise<EndpointSecurityState>;
```

- [ ] **Step 1: Write RED permission-window tests**

Use a promise gate around `setEndpointPermissions`. Connect while the permission step is blocked and send `runtime.stop`; assert no operation handler runs and no response is emitted. Add tests that a no-op permission hook, wrong owner, non-socket path, or mode other than `0600` makes startup fail and closes queued sockets.

- [ ] **Step 2: Run the RED control tests**

```bash
npx -y npm@11.13.0 run build --workspace @tegojs/cli
node --test --test-name-pattern="permission initialization|owner-private|0600" packages/cli/dist/test/control.test.js
```

Expected: FAIL because listening currently precedes verified permission readiness.

- [ ] **Step 3: Pause accepted sockets until verified**

Create the Unix server with paused connections, bind it, call the permission setter, then `lstat()` and verify socket type, `process.getuid()` ownership where available, and exact `0o600`. Only after verification may queued sockets resume and dispatch. On any verification error, destroy queued sockets and close the server. Keep the injection hook only as a testable action; never trust its return value.

- [ ] **Step 4: Run GREEN control and CLI tests**

```bash
npx -y npm@11.13.0 run build --workspace @tegojs/cli
node --test packages/cli/dist/test/control.test.js
```

Expected: PASS with no operation before permission verification.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/control/server.ts packages/cli/test/control.test.ts
git commit -m "fix(control): verify endpoint permissions before dispatch"
```

### Task 3: Repair Sequential Provider Loss and Provider Upgrade Recovery

**Files:**
- Modify: `packages/runtime/src/capabilities/resolver.ts`
- Modify: `packages/runtime/src/reconcile/reconciler.ts`
- Modify: `packages/runtime/test/capability-resolution.test.ts`
- Modify: `packages/runtime/test/reconciler.test.ts`
- Modify: `tests/integration/reconciler-state-stores.test.mjs`

**Interfaces:**
- Consumes: Durable capability bindings and `PersistedProviderLoss`.
- Produces:

```ts
interface CapabilityResolutionDeployment {
  readonly activated: boolean;
  readonly ready: boolean;
}

interface ProviderRecoveryBindingPrerequisite {
  readonly capability: CapabilityName;
  readonly provider: PluginDeploymentIdentity;
}
```

`providerGeneration` becomes transaction-time evidence, not the durable logical binding identity.

- [ ] **Step 1: Write RED sequential-loss tests**

Cover `degrade -> fail`, `suspend -> fail`, restart between losses, and provider re-drop. Assert one durable action upgraded by `fail > suspend > degrade` and no weaker observation after escalation.

- [ ] **Step 2: Write RED provider-generation recovery tests**

For degrade and suspend, lose provider generation `1`, install compatible generation `2` under the same provider identity, and assert recovery. Add a negative binding-identity change case.

- [ ] **Step 3: Run RED**

```bash
npx -y npm@11.13.0 run build --workspace @tegojs/runtime
node --test --test-name-pattern="sequential provider loss|provider generation upgrade" packages/runtime/dist/test/capability-resolution.test.js packages/runtime/dist/test/reconciler.test.js tests/integration/reconciler-state-stores.test.mjs
```

Expected: FAIL with no second loss decision and retained provider-generation hold.

- [ ] **Step 4: Separate activation history from current readiness**

Set `activated` from durable component history. Produce loss decisions whenever the consumer was activated or already has a provider-loss record, not only while currently ready. Merge newly lost bindings with the durable record and recompute strongest action transactionally.

- [ ] **Step 5: Fence recovery with current provider evidence**

Persist capability-to-provider identity only. During each recovery planning/restoration/claim transaction, load the current deployment generation, installation provision, component readiness, binding revision, and provider component revision; accept a compatible higher generation of the same identity and fence that current evidence.

- [ ] **Step 6: Run GREEN matrix and commit**

```bash
npx -y npm@11.13.0 run build
node --test --test-name-pattern="provider loss|generation upgrade|binding survives" packages/runtime/dist/test/capability-resolution.test.js packages/runtime/dist/test/reconciler.test.js tests/integration/reconciler-state-stores.test.mjs
git add packages/runtime/src/capabilities/resolver.ts packages/runtime/src/reconcile/reconciler.ts packages/runtime/test/capability-resolution.test.ts packages/runtime/test/reconciler.test.ts tests/integration/reconciler-state-stores.test.mjs
git commit -m "fix(runtime): escalate provider loss across recovery states"
```

### Task 4: Recover the Durable Starting Checkpoint with Real Effects

**Files:**
- Modify: `packages/runtime/src/reconcile/reconciler.ts`
- Modify: `packages/runtime/src/components/component-effects.ts`
- Modify: `packages/runtime/test/component-effects.test.ts`
- Modify: `tests/integration/runtime-fault-injection.test.mjs`
- Modify: `tests/integration/reconciler-state-stores.test.mjs`

**Interfaces:**
- Produces:

```ts
interface ComponentLifecycleEffects {
  restoreStarting(effect: StartEffect): Promise<void>;
}
```

`restoreStarting()` prepares the exact artifact/binding and reconstructs the registry, but does not report a completed start.

- [ ] **Step 1: Write a real-effects RED fault**

Use a fresh `ComponentEffects`, fresh `ComponentRegistry`, and fresh host after external `start()` succeeds but the `ready` commit is blocked. Assert restart reconstructs the exact prepared binding and replays start to ready instead of persisting `LIFECYCLE_START_FAILED`.

- [ ] **Step 2: Run RED**

```bash
npx -y npm@11.13.0 run build
node --test --test-name-pattern="starting checkpoint" tests/integration/runtime-fault-injection.test.mjs packages/runtime/dist/test/component-effects.test.js
```

Expected: FAIL because `starting` is excluded from restoration.

- [ ] **Step 3: Restore starting before claim replay**

Include `starting` in restart restoration. Validate deployment generation, activation, digest, executor, and authority; prepare the artifact and registry binding without calling the lifecycle start hook. Let the durable outbox start claim perform the idempotent start.

- [ ] **Step 4: Run GREEN and commit**

```bash
node --test --test-name-pattern="starting checkpoint|lifecycle interruption" tests/integration/runtime-fault-injection.test.mjs packages/runtime/dist/test/component-effects.test.js tests/integration/reconciler-state-stores.test.mjs
git add packages/runtime/src/reconcile/reconciler.ts packages/runtime/src/components/component-effects.ts packages/runtime/test/component-effects.test.ts tests/integration/runtime-fault-injection.test.mjs tests/integration/reconciler-state-stores.test.mjs
git commit -m "fix(runtime): restore durable starting checkpoints"
```

### Task 5: Publish Typed Live Runtime Status

**Files:**
- Modify: `packages/contracts/src/operations.ts`
- Modify: `packages/contracts/src/schema.ts`
- Modify: `packages/runtime/src/runtime-host.ts`
- Modify: `packages/runtime/src/create-runtime.ts`
- Modify: `packages/runtime/src/runtime-operations.ts`
- Modify: `packages/runtime/src/reconcile/reconciler.ts`
- Modify: `packages/runtime/test/runtime.test.ts`
- Modify: `tests/integration/node-runtime-host.test.mjs`

**Interfaces:**
- Produces:

```ts
type PluginDeploymentObservationStatus =
  | "blocked"
  | "degraded"
  | "disabled"
  | "failed"
  | "ready"
  | "reconciling"
  | "suspended";

interface PluginDeploymentObservation extends JsonObject {
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly generation: Generation;
  readonly status: PluginDeploymentObservationStatus;
  readonly diagnostics: readonly RuntimeDiagnostic[];
  readonly updatedAt: string;
}

interface RuntimeObservedStatusReader {
  read(): Promise<{
    readonly deploymentCount: number;
    readonly installationCount: number;
    readonly deploymentReadiness: readonly { readonly essential: boolean; readonly ready: boolean }[];
  }>;
}
```

- [ ] **Step 1: Write RED status tests**

Assert empty startup, deploy-after-start, provider degrade/recover, essential failure, follower read, and restart-after-ready all update `runtime.status().counts` and readiness without recreating the Runtime object.

- [ ] **Step 2: Run RED**

```bash
npx -y npm@11.13.0 run build
node --test --test-name-pattern="live runtime status|typed deployment observation" packages/runtime/dist/test/runtime.test.js tests/integration/node-runtime-host.test.mjs
```

Expected: FAIL because status uses `#recovery`.

- [ ] **Step 3: Add the public observation parser**

Move the observation union to contracts, validate exact fields/canonical generation/status/diagnostics, and replace the generic `JsonValue` operation surface.

- [ ] **Step 4: Read status from durable observed state**

Create one topology-neutral status reader over `StateStore`. On every `status()` call, scan installations, deployments, and deployment observations for the configured application; compute essential readiness from current observations. Followers use the same durable reader.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx -y npm@11.13.0 run build
node --test --test-name-pattern="runtime status|deployment observation" packages/contracts/dist/test/contracts.test.js packages/runtime/dist/test/runtime.test.js tests/integration/node-runtime-host.test.mjs
git add packages/contracts/src/operations.ts packages/contracts/src/schema.ts packages/runtime/src/runtime-host.ts packages/runtime/src/create-runtime.ts packages/runtime/src/runtime-operations.ts packages/runtime/src/reconcile/reconciler.ts packages/runtime/test/runtime.test.ts tests/integration/node-runtime-host.test.mjs
git commit -m "fix(runtime): report live durable readiness"
```

### Task 6: Carry One Immutable Execution Binding Across All Executors

**Files:**
- Modify: `packages/contracts/src/execution.ts`
- Modify: `packages/contracts/src/schema.ts`
- Modify: `packages/runtime/src/tasks/task-service.ts`
- Modify: `packages/runtime/test/task-service.test.ts`
- Modify: `packages/cli/src/runtime/create-node-runtime-host.ts`
- Modify: `packages/cli/src/runtime/local-component-session-host.ts`
- Modify: `packages/cli/src/worker/worker-process.ts`
- Modify: `packages/cli/test/worker-command.test.ts`
- Modify: `tests/e2e/single-main-process.test.mjs`

**Interfaces:**
- Produces:

```ts
interface ExecutionBinding extends JsonObject {
  readonly configuration: JsonValue;
  readonly permissionGrants: readonly Permission[];
  readonly capabilityDefinitions: readonly CapabilityDefinition[];
  readonly capabilityBindings: readonly CapabilityBinding[];
  readonly fingerprint: string;
}

interface ExecutionRequest extends JsonObject {
  readonly binding: ExecutionBinding;
}

interface TaskExecutorSelection {
  readonly target: TaskExecutionTarget;
  readonly binding: ExecutionBinding;
  readonly executor: Executor;
}
```

- [ ] **Step 1: Write RED topology-parity tests**

Run one plugin through thread, process, and remote. It must read the same nested configuration, receive identical effective grants/capability definitions/bindings, and reject a request whose binding fingerprint does not match target generation/digest.

- [ ] **Step 2: Run RED**

```bash
npx -y npm@11.13.0 run build
node --test --test-name-pattern="execution binding parity" packages/runtime/dist/test/task-service.test.js packages/cli/dist/test/worker-command.test.js tests/e2e/single-main-process.test.mjs
```

Expected: FAIL because remote constructs `{}` and an executor-only grant.

- [ ] **Step 3: Build and persist the binding at selection**

Resolve deployment, installation, component, durable capability bindings, and effective grants before task admission. Canonicalize the binding and compute its SHA-256 fingerprint. Store it in `TaskRecord`/request evidence so restart dispatch reuses the same immutable binding.

- [ ] **Step 4: Validate at every executor boundary**

Contracts parse the binding. Local and remote artifact selection verify application/plugin/component/generation/digest and fingerprint. Worker uses the request binding verbatim and never synthesizes configuration or permissions.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx -y npm@11.13.0 run build
node --test --test-name-pattern="execution binding|remote component" packages/contracts/dist/test/contracts.test.js packages/runtime/dist/test/task-service.test.js packages/cli/dist/test/worker-command.test.js tests/e2e/single-main-process.test.mjs
git add packages/contracts/src/execution.ts packages/contracts/src/schema.ts packages/runtime/src/tasks/task-service.ts packages/runtime/test/task-service.test.ts packages/cli/src/runtime/create-node-runtime-host.ts packages/cli/src/runtime/local-component-session-host.ts packages/cli/src/worker/worker-process.ts packages/cli/test/worker-command.test.ts tests/e2e/single-main-process.test.mjs
git commit -m "feat(runtime): bind execution context across executors"
```

### Task 7: Wire the Capability Production Plane End to End

**Files:**
- Modify: `packages/contracts/src/plugin.ts`
- Modify: `packages/contracts/src/schema.ts`
- Modify: `packages/plugin-sdk/src/component.ts`
- Create: `packages/runtime/src/capabilities/router.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/cli/src/runtime/create-node-runtime-host.ts`
- Modify: `packages/cli/src/runtime/local-component-session-host.ts`
- Modify: `packages/cli/src/worker/worker-process.ts`
- Modify: `packages/executor-node/src/host/component-host.ts`
- Modify: `packages/executor-node/src/host/protocol.ts`
- Modify: `packages/transport-websocket/src/remote-protocol.ts`
- Modify: `packages/transport-websocket/src/remote-executor.ts`
- Test: `packages/runtime/test/capability-router.test.ts`
- Test: `tests/integration/capability-topology.test.mjs`

**Interfaces:**
- Produces:

```ts
interface PluginCapabilityProvision extends JsonObject {
  readonly name: CapabilityName;
  readonly protocolVersion: string;
  readonly componentId: ComponentId;
  readonly methods: readonly string[];
  readonly requestSchema: JsonSchema;
  readonly responseSchema: JsonSchema;
}

interface ComponentCapabilityInvocationHandler {
  invokeCapability(
    context: ComponentContext,
    request: ComponentCapabilityCall,
  ): Promise<JsonValue> | JsonValue;
}

interface CapabilityRouter {
  invoke(consumer: ComponentInstanceIdentity, call: ComponentCapabilityInvocation): Promise<JsonValue>;
}

interface RemoteComponentActivation extends JsonObject {
  readonly target: TaskExecutionTarget;
  readonly configuration: JsonValue;
  readonly permissionGrants: readonly Permission[];
  readonly capabilityDefinitions: readonly CapabilityDefinition[];
  readonly capabilityBindings: readonly CapabilityBinding[];
  readonly bindingFingerprint: string;
}
```

- [ ] **Step 1: Write RED manifest and router tests**

Require inline schemas and provider `componentId`; reject duplicate definitions and undeclared provider components. Test exact durable binding selection, request validation before provider code, response validation after provider code, permission denial, provider not-ready, binding change, and secret-value exfiltration rejection.

- [ ] **Step 2: Write RED topology tests**

Use a task provider with `invokeCapability` and a task consumer calling `context.capabilities.call()`. Run consumer/provider combinations through thread, process, and remote. Assert identical output and exact provider activation.

- [ ] **Step 3: Run RED**

```bash
npx -y npm@11.13.0 run build
node --test --test-name-pattern="capability router|capability topology" packages/contracts/dist/test/contracts.test.js packages/runtime/dist/test/capability-router.test.js tests/integration/capability-topology.test.mjs
```

Expected: FAIL because manifests have no schemas/owner component and production hosts reject capabilities.

- [ ] **Step 4: Implement manifest definitions and SDK handler**

Parse the provision as a `CapabilityDefinition` plus provider component identity and a canonical non-empty method set. Extend component definitions with the optional `invokeCapability` hook; in phase one only task components may implement it. Service hosting remains explicitly deferred.

- [ ] **Step 5: Implement runtime-owned exact-provider routing**

Load the consumer's durable binding, exact ready provider deployment/activation, and provision. Gate request, dispatch an internal exact-target execution to the provider component using the immutable execution binding, then gate response. Use operation IDs derived from consumer call identity for dedupe.

- [ ] **Step 6: Carry remote capability calls through Main**

Add `component.activate`, `component.activated`, `component.drain`, and `component.stop` request/response envelopes so Main sends the exact immutable activation binding before a remote component becomes ready. For remote consumers, add a Worker `capability.invoke` request that self-correlates to Main. Main validates the authenticated Worker/consumer target, authorizes and routes it through `CapabilityRouter`, and correlates the response to the request. When the provider is remote, Main forwards the invocation to that provider's exact remote activation. The Worker never resolves providers or grants locally.

- [ ] **Step 7: Remove the capability/service fail-closed production gate**

Replace `assertLocalComponentManifestSupported()` with validation that task provider hooks, schemas, method declarations, grants, and supported executors are present. Continue rejecting service components and malformed or unrouteable manifests before import.

- [ ] **Step 8: Run GREEN and commit**

```bash
npx -y npm@11.13.0 run build
node --test --test-name-pattern="capability" packages/contracts/dist/test/contracts.test.js packages/runtime/dist/test/*.test.js packages/executor-node/dist/test/*.test.js packages/transport-websocket/dist/test/*.test.js tests/integration/capability-topology.test.mjs
git add packages/contracts packages/plugin-sdk packages/runtime packages/cli packages/executor-node packages/transport-websocket tests/integration/capability-topology.test.mjs
git commit -m "feat(runtime): route capabilities across executors"
```

### Task 8: Complete Public Conformance and Replay Integrity

**Files:**
- Modify: `packages/testkit/src/worker-suite.ts`
- Modify: `packages/testkit/test/public-suites.test.ts`
- Modify: `packages/testkit/test/worker-session-public-adapter-compatibility.ts`
- Modify: `packages/runtime/src/reconcile/plan.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/test/capability-resolution.test.ts`
- Modify: `packages/transport-websocket/src/session.ts`
- Modify: `packages/transport-websocket/test/session.test.ts`
- Modify: `docs/superpowers/specs/2026-07-23-runtime-kernel-phase-1-design.md`

**Interfaces:**
- `WorkerSessionLike.request()` matches the public transport request signature.
- Replay retention stores `{ messageId, fingerprint }`.
- `parseActivation()` throws `DiagnosticError` code `ACTIVATION_INVALID`.

- [ ] **Step 1: Write RED public API tests**

Prove an adapter without `request()` fails the public compile fixture; conformance invokes `request()` and validates self-/response-correlation. Import provider-loss helpers only from `@tegojs/runtime`. Reject invalid activation with the stable diagnostic.

- [ ] **Step 2: Write RED replay equivocation test**

Send the same session/sequence/message ID twice with different canonical envelope content. Assert protocol close; an identical replay remains ignored.

- [ ] **Step 3: Implement and run GREEN**

```bash
npx -y npm@11.13.0 run build
node --test packages/testkit/dist/test/*.test.js packages/transport-websocket/dist/test/session.test.js packages/runtime/dist/test/capability-resolution.test.js
```

- [ ] **Step 4: Correct the maintained design spec and commit**

Make `correlationId` required and document self-correlation/no downgrade. Export intentionally public provider-loss types/functions from the runtime entry. Commit:

```bash
git add packages/testkit packages/runtime packages/transport-websocket docs/superpowers/specs/2026-07-23-runtime-kernel-phase-1-design.md
git commit -m "fix(protocol): complete public conformance contracts"
```

### Task 9: Expand Fault Injection and Bound Process Trees

**Files:**
- Modify: `tests/integration/runtime-fault-injection.test.mjs`
- Modify: `tests/integration/reconciler-state-stores.test.mjs`
- Modify: `tests/architecture/system-ci.test.mjs`
- Modify: `scripts/run-ci-test.mjs`
- Modify: `scripts/verify-release.mjs`

**Interfaces:**
- `runReleaseCommand({ name, command, args, timeoutMs })` uses the managed process-tree runner.

- [ ] **Step 1: Write RED parity faults**

Data-drive lifecycle/starting and stale-fencing faults through Memory and SQLite. Add PostgreSQL stale-authority fault under `TEGO_POSTGRES_URL`. Restart `RemoteExecutor`/durable attempt store before duplicate terminal replay. After permission denial, correct the grant and prove exactly one import.

- [ ] **Step 2: Write RED process-tree and timeout tests**

Have a child spawn a grandchild; on timeout verify both disappear before metadata is final. Make a release stage hang and assert a structured bounded timeout diagnostic.

- [ ] **Step 3: Implement bounded runners**

Reuse the event-driven reporter process group/tree termination for release commands. Wait for Windows `taskkill` completion. Persist per-stage start/end/duration/timeout metadata.

- [ ] **Step 4: Run GREEN and commit**

```bash
TEGO_POSTGRES_URL=postgresql://tego_test:tego_test@127.0.0.1:5432/tego_next_test node --test tests/integration/runtime-fault-injection.test.mjs tests/integration/reconciler-state-stores.test.mjs tests/architecture/system-ci.test.mjs
git add tests/integration tests/architecture/system-ci.test.mjs scripts/run-ci-test.mjs scripts/verify-release.mjs
git commit -m "test(runtime): harden fault and process recovery"
```

### Task 10: Make GitHub CI Gates Structural and Reproducible

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/verify-release.mjs`
- Modify: `tests/architecture/system-ci.test.mjs`

**Interfaces:**
- `validateWorkflowContract()` parses job and step structure and rejects disabled/soft-fail required gates.

- [ ] **Step 1: Write RED workflow mutations**

Mutate every required step with `if: false`, `continue-on-error: true`, wrong job, or commented command. Remove the deterministic package step. Each mutation must produce `ci_contract_incomplete`.

- [ ] **Step 2: Add the CI package gate**

Add a non-recursive deterministic package/reproducibility command after build in `quality`. Pin `checkout`, `setup-node`, and `upload-artifact` to reviewed full commit SHAs with version comments. Keep `contents: read`.

- [ ] **Step 3: Parse and validate active step fields**

Validate exact required jobs/commands/order, no disabled or soft-fail gates, PostgreSQL service/version, bounded reporter commands, upload-on-always, and package reproducibility.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx -y npm@11.13.0 run build
node --test tests/architecture/system-ci.test.mjs
TEGO_POSTGRES_URL=postgresql://tego_test:tego_test@127.0.0.1:5432/tego_next_test npx -y npm@11.13.0 run verify:release -- --preflight
git add .github/workflows/ci.yml scripts/verify-release.mjs tests/architecture/system-ci.test.mjs
git commit -m "ci: enforce reproducible release gates"
```

### Task 11: Make Cluster Retry Time and Node Composition Explicit

**Files:**
- Modify: `packages/contracts/src/driver.ts`
- Modify: `packages/drivers-postgres/src/create-postgres-drivers.ts`
- Modify: `packages/drivers-postgres/src/postgres-state-store.ts`
- Modify: `packages/runtime/src/reconcile/reconciler.ts`
- Modify: `packages/cli/src/runtime/create-node-runtime-host.ts`
- Modify: `docs/architecture/runtime-kernel.md`
- Modify: `tests/integration/postgres-state-store.test.ts`

**Interfaces:**
- Produces:

```ts
interface ClusterTime {
  now(): Promise<string>;
}
```

PostgreSQL uses database time for persisted retry availability; single Main continues using the local injected clock.

- [ ] **Step 1: Write RED clock-skew takeover tests**

Persist a retry from a leader clock far ahead, take authority with a leader clock far behind, and assert retry availability follows PostgreSQL time rather than either process clock.

- [ ] **Step 2: Implement cluster time**

Expose `SELECT clock_timestamp()` through the PostgreSQL driver and use it whenever multi-Main reconciliation persists or evaluates retry deadlines. Keep fake/local clock determinism for embedded/single-Main mode.

- [ ] **Step 3: Clarify Node composition ownership**

Document the current Node host as the phase-one composition root and CLI as its command/control adapter. Do not claim the CLI package is packaging-only. Record extraction to a future `@tegojs/node-host` package as non-blocking packaging cleanup, not a behavioral dependency.

- [ ] **Step 4: Run GREEN and commit**

```bash
TEGO_POSTGRES_URL=postgresql://tego_test:tego_test@127.0.0.1:5432/tego_next_test npx -y npm@11.13.0 run test:integration
npx -y npm@11.13.0 run build
git add packages/contracts packages/drivers-postgres packages/runtime packages/cli docs/architecture/runtime-kernel.md tests/integration
git commit -m "fix(runtime): use authoritative cluster retry time"
```

### Task 12: Final Reviews, Release Notes, CI Evidence, and Reclosure

**Files:**
- Create: `docs/reviews/phase-1-api-architecture-review.md`
- Create: `docs/reviews/phase-1-security-concurrency-recovery-review.md`
- Create: `docs/releases/0.1.0-alpha.1.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/tasks.md`

**Interfaces:**
- Consumes: Independent post-fix API, architecture, security, concurrency, recovery, and fault/CI reviews.
- Produces: Review evidence, release notes, closed `12.3–12.6`, and merge-ready GitHub evidence.

- [ ] **Step 1: Run full local release verification**

```bash
TEGO_POSTGRES_URL=postgresql://tego_test:tego_test@127.0.0.1:5432/tego_next_test npx -y npm@11.13.0 run verify
TEGO_POSTGRES_URL=postgresql://tego_test:tego_test@127.0.0.1:5432/tego_next_test npx -y npm@11.13.0 run verify:release
npx -y npm@11.13.0 run openspec:validate
```

Expected: all stages PASS on a clean worktree.

- [ ] **Step 2: Run five independent read-only reviews**

Use API/protocol, architecture, security, concurrency/recovery, and fault/release reviewers over the complete branch. Resolve every Critical and Important finding and re-review until all five return ready.

- [ ] **Step 3: Write review evidence**

Record reviewed SHA range, commands, PostgreSQL version, test counts, resolved findings, accepted non-blocking limitations, and reviewer verdicts in the two review documents.

- [ ] **Step 4: Write alpha release notes**

Document supported single-Main/multi-Main topologies, three executors, capability routing, plugin lifecycle, trusted local endpoint, Node.js 26 LTS production gate, Windows ACL limitation, storage-DoS scope, and explicitly deferred layer-two HTTP/security/datasource/workflow/frontend capabilities.

- [ ] **Step 5: Push the branch and obtain authoritative GitHub evidence**

Push the exact reviewed commit. Require successful `quality`, `PostgreSQL integration`, and `Main and Worker process E2E` jobs for that SHA; record run/job URLs and artifact names in the review evidence.

- [ ] **Step 6: Reclose only proven items**

Close every task reopened in Task 1 plus `12.3`, `12.4`, `12.5`, and `12.6`. Run strict OpenSpec validation and commit:

```bash
git add docs/reviews docs/releases openspec/changes/runtime-kernel-phase-1/tasks.md
git commit -m "docs: close phase one release review"
```

- [ ] **Step 7: Final clean-tree release preflight**

```bash
TEGO_POSTGRES_URL=postgresql://tego_test:tego_test@127.0.0.1:5432/tego_next_test npx -y npm@11.13.0 run verify:release -- --preflight
git status --porcelain=v1
```

Expected: preflight `{"ok":true,"mode":"preflight"}` and empty status.

## Acceptance Criteria

- Unix local control dispatch cannot occur before owner/mode verification.
- Sequential provider losses escalate, compatible provider upgrades recover, and `starting` restart converges with real effects.
- Runtime status and deployment observations are live, typed, durable, and topology-independent.
- Thread, process, and remote receive the same immutable execution binding.
- Capability schemas, provider ownership, permission gates, exact binding, and request/response validation work end to end across all executors.
- Public testkit covers request correlation; same-ID equivocation is rejected.
- Fault evidence covers Memory, SQLite, PostgreSQL, restart, durable dedupe, permission recovery, and process descendants.
- CI contains a structural, non-disableable deterministic packaging gate and bounded diagnostic runners.
- Multi-Main retry time is authoritative under process clock skew.
- Five independent final reviews have no blocking finding.
- Local release verification and the exact pushed GitHub SHA are green before OpenSpec release closure.

## Stop Conditions

- Stop a task if a proposed compatibility path would accept an ambiguous legacy identity or mutable execution binding.
- Stop capability routing if the exact persisted provider/activation cannot be fenced before provider code executes.
- Stop reclosure if any required CI gate is skipped, soft-failed, or has no exact-SHA evidence.
- Do not merge or close `12.5` while any reviewer reports a Critical or Important finding.
