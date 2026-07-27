import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  assertExecutionBindingMatches,
  type CapabilityBinding,
  type CapabilityDefinition,
  type ComponentCapabilityInvocation,
  createExecutionBinding,
  DiagnosticError,
  type ExecutionBinding,
  type JsonObject,
  type JsonValue,
  parseApplicationId,
  parseArtifactDigest,
  parseCapabilityName,
  parseNodeId,
  parsePermissionSet,
  parsePluginDeployment,
  parsePluginInstallation,
  parseRuntimeId,
  parseWorkerId,
  type RunTaskRequest,
  type Runtime,
  type RuntimeAuthority,
  type RuntimeConfiguration,
  type RuntimeDrivers,
  runtimeDiagnostic,
  type StateTransaction,
  type TaskExecutionTarget,
} from "@tegojs/contracts";
import { createLocalDrivers } from "@tegojs/drivers-local";
import { createPostgresDrivers } from "@tegojs/drivers-postgres";
import {
  ArtifactService,
  type CapabilityRoute,
  CapabilityRouter,
  ComponentEffects,
  type ComponentInstanceIdentity,
  type ComponentLifecycleHost,
  ComponentRegistry,
  canonicalJsonBytes,
  createRuntimeHost,
  type PlacementWorker,
  PreparedArtifactCache,
  parseActivation,
  Reconciler,
  TaskService,
} from "@tegojs/runtime";
import {
  createMainEndpoint,
  listenForMain,
  RemoteExecutor,
  StateWorkerEpochAllocator,
  type WorkerSession,
} from "@tegojs/transport-websocket";
import type { LocalArtifactIngress } from "../control/server.js";
import {
  assertLocalComponentManifestSupported,
  canonicalJsonEqual,
  LocalComponentSessionHost,
} from "./local-component-session-host.js";
import { LocalComponentSessionRegistry } from "./local-component-session-registry.js";
import { StateRemoteAttemptStore } from "./remote-attempt-store.js";
import {
  RemoteComponentSessionHost,
  remoteComponentExecutorId,
} from "./remote-component-session-host.js";

export interface NodeWorkerListenerOptions {
  readonly credential: string;
  readonly host: string;
  readonly port: number;
  readonly workerId: string;
}

export interface CreateNodeRuntimeHostOptions {
  readonly applicationId: string;
  readonly dataDirectory: string;
  readonly mode: RuntimeConfiguration["mode"];
  readonly nodeId: string;
  readonly runtimeId: string;
  readonly postgresUrl?: string;
  readonly signal?: AbortSignal;
  readonly worker?: NodeWorkerListenerOptions;
}

export interface NodeRuntimeHost {
  readonly runtime: Runtime;
  readonly artifactIngress: LocalArtifactIngress;
  startWorkerListener(): Promise<string | undefined>;
}

interface OwnedWorkerListener {
  readonly url: URL;
  close(): Promise<void>;
}

class WorkerListenerRollbackError extends AggregateError {}

export class NodeWorkerListenerOwner {
  readonly #bind: () => Promise<OwnedWorkerListener>;
  readonly #closedDuringBind = new Error("Worker listener owner closed during bind");
  #listener: OwnedWorkerListener | undefined;
  #listenerStart: Promise<OwnedWorkerListener> | undefined;
  #closed = false;

  constructor(bind: () => Promise<OwnedWorkerListener>) {
    this.#bind = bind;
  }

  async start(): Promise<string> {
    if (this.#closed) throw new Error("Worker listener owner is closed");
    this.#listenerStart ??= this.#bind().then(async (candidate) => {
      if (this.#closed) {
        try {
          await candidate.close();
        } catch (error) {
          throw new WorkerListenerRollbackError([error], "Worker listener rollback failed");
        }
        throw this.#closedDuringBind;
      }
      this.#listener = candidate;
      return candidate;
    });
    return (await this.#listenerStart).url.href;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#listener !== undefined) {
      await this.#listener.close();
      return;
    }
    if (this.#listenerStart === undefined) return;
    try {
      await this.#listenerStart;
    } catch (error) {
      if (error instanceof WorkerListenerRollbackError) throw error;
    }
  }
}

async function digestFile(path: string): Promise<ReturnType<typeof parseArtifactDigest>> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return parseArtifactDigest(`sha256:${hash.digest("hex")}`);
}

export async function createNodeRuntimeHost(
  options: CreateNodeRuntimeHostOptions,
): Promise<NodeRuntimeHost> {
  if (
    options.worker !== undefined &&
    (options.worker.credential.trim().length === 0 ||
      Buffer.byteLength(options.worker.credential, "utf8") > 4_096)
  ) {
    throw new TypeError("Worker listener credential is invalid");
  }
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  const local = await createLocalDrivers({ dataDirectory: options.dataDirectory });
  let drivers: RuntimeDrivers = local;
  if (options.postgresUrl !== undefined) {
    const postgres = createPostgresDrivers({
      connectionString: options.postgresUrl,
      namespace: options.runtimeId,
    });
    drivers = {
      ...local,
      artifacts: postgres.artifacts,
      coordination: postgres.coordination,
      state: postgres.state,
    };
  }

  const configuration: RuntimeConfiguration = {
    applicationId: parseApplicationId(options.applicationId),
    mode: options.mode,
    nodeId: parseNodeId(options.nodeId),
    runtimeId: parseRuntimeId(options.runtimeId),
  };
  const artifactService = new ArtifactService({
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
  const localArtifactGate = {
    validate: async (request: Parameters<ArtifactService["validate"]>[0]) => {
      const artifact = await artifactService.validate(request);
      assertLocalComponentManifestSupported(artifact.manifest);
      return artifact;
    },
  };
  const preparedArtifacts = new PreparedArtifactCache({
    artifacts: drivers.artifacts,
    root: join(options.dataDirectory, "prepared"),
  });
  const componentRegistry = new ComponentRegistry();
  const sessionRegistry = new LocalComponentSessionRegistry(options.runtimeId);
  let capabilityRouter: CapabilityRouter | undefined;
  const componentHost = new LocalComponentSessionHost({
    nodeId: options.nodeId,
    runtimeId: options.runtimeId,
    clock: drivers.clock,
    processHost: drivers.processHost,
    secretProvider: drivers.secrets,
    registry: sessionRegistry,
    resolveExecutionBinding: (binding, target) =>
      drivers.state.transact({}, async (transaction) =>
        resolveExecutionBinding(
          transaction,
          {
            applicationId: binding.deployment.applicationId,
            pluginId: binding.deployment.pluginId,
            componentId: binding.component.componentId,
          },
          target,
        ),
      ),
    invokeCapability: (consumer, invocation) => {
      const router = capabilityRouter;
      if (router === undefined) throw new Error("Capability router is unavailable");
      return router.invoke(consumer, invocation);
    },
  });
  const configuredWorkerId =
    options.worker === undefined ? undefined : parseWorkerId(options.worker.workerId);
  let remoteExecutor: RemoteExecutor | undefined;
  const remoteComponentHost = new RemoteComponentSessionHost({
    registry: sessionRegistry,
    resolveExecutor: (workerId) => (workerId === configuredWorkerId ? remoteExecutor : undefined),
    runtimeId: options.runtimeId,
  });
  const lifecycleHost: ComponentLifecycleHost = {
    start: (binding) =>
      binding.executor === "remote"
        ? remoteComponentHost.start(binding)
        : componentHost.start(binding),
    drain: (binding) =>
      binding.executor === "remote"
        ? remoteComponentHost.drain(binding)
        : componentHost.drain(binding),
    stop: (binding) =>
      binding.executor === "remote"
        ? remoteComponentHost.stop(binding)
        : componentHost.stop(binding),
  };
  const resolveExecutionBinding = async (
    transaction: StateTransaction,
    request: Pick<RunTaskRequest, "applicationId" | "componentId" | "pluginId">,
    target: TaskExecutionTarget,
  ): Promise<ExecutionBinding> => {
    const durableDeployment = await transaction.get({
      namespace: "tego",
      collection: "deployments",
      id: `${request.applicationId}/${request.pluginId}`,
    });
    if (durableDeployment === undefined) {
      throw new Error("Task deployment is unavailable while building its execution binding");
    }
    const deployment = parsePluginDeployment(durableDeployment.value);
    if (
      deployment.applicationId !== request.applicationId ||
      deployment.pluginId !== request.pluginId ||
      deployment.state !== "active" ||
      deployment.generation !== target.deploymentGeneration ||
      deployment.artifactDigest !== target.artifactDigest
    ) {
      throw new Error("Task deployment does not match its immutable execution target");
    }
    const durableInstallation = await transaction.get({
      namespace: "tego",
      collection: "installations",
      id: `${deployment.pluginId}@${deployment.version}@${deployment.artifactDigest}`,
    });
    if (durableInstallation === undefined) {
      throw new Error("Task installation is unavailable while building its execution binding");
    }
    const installation = parsePluginInstallation(durableInstallation.value);
    const component = installation.manifest.components.find(
      (candidate) => candidate.componentId === request.componentId,
    );
    if (
      installation.pluginId !== deployment.pluginId ||
      installation.version !== deployment.version ||
      installation.digest !== deployment.artifactDigest ||
      component === undefined ||
      !component.executors.includes(target.executor.type)
    ) {
      throw new Error("Task component does not match its immutable execution target");
    }
    const durableInstance = await transaction.get({
      namespace: "tego",
      collection: "component-instances",
      id: target.instanceId,
    });
    const instance =
      durableInstance?.value !== null &&
      typeof durableInstance?.value === "object" &&
      !Array.isArray(durableInstance.value)
        ? (durableInstance.value as JsonObject)
        : undefined;
    if (
      instance === undefined ||
      instance.applicationId !== request.applicationId ||
      instance.pluginId !== request.pluginId ||
      instance.componentId !== request.componentId ||
      instance.deploymentGeneration !== target.deploymentGeneration ||
      instance.artifactDigest !== target.artifactDigest ||
      instance.instanceId !== target.instanceId
    ) {
      throw new Error("Task component instance does not match its immutable execution target");
    }

    const capabilityBindings: CapabilityBinding[] = [];
    const capabilityDefinitions: CapabilityDefinition[] = [];
    for await (const record of transaction.scan({
      namespace: "tego",
      collection: "capability-bindings",
      idPrefix: `${request.applicationId}/${request.pluginId}/`,
    })) {
      const value =
        record.value !== null && typeof record.value === "object" && !Array.isArray(record.value)
          ? (record.value as JsonObject)
          : undefined;
      const consumer =
        value?.consumer !== null &&
        typeof value?.consumer === "object" &&
        !Array.isArray(value.consumer)
          ? (value.consumer as JsonObject)
          : undefined;
      const provider =
        value?.provider !== null &&
        typeof value?.provider === "object" &&
        !Array.isArray(value.provider)
          ? (value.provider as JsonObject)
          : undefined;
      if (
        consumer?.applicationId !== request.applicationId ||
        consumer.pluginId !== request.pluginId ||
        value?.deploymentGeneration !== deployment.generation ||
        typeof value.capability !== "string" ||
        typeof provider?.applicationId !== "string" ||
        typeof provider.pluginId !== "string"
      ) {
        continue;
      }
      const providerDeploymentRecord = await transaction.get({
        namespace: "tego",
        collection: "deployments",
        id: `${provider.applicationId}/${provider.pluginId}`,
      });
      if (providerDeploymentRecord === undefined) {
        throw new Error("Capability provider deployment is unavailable");
      }
      const providerDeployment = parsePluginDeployment(providerDeploymentRecord.value);
      const providerInstallationRecord = await transaction.get({
        namespace: "tego",
        collection: "installations",
        id: `${providerDeployment.pluginId}@${providerDeployment.version}@${providerDeployment.artifactDigest}`,
      });
      if (providerInstallationRecord === undefined) {
        throw new Error("Capability provider installation is unavailable");
      }
      const providerInstallation = parsePluginInstallation(providerInstallationRecord.value);
      const provision = providerInstallation.manifest.capabilities.provides.find(
        (candidate) => candidate.name === value.capability,
      );
      if (provision === undefined) {
        throw new Error("Capability provider no longer provides the durable binding");
      }
      capabilityBindings.push({
        capability: {
          name: parseCapabilityName(provision.name),
          protocolVersion: provision.protocolVersion,
        },
        providerDeployment: {
          applicationId: providerDeployment.applicationId,
          pluginId: providerDeployment.pluginId,
        },
      });
      capabilityDefinitions.push({
        identity: {
          name: parseCapabilityName(provision.name),
          protocolVersion: provision.protocolVersion,
        },
        methods: provision.methods,
        requestSchema: provision.requestSchema,
        responseSchema: provision.responseSchema,
      });
    }
    return createExecutionBinding(
      {
        applicationId: request.applicationId,
        pluginId: request.pluginId,
        componentId: request.componentId,
        target,
      },
      {
        configuration: deployment.configuration,
        permissionGrants: deployment.permissionGrants,
        capabilityDefinitions,
        capabilityBindings,
      },
    );
  };
  const loadCapabilityRoute = async (
    consumer: ComponentInstanceIdentity,
    identity: ComponentCapabilityInvocation["identity"],
  ): Promise<CapabilityRoute> =>
    drivers.state.transact({}, async (transaction) => {
      const consumerInstanceRecord = await transaction.get({
        namespace: "tego",
        collection: "component-instances",
        id: consumer.target.instanceId,
      });
      const consumerInstance =
        consumerInstanceRecord?.value !== null &&
        typeof consumerInstanceRecord?.value === "object" &&
        !Array.isArray(consumerInstanceRecord.value)
          ? (consumerInstanceRecord.value as JsonObject)
          : undefined;
      if (
        consumerInstance === undefined ||
        consumerInstance.applicationId !== consumer.applicationId ||
        consumerInstance.pluginId !== consumer.pluginId ||
        consumerInstance.componentId !== consumer.componentId ||
        consumerInstance.deploymentGeneration !== consumer.target.deploymentGeneration ||
        consumerInstance.artifactDigest !== consumer.target.artifactDigest ||
        consumerInstance.lifecycle !== "ready" ||
        parseActivation(
          Object.hasOwn(consumerInstance, "activation") ? consumerInstance.activation : "1",
        ) !== consumer.activation
      ) {
        throw new Error("Capability consumer is not the exact durable ready activation");
      }
      const consumerBinding = await resolveExecutionBinding(transaction, consumer, consumer.target);
      if (consumerBinding.fingerprint !== consumer.bindingFingerprint) {
        throw new Error("Capability consumer immutable binding changed");
      }
      const binding = consumerBinding.capabilityBindings.find(
        (candidate) =>
          candidate.capability.name === identity.name &&
          candidate.capability.protocolVersion === identity.protocolVersion,
      );
      if (binding === undefined) throw new Error("Capability has no durable consumer binding");
      const providerDeploymentRecord = await transaction.get({
        namespace: "tego",
        collection: "deployments",
        id: `${binding.providerDeployment.applicationId}/${binding.providerDeployment.pluginId}`,
      });
      if (providerDeploymentRecord === undefined) {
        throw new Error("Capability provider deployment is unavailable");
      }
      const providerDeployment = parsePluginDeployment(providerDeploymentRecord.value);
      if (
        providerDeployment.applicationId !== binding.providerDeployment.applicationId ||
        providerDeployment.pluginId !== binding.providerDeployment.pluginId ||
        providerDeployment.state !== "active"
      ) {
        throw new Error("Capability provider deployment is not active");
      }
      const providerInstallationRecord = await transaction.get({
        namespace: "tego",
        collection: "installations",
        id: `${providerDeployment.pluginId}@${providerDeployment.version}@${providerDeployment.artifactDigest}`,
      });
      if (providerInstallationRecord === undefined) {
        throw new Error("Capability provider installation is unavailable");
      }
      const providerInstallation = parsePluginInstallation(providerInstallationRecord.value);
      const provision = providerInstallation.manifest.capabilities.provides.find(
        (candidate) =>
          candidate.name === identity.name &&
          candidate.protocolVersion === identity.protocolVersion,
      );
      if (provision === undefined) {
        throw new Error("Capability provider provision no longer matches the durable binding");
      }
      const providerComponent = providerInstallation.manifest.components.find(
        (candidate) => candidate.componentId === provision.componentId,
      );
      if (providerComponent?.kind !== "task") {
        throw new Error("Capability provider component must be a task");
      }
      const providerSession = sessionRegistry.resolveComponent(
        providerDeployment.applicationId,
        providerDeployment.pluginId,
        providerComponent.componentId,
        (target) =>
          componentRegistry.get(target.instanceId)?.state === "active" &&
          componentRegistry.get(target.instanceId)?.acceptingTasks === true,
      );
      const providerInstanceRecord = await transaction.get({
        namespace: "tego",
        collection: "component-instances",
        id: providerSession.target.instanceId,
      });
      const providerInstance =
        providerInstanceRecord?.value !== null &&
        typeof providerInstanceRecord?.value === "object" &&
        !Array.isArray(providerInstanceRecord.value)
          ? (providerInstanceRecord.value as JsonObject)
          : undefined;
      const providerActivation =
        providerInstance === undefined
          ? undefined
          : parseActivation(
              Object.hasOwn(providerInstance, "activation") ? providerInstance.activation : "1",
            );
      if (
        providerInstance === undefined ||
        providerInstance.applicationId !== providerDeployment.applicationId ||
        providerInstance.pluginId !== providerDeployment.pluginId ||
        providerInstance.componentId !== providerComponent.componentId ||
        providerInstance.deploymentGeneration !== providerDeployment.generation ||
        providerInstance.artifactDigest !== providerDeployment.artifactDigest ||
        providerInstance.lifecycle !== "ready" ||
        providerActivation === undefined
      ) {
        throw new Error("Capability provider is not an exact durable ready activation");
      }
      const providerBinding = await resolveExecutionBinding(
        transaction,
        {
          applicationId: providerDeployment.applicationId,
          pluginId: providerDeployment.pluginId,
          componentId: providerComponent.componentId,
        },
        providerSession.target,
      );
      const routeRevision = createHash("sha256")
        .update(
          canonicalJsonBytes({
            consumer,
            consumerBindingFingerprint: consumerBinding.fingerprint,
            binding,
            providerTarget: providerSession.target,
            providerActivation,
            providerBindingFingerprint: providerBinding.fingerprint,
            consumerInstanceRevision: consumerInstanceRecord?.revision ?? "",
            providerInstanceRevision: providerInstanceRecord?.revision ?? "",
            providerDeploymentGeneration: providerDeployment.generation,
          }),
        )
        .digest("hex");
      return {
        consumer,
        consumerBindingFingerprint: consumerBinding.fingerprint,
        permissionGrants: consumerBinding.permissionGrants,
        binding,
        provision: {
          identity: {
            name: parseCapabilityName(provision.name),
            protocolVersion: provision.protocolVersion,
          },
          componentId: provision.componentId,
          methods: provision.methods,
          requestSchema: provision.requestSchema,
          responseSchema: provision.responseSchema,
        },
        provider: {
          applicationId: providerDeployment.applicationId,
          pluginId: providerDeployment.pluginId,
          componentId: providerComponent.componentId,
          target: providerSession.target,
          activation: providerActivation,
          bindingFingerprint: providerBinding.fingerprint,
        },
        routeRevision,
      };
    });
  capabilityRouter = new CapabilityRouter({
    resolve: (consumer, call) => loadCapabilityRoute(consumer, call.identity),
    revalidate: async (route) =>
      (await loadCapabilityRoute(route.consumer, route.provision.identity)).routeRevision ===
      route.routeRevision,
    dispatch: async (route, invocation) => {
      const provider = sessionRegistry.resolveExact(route.provider.target).executor as {
        invokeCapability?: (request: ComponentCapabilityInvocation) => Promise<JsonValue>;
      };
      if (typeof provider.invokeCapability !== "function") {
        throw new Error("Capability provider executor cannot invoke provider hooks");
      }
      return provider.invokeCapability(invocation);
    },
  });
  const tasks = new TaskService({
    state: drivers.state,
    clock: drivers.clock,
    selectExecutor: async (request, target, _signal, persistedBinding) => {
      const selection =
        target === undefined
          ? sessionRegistry.resolveFresh(
              request,
              (candidate) =>
                componentRegistry.get(candidate.instanceId)?.state === "active" &&
                componentRegistry.get(candidate.instanceId)?.acceptingTasks === true,
            )
          : sessionRegistry.resolveExact(target);
      const binding =
        persistedBinding === undefined
          ? await drivers.state.transact({}, async (transaction) =>
              resolveExecutionBinding(transaction, request, selection.target),
            )
          : assertExecutionBindingMatches(
              {
                applicationId: request.applicationId,
                pluginId: request.pluginId,
                componentId: request.componentId,
                target: selection.target,
              },
              persistedBinding,
            );
      return {
        target: selection.target,
        binding,
        executor: selection.executor,
      };
    },
  });
  let activeWorkerAuthority: RuntimeAuthority | undefined;
  let requestedWorkerAuthority: RuntimeAuthority | undefined;
  let authorityGeneration = 0;
  let allocatedWorkerAuthorityGeneration: number | undefined;
  const mainEndpoint =
    options.worker === undefined
      ? undefined
      : createMainEndpoint({
          credential: options.worker.credential,
          workerId: parseWorkerId(options.worker.workerId),
          epochAllocator: {
            next: async (workerId) => {
              const authority = activeWorkerAuthority;
              const generation = authorityGeneration;
              if (authority === undefined || !sameAuthority(authority, requestedWorkerAuthority)) {
                throw new Error("Only the authoritative Main can register a Worker session");
              }
              const epoch = await new StateWorkerEpochAllocator({
                state: drivers.state,
                fencing: authority,
              }).next(workerId);
              if (
                generation !== authorityGeneration ||
                !sameAuthority(authority, activeWorkerAuthority) ||
                !sameAuthority(authority, requestedWorkerAuthority)
              ) {
                throw new Error("Main authority changed during Worker session registration");
              }
              allocatedWorkerAuthorityGeneration = generation;
              return epoch;
            },
          },
          assertRegistrationPublishable: () => {
            if (
              activeWorkerAuthority === undefined ||
              allocatedWorkerAuthorityGeneration !== authorityGeneration ||
              !sameAuthority(activeWorkerAuthority, requestedWorkerAuthority)
            ) {
              throw new Error("Main authority changed before Worker session publication");
            }
            allocatedWorkerAuthorityGeneration = undefined;
          },
          clock: drivers.clock,
        });
  const placementWorkers: PlacementWorker[] = [];
  let attachedWorkerSession: WorkerSession | undefined;
  let attachedWorkerUnsubscribe: (() => void) | undefined;
  let attachmentGeneration = 0;
  let workerLifecycleTail = Promise.resolve();
  let activeReconciler: Reconciler | undefined;
  let reportReconcilerBackgroundError: ((error: unknown) => void) | undefined;
  const enqueueWorkerLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const execution = workerLifecycleTail.then(operation, operation);
    workerLifecycleTail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  };
  const sameAuthority = (
    left: RuntimeAuthority | undefined,
    right: RuntimeAuthority | undefined,
  ): boolean =>
    left?.resource === right?.resource &&
    left?.epoch === right?.epoch &&
    (left !== undefined) === (right !== undefined);
  const removePlacement = (session: WorkerSession): void => {
    if (attachedWorkerSession !== session) return;
    attachmentGeneration += 1;
    attachedWorkerSession = undefined;
    attachedWorkerUnsubscribe?.();
    attachedWorkerUnsubscribe = undefined;
    placementWorkers.splice(0);
    const reconciler = activeReconciler;
    if (reconciler !== undefined && activeWorkerAuthority !== undefined) {
      void reconciler.wake().catch((error: unknown) => reportReconcilerBackgroundError?.(error));
    }
  };
  const attachWorkerSession = (session: WorkerSession): Promise<void> =>
    enqueueWorkerLifecycle(async () => {
      const executor = remoteExecutor;
      const authority = activeWorkerAuthority;
      const currentAuthorityGeneration = authorityGeneration;
      if (
        mainEndpoint === undefined ||
        configuredWorkerId === undefined ||
        executor === undefined ||
        authority === undefined ||
        !sameAuthority(authority, requestedWorkerAuthority)
      ) {
        throw new Error("Remote Worker runtime is not owned by this Main");
      }
      const registration = mainEndpoint.registration(configuredWorkerId);
      if (
        registration === undefined ||
        registration.workerId !== configuredWorkerId ||
        mainEndpoint.current(configuredWorkerId) !== session
      ) {
        throw new Error("Remote Worker registration is unavailable");
      }
      const generation = ++attachmentGeneration;
      const unsubscribe = session.onStateChange((state) => {
        if (state !== "ready") {
          void enqueueWorkerLifecycle(async () => removePlacement(session)).catch(
            (error: unknown) => reportReconcilerBackgroundError?.(error),
          );
        }
      });
      const workerPermission = parsePermissionSet([
        {
          kind: "worker",
          labels: registration.labels,
          resources: registration.resources,
        },
      ])[0];
      if (workerPermission?.kind !== "worker") {
        throw new Error("Remote Worker registration resources are invalid");
      }
      await executor.attach(session);
      if (!(await executor.probe()).available) {
        throw new Error("Remote Worker executor is unavailable after session attachment");
      }
      const executors = registration.executors.filter(
        (executor): executor is "process" | "thread" =>
          executor === "process" || executor === "thread",
      );
      if (
        generation !== attachmentGeneration ||
        currentAuthorityGeneration !== authorityGeneration ||
        !sameAuthority(authority, activeWorkerAuthority) ||
        !sameAuthority(authority, requestedWorkerAuthority) ||
        remoteExecutor !== executor ||
        mainEndpoint.current(configuredWorkerId) !== session ||
        session.state !== "ready" ||
        !session.available
      ) {
        unsubscribe();
        throw new Error("Remote Worker session was replaced during attachment");
      }
      attachedWorkerUnsubscribe?.();
      attachedWorkerUnsubscribe = unsubscribe;
      attachedWorkerSession = session;
      placementWorkers.splice(0, placementWorkers.length, {
        workerId: configuredWorkerId,
        labels: workerPermission.labels,
        resources: workerPermission.resources,
        executors,
        preparedArtifacts: registration.preparedArtifacts,
      });
      const reconciler = activeReconciler;
      if (reconciler !== undefined) {
        void (async () => {
          await reconciler.wake();
          if (
            generation === attachmentGeneration &&
            attachedWorkerSession === session &&
            session.state === "ready" &&
            session.available &&
            sameAuthority(authority, activeWorkerAuthority) &&
            remoteExecutor === executor
          ) {
            await tasks.recoverRemoteWorker(configuredWorkerId);
          }
        })().catch((error: unknown) => reportReconcilerBackgroundError?.(error));
      }
    });
  const setWorkerAuthority = (authority: RuntimeAuthority | undefined): Promise<void> => {
    const requested = authority === undefined ? undefined : structuredClone(authority);
    const generation = ++authorityGeneration;
    requestedWorkerAuthority = requested;
    return enqueueWorkerLifecycle(async () => {
      if (generation !== authorityGeneration) return;
      if (configuredWorkerId === undefined) {
        activeWorkerAuthority = requested;
        return;
      }
      if (sameAuthority(activeWorkerAuthority, requested)) return;
      const previousSession = attachedWorkerSession;
      const previousExecutor = remoteExecutor;
      activeWorkerAuthority = undefined;
      attachmentGeneration += 1;
      attachedWorkerSession = undefined;
      attachedWorkerUnsubscribe?.();
      attachedWorkerUnsubscribe = undefined;
      placementWorkers.splice(0);
      remoteExecutor = undefined;
      previousExecutor?.revokeAuthority();
      await previousSession?.close().catch(() => undefined);
      if (requested === undefined || generation !== authorityGeneration) return;
      remoteExecutor = new RemoteExecutor({
        id: remoteComponentExecutorId(configuredWorkerId),
        workerId: configuredWorkerId,
        clock: drivers.clock,
        attemptStore: new StateRemoteAttemptStore({
          state: drivers.state,
          workerId: configuredWorkerId,
          fencing: requested,
        }),
      });
      activeWorkerAuthority = requested;
    });
  };
  const listenerOwner =
    options.worker === undefined || mainEndpoint === undefined
      ? undefined
      : new NodeWorkerListenerOwner(() =>
          listenForMain({
            endpoint: mainEndpoint,
            host: options.worker?.host ?? "127.0.0.1",
            port: options.worker?.port ?? 0,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onSession: attachWorkerSession,
          }),
        );
  const workers = {
    count: () => placementWorkers.length,
    placements: () => structuredClone(placementWorkers),
    setAuthority: setWorkerAuthority,
    close: async () => {
      const errors: unknown[] = [];
      try {
        await setWorkerAuthority(undefined);
      } catch (error) {
        errors.push(error);
      }
      for (const close of [
        () => sessionRegistry.close(),
        () => listenerOwner?.close(),
        () => mainEndpoint?.close(),
        () => preparedArtifacts.close(),
      ]) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Worker listener cleanup failed");
    },
  };
  const runtime = createRuntimeHost(configuration, drivers, {
    artifactService,
    tasks,
    workers,
    createReconciler: (authority, context) => {
      reportReconcilerBackgroundError = context.onBackgroundError;
      activeReconciler = new Reconciler({
        artifactGate: localArtifactGate,
        authority,
        clock: drivers.clock,
        effects: new ComponentEffects({
          artifacts: preparedArtifacts,
          registry: componentRegistry,
          supportedExecutors:
            configuredWorkerId === undefined
              ? ["process", "thread"]
              : ["process", "thread", "remote"],
          host: lifecycleHost,
          authority: context.currentAuthority,
          resolveDeployment: async (effect) => {
            const durableDeployment = await drivers.state.read({
              namespace: "tego",
              collection: "deployments",
              id: `${effect.applicationId}/${effect.pluginId}`,
            });
            if (durableDeployment === undefined) return undefined;
            const deployment = parsePluginDeployment(durableDeployment.value);
            if (
              deployment.applicationId !== effect.applicationId ||
              deployment.pluginId !== effect.pluginId ||
              deployment.generation !== effect.deploymentGeneration ||
              deployment.artifactDigest !== effect.artifactDigest
            ) {
              return undefined;
            }
            const durableInstance = await drivers.state.read({
              namespace: "tego",
              collection: "component-instances",
              id: effect.instanceId,
            });
            const instance: Record<string, unknown> | undefined =
              durableInstance?.value !== null &&
              typeof durableInstance?.value === "object" &&
              !Array.isArray(durableInstance.value)
                ? (durableInstance.value as Record<string, unknown>)
                : undefined;
            if (
              instance === undefined ||
              instance.instanceId !== effect.instanceId ||
              parseActivation(Object.hasOwn(instance, "activation") ? instance.activation : "1") !==
                effect.activation ||
              instance.deploymentGeneration !== effect.deploymentGeneration
            ) {
              return undefined;
            }
            const durableInstallation = await drivers.state.read({
              namespace: "tego",
              collection: "installations",
              id: `${deployment.pluginId}@${deployment.version}@${deployment.artifactDigest}`,
            });
            if (durableInstallation === undefined) return undefined;
            const installation = parsePluginInstallation(durableInstallation.value);
            const artifact = await localArtifactGate.validate({
              digest: effect.artifactDigest,
            });
            if (
              installation.pluginId !== deployment.pluginId ||
              installation.version !== deployment.version ||
              installation.digest !== deployment.artifactDigest ||
              artifact.digest !== installation.digest ||
              !canonicalJsonEqual(artifact.manifest, installation.manifest)
            ) {
              return undefined;
            }
            return {
              deployment,
              artifact,
            };
          },
        }),
        state: drivers.state,
        workers: placementWorkers,
        onBackgroundError: context.onBackgroundError,
      });
      return activeReconciler;
    },
  });
  const artifactIngress: LocalArtifactIngress = {
    putPath: async (artifactPath) => {
      const resolved = await realpath(artifactPath);
      const metadata = await stat(resolved);
      if (!metadata.isFile()) {
        throw new DiagnosticError(
          runtimeDiagnostic({
            code: "ARTIFACT_PATH_INVALID",
            message: "Artifact path must identify a regular file",
            source: { kind: "artifact", id: resolved },
          }),
        );
      }
      const digest = await digestFile(resolved);
      await drivers.artifacts.put(digest, createReadStream(resolved));
      return digest;
    },
  };
  const startWorkerListener = async (): Promise<string | undefined> => {
    if (listenerOwner === undefined) return undefined;
    const status = await runtime.status();
    if (status.lifecycle !== "running") {
      throw new Error("Runtime must be running before the Worker listener binds");
    }
    return listenerOwner.start();
  };
  return {
    runtime,
    artifactIngress,
    startWorkerListener,
  };
}
