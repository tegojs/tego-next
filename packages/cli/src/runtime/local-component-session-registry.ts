import {
  DiagnosticError,
  type Executor,
  type JsonValue,
  parseTaskExecutionTarget,
  type RunTaskRequest,
  runtimeDiagnostic,
  type TaskExecutionTarget,
} from "@tegojs/contracts";
import type { ComponentInstanceIdentity } from "@tegojs/runtime";

export interface LocalComponentSessionRegistration {
  readonly applicationId: RunTaskRequest["applicationId"];
  readonly pluginId: RunTaskRequest["pluginId"];
  readonly componentId: RunTaskRequest["componentId"];
  readonly target: TaskExecutionTarget;
  readonly executor: Executor;
  readonly drainLifecycle: Executor["drain"];
  readonly capabilityConsumer?: ComponentInstanceIdentity;
  readonly releaseBoundaries?: () => void;
}

interface RegisteredLocalComponentSession extends LocalComponentSessionRegistration {
  accepting: boolean;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function registryError(
  code: `LIFECYCLE_${string}`,
  message: string,
  runtimeId: string,
  details: Record<string, JsonValue> = {},
): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "runtime", id: runtimeId },
      details,
    }),
  );
}

export function localComponentSessionTargetKey(input: TaskExecutionTarget): string {
  const target = parseTaskExecutionTarget(input);
  return JSON.stringify([
    target.instanceId,
    target.deploymentGeneration,
    target.artifactDigest,
    target.executor.id,
    target.executor.type,
    target.executor.workerId ?? null,
  ]);
}

export class LocalComponentSessionRegistry {
  readonly #runtimeId: string;
  readonly #sessions = new Map<string, RegisteredLocalComponentSession>();
  #closePromise: Promise<void> | undefined;

  constructor(runtimeId: string) {
    this.#runtimeId = runtimeId;
  }

  register(registration: LocalComponentSessionRegistration): void {
    const key = localComponentSessionTargetKey(registration.target);
    if (this.#closePromise !== undefined) {
      throw registryError(
        "LIFECYCLE_COMPONENT_HOST_UNAVAILABLE",
        "Local component session registry is closed",
        this.#runtimeId,
      );
    }
    if (this.#sessions.has(key)) {
      throw registryError(
        "LIFECYCLE_INSTANCE_CONFLICT",
        "An exact local component session target is already registered",
        this.#runtimeId,
        { target: key },
      );
    }
    const target = deepFreeze(parseTaskExecutionTarget(registration.target));
    this.#sessions.set(key, {
      ...registration,
      target,
      accepting: true,
    });
  }

  markDraining(target: TaskExecutionTarget): void {
    this.#require(target).accepting = false;
  }

  resolveExact(target: TaskExecutionTarget): LocalComponentSessionRegistration {
    return this.#snapshot(this.#require(target));
  }

  findExact(target: TaskExecutionTarget): LocalComponentSessionRegistration | undefined {
    const session = this.#sessions.get(localComponentSessionTargetKey(target));
    return session === undefined ? undefined : this.#snapshot(session);
  }

  resolveFresh(
    request: RunTaskRequest,
    isComponentAccepting: (target: TaskExecutionTarget) => boolean = () => true,
  ): LocalComponentSessionRegistration {
    return this.resolveComponent(
      request.applicationId,
      request.pluginId,
      request.componentId,
      isComponentAccepting,
    );
  }

  resolveComponent(
    applicationId: RunTaskRequest["applicationId"],
    pluginId: RunTaskRequest["pluginId"],
    componentId: RunTaskRequest["componentId"],
    isComponentAccepting: (target: TaskExecutionTarget) => boolean = () => true,
  ): LocalComponentSessionRegistration {
    const candidates = [...this.#sessions.values()].filter(
      (candidate) =>
        candidate.accepting &&
        isComponentAccepting(candidate.target) &&
        candidate.applicationId === applicationId &&
        candidate.pluginId === pluginId &&
        candidate.componentId === componentId,
    );
    if (candidates.length === 0) {
      throw registryError(
        "LIFECYCLE_INSTANCE_MISSING",
        "No active accepting local component session matches the task",
        this.#runtimeId,
        {
          applicationId,
          pluginId,
          componentId,
        },
      );
    }
    if (candidates.length !== 1) {
      throw registryError(
        "LIFECYCLE_INSTANCE_AMBIGUOUS",
        "Local component session selection is ambiguous",
        this.#runtimeId,
        {
          applicationId,
          pluginId,
          componentId,
          candidateTargets: candidates.map((candidate) =>
            localComponentSessionTargetKey(candidate.target),
          ),
        },
      );
    }
    return this.#snapshot(candidates[0] as RegisteredLocalComponentSession);
  }

  remove(target: TaskExecutionTarget): LocalComponentSessionRegistration {
    const key = localComponentSessionTargetKey(target);
    const session = this.#require(target);
    this.#sessions.delete(key);
    return this.#snapshot(session);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) session.accepting = false;
    this.#closePromise = (async () => {
      const results = await Promise.allSettled(
        sessions.map(async (session) => {
          try {
            await session.executor.close();
          } finally {
            session.releaseBoundaries?.();
          }
        }),
      );
      this.#sessions.clear();
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Local component session cleanup failed");
      }
    })();
    return this.#closePromise;
  }

  #require(target: TaskExecutionTarget): RegisteredLocalComponentSession {
    const key = localComponentSessionTargetKey(target);
    const session = this.#sessions.get(key);
    if (session === undefined) {
      throw registryError(
        "LIFECYCLE_INSTANCE_MISSING",
        "The exact local component session target is unavailable",
        this.#runtimeId,
        { target: key },
      );
    }
    return session;
  }

  #snapshot(session: RegisteredLocalComponentSession): LocalComponentSessionRegistration {
    return Object.freeze({
      applicationId: session.applicationId,
      pluginId: session.pluginId,
      componentId: session.componentId,
      target: deepFreeze(structuredClone(session.target)),
      executor: session.executor,
      drainLifecycle: session.drainLifecycle,
      ...(session.capabilityConsumer === undefined
        ? {}
        : { capabilityConsumer: deepFreeze(structuredClone(session.capabilityConsumer)) }),
      ...(session.releaseBoundaries === undefined
        ? {}
        : { releaseBoundaries: session.releaseBoundaries }),
    });
  }
}
