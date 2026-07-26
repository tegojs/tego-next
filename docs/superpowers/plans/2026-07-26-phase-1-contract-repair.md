# Phase 1 Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the phase-one specification and implementation so provider loss, Worker correlation, follower artifact ingress, and operator documentation have durable, testable, release-verifiable contracts.

**Architecture:** Repair the canonical OpenSpec first, then implement each contract through focused red-green slices. Provider selection becomes durable observed state, provider-loss actions are reduced deterministically to `fail > suspend > degrade`, and a persisted activation ordinal gives suspend/recovery new idempotent lifecycle identities without changing desired generation; Worker envelopes always carry correlation identity; follower artifact ingress remains immutable content ingestion while fenced semantic state cannot change.

**Tech Stack:** Node.js 26.5.0, npm 11.13.0 workspaces, TypeScript 7 ESM, Node test runner, AJV JSON Schema, SQLite `node:sqlite`, PostgreSQL 16, WebSocket `ws`, OpenSpec.

## Global Constraints

- Preserve the layer-one boundary: no frontend, HTTP routing, authentication service, business ACL, cache, workflow, scheduler, datasource, or Tego 1.x API.
- Add no dependencies.
- Keep all public generations, revisions, fencing epochs, sequences, and other wire identities canonical unsigned decimal strings; never convert them to JSON numbers.
- Use event-driven assertions, fake/manual clocks, promise gates, process events, or bounded polling helpers; add no fixed sleeps.
- Only the current fenced leader may mutate semantic control-plane state; stale and follower writes must fail closed.
- Immutable content-addressed artifact bytes may be ingested through a trusted local control endpoint before semantic installation is fenced; document the resulting local storage-denial-of-service scope.
- Existing persisted component records without an activation field normalize to activation `"1"`; do not require destructive state migration.
- A suspend recovery stays in the same desired deployment generation but uses a new activation identity; a fail action cannot reactivate until desired generation increases.
- Provider-loss precedence is exactly `fail > suspend > degrade`, independent of manifest requirement order, deployment scan order, or restart.
- `WorkerEnvelope.correlationId` is mandatory: one-way messages and requests self-correlate to their own `messageId`; responses correlate to the triggering request's `messageId`.
- Keep contributor-facing commands and examples executable and data-driven; use one real 64-hex SHA-256 digest in examples.
- Reopen only checklist items whose proof changes in this repair, and reclose them only after their focused and full evidence passes.

---

## File Map

**Canonical contract and closure**

- Modify: `openspec/changes/runtime-kernel-phase-1/specs/capability-resolution/spec.md` — provider binding, precedence, recovery, and restart scenarios.
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/plugin-deployment/spec.md` — activation identity, suspended observation, and fail-generation fencing.
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/worker-protocol/spec.md` — mandatory correlation scenarios.
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/plugin-artifacts/spec.md` — immutable follower ingress and semantic-state fencing scenario.
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/runtime-bootstrap/spec.md` — provider-loss restart recovery scenario.
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/runtime-operations/spec.md` — trusted local endpoint/storage scope and follower behavior.
- Modify: `openspec/changes/runtime-kernel-phase-1/tasks.md` — narrowly reopen and finally reclose affected checklist claims.

**Provider-loss durability and reconciliation**

- Modify: `packages/runtime/src/capabilities/resolver.ts` — resolve against durable prior bindings and reduce loss actions deterministically.
- Modify: `packages/runtime/src/reconcile/plan.ts` — activation-aware stable instance/effect identities and provider-loss planning input.
- Modify: `packages/runtime/src/reconcile/reconciler.ts` — durable automatic bindings, provider-loss state, observed status, lifecycle effects, readiness, and legacy defaulting.
- Modify: `packages/runtime/src/components/component-registry.ts` — include activation in immutable component binding checks.
- Modify: `packages/runtime/src/components/component-effects.ts` — carry activation through lifecycle host bindings.
- Modify: `packages/cli/src/runtime/create-node-runtime-host.ts` — preserve activation when restoring/hosting local and remote components.
- Modify: `packages/runtime/test/capability-resolution.test.ts` — precedence and durable-binding resolver tests.
- Modify: `packages/runtime/test/reconciler.test.ts` — degrade, suspend, fail, activation identity, observation, readiness, and legacy-record tests.
- Modify: `packages/runtime/test/component-effects.test.ts` — activation-aware immutable binding tests.
- Modify: `tests/integration/reconciler-state-stores.test.mjs` — Memory/SQLite persistence and SQLite close/reopen coverage.

**Worker correlation**

- Modify: `packages/contracts/src/worker.ts` — mandatory `WorkerEnvelope.correlationId`.
- Modify: `packages/contracts/src/schema.ts` — require and parse correlation identity.
- Modify: `packages/contracts/test/contracts.test.ts` — strict missing-field rejection and wire round trip.
- Modify: `packages/transport-websocket/src/remote-protocol.ts` — mandatory public session-message correlation types.
- Modify: `packages/transport-websocket/src/session.ts` — self-correlation and response correlation.
- Modify: `packages/transport-websocket/test/session.test.ts` — raw envelope and request/response behavior.
- Modify: `packages/transport-websocket/test/remote-test-support.ts` — mandatory fixture correlation.
- Modify: `packages/transport-websocket/test/remote-executor.test.ts` — updated correlated fixtures.
- Modify: `packages/transport-websocket/test/reconnect.test.ts` — updated correlated fixtures and reconnect assertions.
- Modify: `packages/testkit/src/worker-suite.ts` — public conformance contract.
- Modify: `packages/testkit/test/public-suites.test.ts` — public-only mandatory correlation evidence.
- Modify: `packages/testkit/test/worker-session-legacy-compatibility.ts` — replace optional-correlation legacy shape with protocol-1.0 mandatory shape.
- Modify: `tests/fixtures/runtime-fault-session.mjs` — self-correlated fault-session messages.

**Follower ingress and documentation**

- Modify: `tests/e2e/single-main-process.test.mjs` — black-box follower install-path evidence and semantic snapshot comparison.
- Modify: `packages/cli/test/control.test.ts` — local ingress ordering and trusted-endpoint boundary tests.
- Modify: `docs/architecture/runtime-kernel.md` — correct remote attempt, thread/event-loop, provider-loss, and correlation wording.
- Modify: `docs/operations/deployment-topologies.md` — follower immutable ingress and operational fencing scope.
- Modify: `docs/security/threat-model.md` — Unix `0600`, Windows ACL limitation, and trusted local storage-DoS boundary.
- Modify: `docs/guides/contributing-and-plugins.md` — valid digest example and exact command/protocol/state claims.
- Modify: `tests/architecture/documentation.test.mjs` — table-driven documentation contract assertions.

### Task 1: Restore Canonical OpenSpec and Checklist Truth

**Files:**
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/capability-resolution/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/plugin-deployment/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/worker-protocol/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/plugin-artifacts/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/runtime-bootstrap/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/specs/runtime-operations/spec.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/tasks.md`

**Interfaces:**
- Consumes: Current phase-one OpenSpec requirements and the architecture-review repair list.
- Produces: Normative `@spec:` scenario slugs for all later tests and a truthful set of reopened checklist items.

- [ ] **Step 1: Reopen only the affected checklist evidence**

Change these entries from `[x]` to `[ ]`: `2.4`, `2.5`, `4.3`, `4.4`, `4.5`, `5.3`, `6.2`, `6.4`, `7.2`, `7.3`, `7.5`, `7.6`, `9.1`, `10.3`, `10.4`, `11.3`, `11.7`, `12.1`, and `12.2`. Leave `12.3` closed because the release command itself is unchanged, and leave `12.4`–`12.6` in their current open state.

- [ ] **Step 2: Add the provider-loss normative scenarios**

Add explicit scenarios with these exact outcomes:

```markdown
#### Scenario: Automatic binding survives provider loss and restart
- **WHEN** a ready consumer was automatically bound to the only compatible provider and that provider becomes unavailable or Main restarts
- **THEN** the persisted binding remains authoritative and the consumer does not silently rebind to another provider

#### Scenario: Multiple provider losses use deterministic precedence
- **WHEN** one ready consumer simultaneously loses requirements declaring `degrade`, `suspend`, and `fail`
- **THEN** the reconciler applies one deployment action using `fail` before `suspend` before `degrade`, independent of requirement order

#### Scenario: Degraded provider recovers
- **WHEN** a consumer degraded for provider loss observes its persisted provider ready again
- **THEN** the same component activation returns to `ready` and application readiness is recomputed

#### Scenario: Suspended provider recovers
- **WHEN** a suspended consumer's persisted provider becomes ready again
- **THEN** the reconciler starts a new activation in the same desired generation after the prior activation has drained and stopped

#### Scenario: Failed provider recovers
- **WHEN** a consumer failed for provider loss and the provider becomes ready without a desired deployment change
- **THEN** the consumer remains failed and stopped until a higher desired generation is persisted
```

In `plugin-deployment/spec.md`, state that activation is a persisted unsigned decimal string scoped within `(applicationId, pluginId, componentId, generation)`, observations may be `suspended`, and activation participates in stable instance, operation, and message identities.

- [ ] **Step 3: Add Worker and follower-ingress normative scenarios**

Add these contract outcomes:

```markdown
#### Scenario: One-way message self-correlates
- **WHEN** either peer sends a one-way or request envelope
- **THEN** `correlationId` equals that envelope's `messageId`

#### Scenario: Response correlates to request
- **WHEN** a peer sends a response to a received request
- **THEN** the response `correlationId` equals the request `messageId`

#### Scenario: Missing correlation identity
- **WHEN** a peer sends a protocol-1.0 envelope without `correlationId`
- **THEN** the receiver rejects the envelope as an invalid protocol message

#### Scenario: Follower receives immutable artifact ingress
- **WHEN** a trusted local client sends `plugin install <path>` to a multi-Main follower
- **THEN** content-addressed artifact bytes may be ingested, installation and deployment records do not change, and the operation returns a not-leader diagnostic
```

Also specify that local endpoint access is trusted, Unix sockets are owner-only `0600` under an owner-private directory, built-in Windows named pipes have no implemented ACL hardening, and admitted immutable bytes can consume shared artifact storage.

- [ ] **Step 4: Validate RED OpenSpec/checklist state**

Run: `npm run openspec:validate`

Expected: PASS for the expanded canonical scenarios; repository release closure remains intentionally incomplete because the affected task boxes are open.

- [ ] **Step 5: Commit the contract correction**

```bash
git add openspec/changes/runtime-kernel-phase-1
git commit -m "spec: repair phase one runtime contracts"
```

### Task 2: Persist Automatic Capability Bindings and Normalize Legacy State

**Files:**
- Modify: `packages/runtime/src/capabilities/resolver.ts`
- Modify: `packages/runtime/src/reconcile/reconciler.ts`
- Modify: `packages/runtime/test/capability-resolution.test.ts`
- Modify: `packages/runtime/test/reconciler.test.ts`
- Modify: `tests/integration/reconciler-state-stores.test.mjs`

**Interfaces:**
- Consumes: `PreviousCapabilityBinding`, `ResolvedCapabilityBinding`, `StateStore`, and `PluginDeployment.capabilityBindings`.
- Produces:

```ts
interface PersistedCapabilityBinding extends JsonObject {
  readonly consumer: PluginDeploymentIdentity;
  readonly capability: CapabilityName;
  readonly provider: PluginDeploymentIdentity;
  readonly source: "automatic" | "explicit";
  readonly deploymentGeneration: Generation;
  readonly updatedAt: string;
}

function capabilityBindingKey(
  consumer: PluginDeploymentIdentity,
  capability: CapabilityName,
): StateKey<PersistedCapabilityBinding>;
```

Records live in namespace `tego`, collection `capability-bindings`, keyed by `${applicationId}/${pluginId}/${capability}`.

- [ ] **Step 1: Write RED resolver tests for a durable automatic binding**

Add a test proving that `previousBindings` keeps provider A selected when provider B later becomes ready, and that loss decisions still name A. Use `parseGeneration("1")` only in reconciler persistence tests; resolver identities remain `PluginDeploymentIdentity`.

- [ ] **Step 2: Run the resolver RED test**

Run: `npm run build --workspace @tegojs/runtime && node --test --test-name-pattern="persisted automatic binding" packages/runtime/dist/test/capability-resolution.test.js`

Expected: FAIL because the resolver currently treats only explicit desired bindings as previous bindings and may select a newly ready provider.

- [ ] **Step 3: Make prior bindings authoritative during resolution**

Add a lookup keyed by consumer/capability and select in this order:

```ts
const persisted = previousByRequirement.get(`${identityKey(consumer.identity)}/${requirement.name}`);
const explicit = ownBinding(consumer.bindings, requirement.name);
const selectedIdentity = explicit ?? persisted?.provider;
```

Validate a persisted provider's identity and protocol compatibility exactly like an explicit provider. When that persisted provider is unavailable for a previously ready consumer, append a null observed binding plus the provider-loss action and do not emit `CAPABILITY_EXPLICIT_PROVIDER_UNREADY` or `CAPABILITY_REQUIRED_UNAVAILABLE`; the durable loss state drives reconciliation. Preserve explicit desired binding precedence over persisted automatic state.

- [ ] **Step 4: Write RED reconciler tests for durable binding records**

Assert that first convergence persists one `PersistedCapabilityBinding` for the unique automatic provider, repeated wake does not churn its revision, and a second compatible provider does not replace it. Add a legacy-state case where no binding record exists and the first successful resolution creates it.

- [ ] **Step 5: Run the reconciler RED tests**

Run: `npm run build --workspace @tegojs/runtime && node --test --test-name-pattern="automatic capability binding" packages/runtime/dist/test/reconciler.test.js`

Expected: FAIL because `#gateDeployment()` currently reconstructs `previousBindings` only from desired `capabilityBindings` and writes no observed binding state.

- [ ] **Step 6: Persist bindings transactionally and load them before gating**

Add `#loadCapabilityBindings()` and `#persistResolvedBindings()` to `Reconciler`. Persist only bindings whose provider is non-null; mark desired bindings `explicit` and resolver-selected bindings `automatic`. Use expected revision, fencing from `#transactionOptions()`, canonical sorted writes, and delete only records whose consumer desired generation changed or whose requirement no longer exists.

- [ ] **Step 7: Add Memory/SQLite state-store evidence**

Extend `withRealStateStores()` with a scenario that converges provider/consumer, reconstructs a new `Reconciler` over the same Memory store, and for SQLite closes/reopens `SqliteStateStore` at the same `databasePath`. Assert the binding record survives and provider B is not substituted.

- [ ] **Step 8: Run GREEN focused persistence tests**

Run: `npm run build && node --test --test-name-pattern="automatic capability binding|binding survives" packages/runtime/dist/test/capability-resolution.test.js packages/runtime/dist/test/reconciler.test.js tests/integration/reconciler-state-stores.test.mjs`

Expected: PASS with both `MemoryStateStore` and `SqliteStateStore` subtests green.

- [ ] **Step 9: Commit durable binding state**

```bash
git add packages/runtime/src/capabilities/resolver.ts packages/runtime/src/reconcile/reconciler.ts packages/runtime/test/capability-resolution.test.ts packages/runtime/test/reconciler.test.ts tests/integration/reconciler-state-stores.test.mjs
git commit -m "fix(runtime): persist automatic capability bindings"
```

### Task 3: Apply Provider-Loss Precedence and Degrade Restoration

**Files:**
- Modify: `packages/runtime/src/capabilities/resolver.ts`
- Modify: `packages/runtime/src/reconcile/reconciler.ts`
- Modify: `packages/runtime/test/capability-resolution.test.ts`
- Modify: `packages/runtime/test/reconciler.test.ts`

**Interfaces:**
- Consumes: Durable bindings from Task 2 and `ProviderLossDecision`.
- Produces:

```ts
type ProviderLossAction = "degrade" | "fail" | "suspend";

interface PersistedProviderLoss extends JsonObject {
  readonly consumer: PluginDeploymentIdentity;
  readonly deploymentGeneration: Generation;
  readonly action: ProviderLossAction;
  readonly capabilities: readonly CapabilityName[];
  readonly providers: readonly PluginDeploymentIdentity[];
  readonly updatedAt: string;
}

function strongestProviderLoss(
  actions: readonly ProviderLossDecision[],
): ProviderLossAction | undefined;
```

Provider-loss records live in collection `provider-loss`, keyed by `${applicationId}/${pluginId}`.

- [ ] **Step 1: Write RED precedence tests**

Cover every permutation of `degrade`, `suspend`, and `fail`, asserting `strongestProviderLoss()` returns `fail`; cover `degrade` plus `suspend`, asserting `suspend`; assert capabilities/providers are stored in lexical identity order.

- [ ] **Step 2: Run the precedence RED test**

Run: `npm run build --workspace @tegojs/runtime && node --test --test-name-pattern="provider loss precedence" packages/runtime/dist/test/capability-resolution.test.js`

Expected: FAIL because no deployment-level precedence reducer exists.

- [ ] **Step 3: Implement the deterministic reducer**

Use an explicit rank, never enum/lexical order:

```ts
const providerLossRank: Readonly<Record<ProviderLossAction, number>> = {
  degrade: 1,
  suspend: 2,
  fail: 3,
};
```

Return the maximum rank after sorting diagnostic evidence independently.

- [ ] **Step 4: Write RED degrade/recovery reconciliation tests**

Start a ready essential consumer, make its persisted provider unavailable, and assert:

```ts
assert.equal(instance.lifecycle, "degraded");
assert.equal(observation.status, "degraded");
assert.equal(reconciler.applicationReady(), false);
```

Restore the same provider and assert the same `instanceId` returns to `ready`, the loss record is removed with expected-revision fencing, observation becomes `ready`, and readiness becomes true.

- [ ] **Step 5: Run the degrade RED tests**

Run: `npm run build --workspace @tegojs/runtime && node --test --test-name-pattern="degrade.*provider|provider.*degrade" packages/runtime/dist/test/reconciler.test.js`

Expected: FAIL because `providerLossActions` are currently calculated but never reconciled.

- [ ] **Step 6: Reconcile degrade as observed component state**

Persist `PersistedProviderLoss`, transition every ready consumer instance through `transitionComponentLifecycle(instance.lifecycle, "degraded")`, and transition `degraded` back to `ready` only after the durable provider binding is ready again. Do not emit drain/stop effects for degrade.

- [ ] **Step 7: Run GREEN resolver and degrade tests**

Run: `npm run build --workspace @tegojs/runtime && node --test --test-name-pattern="provider loss precedence|degrade.*provider|provider.*degrade" packages/runtime/dist/test/capability-resolution.test.js packages/runtime/dist/test/reconciler.test.js`

Expected: PASS with deterministic action and readiness restoration.

- [ ] **Step 8: Commit precedence and degrade recovery**

```bash
git add packages/runtime/src/capabilities/resolver.ts packages/runtime/src/reconcile/reconciler.ts packages/runtime/test/capability-resolution.test.ts packages/runtime/test/reconciler.test.ts
git commit -m "fix(runtime): reconcile degraded provider loss"
```

### Task 4: Add Activation-Aware Suspend Drain, Hold, and Reactivation

**Files:**
- Modify: `packages/runtime/src/reconcile/plan.ts`
- Modify: `packages/runtime/src/reconcile/reconciler.ts`
- Modify: `packages/runtime/src/components/component-registry.ts`
- Modify: `packages/runtime/src/components/component-effects.ts`
- Modify: `packages/cli/src/runtime/create-node-runtime-host.ts`
- Modify: `packages/runtime/test/reconciler.test.ts`
- Modify: `packages/runtime/test/component-effects.test.ts`
- Modify: `tests/integration/reconciler-state-stores.test.mjs`

**Interfaces:**
- Consumes: `Generation`, `ReconcileEffect`, `ComponentInstance`, and Task 3 provider-loss state.
- Produces:

```ts
type Activation = string;

interface ComponentInstance {
  readonly activation: Activation;
}

interface ReconcileEffect {
  readonly activation: Activation;
}

function reconcileEffectIdentities(
  deployment: Pick<PluginDeployment, "applicationId" | "generation" | "pluginId">,
  componentId: ComponentId,
  kind: ReconcileEffectKind,
  activation?: Activation,
): {
  readonly instanceId: string;
  readonly operationId: OperationId;
  readonly messageId: MessageId;
};
```

The default `activation` is `"1"` for source compatibility and legacy persisted records. Identity parts include `a${activation}` after `g${generation}`.

- [ ] **Step 1: Write RED activation identity and legacy-default tests**

Assert generation `"7"` activation `"1"` and activation `"2"` produce different instance/operation/message identities. Insert a persisted component record without `activation` and assert load normalizes it to `"1"` without changing its existing generation.

- [ ] **Step 2: Run the activation RED tests**

Run: `npm run build --workspace @tegojs/runtime && node --test --test-name-pattern="activation identity|legacy activation" packages/runtime/dist/test/reconciler.test.js`

Expected: FAIL because identities currently contain only application, plugin, component, generation, and effect kind.

- [ ] **Step 3: Carry activation through all immutable bindings**

Add `activation` to `PersistedComponentInstance`, parsed `ReconcileEffect`, component registry bindings, component effect host bindings, restoration checks, and local/remote component host construction. Validate it with the same canonical unsigned-decimal rule used for generations; do not parse it as a number.

- [ ] **Step 4: Write RED suspend lifecycle tests**

Prove this exact sequence using effect gates rather than timers:

```text
activation 1 ready
provider loss -> drain activation 1
drain complete -> stop activation 1
stop complete -> deployment observation suspended
provider remains unavailable -> no prepare/start
provider recovers -> prepare activation 2 -> start activation 2 -> ready
```

Assert desired generation never changes, activation 1 stays stopped, activation 2 has a different stable identity, and an essential suspended deployment is not application-ready.

- [ ] **Step 5: Run the suspend RED tests**

Run: `npm run build && node --test --test-name-pattern="suspend.*activation|suspended provider" packages/runtime/dist/test/reconciler.test.js packages/runtime/dist/test/component-effects.test.js`

Expected: FAIL because suspend actions are ignored and generation-only completed operation IDs prevent same-generation reactivation.

- [ ] **Step 6: Implement suspend drain/stop/hold/reactivation**

When strongest action is `suspend`, plan existing instances through drain then stop. Record `DeploymentObservation.status` as `"suspended"` only after all current activation instances are stopped. While the bound provider is unavailable, plan no current-generation prepare. On recovery, compute the next activation with decimal-string increment:

```ts
function nextActivation(current: string): string {
  return (BigInt(current) + 1n).toString();
}
```

Persist the new activation before enqueueing its prepare effect in the same fenced transaction.

- [ ] **Step 7: Add Memory/SQLite restart-at-hold evidence**

Stop the first `Reconciler` after activation 1 reaches suspended hold, recreate it on Memory, and close/reopen SQLite before recreating it. Assert no premature activation starts; after provider recovery, each store starts exactly activation 2 once.

- [ ] **Step 8: Run GREEN suspend and persistence tests**

Run: `npm run build && node --test --test-name-pattern="activation identity|legacy activation|suspend.*activation|suspended provider" packages/runtime/dist/test/reconciler.test.js packages/runtime/dist/test/component-effects.test.js tests/integration/reconciler-state-stores.test.mjs`

Expected: PASS without fixed sleeps and with identical Memory/SQLite behavior.

- [ ] **Step 9: Commit activation-aware suspension**

```bash
git add packages/runtime/src/reconcile/plan.ts packages/runtime/src/reconcile/reconciler.ts packages/runtime/src/components/component-registry.ts packages/runtime/src/components/component-effects.ts packages/cli/src/runtime/create-node-runtime-host.ts packages/runtime/test/reconciler.test.ts packages/runtime/test/component-effects.test.ts tests/integration/reconciler-state-stores.test.mjs
git commit -m "fix(runtime): reactivate suspended consumers safely"
```

### Task 5: Enforce Fail Drain/Stop and New-Generation Recovery

**Files:**
- Modify: `packages/runtime/src/reconcile/reconciler.ts`
- Modify: `packages/runtime/test/reconciler.test.ts`
- Modify: `tests/integration/reconciler-state-stores.test.mjs`

**Interfaces:**
- Consumes: Task 3 precedence and Task 4 activation identities.
- Produces: Durable fail hold for one desired generation and readiness behavior for essential/non-essential consumers.

- [ ] **Step 1: Write RED fail lifecycle tests**

Prove `ready -> draining -> stopping -> stopped`, then assert observation `failed`, structured diagnostic code `CAPABILITY_PROVIDER_LOST`, and no reactivation when the provider returns at the same generation. Increment desired generation and assert activation resets to `"1"` for the new generation and converges.

- [ ] **Step 2: Add mixed-policy RED tests**

Create one consumer with requirements ordered `[degrade, suspend, fail]` and another ordered `[fail, degrade, suspend]`. Assert both perform only fail drain/stop, neither briefly publishes `degraded` or `suspended`, and both remain stopped after restart.

- [ ] **Step 3: Run the fail RED tests**

Run: `npm run build --workspace @tegojs/runtime && node --test --test-name-pattern="failed provider loss|mixed provider loss" packages/runtime/dist/test/reconciler.test.js`

Expected: FAIL because provider-loss fail is not applied to lifecycle or desired-generation gating.

- [ ] **Step 4: Implement fail hold and generation release**

Persist loss generation with the fail record. Drain/stop the current activation, publish `failed`, and reject prepare/start planning while `deployment.generation === loss.deploymentGeneration`. When a higher desired generation is observed, delete the stale loss record transactionally and reconcile the new generation normally.

- [ ] **Step 5: Add restart/readiness coverage**

For Memory and reopened SQLite, assert fail hold survives reconstruction. Essential failed consumers make `applicationReady()` false; non-essential failed consumers do not make application readiness false when all essential deployments are ready.

- [ ] **Step 6: Run GREEN provider-loss matrix**

Run: `npm run build && node --test --test-name-pattern="provider loss|suspend|degrade|failed provider|mixed provider|binding survives" packages/runtime/dist/test/capability-resolution.test.js packages/runtime/dist/test/reconciler.test.js tests/integration/reconciler-state-stores.test.mjs`

Expected: PASS for degrade restoration, suspend same-generation activation, fail new-generation requirement, precedence, and Memory/SQLite restart.

- [ ] **Step 7: Commit fail fencing**

```bash
git add packages/runtime/src/reconcile/reconciler.ts packages/runtime/test/reconciler.test.ts tests/integration/reconciler-state-stores.test.mjs
git commit -m "fix(runtime): fence failed consumers by generation"
```

### Task 6: Make Worker Correlation Mandatory End to End

**Files:**
- Modify: `packages/contracts/src/worker.ts`
- Modify: `packages/contracts/src/schema.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/transport-websocket/src/remote-protocol.ts`
- Modify: `packages/transport-websocket/src/session.ts`
- Modify: `packages/transport-websocket/test/session.test.ts`

**Interfaces:**
- Consumes: `MessageId`, `WorkerEnvelope`, `WorkerSession.send()`, and `WorkerSession.request()`.
- Produces:

```ts
export interface WorkerEnvelope<T extends JsonValue = JsonValue> extends JsonObject {
  readonly correlationId: MessageId;
}

export interface RemoteSessionMessage {
  readonly correlationId: string;
}

export interface WorkerSessionMessage {
  readonly correlationId: string;
}
```

`send(type, payload)` self-correlates; `send(type, payload, { correlationId })` is a response; `request(type, payload)` sends a self-correlated request and waits for a response correlated to its `messageId`.

- [ ] **Step 1: Write RED schema and type-contract tests**

Remove `correlationId` from an otherwise valid protocol-1.0 envelope and assert `parseWorkerEnvelope()` rejects it. Round-trip an envelope whose `sequence` is `"18446744073709551615"` and correlation is a valid message ID.

- [ ] **Step 2: Run the contract RED tests**

Run: `npm run build --workspace @tegojs/contracts && node --test --test-name-pattern="correlation" packages/contracts/dist/test/contracts.test.js`

Expected: FAIL because `correlationId` is optional in the interface and absent from JSON Schema `required`.

- [ ] **Step 3: Require correlation in the public wire schema**

Add `"correlationId"` to `workerEnvelopeSchema.required`, make the TypeScript property non-optional, and preserve `parseMessageId()` validation. Do not alter decimal-string sequence handling.

- [ ] **Step 4: Write RED session behavior tests**

Inspect raw sent control frames and assert:

```ts
assert.equal(oneWay.correlationId, oneWay.messageId);
assert.equal(request.correlationId, request.messageId);
assert.equal(response.correlationId, request.messageId);
```

Inject a raw envelope without correlation and assert close diagnostic `PROTOCOL_MESSAGE_INVALID`.

- [ ] **Step 5: Run the session RED tests**

Run: `npm run build --workspace @tegojs/transport-websocket && node --test --test-name-pattern="self-correlates|missing correlation|response correlates" packages/transport-websocket/dist/test/session.test.js`

Expected: FAIL because `#sendEnvelope()` currently omits correlation when options do not provide it.

- [ ] **Step 6: Implement sender self-correlation and response correlation**

Construct every envelope with:

```ts
correlationId: parseMessageId(options.correlationId ?? messageId),
```

Keep pending requests keyed by the request `messageId`; incoming self-correlated one-way messages must not resolve an unrelated pending request. A response uses the caller-supplied triggering `messageId`.

- [ ] **Step 7: Run GREEN contract/session tests**

Run: `npm run build && node --test --test-name-pattern="correlation|self-correlates|missing correlation|response correlates" packages/contracts/dist/test/contracts.test.js packages/transport-websocket/dist/test/session.test.js`

Expected: PASS with strict missing-field rejection and mandatory correlation on all control envelopes.

- [ ] **Step 8: Commit the protocol contract**

```bash
git add packages/contracts/src/worker.ts packages/contracts/src/schema.ts packages/contracts/test/contracts.test.ts packages/transport-websocket/src/remote-protocol.ts packages/transport-websocket/src/session.ts packages/transport-websocket/test/session.test.ts
git commit -m "fix(protocol): require worker correlation identity"
```

### Task 7: Update Public TestKit, Fixtures, and Transport Consumers

**Files:**
- Modify: `packages/transport-websocket/test/remote-test-support.ts`
- Modify: `packages/transport-websocket/test/remote-executor.test.ts`
- Modify: `packages/transport-websocket/test/reconnect.test.ts`
- Modify: `packages/testkit/src/worker-suite.ts`
- Modify: `packages/testkit/test/public-suites.test.ts`
- Modify: `packages/testkit/test/worker-session-legacy-compatibility.ts`
- Modify: `tests/fixtures/runtime-fault-session.mjs`

**Interfaces:**
- Consumes: Mandatory `WorkerSessionMessage.correlationId` from Task 6.
- Produces: Public third-party Worker conformance proof with no private imports and correlated fixture traffic.

- [ ] **Step 1: Write RED public-suite assertions**

In `worker-suite.ts`, require the first one-way message's `correlationId` to equal its `messageId`, then send a response with `{ correlationId: message.messageId }` and assert the receiver observes that request identity.

- [ ] **Step 2: Run the public testkit RED tests**

Run: `npm run build && node --test packages/testkit/dist/test/public-suites.test.js`

Expected: FAIL or TypeScript compile errors because public fixtures still expose optional correlation.

- [ ] **Step 3: Update every fixture at the message construction boundary**

Replace conditional spreads with mandatory values:

```ts
correlationId: options.correlationId ?? messageId,
```

For hand-authored inbound responses, set `correlationId` to the triggering request `messageId`; for hand-authored one-way messages, set it to that envelope's own `messageId`.

- [ ] **Step 4: Remove misleading protocol-1.0 legacy compatibility**

Rename the legacy fixture/test description so it covers accepted public session adapters, not an optional-correlation wire shape. Protocol `1.0` has one strict mandatory-correlation contract; do not add downgrade logic.

- [ ] **Step 5: Run GREEN transport and public suites**

Run: `npm run build && node --test packages/transport-websocket/dist/test/*.test.js packages/testkit/dist/test/*.test.js`

Expected: PASS with no optional `correlationId` TypeScript surfaces and no fixture bypass.

- [ ] **Step 6: Commit fixture and testkit repair**

```bash
git add packages/transport-websocket/test packages/testkit/src/worker-suite.ts packages/testkit/test tests/fixtures/runtime-fault-session.mjs
git commit -m "test(protocol): enforce public correlation contract"
```

### Task 8: Prove Follower Immutable Artifact Ingress Is Semantically Fenced

**Files:**
- Modify: `tests/e2e/single-main-process.test.mjs`
- Modify: `packages/cli/test/control.test.ts`

**Interfaces:**
- Consumes: Real two-Main PostgreSQL process harness, `plugin install <path>`, `runtime snapshot`, and the existing local `plugin.install-path` dispatch.
- Produces: Black-box evidence that follower ingress may write immutable bytes but cannot create installation/deployment semantic records.

- [ ] **Step 1: Write a RED black-box follower ingress assertion**

In the real two-Main test, first call an intentionally not-yet-defined `semanticSnapshotItems(snapshot)` test helper so the new black-box scenario has a genuine RED boundary. Capture the follower's paged runtime snapshot, invoke:

```js
await runCli([
  "plugin",
  "install",
  artifactPath,
  "--endpoint",
  follower.candidate.configuration.endpoint,
  "--json",
]);
```

Assert the command rejects with `COORDINATION_NOT_LEADER`, then recapture both follower and leader snapshots and compare semantic collections `installations`, `deployments`, `instances`, `operations`, and `tasks` after removing pagination cursors only. Do not inspect PostgreSQL tables or driver internals.

- [ ] **Step 2: Run the multi-Main RED test**

Run: `npm run test:e2e:multi-main`

Expected: FAIL with `ReferenceError: semanticSnapshotItems is not defined`.

- [ ] **Step 3: Implement the semantic snapshot helper and add a focused control dispatch ordering test**

Add this test-only helper:

```js
function semanticSnapshotItems(snapshot) {
  return Object.fromEntries(
    ["installations", "deployments", "instances", "operations", "tasks"].map((collection) => [
      collection,
      snapshot[collection].items,
    ]),
  );
}
```

Use a fake `LocalArtifactIngress` that records `putPath`, and a fake `installPlugin` that returns `COORDINATION_NOT_LEADER`. Assert ingress occurs once, installation returns the fencing error, and no fake semantic state collection changes. This locks the intended immutable-ingress boundary instead of incorrectly promising pre-ingress authority rejection.

- [ ] **Step 4: Run GREEN ingress tests**

Run: `npm run build --workspace @tegojs/cli && node --test --test-name-pattern="follower|artifact ingress" packages/cli/dist/test/control.test.js`

Expected: PASS and explicitly demonstrate `putPath` may precede the semantic fencing rejection.

- [ ] **Step 5: Run GREEN black-box system evidence**

Run: `npm run test:e2e:multi-main`

Expected: PASS with a follower not-leader diagnostic and byte-for-byte-equal serialized semantic snapshot items before/after the rejected install.

- [ ] **Step 6: Commit follower ingress evidence**

```bash
git add packages/cli/test/control.test.ts tests/e2e/single-main-process.test.mjs
git commit -m "test(runtime): fence follower artifact installation"
```

### Task 9: Correct Documentation and Make Assertions Data-Driven

**Files:**
- Modify: `docs/architecture/runtime-kernel.md`
- Modify: `docs/operations/deployment-topologies.md`
- Modify: `docs/security/threat-model.md`
- Modify: `docs/guides/contributing-and-plugins.md`
- Modify: `tests/architecture/documentation.test.mjs`

**Interfaces:**
- Consumes: Implemented state machines, `WorkerEnvelope`, `startControlServer()`, CLI parser, and Task 8 ingress behavior.
- Produces: Exact operator claims locked to data tables rather than broad marker searches.

- [ ] **Step 1: Write RED data-driven documentation assertions**

Replace broad command/protocol/state marker loops with tables shaped as:

```js
const documentedContracts = [
  {
    document: "architecture",
    required: [
      "terminal -> expired",
      "correlation ID",
      "Worker Thread has its own event loop",
    ],
  },
  {
    document: "security",
    required: [
      "no application-layer authentication",
      "0600",
      "Windows named-pipe ACL hardening is not implemented",
    ],
  },
  {
    document: "operations",
    required: ["immutable artifact bytes", "COORDINATION_NOT_LEADER", "storage denial of service"],
  },
];
```

Add an exact command inventory derived from current CLI surface and a regex requiring `sha256:[0-9a-f]{64}` while rejecting the current non-hex digest sentinel.

- [ ] **Step 2: Run the documentation RED test**

Run: `node --test tests/architecture/documentation.test.mjs`

Expected: FAIL on current `unknown -> expired`, optional correlation wording, missing `0600`/Windows limitation, non-hex digest sentinel, and missing storage-DoS statement.

- [ ] **Step 3: Correct remote attempt and thread wording**

Document the actual retention transition as `terminal -> expired`; `unknown` remains non-terminal reconciliation state and does not directly expire. State that a Worker Thread has its own JavaScript event loop/thread while sharing the Main process, address space, privileges, and process-wide resources; do not say it runs on the Main JavaScript event loop.

- [ ] **Step 4: Correct local-control security and follower ingress wording**

State:

```text
The local control protocol has no application-layer authentication and relies on operating-system access to its endpoint.
On Unix, startup verifies an owner-private parent directory and applies mode 0600 to the socket.
The built-in Windows named-pipe path has no implemented ACL hardening; operators must provide an OS deployment boundary.
The endpoint is trusted. A follower may admit content-addressed immutable bytes before semantic installation is rejected, so an authorized local client can consume artifact storage even though it cannot mutate installations or deployments.
```

- [ ] **Step 5: Replace the non-executable digest sentinel and align protocol claims**

Use:

```text
sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Document correlation as mandatory, with self-correlation for one-way/request and request correlation for responses. Keep exact CLI names currently accepted by `parse-command.ts`.

- [ ] **Step 6: Run GREEN documentation tests**

Run: `node --test tests/architecture/documentation.test.mjs tests/architecture/readme.test.mjs`

Expected: PASS with per-document data-driven state, protocol, security, and command assertions.

- [ ] **Step 7: Commit documentation corrections**

```bash
git add docs/architecture/runtime-kernel.md docs/operations/deployment-topologies.md docs/security/threat-model.md docs/guides/contributing-and-plugins.md tests/architecture/documentation.test.mjs
git commit -m "docs: correct phase one runtime contracts"
```

### Task 10: Focused Verification, Full Verification, and Checklist Reclosure

**Files:**
- Modify: `openspec/changes/runtime-kernel-phase-1/tasks.md`

**Interfaces:**
- Consumes: All focused evidence from Tasks 2–9.
- Produces: Reclosed affected checklist claims and release-review evidence ready for `12.5`; does not close `12.4`, `12.5`, or `12.6`.

- [ ] **Step 1: Run contract and provider-loss focused verification**

Run:

```bash
npm run build
node --test packages/contracts/dist/test/contracts.test.js
node --test packages/runtime/dist/test/capability-resolution.test.js packages/runtime/dist/test/reconciler.test.js packages/runtime/dist/test/component-effects.test.js
node --test tests/integration/reconciler-state-stores.test.mjs
```

Expected: PASS with mandatory correlation, durable bindings, precedence, degrade restoration, suspend activation, fail generation fencing, and Memory/SQLite restart.

- [ ] **Step 2: Run transport, testkit, ingress, and docs focused verification**

Run:

```bash
node --test packages/transport-websocket/dist/test/*.test.js
node --test packages/testkit/dist/test/*.test.js
node --test packages/cli/dist/test/control.test.js
node --test tests/architecture/documentation.test.mjs tests/architecture/readme.test.mjs
npm run test:e2e:multi-main
npm run openspec:validate
```

Expected: PASS with public fixture compatibility, follower semantic-state no-mutation, exact docs claims, and valid canonical OpenSpec.

- [ ] **Step 3: Run the full repository verification**

Run: `npm run verify`

Expected: PASS for format, lint, build, typecheck, unit, architecture, local integration, and single-Main E2E.

- [ ] **Step 4: Run release preflight**

Run: `npm run verify:release -- --preflight`

Expected: PASS for clean-install/release-preflight gates available locally; PostgreSQL-authoritative CI remains part of review closure.

- [ ] **Step 5: Reclose only the repaired checklist items**

Change `2.4`, `2.5`, `4.3`, `4.4`, `4.5`, `5.3`, `6.2`, `6.4`, `7.2`, `7.3`, `7.5`, `7.6`, `9.1`, `10.3`, `10.4`, `11.3`, `11.7`, `12.1`, and `12.2` back to `[x]`, appending concise evidence references where the existing checklist style already uses them. Leave `12.4`, `12.5`, and `12.6` open.

- [ ] **Step 6: Revalidate the reclosed canonical checklist**

Run: `npm run openspec:validate`

Expected: PASS with no affected implementation claim left open and no unrelated closure changed.

- [ ] **Step 7: Commit checklist reclosure**

```bash
git add openspec/changes/runtime-kernel-phase-1/tasks.md
git commit -m "docs: reclose phase one repair evidence"
```

## Acceptance Criteria

- Canonical OpenSpec explicitly covers durable automatic binding, provider-loss precedence, degrade/recover, suspend/recover, fail/new-generation, restart, mandatory Worker correlation, and follower immutable ingress.
- Automatic bindings and provider-loss state survive Memory-state reconstruction and SQLite close/reopen.
- Provider-loss behavior is deterministic: `fail > suspend > degrade`.
- Degrade restores the same activation; suspend drains/stops/holds and starts the next activation in the same desired generation; fail drains/stops and cannot start until a higher desired generation.
- Stable instance, operation, and message identities include activation; legacy persisted instances default to activation `"1"`.
- Essential readiness reflects degraded, suspended, and failed observations; non-essential failure does not incorrectly make application readiness false.
- Every protocol-1.0 Worker envelope has a valid `correlationId`; missing correlation is rejected; public testkit and fixtures expose no optional correlation contract.
- A black-box follower `plugin install <path>` returns not-leader and leaves installations, deployments, instances, operations, and tasks unchanged.
- Documentation states terminal-to-expired retention, correct Worker Thread/event-loop semantics, Unix socket `0600`, the Windows named-pipe ACL limitation, trusted local artifact-storage DoS scope, mandatory correlation, and a valid 64-hex digest.
- Focused tests, `npm run verify`, `npm run verify:release -- --preflight`, and `npm run openspec:validate` pass before affected checklist items are reclosed.

## Risks and Controls

- **Risk: automatic binding persistence mutates desired deployment state.** Keep explicit desired `capabilityBindings` unchanged and store automatic bindings in the separate observed `capability-bindings` collection.
- **Risk: same-generation suspension reuses completed lifecycle messages.** Include activation in instance, operation, and message identities and increment activation as a decimal string.
- **Risk: action order changes across scans.** Reduce by an explicit numeric precedence table and sort only diagnostic evidence.
- **Risk: legacy records become unreadable.** Normalize missing activation to `"1"` at the reconciliation load boundary and prove restart against existing-shape records.
- **Risk: self-correlated one-way messages resolve requests accidentally.** Pending requests remain keyed by request message ID, and only a received response matching a pending key resolves it; tests cover unrelated self-correlation.
- **Risk: follower ingress is mistaken for an authenticated upload API.** Keep the endpoint explicitly trusted and document immutable-storage exhaustion as an operator-controlled threat.
- **Risk: reclosure overstates release readiness.** Reclose only the listed affected tasks; keep `12.4`, `12.5`, and `12.6` open until their independent review/release requirements are satisfied.

## Stop Conditions

- Stop implementation if existing persisted activation cannot be normalized without changing an already-published stable identity; resolve identity compatibility before enqueueing new lifecycle effects.
- Stop reclosure if either Memory or SQLite restart coverage fails, if any missing-correlation envelope is accepted, or if follower semantic snapshot items change.
- Do not close `12.5` from this plan; hand the green repair commits and verification output back to the architecture/API/security/concurrency/failure-recovery review.
