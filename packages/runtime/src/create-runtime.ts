import {
  type Clock,
  DiagnosticError,
  type JsonValue,
  type PluginDeployment,
  type PluginDeploymentObservation,
  parsePluginDeployment,
  parseRuntimeConfiguration,
  parseRuntimeEvent,
  parseRuntimeStatus,
  type Runtime,
  type RuntimeAuthority,
  type RuntimeConfiguration,
  type RuntimeDrivers,
  type RuntimeEvent,
  type RuntimeLifecycleState,
  type RuntimeStatus,
  type ScannedState,
  type StateStore,
  type StateTransaction,
  runtimeDiagnostic,
  type StopOptions,
  serializeCause,
} from "@tegojs/contracts";
import { decodePersistedPluginDeploymentObservation } from "./deployment-observation.js";
import { DriverSupervisor } from "./driver-supervisor.js";
import { LeadershipController } from "./leadership-controller.js";
import { isRuntimeReady } from "./readiness.js";
import type { Reconciler } from "./reconcile/reconciler.js";
import { type RuntimeRecoverySnapshot, recoverRuntimeState } from "./recovery.js";
import type {
  RuntimeHostServices,
  RuntimeObservedStatus,
  RuntimeObservedStatusReader,
} from "./runtime-host.js";
import { RuntimeOperationController } from "./runtime-operations.js";
import { transitionRuntimeState } from "./runtime-state.js";

export async function wakeReconcilerForAuthority(
  expected: RuntimeAuthority,
  current: RuntimeAuthority | undefined,
  reconcilerAuthority: RuntimeAuthority | undefined,
  reconciler: Pick<Reconciler, "wake"> | undefined,
  clock: Clock,
): Promise<void> {
  if (
    current?.resource !== expected.resource ||
    current.epoch !== expected.epoch ||
    reconcilerAuthority?.resource !== expected.resource ||
    reconcilerAuthority.epoch !== expected.epoch ||
    reconciler === undefined
  ) {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "COORDINATION_FENCE_REJECTED",
        message: "Reconciler wake authority no longer matches the active runtime leader",
        source: { kind: "coordination", id: expected.resource },
        observedAt: clock.now().toISOString(),
      }),
    );
  }
  await reconciler.wake();
}

const observedStatusPageSize = 100;

async function scanObservedStatusCollection<T extends JsonValue>(
  transaction: StateTransaction,
  collection: "deployment-observations" | "deployments" | "installations",
): Promise<readonly ScannedState<T>[]> {
  const records: ScannedState<T>[] = [];
  let afterId: string | undefined;
  while (true) {
    const page: ScannedState<T>[] = [];
    for await (const record of transaction.scan<T>({
      namespace: "tego",
      collection,
      ...(afterId === undefined ? {} : { afterId }),
      limit: observedStatusPageSize,
    })) {
      page.push(record);
    }
    records.push(...page);
    if (page.length < observedStatusPageSize) return records;
    afterId = page.at(-1)?.key.id;
    if (afterId === undefined) return records;
  }
}

function compareDeploymentRecords(
  left: ScannedState<PluginDeployment>,
  right: ScannedState<PluginDeployment>,
): number {
  const leftGeneration = BigInt(left.value.generation);
  const rightGeneration = BigInt(right.value.generation);
  if (leftGeneration !== rightGeneration) {
    return leftGeneration < rightGeneration ? -1 : 1;
  }
  const canonicalId = `${left.value.applicationId}/${left.value.pluginId}`;
  const leftCanonical = left.key.id === canonicalId;
  const rightCanonical = right.key.id === canonicalId;
  if (leftCanonical !== rightCanonical) return leftCanonical ? 1 : -1;
  return left.key.id < right.key.id ? 1 : left.key.id > right.key.id ? -1 : 0;
}

function currentDeploymentRecords(
  records: readonly ScannedState<PluginDeployment>[],
  applicationId: RuntimeConfiguration["applicationId"],
): readonly ScannedState<PluginDeployment>[] {
  const current = new Map<string, ScannedState<PluginDeployment>>();
  for (const record of records) {
    const deployment = parsePluginDeployment(record.value);
    if (deployment.applicationId !== applicationId) continue;
    const parsed = { ...record, value: deployment };
    const identity = `${deployment.applicationId}/${deployment.pluginId}`;
    const previous = current.get(identity);
    if (previous === undefined || compareDeploymentRecords(previous, parsed) < 0) {
      current.set(identity, parsed);
    }
  }
  return [...current.values()];
}

class DurableRuntimeObservedStatusReader implements RuntimeObservedStatusReader {
  readonly #applicationId: RuntimeConfiguration["applicationId"];
  readonly #state: StateStore;

  constructor(state: StateStore, applicationId: RuntimeConfiguration["applicationId"]) {
    this.#state = state;
    this.#applicationId = applicationId;
  }

  read(): Promise<RuntimeObservedStatus> {
    return this.#state.transact({}, async (transaction) => {
      const installations = await scanObservedStatusCollection<JsonValue>(
        transaction,
        "installations",
      );
      const deployments = currentDeploymentRecords(
        await scanObservedStatusCollection<PluginDeployment>(transaction, "deployments"),
        this.#applicationId,
      );
      const observations = await scanObservedStatusCollection<PluginDeploymentObservation>(
        transaction,
        "deployment-observations",
      );
      const observationByDeployment = new Map<string, ScannedState<PluginDeploymentObservation>>();
      for (const record of observations) {
        const decoded = decodePersistedPluginDeploymentObservation(record.value).observation;
        if (decoded.applicationId !== this.#applicationId) continue;
        const identity = `${decoded.applicationId}/${decoded.pluginId}`;
        const deployment = deployments.find(
          (candidate) =>
            `${candidate.value.applicationId}/${candidate.value.pluginId}` === identity,
        );
        if (deployment === undefined || decoded.generation !== deployment.value.generation) {
          continue;
        }
        const parsed = { ...record, value: decoded };
        const previous = observationByDeployment.get(identity);
        const canonicalId = identity;
        const parsedCanonical = parsed.key.id === canonicalId;
        const previousCanonical = previous?.key.id === canonicalId;
        if (
          previous === undefined ||
          (parsedCanonical && !previousCanonical) ||
          (parsedCanonical === previousCanonical && parsed.key.id < previous.key.id)
        ) {
          observationByDeployment.set(identity, parsed);
        }
      }
      return {
        deploymentCount: deployments.length,
        installationCount: installations.length,
        deploymentReadiness: deployments.map(({ value: deployment }) => {
          const observation = observationByDeployment.get(
            `${deployment.applicationId}/${deployment.pluginId}`,
          )?.value;
          return {
            essential: deployment.essential,
            ready:
              deployment.state === "disabled" ||
              (observation?.generation === deployment.generation && observation.status === "ready"),
          };
        }),
      };
    });
  }
}

class RuntimeEventIterator implements AsyncIterable<RuntimeEvent>, AsyncIterator<RuntimeEvent> {
  readonly #onClose: () => void;
  readonly #queue: RuntimeEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<RuntimeEvent>) => void> = [];
  #closed: boolean;

  constructor(closed: boolean, onClose: () => void) {
    this.#closed = closed;
    this.#onClose = onClose;
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    return this;
  }

  next(): Promise<IteratorResult<RuntimeEvent>> {
    const event = this.#queue.shift();
    if (event !== undefined) {
      return Promise.resolve({ done: false, value: event });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  return(): Promise<IteratorResult<RuntimeEvent>> {
    this.#queue.length = 0;
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  publish(event: RuntimeEvent): void {
    if (this.#closed) return;
    const copy = structuredClone(event);
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#queue.push(copy);
    } else {
      waiter({ done: false, value: copy });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
    this.#onClose();
  }
}

class RuntimeEventStream implements AsyncIterable<RuntimeEvent> {
  readonly #iterators = new Set<RuntimeEventIterator>();
  #closed = false;

  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    let iterator: RuntimeEventIterator;
    iterator = new RuntimeEventIterator(this.#closed, () => this.#iterators.delete(iterator));
    if (!this.#closed) this.#iterators.add(iterator);
    return iterator;
  }

  publish(event: RuntimeEvent): void {
    for (const iterator of this.#iterators) iterator.publish(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const iterator of [...this.#iterators]) iterator.close();
    this.#iterators.clear();
  }
}

type TerminalObservedStatus =
  | {
      readonly kind: "failure";
      readonly error: unknown;
    }
  | {
      readonly kind: "status";
      readonly status: RuntimeObservedStatus;
    };

class TegoRuntime implements Runtime {
  readonly operations: RuntimeOperationController;
  readonly events: AsyncIterable<RuntimeEvent>;
  readonly #configuration: RuntimeConfiguration;
  readonly #drivers: RuntimeDrivers;
  readonly #services: RuntimeHostServices | undefined;
  readonly #supervisor: DriverSupervisor;
  readonly #eventStream = new RuntimeEventStream();
  readonly #observedStatus: RuntimeObservedStatusReader;
  #lifecycle: RuntimeLifecycleState = "created";
  #recovery: RuntimeRecoverySnapshot = {
    installationCount: 0,
    deploymentCount: 0,
    deploymentReadiness: [],
    taskCount: 0,
    operations: [],
  };
  #leadership: RuntimeAuthority | undefined;
  #leadershipController: LeadershipController | undefined;
  #reconciler: Reconciler | undefined;
  #reconcilerAuthority: RuntimeAuthority | undefined;
  #reconcilerCurrentAuthority: RuntimeAuthority | undefined;
  #driverHealth: RuntimeStatus["drivers"] = [];
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopRequested = false;
  #workerAuthorityActive = false;
  #servicesClosed = false;
  #driversOpened = false;
  #terminalObservedStatus: TerminalObservedStatus | undefined;

  constructor(
    configuration: RuntimeConfiguration,
    drivers: RuntimeDrivers,
    services?: RuntimeHostServices,
  ) {
    this.#configuration = parseRuntimeConfiguration(configuration);
    this.#drivers = drivers;
    this.#services = services;
    this.#observedStatus = new DurableRuntimeObservedStatusReader(
      drivers.state,
      this.#configuration.applicationId,
    );
    this.#supervisor = new DriverSupervisor(drivers);
    this.operations = new RuntimeOperationController({
      clock: drivers.clock,
      state: drivers.state,
      ...(services?.artifactService === undefined
        ? {}
        : { artifactService: services.artifactService }),
      ...(services === undefined ? {} : { tasks: services.tasks }),
      authority: () => this.#leadership,
      wake: (expected) =>
        wakeReconcilerForAuthority(
          expected,
          this.#leadership,
          this.#reconcilerAuthority,
          this.#reconciler,
          this.#drivers.clock,
        ),
    });
    this.events = this.#eventStream;
  }

  start(): Promise<void> {
    if (this.#lifecycle === "stopped" || this.#lifecycle === "stopping" || this.#stopRequested) {
      return Promise.reject(this.#transitionError("Runtime cannot start after stopping has begun"));
    }
    if (this.#startPromise !== undefined) return this.#startPromise;
    const starting = this.#start();
    this.#startPromise = starting;
    return starting;
  }

  status(): Promise<RuntimeStatus> {
    return this.#status();
  }

  stop(_options: StopOptions = {}): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopRequested = true;
    const stopping = this.#stop();
    this.#stopPromise = stopping;
    return stopping;
  }

  async #start(): Promise<void> {
    try {
      this.#assertCoordinationScope();
      this.#setLifecycle("opening");
      await this.#supervisor.open();
      this.#driversOpened = true;
      if (this.#stopRequested) return;

      this.#setLifecycle("recovering");
      this.#recovery = await recoverRuntimeState(
        this.#drivers.state,
        this.#configuration.applicationId,
      );
      await this.#services?.tasks.recover();
      this.operations.setRecovered(this.#recovery.operations);
      if (this.#stopRequested) return;

      this.#driverHealth = await this.#supervisor.health(this.#drivers.clock.now().toISOString());
      if (this.#stopRequested) return;
      this.operations.openReadOnly();

      this.#setLifecycle("electing");
      const expectedResource = `runtime:${this.#configuration.runtimeId}`;
      const leadershipController = new LeadershipController({
        coordination: this.#drivers.coordination,
        clock: this.#drivers.clock,
        resource: expectedResource,
        onAcquired: (leadership) => this.#activateAuthority(leadership),
        onLost: (leadership) => this.#deactivateAuthority(leadership),
        ...(this.#services?.onDiagnostic === undefined
          ? {}
          : {
              onDiagnostic: (diagnostic) => this.#services?.onDiagnostic?.(diagnostic),
            }),
      });
      this.#leadershipController = leadershipController;
      await leadershipController.start();
      if (this.#configuration.mode === "single-main") {
        await leadershipController.waitForAuthority();
      }
      if (this.#stopRequested) return;

      this.#setLifecycle("running");
      if (this.#leadership !== undefined) this.operations.openMutations();
    } catch (error) {
      this.operations.close();
      await this.#leadershipController?.stop().catch(() => undefined);
      await this.#stopReconciler().catch(() => undefined);
      if (this.#driversOpened) {
        await this.#captureTerminalObservedStatus();
      } else {
        this.#captureRecoveredObservedStatus();
      }
      await this.#closeServices();
      await this.#supervisor.close();
      this.#driversOpened = false;
      if (
        this.#lifecycle !== "failed" &&
        this.#lifecycle !== "stopped" &&
        this.#lifecycle !== "stopping"
      ) {
        this.#setLifecycle("failed");
      }
      throw error;
    }
  }

  async #stop(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.#leadershipController?.stop();
    } catch (error) {
      errors.push(error);
    }
    await this.#startPromise?.catch(() => undefined);
    if (this.#lifecycle === "stopped") return;
    this.operations.close();
    if (this.#lifecycle === "running") this.#setLifecycle("draining");
    if (this.#lifecycle !== "stopping") this.#setLifecycle("stopping");
    try {
      await this.#stopReconciler();
      await this.#revokeWorkerAuthority();
    } catch (error) {
      errors.push(error);
    }
    const observedStatusFailure = await this.#captureTerminalObservedStatus();
    if (observedStatusFailure !== undefined) errors.push(observedStatusFailure);
    errors.push(...(await this.#closeServices()), ...(await this.#supervisor.close()));
    this.#driversOpened = false;
    this.#setLifecycle(errors.length === 0 ? "stopped" : "failed");
    this.#eventStream.close();
    if (errors.length > 0) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "BOOTSTRAP_STOP_FAILED",
          message: "One or more runtime resources failed to close",
          source: { kind: "runtime", id: "shutdown" },
          details: {
            causes: errors.map((error) => serializeCause(error)),
          },
          observedAt: this.#drivers.clock.now().toISOString(),
        }),
      );
    }
  }

  async #status(): Promise<RuntimeStatus> {
    if (this.#lifecycle === "running") {
      this.#driverHealth = await this.#supervisor.health(this.#drivers.clock.now().toISOString());
    }
    const observed = await this.#readObservedStatus();
    const driverHealth = this.#driverHealth.map(({ health }) => health);
    const status = {
      identity: {
        runtimeId: this.#configuration.runtimeId,
        applicationId: this.#configuration.applicationId,
        nodeId: this.#configuration.nodeId,
      },
      mode: this.#configuration.mode,
      lifecycle: this.#lifecycle,
      liveness: this.#lifecycle === "running",
      readiness: isRuntimeReady({
        lifecycle: this.#lifecycle,
        drivers: driverHealth,
        deployments: observed.deploymentReadiness.map((deployment) => ({
          desired: true,
          ...deployment,
        })),
      }),
      acceptingOperations: this.operations.accepting,
      drivers: this.#driverHealth,
      counts: {
        deployments: observed.deploymentCount,
        installations: observed.installationCount,
        recoverableOperations: this.#recovery.operations.length,
        tasks: this.#services?.tasks.count() ?? this.#recovery.taskCount,
        workers: this.#services?.workers.count() ?? 0,
      },
      ...(this.#leadership === undefined
        ? {}
        : {
            authority: {
              resource: this.#leadership.resource,
              epoch: this.#leadership.epoch,
            },
          }),
    } satisfies RuntimeStatus;
    return structuredClone(parseRuntimeStatus(status));
  }

  async #captureTerminalObservedStatus(): Promise<unknown | undefined> {
    if (this.#terminalObservedStatus !== undefined) return undefined;
    try {
      this.#terminalObservedStatus = {
        kind: "status",
        status: await this.#observedStatus.read(),
      };
      return undefined;
    } catch (error) {
      this.#terminalObservedStatus = {
        kind: "failure",
        error,
      };
      return error;
    }
  }

  #captureRecoveredObservedStatus(): void {
    if (this.#terminalObservedStatus !== undefined) return;
    this.#terminalObservedStatus = {
      kind: "status",
      status: {
        deploymentCount: this.#recovery.deploymentCount,
        installationCount: this.#recovery.installationCount,
        deploymentReadiness: this.#recovery.deploymentReadiness.map(({ essential, ready }) => ({
          essential,
          ready,
        })),
      },
    };
  }

  #readObservedStatus(): Promise<RuntimeObservedStatus> {
    if (this.#terminalObservedStatus?.kind === "failure") {
      return Promise.reject(this.#terminalObservedStatus.error);
    }
    if (this.#terminalObservedStatus?.kind === "status") {
      return Promise.resolve(this.#terminalObservedStatus.status);
    }
    return this.#observedStatus.read();
  }

  #assertCoordinationScope(): void {
    if (this.#configuration.mode !== "multi-main") return;
    if (this.#drivers.coordination.scope !== "distributed") {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "BOOTSTRAP_COORDINATION_NOT_DISTRIBUTED",
          message: "multi-main mode requires distributed coordination",
          source: { kind: "runtime", id: this.#configuration.runtimeId },
          details: {
            mode: this.#configuration.mode,
            coordinationScope: this.#drivers.coordination.scope,
          },
          observedAt: this.#drivers.clock.now().toISOString(),
        }),
      );
    }
    if (this.#drivers.state.scope !== "shared") {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "BOOTSTRAP_STATE_NOT_SHARED",
          message: "multi-main mode requires shared state storage",
          source: { kind: "runtime", id: this.#configuration.runtimeId },
          details: {
            mode: this.#configuration.mode,
            stateScope: this.#drivers.state.scope,
          },
          observedAt: this.#drivers.clock.now().toISOString(),
        }),
      );
    }
    if (this.#drivers.artifacts.scope !== "shared") {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "BOOTSTRAP_ARTIFACTS_NOT_SHARED",
          message: "multi-main mode requires shared artifact storage",
          source: { kind: "runtime", id: this.#configuration.runtimeId },
          details: {
            mode: this.#configuration.mode,
            artifactScope: this.#drivers.artifacts.scope,
          },
          observedAt: this.#drivers.clock.now().toISOString(),
        }),
      );
    }
  }

  async #activateAuthority(authority: RuntimeAuthority): Promise<void> {
    if (this.#stopRequested) return;
    if (this.#services === undefined) {
      this.#leadership = structuredClone(authority);
      if (this.#lifecycle === "running" && !this.#stopRequested) {
        this.operations.openMutations();
      }
      return;
    }

    this.#reconcilerCurrentAuthority = structuredClone(authority);
    this.#workerAuthorityActive = true;
    await this.#services.workers.setAuthority(authority);
    let reconciler!: Reconciler;
    reconciler = this.#services.createReconciler(authority, {
      currentAuthority: () =>
        this.#reconciler === reconciler ? this.#reconcilerCurrentAuthority : undefined,
      onBackgroundError: (error) => {
        this.#handleReconcilerBackgroundFailure(reconciler, authority, error);
      },
    });
    this.#reconciler = reconciler;
    this.#reconcilerAuthority = structuredClone(authority);
    await reconciler.start();
    await this.#services.tasks.setAuthority(authority);
    this.#leadership = structuredClone(authority);
    this.#services.authorityAdmission.open(authority);
    if (this.#lifecycle === "running" && !this.#stopRequested) {
      this.operations.openMutations();
    }
  }

  async #deactivateAuthority(authority: RuntimeAuthority): Promise<void> {
    if (
      this.#leadership !== undefined &&
      (this.#leadership.resource !== authority.resource ||
        this.#leadership.epoch !== authority.epoch)
    ) {
      return;
    }
    this.operations.closeMutations();
    this.#leadership = undefined;
    this.#reconcilerCurrentAuthority = undefined;
    if (this.#services === undefined) return;

    const errors: unknown[] = [];
    try {
      this.#services.authorityAdmission.close(authority);
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#services.tasks.setAuthority(undefined);
    } catch (error) {
      errors.push(error);
    }
    let reconcilerStopped = false;
    try {
      await this.#stopReconciler();
      reconcilerStopped = true;
    } catch (error) {
      errors.push(error);
    }
    if (reconcilerStopped) {
      try {
        await this.#revokeWorkerAuthority();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "COORDINATION_LEADERSHIP_CALLBACK_FAILED",
          message: "Leader-owned runtime services failed to deactivate",
          source: { kind: "runtime", id: this.#configuration.runtimeId },
          details: { causes: errors.map((error) => serializeCause(error)) },
          observedAt: this.#drivers.clock.now().toISOString(),
        }),
      );
    }
  }

  async #stopReconciler(): Promise<void> {
    const reconciler = this.#reconciler;
    if (reconciler === undefined) return;
    await reconciler.stop();
    if (this.#reconciler === reconciler) {
      this.#reconciler = undefined;
      this.#reconcilerAuthority = undefined;
      this.#reconcilerCurrentAuthority = undefined;
    }
  }

  async #revokeWorkerAuthority(): Promise<void> {
    if (this.#services === undefined || !this.#workerAuthorityActive) return;
    await this.#services.workers.setAuthority(undefined);
    this.#workerAuthorityActive = false;
  }

  #handleReconcilerBackgroundFailure(
    reconciler: Reconciler,
    authority: RuntimeAuthority,
    error: unknown,
  ): void {
    if (
      this.#reconciler !== reconciler ||
      this.#reconcilerAuthority?.resource !== authority.resource ||
      this.#reconcilerAuthority.epoch !== authority.epoch
    ) {
      return;
    }
    this.operations.closeMutations();
    this.#leadership = undefined;
    this.#reconcilerCurrentAuthority = undefined;
    try {
      this.#services?.authorityAdmission.close(authority);
    } catch {
      // The authoritative stop path retries and reports cleanup failures.
    }
    const diagnostic = runtimeDiagnostic({
      code: "LIFECYCLE_RECONCILE_BACKGROUND_FAILED",
      message: "Leader-owned background reconciliation failed",
      source: { kind: "runtime", id: this.#configuration.runtimeId },
      cause: serializeCause(error),
      observedAt: this.#drivers.clock.now().toISOString(),
    });
    try {
      void Promise.resolve(this.#services?.onDiagnostic?.(diagnostic)).catch(() => undefined);
    } catch {
      // Runtime shutdown below remains authoritative even when the diagnostic sink fails.
    }
    if (
      this.#lifecycle !== "failed" &&
      this.#lifecycle !== "stopped" &&
      this.#lifecycle !== "stopping"
    ) {
      this.#setLifecycle("failed");
    }
    void this.stop().catch(() => undefined);
  }

  async #closeServices(): Promise<readonly unknown[]> {
    if (this.#services === undefined || this.#servicesClosed) return [];
    this.#servicesClosed = true;
    const errors: unknown[] = [];
    for (const close of [
      () => this.#services?.tasks.close(),
      () => this.#services?.workers.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  #setLifecycle(next: RuntimeLifecycleState): void {
    const previous = this.#lifecycle;
    this.#lifecycle = transitionRuntimeState(
      previous,
      next,
      this.#drivers.clock.now().toISOString(),
    );
    this.#eventStream.publish(
      parseRuntimeEvent({
        type: "runtime.lifecycle",
        previous,
        current: next,
        occurredAt: this.#drivers.clock.now().toISOString(),
      }),
    );
  }

  #transitionError(message: string): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "LIFECYCLE_TRANSITION_INVALID",
        message,
        source: { kind: "runtime", id: this.#configuration.runtimeId },
        details: { lifecycle: this.#lifecycle },
        observedAt: this.#drivers.clock.now().toISOString(),
      }),
    );
  }
}

export function createRuntime(
  configuration: RuntimeConfiguration,
  drivers: RuntimeDrivers,
): Runtime {
  return new TegoRuntime(configuration, drivers);
}

export function createManagedRuntime(
  configuration: RuntimeConfiguration,
  drivers: RuntimeDrivers,
  services: RuntimeHostServices,
): Runtime {
  return new TegoRuntime(configuration, drivers, services);
}
