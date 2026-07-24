import {
  DiagnosticError,
  parseLeadership,
  parseRuntimeConfiguration,
  parseRuntimeEvent,
  parseRuntimeStatus,
  runtimeDiagnostic,
  serializeCause,
  type Leadership,
  type Runtime,
  type RuntimeConfiguration,
  type RuntimeEvent,
  type RuntimeLifecycleState,
  type RuntimeStatus,
  type RuntimeDrivers,
  type StopOptions,
} from "@tegojs/contracts";
import { DriverSupervisor } from "./driver-supervisor.js";
import { isRuntimeReady } from "./readiness.js";
import { recoverRuntimeState, type RuntimeRecoverySnapshot } from "./recovery.js";
import { RuntimeOperationController } from "./runtime-operations.js";
import { transitionRuntimeState } from "./runtime-state.js";

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
  #leadership: Leadership | undefined;
  #driverHealth: RuntimeStatus["drivers"] = [];
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopRequested = false;

  constructor(configuration: RuntimeConfiguration, drivers: RuntimeDrivers) {
    this.#configuration = parseRuntimeConfiguration(configuration);
    this.#drivers = drivers;
    this.#supervisor = new DriverSupervisor(drivers);
    this.operations = new RuntimeOperationController(drivers.clock);
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
      this.operations.setRecovered(this.#recovery.operations);
      if (this.#stopRequested) return;

      this.#setLifecycle("electing");
      const expectedResource = `runtime:${this.#configuration.runtimeId}`;
      const leadershipHandle = await this.#drivers.coordination.campaign({
        resource: expectedResource,
      });
      const leadership = parseLeadership(leadershipHandle.leadership);
      if (leadership.resource !== expectedResource) {
        throw new DiagnosticError(
          runtimeDiagnostic({
            code: "COORDINATION_LEADERSHIP_RESOURCE_MISMATCH",
            message: "Coordination leadership does not match the campaign resource",
            source: { kind: "coordination", id: "leadership" },
            details: {
              expectedResource,
              actualResource: leadership.resource,
            },
            observedAt: this.#drivers.clock.now().toISOString(),
          }),
        );
      }
      this.#leadership = structuredClone(leadership);
      if (this.#stopRequested) return;

      this.#setLifecycle("running");
      this.#driverHealth = await this.#supervisor.health(this.#drivers.clock.now().toISOString());
      if (this.#stopRequested) return;
      this.operations.open();
    } catch (error) {
      this.operations.close();
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
    await this.#startPromise?.catch(() => undefined);
    if (this.#lifecycle === "stopped") return;
    this.operations.close();
    if (this.#lifecycle === "running") this.#setLifecycle("draining");
    if (this.#lifecycle !== "stopping") this.#setLifecycle("stopping");
    const errors = await this.#supervisor.close();
    this.#setLifecycle("stopped");
    this.#eventStream.close();
    if (errors.length > 0) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "BOOTSTRAP_STOP_FAILED",
          message: "One or more runtime drivers failed to close",
          source: { kind: "runtime", id: "driver-supervisor" },
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
        tasks: this.#recovery.taskCount,
        workers: 0,
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
