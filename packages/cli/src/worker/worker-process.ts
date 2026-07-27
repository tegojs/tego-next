import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type ArtifactDigest,
  createExecutionBinding,
  DiagnosticError,
  type ExecutionRequest,
  type Executor,
  type ExecutorCapabilities,
  type PluginComponent,
  parseArtifactDigest,
  parseExecutionRequest,
  parseWorkerId,
  type RuntimeDrivers,
  runtimeDiagnostic,
  type WorkerId,
} from "@tegojs/contracts";
import { createLocalDrivers } from "@tegojs/drivers-local";
import {
  type ComponentSandboxSession,
  createProcessComponentSession,
  createThreadComponentSession,
  ProcessExecutor,
  type ResolvedThreadComponent,
  ThreadExecutor,
} from "@tegojs/executor-node";
import {
  ArtifactService,
  createComponentBoundaries,
  type PreparedArtifact,
  PreparedArtifactCache,
} from "@tegojs/runtime";
import {
  connectWorker,
  createWorkerEndpoint,
  listenForWorker,
  type RemoteCapabilityInvocation,
  type RemoteComponentActivation,
  type WebSocketListener,
  type WorkerAssignmentRejection,
  WorkerRuntime,
  type WorkerSession,
} from "@tegojs/transport-websocket";
import type { WorkerStartCommand } from "../parse-command.js";
import { StateRemoteAttemptStore } from "../runtime/remote-attempt-store.js";

export {
  StateRemoteAttemptStore,
  type StateRemoteAttemptStoreOptions,
} from "../runtime/remote-attempt-store.js";

export interface PreparedArtifactSelection {
  readonly digests: readonly ArtifactDigest[];
  resolveComponent(
    request: ExecutionRequest,
    executor?: { readonly id: string; readonly type: "process" | "thread" },
  ): ResolvedThreadComponent;
  resolveActivation(activation: RemoteComponentActivation): ResolvedThreadComponent;
  selectActivationExecutorKind(activation: RemoteComponentActivation): "process" | "thread";
  selectExecutorKind(request: ExecutionRequest): "process" | "thread";
  validateActivation(activation: RemoteComponentActivation): WorkerAssignmentRejection | undefined;
  validateAssignment(request: ExecutionRequest): WorkerAssignmentRejection | undefined;
}

function createWorkerLocalExecutor(executor: Executor): Executor {
  if (executor.type !== "process" && executor.type !== "thread") {
    throw new TypeError("Worker local executor must use process or thread isolation");
  }
  const local: Executor = {
    id: executor.id,
    type: executor.type,
    probe: () => executor.probe(),
    submit: (request) => executor.submit(parseExecutionRequest(request)),
    observe: (taskId, attemptId) => executor.observe(taskId, attemptId),
    cancel: (taskId, attemptId) => executor.cancel(taskId, attemptId),
    drain: (options) => executor.drain(options),
    health: () => executor.health(),
    close: () => executor.close(),
  };
  return Object.freeze(local);
}

function artifactSelectionError(message: string): WorkerAssignmentRejection {
  return {
    code: "EXECUTOR_REMOTE_ARTIFACT_UNPREPARED",
    message,
  };
}

export function createPreparedArtifactSelection(
  artifacts: readonly PreparedArtifact[],
  runtimeId: string,
): PreparedArtifactSelection {
  const byPlugin = new Map<string, readonly PreparedArtifact[]>();
  for (const artifact of artifacts) {
    const existing = byPlugin.get(artifact.manifest.pluginId) ?? [];
    byPlugin.set(artifact.manifest.pluginId, Object.freeze([...existing, artifact]));
  }
  const digests = Object.freeze(artifacts.map((artifact) => artifact.digest));

  const select = (
    request: ExecutionRequest,
  ): { readonly artifact: PreparedArtifact; readonly component: PluginComponent } => {
    const rejection = validateAssignment(request);
    if (rejection !== undefined) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: rejection.code,
          message: rejection.message,
          source: { kind: "executor", id: "worker-artifact-selection" },
        }),
      );
    }
    const artifact = byPlugin
      .get(request.pluginId)
      ?.find((candidate) => candidate.digest === request.target.artifactDigest);
    if (artifact === undefined) {
      throw new Error("Validated Worker artifact selection is unavailable");
    }
    const component = artifact.manifest.components.find(
      (candidate) => candidate.componentId === request.componentId,
    ) as PluginComponent;
    return { artifact, component };
  };

  const selectActivation = (
    activation: RemoteComponentActivation,
  ): { readonly artifact: PreparedArtifact; readonly component: PluginComponent } => {
    const rejection = validateActivation(activation);
    if (rejection !== undefined) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: rejection.code,
          message: rejection.message,
          source: { kind: "executor", id: "worker-artifact-selection" },
        }),
      );
    }
    const artifact = byPlugin
      .get(activation.identity.pluginId)
      ?.find((candidate) => candidate.digest === activation.target.artifactDigest);
    if (artifact === undefined) {
      throw new Error("Validated Worker activation artifact selection is unavailable");
    }
    const component = artifact.manifest.components.find(
      (candidate) => candidate.componentId === activation.identity.componentId,
    ) as PluginComponent;
    return { artifact, component };
  };

  const validateAssignment = (request: ExecutionRequest): WorkerAssignmentRejection | undefined => {
    try {
      parseExecutionRequest(request);
    } catch {
      return {
        code: "PROTOCOL_EXECUTION_BINDING_INVALID",
        message: "Execution binding does not match the assignment target",
      };
    }
    const candidates = (byPlugin.get(request.pluginId) ?? []).filter(
      (candidate) => candidate.digest === request.target.artifactDigest,
    );
    if (candidates.length === 0) {
      return artifactSelectionError("No prepared artifact matches the assignment target");
    }
    if (candidates.length !== 1) {
      return artifactSelectionError("Multiple prepared artifacts match the assignment target");
    }
    const components = candidates[0]?.manifest.components.filter(
      (component) => component.componentId === request.componentId,
    );
    if (components?.length !== 1) {
      return artifactSelectionError("Prepared artifact does not contain the assignment component");
    }
    if (
      !components[0]?.executors.some((executor) => executor === "thread" || executor === "process")
    ) {
      return artifactSelectionError("Prepared component has no local Worker executor");
    }
    return undefined;
  };
  const validateActivation = (
    activation: RemoteComponentActivation,
  ): WorkerAssignmentRejection | undefined => {
    const identity = {
      ...activation.identity,
      target: activation.target,
    };
    const binding = createExecutionBinding(identity, {
      configuration: activation.configuration,
      permissionGrants: activation.permissionGrants,
      capabilityDefinitions: activation.capabilityDefinitions,
      capabilityBindings: activation.capabilityBindings,
    });
    if (binding.fingerprint !== activation.bindingFingerprint) {
      return {
        code: "PROTOCOL_EXECUTION_BINDING_INVALID",
        message: "Remote component activation binding fingerprint is invalid",
      };
    }
    const candidates = (byPlugin.get(activation.identity.pluginId) ?? []).filter(
      (candidate) => candidate.digest === activation.target.artifactDigest,
    );
    if (candidates.length !== 1) {
      return artifactSelectionError(
        candidates.length === 0
          ? "No prepared artifact matches the component activation"
          : "Multiple prepared artifacts match the component activation",
      );
    }
    const components = candidates[0]?.manifest.components.filter(
      (component) => component.componentId === activation.identity.componentId,
    );
    if (components?.length !== 1) {
      return artifactSelectionError("Prepared artifact does not contain the activation component");
    }
    if (
      !components[0]?.executors.some((executor) => executor === "thread" || executor === "process")
    ) {
      return artifactSelectionError("Prepared activation has no local Worker executor");
    }
    return undefined;
  };

  return Object.freeze({
    digests,
    validateActivation,
    validateAssignment,
    selectActivationExecutorKind(activation: RemoteComponentActivation) {
      const { component } = selectActivation(activation);
      return component.executors.includes("thread") ? "thread" : "process";
    },
    selectExecutorKind(request: ExecutionRequest) {
      const { component } = select(request);
      return component.executors.includes("thread") ? "thread" : "process";
    },
    resolveComponent(
      request: ExecutionRequest,
      executor?: { readonly id: string; readonly type: "process" | "thread" },
    ) {
      const { artifact } = select(request);
      return {
        target:
          executor === undefined
            ? request.target
            : {
                ...request.target,
                executor,
              },
        artifactDigest: artifact.digest,
        artifactRoot: artifact.root,
        manifest: artifact.manifest,
        runtimeId,
        instanceId: request.target.instanceId,
        configuration: structuredClone(request.binding.configuration),
        permissionGrants: structuredClone(request.binding.permissionGrants),
        capabilityDefinitions: structuredClone(request.binding.capabilityDefinitions),
      };
    },
    resolveActivation(activation: RemoteComponentActivation) {
      const { artifact } = selectActivation(activation);
      return {
        target: activation.target,
        artifactDigest: artifact.digest,
        artifactRoot: artifact.root,
        manifest: artifact.manifest,
        runtimeId,
        instanceId: activation.target.instanceId,
        configuration: structuredClone(activation.configuration),
        permissionGrants: structuredClone(activation.permissionGrants),
        capabilityDefinitions: structuredClone(activation.capabilityDefinitions),
      };
    },
  });
}

export interface WorkerReadiness {
  readonly type: "worker.ready";
  readonly pid: number;
  readonly direction: WorkerStartCommand["direction"];
  readonly url: string;
  readonly workerId: WorkerId;
  readonly executors: readonly ExecutorCapabilities[];
}

export interface WorkerProcessOptions {
  readonly onReady?: (readiness: WorkerReadiness) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

async function digestFile(path: string): Promise<ArtifactDigest> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return parseArtifactDigest(`sha256:${hash.digest("hex")}`);
}

async function openWorkerDrivers(drivers: RuntimeDrivers): Promise<void> {
  await Promise.all([
    drivers.state.open(),
    drivers.artifacts.open(),
    drivers.processHost.open(),
    drivers.secrets.open(),
  ]);
}

async function closeWorkerDrivers(drivers: RuntimeDrivers): Promise<void> {
  const results = await Promise.allSettled([
    drivers.processHost.close(),
    drivers.secrets.close(),
    drivers.artifacts.close(),
    drivers.state.close(),
  ]);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Worker driver cleanup failed");
}

async function prepareArtifacts(
  paths: readonly string[],
  drivers: RuntimeDrivers,
  dataDirectory: string,
): Promise<{
  readonly artifacts: readonly PreparedArtifact[];
  readonly cache: PreparedArtifactCache;
}> {
  const cache = new PreparedArtifactCache({
    artifacts: drivers.artifacts,
    root: join(dataDirectory, "prepared"),
  });
  const service = new ArtifactService({
    artifacts: drivers.artifacts,
    state: drivers.state,
    clock: drivers.clock,
    compatibility: {
      architecture: process.arch,
      nodeVersion: process.versions.node,
      platform: process.platform,
      tegoContractVersion: "0.0.0",
    },
  });
  const prepared = new Map<ArtifactDigest, PreparedArtifact>();
  try {
    for (const path of paths) {
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isFile()) {
        throw new Error("Prepared artifact path must identify a regular file");
      }
      const digest = await digestFile(canonical);
      await drivers.artifacts.put(digest, createReadStream(canonical));
      await service.validate({ digest });
      const artifact = await cache.prepare({ digest });
      if (prepared.has(digest)) {
        await cache.release(digest);
      } else {
        prepared.set(digest, artifact);
      }
    }
    return { artifacts: Object.freeze([...prepared.values()]), cache };
  } catch (error) {
    await Promise.allSettled([...prepared.keys()].map(async (digest) => cache.release(digest)));
    await cache.close();
    throw error;
  }
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function hasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function remoteTargetKey(target: RemoteComponentActivation["target"]): string {
  return [
    target.instanceId,
    target.deploymentGeneration,
    target.artifactDigest,
    target.executor.id,
    target.executor.workerId ?? "",
  ]
    .map((field) => `${field.length}:${field}`)
    .join("");
}

const RETRYABLE_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);
const INITIAL_RECONNECT_DELAY_MS = 50;
const MAXIMUM_RECONNECT_DELAY_MS = 2_000;

function reconnectDelay(attempt: number): number {
  return Math.min(
    INITIAL_RECONNECT_DELAY_MS * 2 ** Math.min(attempt, 6),
    MAXIMUM_RECONNECT_DELAY_MS,
  );
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof DiagnosticError) {
    return (
      error.diagnostic.code === "PROTOCOL_HANDSHAKE_TIMEOUT" ||
      error.diagnostic.code === "WORKER_HEARTBEAT_EXPIRED" ||
      error.diagnostic.code === "WORKER_TRANSPORT_ERROR"
    );
  }
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code !== undefined && RETRYABLE_NETWORK_CODES.has(code)) return true;
  return (
    error instanceof Error &&
    /closed during handshake|opening handshake has timed out|socket hang up/iu.test(error.message)
  );
}

async function waitForSessionLoss(
  session: WorkerSession,
  signal: AbortSignal | undefined,
): Promise<"aborted" | "lost"> {
  if (hasAborted(signal)) return "aborted";
  if (session.state !== "ready") return "lost";
  return await new Promise<"aborted" | "lost">((resolve) => {
    let removeState = (): void => undefined;
    const finish = (outcome: "aborted" | "lost"): void => {
      removeState();
      signal?.removeEventListener("abort", aborted);
      resolve(outcome);
    };
    removeState = session.onStateChange((state) => {
      if (state !== "ready") finish("lost");
    });
    const aborted = (): void => finish("aborted");
    signal?.addEventListener("abort", aborted, { once: true });
    if (hasAborted(signal)) aborted();
    else if (session.state !== "ready") finish("lost");
  });
}

async function waitForReconnect(
  drivers: RuntimeDrivers,
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (hasAborted(signal)) return false;
  try {
    await drivers.clock.sleep(delayMs, signal);
    return !hasAborted(signal);
  } catch (error) {
    if (hasAborted(signal)) return false;
    throw error;
  }
}

export async function runWorkerProcess(
  command: WorkerStartCommand,
  options: WorkerProcessOptions = {},
): Promise<void> {
  await mkdir(command.dataDirectory, { recursive: true, mode: 0o700 });
  const workerId = parseWorkerId(command.workerId);
  const drivers = await createLocalDrivers({ dataDirectory: command.dataDirectory });
  let prepared: Awaited<ReturnType<typeof prepareArtifacts>> | undefined;
  let runtime: WorkerRuntime | undefined;
  let endpoint: ReturnType<typeof createWorkerEndpoint> | undefined;
  let listener: WebSocketListener | undefined;
  let session: WorkerSession | undefined;
  let thread: ThreadExecutor | undefined;
  let processExecutor: ProcessExecutor | undefined;
  const componentSessions = new Map<
    string,
    {
      readonly activation: RemoteComponentActivation;
      readonly executor: Executor;
      readonly session: ComponentSandboxSession;
      readonly release: () => void;
    }
  >();
  const cleanupErrors: unknown[] = [];
  try {
    await openWorkerDrivers(drivers);
    prepared = await prepareArtifacts(command.prepare, drivers, command.dataDirectory);
    const selection = createPreparedArtifactSelection(prepared.artifacts, `worker-${workerId}`);
    thread = new ThreadExecutor({
      id: `${workerId}:thread`,
      clock: drivers.clock,
      resolveComponent: (request) =>
        selection.resolveComponent(request, { id: `${workerId}:thread`, type: "thread" }),
      remoteWorkerIsolation: true,
      secretProvider: drivers.secrets,
    });
    processExecutor = new ProcessExecutor({
      id: `${workerId}:process`,
      clock: drivers.clock,
      processHost: drivers.processHost,
      resolveComponent: (request) =>
        selection.resolveComponent(request, { id: `${workerId}:process`, type: "process" }),
      remoteWorkerIsolation: true,
      secretProvider: drivers.secrets,
    });
    const capabilities = await Promise.all([thread.probe(), processExecutor.probe()]);
    runtime = new WorkerRuntime({
      workerId,
      clock: drivers.clock,
      attemptStore: new StateRemoteAttemptStore({ state: drivers.state, workerId }),
      preparedArtifacts: () => selection.digests,
      selectExecutor: (request) => {
        const active = componentSessions.get(remoteTargetKey(request.target));
        if (
          active === undefined ||
          active.activation.bindingFingerprint !== request.binding.fingerprint
        ) {
          throw new Error("Prepared local Worker component activation is unavailable");
        }
        return active.executor;
      },
      validateAssignment: selection.validateAssignment,
      validateActivation: (activation) => {
        const rejection = selection.validateActivation(activation);
        if (rejection !== undefined) throw new Error(rejection.message);
      },
      activateComponent: async (activation) => {
        const key = remoteTargetKey(activation.target);
        if (componentSessions.has(key)) {
          throw new Error("Remote component activation is already materialized");
        }
        const isolation = selection.selectActivationExecutorKind(activation);
        const boundaries = createComponentBoundaries({
          invoke: (invocation) => {
            const activeRuntime = runtime;
            if (activeRuntime === undefined) {
              throw new Error("Worker capability routing is unavailable");
            }
            return activeRuntime.invokeMainCapability({
              invocationId: invocation.invocationId,
              bindingFingerprint: activation.bindingFingerprint,
              target: activation.target,
              invocation,
            });
          },
        });
        const registration = boundaries.capability.register(activation.capabilityDefinitions);
        if (!registration.ok) {
          boundaries.capability.clear();
          throw new Error(
            registration.diagnostics[0]?.message ??
              "Remote component capability definitions are invalid",
          );
        }
        const component = selection.resolveActivation(activation);
        let componentSession: ComponentSandboxSession | undefined;
        try {
          componentSession =
            isolation === "thread"
              ? await createThreadComponentSession({
                  target: activation.target,
                  identity: activation.identity,
                  component,
                  executorOptions: {
                    id: `${workerId}:thread`,
                    clock: drivers.clock,
                    resolveComponent: async () => component,
                    remoteWorkerIsolation: true,
                    secretProvider: drivers.secrets,
                    capabilityBoundary: boundaries.capability,
                  },
                })
              : await createProcessComponentSession({
                  target: activation.target,
                  identity: activation.identity,
                  component,
                  executorOptions: {
                    id: `${workerId}:process`,
                    clock: drivers.clock,
                    processHost: drivers.processHost,
                    resolveComponent: async () => component,
                    remoteWorkerIsolation: true,
                    secretProvider: drivers.secrets,
                    capabilityBoundary: boundaries.capability,
                  },
                });
          const activeSession = componentSession;
          componentSessions.set(key, {
            activation: structuredClone(activation),
            executor: createWorkerLocalExecutor(activeSession),
            session: activeSession,
            release: () => boundaries.capability.clear(),
          });
        } catch (error) {
          await componentSession?.close().catch(() => undefined);
          boundaries.capability.clear();
          throw error;
        }
      },
      drainComponent: async (activation) => {
        const active = componentSessions.get(remoteTargetKey(activation.target));
        if (
          active === undefined ||
          active.activation.bindingFingerprint !== activation.bindingFingerprint
        ) {
          throw new Error("Remote component activation is unavailable for drain");
        }
        await active.session.drainLifecycle({});
      },
      stopComponent: async (activation) => {
        const key = remoteTargetKey(activation.target);
        const active = componentSessions.get(key);
        if (
          active === undefined ||
          active.activation.bindingFingerprint !== activation.bindingFingerprint
        ) {
          throw new Error("Remote component activation is unavailable for stop");
        }
        try {
          await active.session.close();
        } finally {
          active.release();
          componentSessions.delete(key);
        }
      },
      invokeCapability: (request: RemoteCapabilityInvocation) => {
        const active = componentSessions.get(remoteTargetKey(request.target));
        if (
          active === undefined ||
          active.activation.bindingFingerprint !== request.bindingFingerprint
        ) {
          throw new Error("Remote capability provider activation is unavailable");
        }
        return active.session.invokeCapability(request.invocation);
      },
    });
    await runtime.initialize();
    endpoint = createWorkerEndpoint({
      credential: command.credential,
      workerId,
      registration: {
        labels: command.labels,
        resources: command.resources,
        executors: capabilities.map((capability) => capability.type),
        preparedArtifacts: selection.digests,
      },
    });

    if (command.direction === "listen") {
      listener = await listenForWorker({
        endpoint,
        host: command.host,
        port: command.port,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onSession: async (accepted) => runtime?.attach(accepted),
      });
      await options.onReady?.({
        type: "worker.ready",
        pid: process.pid,
        direction: command.direction,
        url: listener.url.href,
        workerId,
        executors: capabilities,
      });
      await waitForAbort(options.signal);
    } else {
      const url = new URL(command.url);
      let retryAttempt = 0;
      let readinessEmitted = false;
      for (;;) {
        if (hasAborted(options.signal)) break;
        let retryableAttachRace = false;
        try {
          session = await connectWorker({
            endpoint,
            url,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          await session.ready;
          if (session.state !== "ready") {
            retryableAttachRace = true;
            throw new Error("Worker session closed before runtime attachment");
          }
          try {
            await runtime.attach(session);
          } catch (error) {
            retryableAttachRace = session.state !== "ready";
            throw error;
          }
          retryAttempt = 0;
          if (!readinessEmitted) {
            await options.onReady?.({
              type: "worker.ready",
              pid: process.pid,
              direction: command.direction,
              url: url.href,
              workerId,
              executors: capabilities,
            });
            readinessEmitted = true;
          }
          const outcome = await waitForSessionLoss(session, options.signal);
          await session.close();
          session = undefined;
          if (outcome === "aborted") break;
        } catch (error) {
          await session?.close().catch(() => undefined);
          session = undefined;
          if (hasAborted(options.signal)) break;
          if (!retryableAttachRace && !isRetryableNetworkError(error)) throw error;
        }
        if (!(await waitForReconnect(drivers, reconnectDelay(retryAttempt), options.signal))) {
          break;
        }
        retryAttempt += 1;
      }
    }
  } finally {
    const settle = async (operation: () => Promise<void> | undefined): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await settle(async () => runtime?.close());
    for (const active of componentSessions.values()) {
      await settle(async () => active.session.close());
      active.release();
    }
    componentSessions.clear();
    await settle(async () => listener?.close());
    await settle(async () => session?.close());
    await settle(async () => endpoint?.close());
    await settle(async () => thread?.close());
    await settle(async () => processExecutor?.close());
    if (prepared !== undefined) {
      const resources = prepared;
      await settle(async () => {
        await Promise.all(
          resources.artifacts.map(async (artifact) => resources.cache.release(artifact.digest)),
        );
      });
      await settle(async () => resources.cache.close());
    }
    await settle(async () => closeWorkerDrivers(drivers));
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Worker process cleanup failed");
  }
}
