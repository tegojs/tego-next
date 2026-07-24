# Runtime Kernel Phase 1 Integration Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Tego Next layer one as a real-process, recoverable single-Main and multi-Main runtime whose authoritative acceptance gates run in GitHub Actions.

**Architecture:** `@tegojs/runtime` remains concrete-environment agnostic and receives generic executor, Worker, and lifecycle boundaries. `@tegojs/cli` is the Node.js composition root that combines runtime, local/PostgreSQL drivers, Node executors, WebSocket transport, and the local control channel. System tests launch independent Main and Worker processes and drive them only through public CLI, control, state, and WebSocket boundaries.

**Tech Stack:** Node.js 26.5.0, npm 11.13.0, TypeScript 7.0.2, ESM, Node test runner, `node:sqlite`, PostgreSQL 16.14, `ws` 8.21.1, GitHub Actions.

## Global Constraints

- Use Node.js `26.5.0`, npm `11.13.0`, TypeScript `7.0.2`, and JavaScript ESM runtime artifacts.
- Every production behavior begins with an OpenSpec-tagged failing test and a verified RED result.
- `@tegojs/runtime` may depend on `@tegojs/contracts`, not concrete driver, executor, transport, example, or CLI packages.
- `@tegojs/cli` is the concrete Node.js composition root and may depend on first-layer packages.
- No HTTP, authentication policy, business ACL, data-source, cache, scheduler, workflow, frontend, Docker/Kubernetes executor, external coordinator, or Tego 1.x compatibility API is added.
- System acceptance uses independent Main and Worker operating-system processes and real TCP/WebSocket sockets.
- Fixed sleeps are prohibited; wait on protocol events or durable predicates under explicit deadlines.
- GitHub Actions is authoritative; local focused tests are feedback, not the release verdict.
- Every spawned process, thread, socket, timer, temporary artifact, and database namespace must be cleaned up or reported as a test failure.
- Use `ws@8.21.1` without `bufferutil` or `utf-8-validate`; disable per-message compression and bound payload size, handshake time, heartbeat time, and connection count.
- Every commit message follows Conventional Commits and passes the repository commitlint configuration.

---

## File Structure

### Contracts and runtime

- `packages/contracts/src/coordination.ts` — leadership handle and loss contract.
- `packages/contracts/src/operations.ts` — typed plugin, deployment, task, and Worker operation requests/results.
- `packages/contracts/src/runtime.ts` — runtime status and operation surface.
- `packages/runtime/src/leadership-controller.ts` — background campaign, loss, reacquisition, and shutdown.
- `packages/runtime/src/runtime-host.ts` — artifact, reconcile, task, Worker, and runtime lifecycle orchestration.
- `packages/runtime/src/runtime-operations.ts` — operation admission and delegation.
- `packages/runtime/src/tasks/task-service.ts` — durable task submission, observation, cancellation, terminal recording, and recovery.
- `packages/runtime/src/components/component-registry.ts` — prepared/active component bindings used by executors.
- `packages/runtime/src/components/component-effects.ts` — `Reconciler` effect adapter.
- `packages/runtime/src/artifacts/prepared-artifact-cache.ts` — safe immutable extraction of validated `.tego` archives.

### Concrete Node composition and control

- `packages/transport-websocket/src/network.ts` — real `ws` listener/connect adapters.
- `packages/cli/src/control/protocol.ts` — bounded NDJSON request/response contracts.
- `packages/cli/src/control/server.ts` — Unix socket/named-pipe control server.
- `packages/cli/src/control/client.ts` — control client.
- `packages/cli/src/runtime/create-node-runtime-host.ts` — concrete drivers, executors, transport, and runtime composition.
- `packages/cli/src/runtime/main-process.ts` — long-running Main process entry.
- `packages/cli/src/worker/worker-process.ts` — long-running Worker process entry.
- `packages/cli/src/commands/*.ts` — runtime, plugin, task, and Worker commands.
- `packages/cli/src/parse-command.ts` — `util.parseArgs` command parser.
- `packages/cli/src/run-cli.ts` — structured command dispatch and output.
- `packages/cli/src/bin.ts` — executable `tego` entry point.

### Tests and CI

- `tests/support/managed-process.mjs` — event-driven child-process harness.
- `tests/support/run-artifacts.mjs` — logs, transcripts, and cleanup reports.
- `tests/fixtures/main-process.mjs` — E2E Main launcher using public CLI exports.
- `tests/fixtures/worker-process.mjs` — E2E Worker launcher using public CLI exports.
- `tests/integration/control-channel.test.mjs` — real Unix socket/named-pipe control tests.
- `tests/integration/websocket-network.test.mjs` — real loopback WebSocket tests.
- `tests/e2e/single-main-process.test.mjs` — all-executor and restart flow.
- `tests/e2e/two-main-postgres.test.mjs` — leader takeover and result uniqueness.
- `.github/workflows/ci.yml` — quality, integration, and system-E2E gates.

---

### Task 1: Real-process test harness and diagnostic evidence

**Files:**
- Create: `tests/support/run-artifacts.mjs`
- Create: `tests/support/managed-process.mjs`
- Create: `tests/integration/process-harness.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `createRunArtifacts(testName)`, `spawnManagedProcess(options)`.
- `ManagedProcess.ready(predicate, options)` consumes newline-delimited JSON events from stdout.
- `ManagedProcess.stop(options)` performs graceful request, `SIGTERM`, then `SIGKILL` under bounded deadlines.
- `ManagedProcess.assertClean()` rejects on non-zero exit, unhandled stream error, or surviving PID.

- [ ] **Step 1: Write the failing process-harness tests**

```js
test("@spec:runtime-operations/ci-authoritative-system-acceptance/actionable-system-test-failure", async () => {
  const artifacts = await createRunArtifacts("managed-process");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: [fixture("json-ready-child.mjs")],
    name: "ready-child",
  });
  const ready = await child.ready((event) => event.type === "ready", { timeoutMs: 2_000 });
  assert.equal(ready.pid, child.pid);
  await child.stop({ timeoutMs: 2_000 });
  await child.assertClean();
  assert.match(await readFile(artifacts.stdout("ready-child"), "utf8"), /"type":"ready"/u);
});

test("managed process reports deadline and preserves logs", async () => {
  const artifacts = await createRunArtifacts("silent-process");
  const child = await spawnManagedProcess({
    artifacts,
    command: process.execPath,
    args: [
      "--eval",
      "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)",
    ],
    name: "silent-child",
  });
  await assert.rejects(child.ready(() => true, { timeoutMs: 50 }), /PROCESS_READY_TIMEOUT/u);
  await child.stop({ timeoutMs: 2_000 });
  assert.equal(await child.artifactsExist(), true);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test tests/integration/process-harness.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tests/support/managed-process.mjs`.

Commit verified RED:

```bash
git add tests/integration/process-harness.test.mjs
git commit -m "test: specify managed process harness"
```

- [ ] **Step 3: Implement artifact and managed-process helpers**

```js
export async function spawnManagedProcess({ artifacts, command, args, env = {}, name }) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new ManagedProcess({ artifacts, child, name });
}

export class ManagedProcess {
  get pid() {
    return this.#child.pid;
  }

  async ready(predicate, { timeoutMs }) {
    return waitForJsonEvent(this.#events, predicate, timeoutMs);
  }

  async stop({ timeoutMs }) {
    if (this.#exit.settled) return;
    this.#child.kill("SIGTERM");
    if (!(await settleWithin(this.#exit.promise, timeoutMs))) {
      this.#child.kill("SIGKILL");
      await this.#exit.promise;
    }
  }

  async assertClean() {
    const exit = await this.#exit.promise;
    if (exit.code !== 0 && exit.signal === null) throw processExitDiagnostic(exit);
    if (this.#child.pid !== undefined && isProcessAlive(this.#child.pid)) {
      throw new Error(`PROCESS_LEAK:${this.#child.pid}`);
    }
  }
}
```

`createRunArtifacts()` creates a unique directory beneath
`TEGO_TEST_ARTIFACTS_DIR` when set, otherwise beneath the system temporary
directory. It writes `stdout.log`, `stderr.log`, `events.ndjson`,
`transcript.ndjson`, and `cleanup.json` per process.

- [ ] **Step 4: Verify GREEN and leak-free exit**

Run: `node --test tests/integration/process-harness.test.mjs`

Expected: PASS, zero leaked child processes, and bounded completion under five seconds.

- [ ] **Step 5: Commit**

```bash
git add .gitignore tests/support tests/integration/process-harness.test.mjs
git commit -m "test: add managed process integration harness"
```

---

### Task 2: Observable leadership ownership and loss

**Files:**
- Create: `packages/contracts/src/coordination.ts`
- Modify: `packages/contracts/src/drivers.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/drivers-local/src/local-coordination.ts`
- Modify: `packages/drivers-postgres/src/postgres-coordination.ts`
- Modify: `packages/testkit/src/coordination-suite.ts`
- Modify: `packages/drivers-postgres/test/leadership-faults.test.ts`
- Modify: all tests and fixtures implementing `CoordinationProvider`

**Interfaces:**
- Replaces `campaign(request): Promise<Leadership>` with `campaign(request): Promise<LeadershipHandle>`.
- Produces:

```ts
export interface LeadershipHandle {
  readonly leadership: Leadership;
  readonly lost: Promise<RuntimeDiagnostic>;
  release(): Promise<void>;
}
```

- [ ] **Step 1: Add failing conformance scenarios**

```ts
test("@spec:coordination-provider/fenced-leadership/observable-loss", async () => {
  const first = await provider.campaign({ resource: "runtime:r1" });
  await fixture.breakLeadership(first.leadership);
  const diagnostic = await first.lost;
  assert.equal(diagnostic.code, "COORDINATION_LEADERSHIP_LOST");
  assert.equal(diagnostic.retryable, true);
});

test("@spec:coordination-provider/fenced-leadership/release-and-takeover", async () => {
  const first = await providerA.campaign({ resource });
  const pending = providerB.campaign({ resource });
  await first.release();
  const second = await pending;
  assert.ok(BigInt(second.leadership.epoch) > BigInt(first.leadership.epoch));
});
```

- [ ] **Step 2: Run focused suites and verify RED**

Run:

```bash
npm run test:unit --workspace @tegojs/drivers-local
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" npm run test:integration --workspace @tegojs/drivers-postgres
```

Expected: TypeScript failure because `LeadershipHandle` and `.lost` do not exist.

Commit verified RED:

```bash
git add packages/testkit/src/coordination-suite.ts packages/drivers-postgres/test/leadership-faults.test.ts
git commit -m "test: specify observable leadership loss"
```

- [ ] **Step 3: Implement the contract and local provider**

```ts
export interface LeadershipHandle {
  readonly leadership: Leadership;
  readonly lost: Promise<RuntimeDiagnostic>;
  release(): Promise<void>;
}

export interface CoordinationProvider extends ManagedDriver {
  readonly scope: "distributed" | "local";
  campaign(request: CampaignRequest): Promise<LeadershipHandle>;
  // existing lease, epoch, CAS, and watch methods remain unchanged
}
```

The local handle resolves `lost` only when released or the provider closes. `release()` is idempotent and returns the local leadership slot.

- [ ] **Step 4: Implement PostgreSQL loss and release**

Store a resolver with every dedicated advisory-lock client. Resolve `lost` with
`COORDINATION_LEADERSHIP_LOST` on backend error or unexpected close. `release()`
unlocks and releases the client exactly once. Preserve monotonic fencing epochs
on reacquisition.

- [ ] **Step 5: Run conformance, fault, type, and architecture tests**

Run:

```bash
npm run test:unit --workspace @tegojs/drivers-local
npm run test:unit --workspace @tegojs/runtime
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" npm run test:integration --workspace @tegojs/drivers-postgres
npm run typecheck
npm test
```

Expected: PASS with the PostgreSQL service available.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts packages/drivers-local packages/drivers-postgres packages/testkit packages/runtime/test
git commit -m "feat: expose leadership loss and release"
```

---

### Task 3: Leader-aware runtime host and recovery-complete lifecycle

**Files:**
- Create: `packages/runtime/src/leadership-controller.ts`
- Create: `packages/runtime/src/runtime-host.ts`
- Create: `packages/runtime/test/leadership-controller.test.ts`
- Create: `packages/runtime/test/runtime-host.test.ts`
- Modify: `packages/runtime/src/create-runtime.ts`
- Modify: `packages/runtime/src/runtime-operations.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/contracts/src/runtime.ts`
- Modify: `packages/runtime/test/bootstrap.test.ts`

**Interfaces:**
- Produces `RuntimeHostServices`, `RuntimeHost`, and `createRuntimeHost()`.
- `RuntimeHostServices.createReconciler(authority)` creates a new fenced reconciler for each leadership epoch.
- `RuntimeHostServices.tasks` and `.workers` expose counts and lifecycle hooks without importing concrete packages.

```ts
export interface RuntimeTaskLifecycle {
  recover(): Promise<void>;
  setAuthority(authority: RuntimeAuthority | undefined): Promise<void>;
  count(): number;
  close(): Promise<void>;
}

export interface RuntimeWorkerDirectory {
  count(): number;
  placements(): readonly PlacementWorker[];
  close(): Promise<void>;
}

export interface RuntimeHostServices {
  readonly createReconciler: (authority: RuntimeAuthority) => Reconciler;
  readonly tasks: RuntimeTaskLifecycle;
  readonly workers: RuntimeWorkerDirectory;
}

export function createRuntimeHost(
  configuration: RuntimeConfiguration,
  drivers: RuntimeDrivers,
  services: RuntimeHostServices,
): Runtime;
```

- [ ] **Step 1: Write failing follower and takeover tests**

```ts
test("@spec:coordination-provider/fenced-leadership/follower-remains-operable", async () => {
  const runtime = createRuntimeHost(configuration("multi-main"), drivers, services);
  await runtime.start();
  assert.equal((await runtime.status()).lifecycle, "running");
  assert.equal((await runtime.status()).authority, undefined);
  assert.equal(services.reconcilerStarts, 0);
});

test("@spec:runtime-bootstrap/recovery/leadership-reacquisition", async () => {
  await coordination.acquire(epoch("7"));
  assert.equal(services.reconcilerAuthorities.at(-1)?.epoch, "7");
  await coordination.lose();
  assert.equal(services.activeReconcilers, 0);
  await coordination.acquire(epoch("8"));
  assert.equal(services.reconcilerAuthorities.at(-1)?.epoch, "8");
});
```

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm run build --workspace @tegojs/runtime && node --test packages/runtime/dist/test/runtime-host.test.js`

Expected: FAIL because `createRuntimeHost` is not exported.

Commit verified RED:

```bash
git add packages/runtime/test/leadership-controller.test.ts packages/runtime/test/runtime-host.test.ts packages/runtime/test/bootstrap.test.ts
git commit -m "test: specify leader aware runtime host"
```

- [ ] **Step 3: Implement background leadership control**

```ts
export class LeadershipController {
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#campaignLoop = this.#run();
  }

  async #run(): Promise<void> {
    while (this.#running) {
      const handle = await this.#coordination.campaign({ resource: this.#resource });
      if (!this.#running) {
        await handle.release();
        return;
      }
      await this.#onAcquired(handle.leadership);
      await handle.lost;
      await this.#onLost(handle.leadership);
    }
  }
}
```

The loop has no retry sleep. The coordination campaign remains pending until
leadership is available; provider failures use `Clock.sleep()` with bounded,
deterministic backoff before a new campaign.

- [ ] **Step 4: Implement runtime host lifecycle**

`start()` opens drivers, recovers durable state, opens read-only operations,
starts leadership control, and reports `running` without waiting for a
multi-Main campaign. On acquisition it creates and starts a fenced reconciler
and enables mutating operations. On loss it closes mutating admission before
stopping the reconciler. `stop()` closes admission, releases leadership, stops
reconciliation/tasks/workers, then closes drivers in reverse order.

- [ ] **Step 5: Verify lifecycle, recovery, and architecture**

Run:

```bash
npm run test:unit --workspace @tegojs/runtime
node --test tests/integration/runtime-local.test.mjs
npm run typecheck
npm test
```

Expected: PASS; `@tegojs/runtime` still has no concrete package dependency.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/runtime.ts packages/runtime
git commit -m "feat: add leader-aware runtime host"
```

---

### Task 4: Safe artifact preparation and component lifecycle effects

**Files:**
- Create: `packages/runtime/src/artifacts/prepared-artifact-cache.ts`
- Create: `packages/runtime/test/prepared-artifact-cache.test.ts`
- Create: `packages/runtime/src/components/component-registry.ts`
- Create: `packages/runtime/src/components/component-effects.ts`
- Create: `packages/runtime/test/component-effects.test.ts`
- Modify: `packages/runtime/src/artifacts/manifest-reader.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**

```ts
export interface PreparedArtifact {
  readonly digest: ArtifactDigest;
  readonly root: string;
  readonly manifest: PluginManifest;
}

export interface PreparedArtifactCache {
  prepare(request: ValidateArtifactRequest): Promise<PreparedArtifact>;
  release(digest: ArtifactDigest): Promise<void>;
  close(): Promise<void>;
}

export interface ComponentBinding {
  readonly instanceId: string;
  readonly executor: ExecutorKind;
  readonly workerId?: WorkerId;
  readonly artifact: PreparedArtifact;
  readonly deployment: PluginDeployment;
}
```

- [ ] **Step 1: Add failing archive safety and idempotency tests**

```ts
test("@spec:plugin-artifacts/immutable-artifacts/prepares-atomically", async () => {
  const [left, right] = await Promise.all([cache.prepare(request), cache.prepare(request)]);
  assert.equal(left.root, right.root);
  assert.equal(await readFile(join(left.root, "components/component.js"), "utf8"), source);
});

test("prepared cache rejects a changed entry and removes the temporary directory", async () => {
  await assert.rejects(cache.prepare(corruptRequest), /ARTIFACT_DIGEST_MISMATCH/u);
  assert.deepEqual(await readdir(cacheRoot), []);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run build --workspace @tegojs/runtime && node --test packages/runtime/dist/test/prepared-artifact-cache.test.js`

Expected: FAIL because `PreparedArtifactCache` does not exist.

Commit verified RED:

```bash
git add packages/runtime/test/prepared-artifact-cache.test.ts
git commit -m "test: specify prepared artifact cache"
```

- [ ] **Step 3: Implement validated atomic extraction**

Stream the deterministic tar archive once into a private temporary directory,
reuse the existing portable-path, collision, size, checksum, digest, and
metadata validation, write files with exclusive creation, then atomically
rename to `<cacheRoot>/<sha256>`. Never follow symlinks and never execute plugin
code during preparation.

- [ ] **Step 4: Add failing reconcile-effect tests**

```ts
test("@spec:plugin-deployment/idempotent-reconciliation/component-effects", async () => {
  await effects.perform(prepareEffect);
  await effects.perform(prepareEffect);
  await effects.perform(startEffect);
  assert.equal(registry.require(instanceId).state, "active");
  await effects.perform(stopEffect);
  assert.equal(registry.get(instanceId), undefined);
});
```

Run:

```bash
npm run build --workspace @tegojs/runtime
node --test packages/runtime/dist/test/component-effects.test.js
```

Expected: FAIL because `ComponentRegistry` and the effect adapter do not exist.

Commit verified RED:

```bash
git add packages/runtime/test/component-effects.test.ts
git commit -m "test: specify component lifecycle effects"
```

- [ ] **Step 5: Implement registry and effect adapter**

`prepare` materializes and registers an immutable binding, `start` activates
it, `drain` prevents new tasks while retaining observation, and `stop` removes
the binding and releases its artifact reference. Repeated effects with the same
operation identity return the previous result; conflicting identities fail
with a structured lifecycle diagnostic.

- [ ] **Step 6: Verify runtime package**

Run:

```bash
npm run test:unit --workspace @tegojs/runtime
npm run typecheck
npm test
```

Expected: PASS with no plugin imports during validation or preparation.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/artifacts packages/runtime/src/components packages/runtime/test packages/runtime/src/index.ts
git commit -m "feat: prepare artifacts for component execution"
```

---

### Task 5: Durable plugin, deployment, and task operations

**Files:**
- Create: `packages/contracts/src/operations.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/runtime.ts`
- Create: `packages/runtime/src/tasks/task-service.ts`
- Create: `packages/runtime/test/task-service.test.ts`
- Modify: `packages/runtime/src/runtime-operations.ts`
- Modify: `packages/runtime/src/runtime-host.ts`
- Modify: `packages/runtime/src/recovery.ts`
- Modify: `packages/runtime/test/bootstrap.test.ts`

**Interfaces:**

```ts
export interface InstallPluginRequest {
  readonly digest: ArtifactDigest;
  readonly signature?: ArtifactSignatureEnvelope;
}

export interface DeployPluginRequest {
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly artifactDigest: ArtifactDigest;
  readonly essential: boolean;
  readonly configuration: JsonValue;
  readonly permissionGrants: readonly Permission[];
  readonly capabilityBindings: Readonly<Record<string, PluginDeploymentIdentity>>;
}

export interface RunTaskRequest {
  readonly applicationId: ApplicationId;
  readonly pluginId: PluginId;
  readonly componentId: ComponentId;
  readonly input: JsonValue;
  readonly deadline: string;
  readonly orphanPolicy: OrphanPolicy;
}

export interface RuntimeOperations {
  installPlugin(request: InstallPluginRequest): Promise<PluginInstallation>;
  deployPlugin(request: DeployPluginRequest): Promise<PluginDeployment>;
  pluginStatus(identity: PluginDeploymentIdentity): Promise<PluginDeploymentStatus>;
  runTask(request: RunTaskRequest): Promise<TaskRecord>;
  taskStatus(taskId: TaskId): Promise<TaskRecord | undefined>;
  waitTask(taskId: TaskId): Promise<TaskRecord>;
  cancelTask(taskId: TaskId): Promise<TaskRecord>;
  recoveredOperations(): Promise<readonly PersistedOperationJournalEntry[]>;
}
```

- [ ] **Step 1: Write failing operation and task tests**

```ts
test("@spec:runtime-operations/task-operations/run-example-task", async () => {
  registry.activate(echoBinding("process"));
  const accepted = await service.run(request({ input: { value: "hello" } }));
  assert.equal(accepted.state, "running");
  const terminal = await service.wait(accepted.taskId);
  assert.equal(terminal.result?.status, "succeeded");
  assert.deepEqual(terminal.result?.output, { value: "hello" });
  assert.deepEqual(await recoverTask(state, terminal.taskId), terminal);
});

test("follower rejects mutation before reading artifact bytes", async () => {
  operations.setAuthority(undefined);
  await assert.rejects(
    operations.installPlugin({ digest }),
    /COORDINATION_NOT_LEADER/u,
  );
  assert.equal(artifactReads, 0);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:unit --workspace @tegojs/runtime`

Expected: TypeScript failure because operation request/result contracts and task service are absent.

Commit verified RED:

```bash
git add packages/runtime/test/task-service.test.ts packages/runtime/test/bootstrap.test.ts
git commit -m "test: specify durable runtime operations"
```

- [ ] **Step 3: Implement durable task records**

Persist one canonical record under `tego/tasks/<taskId>`. Commit the accepted
record before executor submission. Persist running and terminal transitions
with expected revisions. Duplicate run identities replay the same record.
State uncertainty after executor completion produces `indeterminate` without
output and never automatically retries.

- [ ] **Step 4: Implement plugin and deployment operations**

`installPlugin` accepts a digest that is already present in the injected
`ArtifactStore`, then invokes `ArtifactService.install`. Local file ingress is
owned by the CLI composition layer so `@tegojs/runtime` never receives a host
path or imports local filesystem policy. `deployPlugin` validates installation
and grants, increments generation transactionally, stores desired state, and
wakes the active reconciler. Status reads desired and observed state without
requiring leadership.

- [ ] **Step 5: Implement restart recovery**

During startup, reload terminal and non-terminal task records. Query the bound
executor for recoverable attempts. Preserve remote `unknown` until Worker
reconciliation; record `indeterminate` only when the authoritative boundary
cannot be proven. Do not accept new mutating operations before this pass ends.

- [ ] **Step 6: Run focused and integration suites**

Run:

```bash
npm run test:unit --workspace @tegojs/runtime
node --test tests/integration/runtime-local.test.mjs
npm run typecheck
npm test
```

Expected: PASS, including restart recovery and follower mutation rejection.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts packages/runtime
git commit -m "feat: add durable runtime operations"
```

---

### Task 6: Local control protocol and runtime CLI

**Files:**
- Create: `packages/cli/src/control/protocol.ts`
- Create: `packages/cli/src/control/server.ts`
- Create: `packages/cli/src/control/client.ts`
- Create: `packages/cli/test/control.test.ts`
- Create: `packages/cli/src/runtime/create-node-runtime-host.ts`
- Create: `packages/cli/src/runtime/main-process.ts`
- Create: `packages/cli/src/commands/runtime.ts`
- Create: `packages/cli/src/parse-command.ts`
- Create: `packages/cli/src/run-cli.ts`
- Create: `packages/cli/src/bin.ts`
- Create: `packages/cli/test/parse-command.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/tsconfig.json`
- Modify: `package-lock.json`

**Interfaces:**

```ts
export interface ControlRequest extends JsonObject {
  readonly protocolVersion: "1.0";
  readonly requestId: string;
  readonly operation: RuntimeOperationName;
  readonly input: JsonValue;
}

export interface ControlResponse extends JsonObject {
  readonly protocolVersion: "1.0";
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: JsonValue;
  readonly diagnostic?: RuntimeDiagnostic;
}

export interface LocalArtifactIngress {
  putPath(artifactPath: string): Promise<ArtifactDigest>;
}

export async function startControlServer(options: ControlServerOptions): Promise<ControlServer>;
export async function requestControl(options: ControlClientOptions): Promise<ControlResponse>;
export async function runCli(options: CliRunOptions): Promise<number>;
```

- [ ] **Step 1: Write failing real-socket control tests**

```ts
test("@spec:runtime-operations/local-runtime-operations/inspect-empty-runtime", async () => {
  const server = await startControlServer({ endpoint, operations: fakeOperations });
  const response = await requestControl({
    endpoint,
    operation: "runtime.status",
    input: {},
    timeoutMs: 1_000,
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.lifecycle, "running");
  await server.close();
});

test("control server rejects oversized and malformed frames", async () => {
  await assert.rejects(sendRaw(endpoint, "x".repeat(MAX_CONTROL_LINE_BYTES + 1)), /PROTOCOL/u);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:unit --workspace @tegojs/cli`

Expected: FAIL because control modules do not exist.

Commit verified RED:

```bash
git add packages/cli/test/control.test.ts
git commit -m "test: specify local control protocol"
```

- [ ] **Step 3: Implement bounded NDJSON control**

Use `node:net`. Bind an owner-only Unix domain socket or Windows named pipe.
Decode one request per line, cap line length and outstanding requests, preserve
request IDs, serialize diagnostics, and close all clients before removing the
endpoint. The server's CLI-only `plugin.install-path` dispatcher resolves and
streams a local artifact through `LocalArtifactIngress`, then invokes the
path-free kernel `installPlugin({ digest })` operation.

- [ ] **Step 4: Write failing runtime CLI tests**

```ts
test("@spec:runtime-operations/local-runtime-operations/json-status", async () => {
  const result = await invoke(["runtime", "status", "--json"], fixture);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).lifecycle, "running");
});

test("unknown command exits non-zero with structured diagnostic", async () => {
  const result = await invoke(["unknown", "--json"], fixture);
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stderr).diagnostic.code, "PROTOCOL_COMMAND_INVALID");
});
```

Run: `npm run test:unit --workspace @tegojs/cli`

Expected: FAIL because the CLI parser and runtime commands are not implemented.

Commit verified RED:

```bash
git add packages/cli/test/parse-command.test.ts
git commit -m "test: specify runtime cli commands"
```

- [ ] **Step 5: Implement parser, runtime commands, and executable**

Use `node:util.parseArgs`; do not add a command framework. Add
`"bin": { "tego": "./dist/src/bin.js" }`. `runtime start` runs foreground by
default; `--detach` spawns `main-process.js` and waits for recovery-complete
status. `runtime stop` is graceful and idempotent.

`createNodeRuntimeHost` is the concrete composition root and adds dependencies
on local/PostgreSQL drivers, executor-node, and transport-websocket. It injects
only contract-shaped boundaries into `@tegojs/runtime`.

- [ ] **Step 6: Verify package boundaries and CLI behavior**

Run:

```bash
npm run test:unit --workspace @tegojs/cli
npm run build
npm run typecheck
npm test
node packages/cli/dist/src/bin.js --help
```

Expected: PASS; the architecture test permits CLI-to-first-layer dependencies and still rejects runtime-to-concrete edges.

- [ ] **Step 7: Commit**

```bash
git add packages/cli packages/runtime packages/contracts package-lock.json
git commit -m "feat: add local runtime control cli"
```

---

### Task 7: Plugin and task CLI commands

**Files:**
- Create: `packages/cli/src/commands/plugin.ts`
- Create: `packages/cli/src/commands/task.ts`
- Create: `packages/cli/test/plugin-command.test.ts`
- Create: `packages/cli/test/task-command.test.ts`
- Modify: `packages/cli/src/parse-command.ts`
- Modify: `packages/cli/src/run-cli.ts`
- Modify: `packages/cli/src/index.ts`

**Interfaces:**
- Adds CLI command mappings for `plugin validate|pack|inspect|install|deploy|status`.
- Adds CLI command mappings for `task run|status|wait|cancel`.
- Every command supports `--json`; human rendering consumes the same typed result.

- [ ] **Step 1: Write failing command tests**

```ts
test("@spec:runtime-operations/plugin-development-operations/validate-before-pack", async () => {
  const result = await invoke(["plugin", "pack", invalidPlugin, "--json"], fixture);
  assert.equal(result.exitCode, 1);
  assert.equal(await exists(outputArtifact), false);
  assert.equal(JSON.parse(result.stderr).diagnostic.source.kind, "artifact");
});

test("@spec:runtime-operations/task-operations/run-example-task", async () => {
  const result = await invoke([
    "task", "run", "org.example.echo/echo", "--input", '{"message":"hi"}', "--json",
  ], fixture);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).result.output, { message: "hi" });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:unit --workspace @tegojs/cli`

Expected: FAIL with unsupported plugin/task command diagnostics.

Commit verified RED:

```bash
git add packages/cli/test/plugin-command.test.ts packages/cli/test/task-command.test.ts
git commit -m "test: specify plugin and task commands"
```

- [ ] **Step 3: Implement plugin commands**

Reuse existing `buildPlugin`, `packPlugin`, and `signArtifact`. Validate and
inspect locally without code execution. Install, deploy, and status cross the
control channel. `install` sends the canonical absolute artifact path rather
than embedding archive bytes in NDJSON.

- [ ] **Step 4: Implement task commands**

Parse JSON input with structured errors. `run` submits and waits unless
`--no-wait` is set. `wait`, `status`, and `cancel` return the canonical task
record, preserving `unknown` and `indeterminate` distinctions.

- [ ] **Step 5: Verify focused and workspace suites**

Run:

```bash
npm run test:unit --workspace @tegojs/cli
npm run build
npm run typecheck
npm test
```

Expected: PASS with identical JSON contracts in direct and socket-backed fixtures.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat: add plugin and task cli commands"
```

---

### Task 8: Real WebSocket adapters and independent Worker command

**Files:**
- Create: `packages/transport-websocket/src/network.ts`
- Create: `packages/transport-websocket/test/network.test.ts`
- Modify: `packages/transport-websocket/src/index.ts`
- Modify: `packages/transport-websocket/package.json`
- Create: `packages/cli/src/worker/worker-process.ts`
- Create: `packages/cli/src/commands/worker.ts`
- Create: `packages/cli/test/worker-command.test.ts`
- Modify: `packages/cli/src/runtime/create-node-runtime-host.ts`
- Modify: `packages/cli/src/parse-command.ts`
- Modify: `packages/cli/src/run-cli.ts`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/tsconfig.json`
- Modify: `package-lock.json`

**Interfaces:**

```ts
export interface WebSocketListener {
  readonly url: URL;
  close(): Promise<void>;
}

export function listenForMain(options: MainWebSocketListenerOptions): Promise<WebSocketListener>;
export function connectWorker(options: WorkerWebSocketConnectOptions): Promise<WorkerSession>;
export function listenForWorker(options: WorkerWebSocketListenerOptions): Promise<WebSocketListener>;
export function connectMain(options: MainWebSocketConnectOptions): Promise<WorkerSession>;
```

- [ ] **Step 1: Add `ws` and write failing loopback tests**

Pin `ws` `8.21.1` in runtime dependencies and `@types/ws` `8.18.1` in development dependencies.

```ts
test("@spec:worker-protocol/real-process-transport-acceptance/loopback-session", async () => {
  const listener = await listenForMain({ endpoint: main, host: "127.0.0.1", port: 0 });
  const session = await connectWorker({ endpoint: worker, url: listener.url });
  await session.ready;
  assert.equal(main.current(workerId)?.available, true);
  await listener.close();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:unit --workspace @tegojs/transport-websocket`

Expected: FAIL because `listenForMain` and `connectWorker` are not exported.

Commit verified RED:

```bash
git add packages/transport-websocket/test/network.test.ts
git commit -m "test: specify real websocket adapters"
```

- [ ] **Step 3: Implement real network adapters**

Use `WebSocketServer` and `WebSocket` from `ws`. Set `perMessageDeflate: false`,
bounded `maxPayload`, bounded handshake deadline, heartbeat termination, and a
maximum connection count. Attach accepted/client sockets to the existing
endpoint classes. Public declarations expose Tego interfaces and `URL`, not
`ws` types.

- [ ] **Step 4: Add disconnect/reconnect test**

Force-close the real socket during an active attempt. Assert the configured
orphan policy, new session epoch, buffered result reconciliation, and exactly
one terminal result. Wait on session state events, never wall-clock sleeps.

Run: `npm run test:unit --workspace @tegojs/transport-websocket`

Expected: FAIL until real reconnect reconciliation is wired through the
network adapter.

Commit verified RED:

```bash
git add packages/transport-websocket/test/network.test.ts packages/cli/test/worker-command.test.ts
git commit -m "test: specify network worker recovery"
```

- [ ] **Step 5: Implement Worker command and process**

`tego worker start` creates local thread/process executors, a durable attempt
store, `WorkerRuntime`, and a Worker endpoint. It supports both:

```text
tego worker start --connect ws://main/worker --prepare ./echo.tego
tego worker start --listen 127.0.0.1:0 --prepare ./echo.tego
```

Each `--prepare` artifact is validated and materialized through
`PreparedArtifactCache` before registration; the Worker advertises those
digests and rejects assignments for unprepared artifacts. Artifact
distribution is intentionally outside phase one.

Emit one structured readiness event containing PID, direction, resolved URL,
Worker ID, and executor capabilities.

- [ ] **Step 6: Verify transport, CLI, and architecture**

Run:

```bash
npm run test:unit --workspace @tegojs/transport-websocket
npm run test:unit --workspace @tegojs/cli
npm run build
npm run typecheck
npm test
```

Expected: PASS with no open WebSocket handles.

- [ ] **Step 7: Commit**

```bash
git add packages/transport-websocket packages/cli package-lock.json
git commit -m "feat: add real websocket worker transport"
```

---

### Task 9: Complete public testkit coverage and executor-neutral echo plugin

**Files:**
- Create: `packages/testkit/src/manifest-suite.ts`
- Create: `packages/testkit/src/lifecycle-suite.ts`
- Create: `packages/testkit/src/worker-suite.ts`
- Create: `packages/testkit/test/public-suites.test.ts`
- Modify: `packages/testkit/src/index.ts`
- Modify: `examples/echo-plugin/manifest.json`
- Modify: `examples/echo-plugin/src/component.ts`
- Create: `examples/echo-plugin/test/component.test.ts`
- Modify: `examples/echo-plugin/package.json`
- Modify: `examples/echo-plugin/tsconfig.json`

**Interfaces:**
- Produces public `manifestConformance`, `lifecycleConformance`, and `workerConformance`.
- Echo component contains no imports from executor or transport packages and declares `process`, `thread`, and `remote`.

- [ ] **Step 1: Write public-export self-tests**

```ts
import {
  manifestConformance,
  lifecycleConformance,
  workerConformance,
} from "@tegojs/testkit";

manifestConformance(() => publicManifestFixture());
lifecycleConformance(() => publicLifecycleFixture());
workerConformance(() => publicWorkerFixture());
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:unit --workspace @tegojs/testkit`

Expected: TypeScript failure because the three suites are not exported.

Commit verified RED:

```bash
git add packages/testkit/test/public-suites.test.ts examples/echo-plugin/test/component.test.ts
git commit -m "test: specify public conformance fixtures"
```

- [ ] **Step 3: Implement public suites**

The suites import only `@tegojs/contracts` and accept public factories. Include
manifest positive/negative cases, lifecycle transition/idempotency cases, and
Worker registration/heartbeat/reconnect/deduplication cases.

- [ ] **Step 4: Update and test echo plugin**

The manifest requests all three executors and contains no executor-specific
configuration. The component returns its input unchanged and its test asserts
load has no side effects beyond the existing fixture marker.

- [ ] **Step 5: Verify testkit, example, and boundaries**

Run:

```bash
npm run test:unit --workspace @tegojs/testkit
npm run test:unit --workspace @tegojs/echo-plugin
npm run build
npm run typecheck
npm test
```

Expected: PASS; the example depends only on `@tegojs/plugin-sdk`.

- [ ] **Step 6: Commit**

```bash
git add packages/testkit examples/echo-plugin
git commit -m "test: complete public conformance fixtures"
```

---

### Task 10: Single-Main real-process system flow

**Files:**
- Create: `tests/fixtures/main-process.mjs`
- Create: `tests/fixtures/worker-process.mjs`
- Create: `tests/e2e/single-main-process.test.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Fixtures call public `@tegojs/cli` process entry functions.
- Readiness events are NDJSON on stdout.
- The E2E test invokes the built `tego` binary and communicates only over control/WebSocket sockets.

- [ ] **Step 1: Write the failing single-Main test**

```js
test("@spec:runtime-operations/ci-authoritative-system-acceptance/real-single-main-executor-parity", async () => {
  const system = await startSingleMainSystem();
  try {
    const artifact = await system.tego("plugin", "pack", echoPlugin, "--json");
    await system.tego("plugin", "install", artifact.path, "--json");
    for (const executor of ["thread", "process", "remote"]) {
      await system.deployEcho({ executor });
      const result = await system.runEcho({ executor, input: { executor } });
      assert.equal(result.status, "succeeded");
      assert.deepEqual(result.output, { executor });
    }
    const before = await system.snapshot();
    await system.restartMain();
    assert.deepEqual(await system.snapshot(), before);
  } finally {
    await system.stop();
    await system.assertClean();
  }
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test tests/e2e/single-main-process.test.mjs`

Expected: FAIL at the first missing Main/Worker fixture or unsupported CLI operation.

Commit verified RED:

```bash
git add tests/e2e/single-main-process.test.mjs
git commit -m "test: specify single main system flow"
```

- [ ] **Step 3: Implement fixtures and complete the flow**

Use an isolated state/cache/control directory. Start Main and Worker as
independent managed processes. Use an OS-assigned WebSocket port reported by a
readiness event. Deploy the echo component three times with executor permission
grants restricted to one executor per generation.

- [ ] **Step 4: Add restart and cleanup assertions**

Restart Main with the same durable directory. Verify installation digest,
deployment generation, observed ready instance, operation journal, task IDs,
attempt IDs, and terminal outputs are unchanged. Assert all PIDs exit, control
socket is removed, WebSocket port closes, and cleanup report is empty.

- [ ] **Step 5: Verify repeatability**

Run:

```bash
npm run build
node --test tests/e2e/single-main-process.test.mjs
node --test tests/e2e/single-main-process.test.mjs
```

Expected: both runs PASS without reused state or occupied ports.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures tests/e2e/single-main-process.test.mjs package.json README.md
git commit -m "test: add single main system flow"
```

---

### Task 11: Two-Main PostgreSQL takeover system flow

**Files:**
- Create: `tests/e2e/two-main-postgres.test.mjs`
- Modify: `tests/fixtures/main-process.mjs`
- Modify: `packages/cli/src/runtime/create-node-runtime-host.ts`
- Modify: `packages/runtime/src/leadership-controller.ts`
- Modify: `packages/runtime/src/runtime-host.ts`
- Modify: `packages/drivers-postgres/test/leadership-faults.test.ts`
- Modify: `package.json`

**Interfaces:**
- Main fixture accepts `TEGO_POSTGRES_URL`, unique driver namespace, shared runtime/application ID, and unique node ID/control endpoint.
- Status reports current fencing authority and follower diagnostics.

- [ ] **Step 1: Write the failing takeover test**

```js
test("@spec:runtime-operations/ci-authoritative-system-acceptance/real-multi-main-takeover", async () => {
  const cluster = await startTwoMainCluster({ postgresUrl: process.env.TEGO_POSTGRES_URL });
  try {
    const first = await cluster.waitForLeader();
    const follower = cluster.other(first);
    assert.equal((await follower.status()).authority, undefined);
    const task = await cluster.runEcho();
    await first.killLeadershipBackend();
    const secondAuthority = await follower.waitForAuthority();
    assert.ok(BigInt(secondAuthority.epoch) > BigInt(first.authority.epoch));
    await assert.rejects(first.commitProbe(), /STATE_STALE_FENCE/u);
    const terminal = await cluster.waitTask(task.taskId);
    assert.equal(terminal.result.status, "succeeded");
    assert.equal(await cluster.terminalRecordCount(task.taskId), 1);
  } finally {
    await cluster.stop();
    await cluster.assertClean();
  }
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run build
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" node --test tests/e2e/two-main-postgres.test.mjs
```

Expected: FAIL because two running Main processes do not yet expose complete takeover behavior.

Commit verified RED:

```bash
git add tests/e2e/two-main-postgres.test.mjs
git commit -m "test: specify multi main takeover"
```

- [ ] **Step 3: Compose complete PostgreSQL runtime drivers**

Combine shared PostgreSQL state/coordination/artifacts with per-process
`NodeProcessHost`, `DevelopmentSecretProvider`, and clock. Use one unique driver
namespace per test and shared runtime/application identities across both Main
processes.

- [ ] **Step 4: Complete leader-only admission and takeover**

Only the current authority starts reconciler effects and task assignment.
Followers serve status and other read-only operations. On `lost`, close
mutating admission before stopping the reconciler. On reacquisition, recover
unfinished state under the new epoch before reopening mutation. All
control-plane writes include the active fencing epoch.

- [ ] **Step 5: Verify stale leader and Worker continuity**

Terminate the dedicated PostgreSQL leadership backend, not the entire Main
process. Verify follower takeover, old-epoch commit rejection, Worker
reconnection, and one terminal task record. Then terminate the former leader
process and ensure the cluster remains available.

- [ ] **Step 6: Run driver and E2E suites**

Run:

```bash
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" npm run test:integration --workspace @tegojs/drivers-postgres
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" node --test tests/e2e/two-main-postgres.test.mjs
npm run typecheck
npm test
```

Expected: PASS with monotonic epochs and exactly one terminal result.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/two-main-postgres.test.mjs tests/fixtures packages/cli packages/runtime packages/drivers-postgres package.json
git commit -m "test: add multi main takeover system flow"
```

---

### Task 12: Authoritative CI gates, release verification, and evidence

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Create: `scripts/verify-release.mjs`
- Create: `tests/architecture/system-ci.test.mjs`
- Modify: `README.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/tasks.md`

**Interfaces:**
- Root `npm run verify` runs all local-capable gates.
- Root `npm run verify:release` validates clean build/test/package/system evidence.
- CI jobs are `quality`, `integration`, and `system-e2e`.

- [ ] **Step 1: Write failing CI architecture tests**

```js
test("@spec:runtime-operations/ci-authoritative-system-acceptance/workflow-gates", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  for (const job of ["quality:", "integration:", "system-e2e:"]) {
    assert.match(workflow, new RegExp(`^  ${job}`, "mu"));
  }
  assert.match(workflow, /TEGO_TEST_ARTIFACTS_DIR/u);
  assert.match(workflow, /actions\/upload-artifact@/u);
  assert.match(workflow, /timeout-minutes:/u);
  assert.match(workflow, /job\.services\.postgres\.ports/u);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/architecture/system-ci.test.mjs`

Expected: FAIL because the workflow has no `system-e2e` job or artifact upload.

Commit verified RED:

```bash
git add tests/architecture/system-ci.test.mjs
git commit -m "test: specify system ci gates"
```

- [ ] **Step 3: Implement the three CI jobs**

`quality` runs install, commitlint, format, lint, build, typecheck, unit, and
architecture tests.

`integration` uses PostgreSQL `16.14-alpine` with:

```yaml
ports:
  - 5432/tcp
options: >-
  --health-cmd "pg_isready -U tego_test -d tego_next_test"
  --health-interval 1s
  --health-timeout 3s
  --health-retries 30
```

Set `TEGO_POSTGRES_URL` from
`${{ job.services.postgres.ports['5432'] }}`. Run all SQLite, executor,
real-WebSocket, PostgreSQL conformance, and fault integration tests.

`system-e2e` builds first, runs single-Main and two-Main tests, sets
`TEGO_TEST_ARTIFACTS_DIR`, and uploads logs/results with `if: ${{ always() }}`
under a bounded upload timeout. Set explicit job and step timeouts.

- [ ] **Step 4: Implement release verification**

`verify-release.mjs` checks the clean working tree, exact Node/npm versions,
lockfile install state, build outputs, deterministic echo artifact digest, all
test reports, and required CI evidence names. It exits non-zero with structured
diagnostics for missing evidence.

- [ ] **Step 5: Run local-capable verification**

Run:

```bash
npm run format:check
npm run lint
npm run build
npm run typecheck
npm test
node --test tests/integration/*.test.mjs
node --test tests/e2e/single-main-process.test.mjs
node --test tests/architecture/system-ci.test.mjs
```

Expected: PASS. PostgreSQL-dependent tests may be deferred to CI only when
`TEGO_POSTGRES_URL` is unavailable; the workflow test must still prove that CI
runs them.

- [ ] **Step 6: Update verified task state and documentation**

Mark an OpenSpec task complete only when its focused evidence has passed.
Document CLI usage, local fast tests, CI authority, log artifact locations,
single-Main deployment, multi-Main PostgreSQL deployment, and the Node 26 LTS
production gate.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml package.json scripts/verify-release.mjs tests/architecture/system-ci.test.mjs README.md openspec/changes/runtime-kernel-phase-1/tasks.md
git commit -m "ci: enforce runtime system acceptance"
```

---

### Task 13: Fault review and alpha release evidence

**Files:**
- Create: `tests/integration/runtime-fault-injection.test.mjs`
- Create: `docs/reviews/2026-07-24-phase-1-api-architecture-review.md`
- Create: `docs/reviews/2026-07-24-phase-1-security-concurrency-review.md`
- Create: `docs/releases/0.1.0-alpha.1.md`
- Modify: `openspec/changes/runtime-kernel-phase-1/tasks.md`

**Interfaces:**
- Fault tests use only public runtime, driver, executor, and control interfaces.
- Review documents contain severity, evidence, disposition, and verification command for every finding.
- Release notes state the Node.js 26 LTS production gate and every deferred capability.

- [ ] **Step 1: Add failing fault-injection assertions**

```js
test("@spec:runtime-operations/ci-authoritative-system-acceptance/fault-evidence", async () => {
  await assertFault("lifecycle-after-effect-before-commit", {
    expectedOperationCount: 1,
    expectedInstanceCount: 1,
  });
  await assertFault("stale-fencing-epoch", {
    expectedDiagnostic: "STATE_STALE_FENCE",
  });
  await assertFault("duplicate-remote-result", {
    expectedTerminalRecordCount: 1,
  });
  await assertFault("permission-grant-removed-before-import", {
    expectedDiagnostic: "PERMISSION_GRANT_EXCEEDED",
    expectedPluginLoadCount: 0,
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/integration/runtime-fault-injection.test.mjs`

Expected: FAIL at the first missing public fault trigger or unmet invariant.

Commit verified RED:

```bash
git add tests/integration/runtime-fault-injection.test.mjs
git commit -m "test: specify phase one fault evidence"
```

- [ ] **Step 3: Close fault-evidence gaps**

Add narrowly scoped public test hooks only where deterministic fault injection
is impossible through existing driver/process controls. Keep hooks in test
factories, not production runtime APIs. Prove lifecycle idempotency, stale
fencing rejection, result deduplication, permission-before-import, recovery
after interrupted persistence, and cleanup after each fault.

- [ ] **Step 4: Run separated review passes**

Perform API/architecture review first, then security/concurrency/recovery
review against the green implementation. Record each finding as:

```markdown
| Severity | Evidence | Finding | Disposition | Verification |
| --- | --- | --- | --- | --- |
| blocking | `path:line` | Concrete invariant violation | Fixed by commit | Exact command |
```

Resolve every blocking or high-severity finding and rerun the affected focused
suite before continuing.

- [ ] **Step 5: Produce alpha release evidence**

Create `docs/releases/0.1.0-alpha.1.md` with:

- implemented layer-one packages and CLI commands;
- single-Main and multi-Main verified topologies;
- GitHub Actions run links and artifact names;
- protocol and state-schema compatibility statement;
- known limitations;
- explicit Node.js 26 LTS production gate;
- deferred HTTP, authz, data/cache/scheduler/workflow, containers/Kubernetes,
  external coordinators, OS sandbox, Tego 1.x compatibility, and frontend work.

- [ ] **Step 6: Verify and mark final OpenSpec tasks**

Run:

```bash
node --test tests/integration/runtime-fault-injection.test.mjs
npm run verify:release
npx openspec validate runtime-kernel-phase-1 --strict
```

Expected: PASS. Mark tasks 12.4, 12.5, and 12.6 complete only after the review
documents and GitHub Actions evidence exist.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/runtime-fault-injection.test.mjs docs/reviews docs/releases openspec/changes/runtime-kernel-phase-1/tasks.md
git commit -m "docs: publish phase one alpha evidence"
```

---

## Final Verification

- [ ] Run `npm ci`.
- [ ] Run `npm run format:check`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run test:integration` with PostgreSQL available.
- [ ] Run `npm run test:e2e` with PostgreSQL available.
- [ ] Run `npm run verify:release`.
- [ ] Run `npx openspec validate runtime-kernel-phase-1 --strict`.
- [ ] Confirm `git status --short` contains only intended tracked changes.
- [ ] Push the feature branch and use GitHub Actions `quality`, `integration`, and `system-e2e` as the authoritative completion verdict.
