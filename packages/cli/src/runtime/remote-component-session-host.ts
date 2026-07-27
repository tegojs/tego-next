import { createHash } from "node:crypto";
import {
  assertExecutionBindingMatches,
  type AttemptId,
  type AttemptStatus,
  type ComponentCapabilityInvocation,
  DiagnosticError,
  type DrainOptions,
  type ExecutionBinding,
  type ExecutionHandle,
  type ExecutionRequest,
  type Executor,
  type ExecutorCapabilities,
  type ExecutorHealth,
  type JsonValue,
  parseExecutorId,
  parseTaskExecutionTarget,
  parseWorkerId,
  runtimeDiagnostic,
  type TaskExecutionTarget,
  type TaskId,
  type WorkerId,
} from "@tegojs/contracts";
import {
  type ComponentBinding,
  type ComponentBindingPreparation,
  type ComponentInstanceIdentity,
  type ComponentLifecycleHost,
  parseActivation,
  type TaskIdentity,
} from "@tegojs/runtime";
import type {
  RemoteCapabilityInvocation,
  RemoteComponentActivation,
} from "@tegojs/transport-websocket";
import type { LocalComponentSessionRegistry } from "./local-component-session-registry.js";

export interface RemoteComponentSessionHostOptions {
  readonly registry: LocalComponentSessionRegistry;
  readonly resolveExecutor: (workerId: WorkerId) => Executor | undefined;
  readonly resolveExecutionBinding: (
    binding: ComponentBindingPreparation,
    target: TaskExecutionTarget,
  ) => Promise<ExecutionBinding>;
  readonly runtimeId: string;
}

interface TargetDrainingExecutor extends Executor {
  activateComponent(activation: RemoteComponentActivation): Promise<void>;
  drainTarget(target: TaskExecutionTarget, options: DrainOptions): Promise<void>;
  drainComponent(target: TaskExecutionTarget, bindingFingerprint?: string): Promise<void>;
  restoreComponentForTermination(activation: RemoteComponentActivation): Promise<void>;
  invokeCapability(request: RemoteCapabilityInvocation): Promise<JsonValue>;
  resumeTarget(
    target: TaskExecutionTarget,
    taskId: TaskId,
    attemptId: AttemptId,
  ): Promise<ExecutionHandle | undefined>;
  observeTarget(
    target: TaskExecutionTarget,
    taskId: TaskId,
    attemptId: AttemptId,
  ): Promise<AttemptStatus | undefined>;
  cancelTarget(target: TaskExecutionTarget, taskId: TaskId, attemptId: AttemptId): Promise<void>;
  stopComponent(target: TaskExecutionTarget, bindingFingerprint?: string): Promise<void>;
}

export function remoteComponentExecutorId(workerIdValue: WorkerId | string): string {
  const workerId = parseWorkerId(workerIdValue);
  const digest = createHash("sha256").update(workerId, "utf8").digest("hex");
  return parseExecutorId(`worker-${digest}:remote`);
}

function hostError(
  code: `LIFECYCLE_${string}`,
  message: string,
  runtimeId: string,
  binding: ComponentBindingPreparation,
): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "runtime", id: runtimeId },
      details: {
        instanceId: binding.instanceId,
        workerId: binding.workerId ?? null,
      },
    }),
  );
}

function sameTarget(left: TaskExecutionTarget, right: TaskExecutionTarget): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.deploymentGeneration === right.deploymentGeneration &&
    left.artifactDigest === right.artifactDigest &&
    left.executor.id === right.executor.id &&
    left.executor.type === right.executor.type &&
    left.executor.workerId === right.executor.workerId
  );
}

function supportsTargetDrain(executor: Executor): executor is TargetDrainingExecutor {
  return (
    "drainTarget" in executor &&
    typeof (executor as Partial<TargetDrainingExecutor>).drainTarget === "function" &&
    "drainComponent" in executor &&
    typeof (executor as Partial<TargetDrainingExecutor>).drainComponent === "function" &&
    "activateComponent" in executor &&
    typeof (executor as Partial<TargetDrainingExecutor>).activateComponent === "function" &&
    "invokeCapability" in executor &&
    typeof (executor as Partial<TargetDrainingExecutor>).invokeCapability === "function" &&
    "resumeTarget" in executor &&
    typeof (executor as Partial<TargetDrainingExecutor>).resumeTarget === "function" &&
    "observeTarget" in executor &&
    typeof (executor as Partial<TargetDrainingExecutor>).observeTarget === "function" &&
    "cancelTarget" in executor &&
    typeof (executor as Partial<TargetDrainingExecutor>).cancelTarget === "function" &&
    "restoreComponentForTermination" in executor &&
    typeof (executor as Partial<TargetDrainingExecutor>).restoreComponentForTermination ===
      "function" &&
    "stopComponent" in executor &&
    typeof (executor as Partial<TargetDrainingExecutor>).stopComponent === "function"
  );
}

class ScopedRemoteExecutor implements Executor {
  readonly id: string;
  readonly type = "remote" as const;
  readonly #shared: TargetDrainingExecutor;
  readonly #target: TaskExecutionTarget;
  readonly #bindingFingerprint: string;
  readonly #identity: TaskIdentity | undefined;
  readonly #active = new Set<Promise<void>>();
  readonly #activeCapabilities = new Set<Promise<void>>();
  #submitTail = Promise.resolve();
  #accepting = true;
  #drainPromise: Promise<void> | undefined;

  constructor(
    shared: TargetDrainingExecutor,
    target: TaskExecutionTarget,
    bindingFingerprint: string,
    accepting = true,
    identity?: TaskIdentity,
  ) {
    this.#shared = shared;
    this.#target = target;
    this.#bindingFingerprint = bindingFingerprint;
    this.#accepting = accepting;
    this.#identity = identity;
    this.id = target.executor.id;
  }

  async probe(): Promise<ExecutorCapabilities> {
    const capability = await this.#shared.probe();
    return {
      ...capability,
      available: capability.available && this.#accepting,
      availableCapacity: this.#accepting ? capability.availableCapacity : 0,
    };
  }

  async submit(request: ExecutionRequest): Promise<ExecutionHandle> {
    if (!this.#accepting) {
      throw new Error("Remote component session is draining and not accepting assignments");
    }
    if (!sameTarget(request.target, this.#target)) {
      throw new Error("Remote component session request target does not match its binding");
    }
    const submitted = this.#submitTail.then(async () => this.#shared.submit(request));
    this.#submitTail = submitted.then(
      () => undefined,
      () => undefined,
    );
    const handle = await submitted;
    this.#track(handle);
    return handle;
  }

  async resume(taskId: TaskId, attemptId: AttemptId): Promise<ExecutionHandle | undefined> {
    this.#assertAttemptIdentity(taskId, attemptId);
    const handle = await this.#shared.resumeTarget(this.#target, taskId, attemptId);
    if (handle !== undefined) this.#track(handle);
    return handle;
  }

  #track(handle: ExecutionHandle): void {
    this.#trackActive(this.#active, handle.result);
  }

  #trackActive(activeOperations: Set<Promise<void>>, result: Promise<unknown>): void {
    const active = result.then(
      () => undefined,
      () => undefined,
    );
    activeOperations.add(active);
    void active.then(() => activeOperations.delete(active));
  }

  async observe(taskId: TaskId, attemptId: AttemptId): Promise<AttemptStatus | undefined> {
    this.#assertAttemptIdentity(taskId, attemptId);
    return await this.#shared.observeTarget(this.#target, taskId, attemptId);
  }

  async cancel(taskId: TaskId, attemptId: AttemptId): Promise<void> {
    this.#assertAttemptIdentity(taskId, attemptId);
    await this.#shared.cancelTarget(this.#target, taskId, attemptId);
  }

  #assertAttemptIdentity(taskId: TaskId, attemptId: AttemptId): void {
    if (
      this.#identity === undefined ||
      (this.#identity.taskId === taskId && this.#identity.attemptId === attemptId)
    ) {
      return;
    }
    throw new Error("Remote task recovery executor does not own this task attempt");
  }

  invokeCapability(invocation: ComponentCapabilityInvocation): Promise<JsonValue> {
    if (!this.#accepting) {
      return Promise.reject(
        new Error("Remote component session is draining and not accepting capability invocations"),
      );
    }
    const result = this.#shared.invokeCapability({
      invocationId: invocation.invocationId,
      bindingFingerprint: this.#bindingFingerprint,
      target: this.#target,
      invocation,
    });
    this.#trackActive(this.#activeCapabilities, result);
    return result;
  }

  drain(_options: DrainOptions): Promise<void> {
    this.#accepting = false;
    this.#drainPromise ??= this.#submitTail
      .then(async () => {
        await Promise.all([...this.#activeCapabilities]);
        await Promise.all([
          Promise.all([...this.#active]),
          this.#shared.drainTarget(this.#target, _options),
          this.#shared.drainComponent(this.#target, this.#bindingFingerprint),
        ]);
      })
      .catch((error: unknown) => {
        this.#drainPromise = undefined;
        throw error;
      });
    return this.#drainPromise;
  }

  async health(): Promise<ExecutorHealth> {
    const health = await this.#shared.health();
    return {
      ...health,
      accepting: health.accepting && this.#accepting,
      active: this.#active.size + this.#activeCapabilities.size,
    };
  }

  close(): Promise<void> {
    return this.drain({});
  }
}

export class RemoteComponentSessionHost implements ComponentLifecycleHost {
  readonly #options: RemoteComponentSessionHostOptions;

  constructor(options: RemoteComponentSessionHostOptions) {
    this.#options = options;
  }

  async prepare(
    binding: ComponentBindingPreparation,
    persisted?: ExecutionBinding,
  ): Promise<ExecutionBinding> {
    const target = this.#target(binding);
    const candidate = persisted ?? (await this.#options.resolveExecutionBinding(binding, target));
    return assertExecutionBindingMatches(
      {
        applicationId: binding.deployment.applicationId,
        pluginId: binding.deployment.pluginId,
        componentId: binding.component.componentId,
        target,
      },
      candidate,
    );
  }

  async start(binding: ComponentBinding): Promise<void> {
    const target = this.#target(binding);
    const shared = this.#resolveShared(binding, target);
    const executionBinding = binding.executionBinding;
    const activation = this.#activation(binding, target);
    await shared.activateComponent(activation);
    const capabilityConsumer: ComponentInstanceIdentity = {
      ...activation.identity,
      activation: binding.activation,
      target,
      bindingFingerprint: executionBinding.fingerprint,
    };
    try {
      this.#options.registry.register({
        applicationId: binding.deployment.applicationId,
        pluginId: binding.deployment.pluginId,
        componentId: binding.component.componentId,
        target,
        executor: new ScopedRemoteExecutor(shared, target, executionBinding.fingerprint),
        drainLifecycle: async (options) =>
          this.#options.registry.resolveExact(target).executor.drain(options),
        capabilityConsumer,
      });
    } catch (error) {
      try {
        await shared.stopComponent(target, executionBinding.fingerprint);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Remote component activation registration rollback failed",
        );
      }
      throw error;
    }
  }

  async drain(binding: ComponentBinding): Promise<void> {
    const target = this.#target(binding);
    const registration = this.#options.registry.resolveExact(target);
    this.#options.registry.markDraining(target);
    await registration.drainLifecycle({});
  }

  async restoreTermination(
    binding: ComponentBinding,
    checkpoint: "draining" | "stopping" = "draining",
  ): Promise<void> {
    const target = this.#target(binding);
    const shared = this.#resolveShared(binding, target);
    await shared.restoreComponentForTermination(this.#activation(binding, target));
    if (checkpoint === "draining") {
      await shared.drainComponent(target, binding.executionBinding.fingerprint);
    }
  }

  async stop(binding: ComponentBinding): Promise<void> {
    const target = this.#target(binding);
    const registration = this.#options.registry.findExact(target);
    const bindingFingerprint =
      registration?.capabilityConsumer?.bindingFingerprint ?? binding.executionBinding.fingerprint;
    if (registration !== undefined) {
      await registration.executor.close();
      await this.#resolveShared(binding, target).stopComponent(target, bindingFingerprint);
      this.#options.registry.remove(target);
      return;
    }
    await this.#resolveShared(binding, target).stopComponent(target, bindingFingerprint);
  }

  resolveTaskRecoveryExecutor(
    targetValue: TaskExecutionTarget,
    bindingFingerprint: string,
    identity: TaskIdentity,
  ): Executor {
    const target = parseTaskExecutionTarget(targetValue);
    if (target.executor.type !== "remote") {
      throw new TypeError("Remote task recovery target must use the remote executor");
    }
    const shared = this.#options.resolveExecutor(target.executor.workerId);
    if (
      shared === undefined ||
      shared.type !== "remote" ||
      shared.id !== target.executor.id ||
      !supportsTargetDrain(shared)
    ) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "LIFECYCLE_COMPONENT_HOST_UNAVAILABLE",
          message: "The selected remote Worker executor is unavailable for exact task recovery",
          source: { kind: "runtime", id: this.#options.runtimeId },
          details: {
            instanceId: target.instanceId,
            workerId: target.executor.workerId,
          },
        }),
      );
    }
    return new ScopedRemoteExecutor(shared, target, bindingFingerprint, false, identity);
  }

  #resolveShared(
    binding: ComponentBindingPreparation,
    target: TaskExecutionTarget,
  ): TargetDrainingExecutor {
    if (target.executor.type !== "remote") {
      throw new TypeError("Remote component target must use the remote executor");
    }
    const shared = this.#options.resolveExecutor(target.executor.workerId);
    if (
      shared === undefined ||
      shared.type !== "remote" ||
      shared.id !== target.executor.id ||
      !supportsTargetDrain(shared)
    ) {
      throw hostError(
        "LIFECYCLE_COMPONENT_HOST_UNAVAILABLE",
        "The selected remote Worker executor is unavailable or cannot recover and drain an exact target",
        this.#options.runtimeId,
        binding,
      );
    }
    return shared;
  }

  #target(binding: ComponentBindingPreparation): TaskExecutionTarget {
    parseActivation(binding.activation);
    if (binding.executor !== "remote" || binding.workerId === undefined) {
      throw hostError(
        "LIFECYCLE_COMPONENT_HOST_UNAVAILABLE",
        "Remote component sessions require an exact Worker placement",
        this.#options.runtimeId,
        binding,
      );
    }
    return parseTaskExecutionTarget({
      instanceId: binding.instanceId,
      deploymentGeneration: binding.deployment.generation,
      artifactDigest: binding.artifact.digest,
      executor: {
        id: remoteComponentExecutorId(binding.workerId),
        type: "remote",
        workerId: binding.workerId,
      },
    });
  }

  #activation(binding: ComponentBinding, target: TaskExecutionTarget): RemoteComponentActivation {
    const executionBinding = binding.executionBinding;
    return {
      identity: {
        applicationId: binding.deployment.applicationId,
        pluginId: binding.deployment.pluginId,
        componentId: binding.component.componentId,
      },
      target,
      configuration: executionBinding.configuration,
      permissionGrants: executionBinding.permissionGrants,
      capabilityDefinitions: executionBinding.capabilityDefinitions,
      capabilityBindings: executionBinding.capabilityBindings,
      bindingFingerprint: executionBinding.fingerprint,
    };
  }
}
