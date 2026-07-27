import { createHash } from "node:crypto";
import {
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
  type ComponentInstanceIdentity,
  type ComponentLifecycleHost,
  parseActivation,
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
    binding: ComponentBinding,
    target: TaskExecutionTarget,
  ) => Promise<ExecutionBinding>;
  readonly resolveTeardownExecutionBinding?: (
    binding: ComponentBinding,
    target: TaskExecutionTarget,
  ) => Promise<ExecutionBinding>;
  readonly runtimeId: string;
}

interface TargetDrainingExecutor extends Executor {
  activateComponent(activation: RemoteComponentActivation): Promise<void>;
  drainTarget(target: TaskExecutionTarget, options: DrainOptions): Promise<void>;
  drainComponent(target: TaskExecutionTarget): Promise<void>;
  invokeCapability(request: RemoteCapabilityInvocation): Promise<JsonValue>;
  resumeTarget(
    target: TaskExecutionTarget,
    taskId: TaskId,
    attemptId: AttemptId,
  ): Promise<ExecutionHandle | undefined>;
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
  binding: ComponentBinding,
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
  readonly #active = new Set<Promise<void>>();
  readonly #activeCapabilities = new Set<Promise<void>>();
  #submitTail = Promise.resolve();
  #accepting = true;
  #drainPromise: Promise<void> | undefined;

  constructor(
    shared: TargetDrainingExecutor,
    target: TaskExecutionTarget,
    bindingFingerprint: string,
  ) {
    this.#shared = shared;
    this.#target = target;
    this.#bindingFingerprint = bindingFingerprint;
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

  observe(taskId: TaskId, attemptId: AttemptId): Promise<AttemptStatus | undefined> {
    return this.#shared.observe(taskId, attemptId);
  }

  cancel(taskId: TaskId, attemptId: AttemptId): Promise<void> {
    return this.#shared.cancel(taskId, attemptId);
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
    this.#drainPromise ??= this.#submitTail.then(async () => {
      await Promise.all([...this.#activeCapabilities]);
      await Promise.all([
        Promise.all([...this.#active]),
        this.#shared.drainTarget(this.#target, _options),
        this.#shared.drainComponent(this.#target),
      ]);
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

  async start(binding: ComponentBinding): Promise<void> {
    const target = this.#target(binding);
    const shared = this.#resolveShared(binding, target);
    const executionBinding = await this.#options.resolveExecutionBinding(binding, target);
    const activation: RemoteComponentActivation = {
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
        await shared.stopComponent(target);
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

  async stop(binding: ComponentBinding): Promise<void> {
    const target = this.#target(binding);
    const registration = this.#options.registry.findExact(target);
    const bindingFingerprint =
      registration?.capabilityConsumer?.bindingFingerprint ??
      (
        await (
          this.#options.resolveTeardownExecutionBinding ?? this.#options.resolveExecutionBinding
        )(binding, target)
      ).fingerprint;
    if (registration !== undefined) {
      await registration.executor.close();
      await this.#resolveShared(binding, target).stopComponent(target, bindingFingerprint);
      this.#options.registry.remove(target);
      return;
    }
    await this.#resolveShared(binding, target).stopComponent(target, bindingFingerprint);
  }

  #resolveShared(binding: ComponentBinding, target: TaskExecutionTarget): TargetDrainingExecutor {
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

  #target(binding: ComponentBinding): TaskExecutionTarget {
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
}
