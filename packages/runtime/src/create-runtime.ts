import {
  type Clock,
  DiagnosticError,
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
  runtimeDiagnostic,
  type StopOptions,
  serializeCause,
} from "@tegojs/contracts";
import { DriverSupervisor } from "./driver-supervisor.js";
import { LeadershipController } from "./leadership-controller.js";
import { isRuntimeReady } from "./readiness.js";
import type { Reconciler } from "./reconcile/reconciler.js";
import { type RuntimeRecoverySnapshot, recoverRuntimeState } from "./recovery.js";
import type { RuntimeHostServices } from "./runtime-host.js";
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

class TegoRuntime implements Runtime {
  readonly operations: RuntimeOperationController;
  readonly events: AsyncIterable<RuntimeEvent>;
  readonly #configuration: RuntimeConfiguration;
  readonly #drivers: RuntimeDrivers;
  readonly #services: RuntimeHostServices | undefined;
  readonly #supervisor: DriverSupervisor;
  readonly #eventStream = new RuntimeEventStream();
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
  #servicesClosed = false;

  constructor(
    configuration: RuntimeConfiguration,
    drivers: RuntimeDrivers,
    services?: RuntimeHostServices,
  ) {
    this.#configuration = parseRuntimeConfiguration(configuration);
    this.#drivers = drivers;
    this.#services = services;
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
      await this.#closeServices();
      await this.#supervisor.close();
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
    } catch (error) {
      errors.push(error);
    }
    errors.push(...(await this.#closeServices()), ...(await this.#supervisor.close()));
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
        deployments: this.#recovery.deploymentReadiness,
      }),
      acceptingOperations: this.operations.accepting,
      drivers: this.#driverHealth,
      counts: {
        deployments: this.#recovery.deploymentCount,
        installations: this.#recovery.installationCount,
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
      await this.#services.tasks.setAuthority(undefined);
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#services.workers.setAuthority(undefined);
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#stopReconciler();
    } catch (error) {
      errors.push(error);
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
