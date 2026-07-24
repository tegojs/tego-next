import {
  type Clock,
  type DeployPluginRequest,
  DiagnosticError,
  diagnosticCode,
  type InstallPluginRequest,
  type PersistedOperationJournalEntry,
  type PluginDeployment,
  type PluginDeploymentIdentity,
  type PluginDeploymentStatus,
  type PluginInstallation,
  parseDeployPluginRequest,
  parseInstallPluginRequest,
  parsePluginDeployment,
  parsePluginDeploymentIdentity,
  parsePluginDeploymentStatus,
  parsePluginInstallation,
  parseRunTaskRequest,
  parseTaskId,
  parseTaskRecord,
  type RunTaskRequest,
  type RuntimeAuthority,
  type RuntimeOperations,
  runtimeDiagnostic,
  type StateFencing,
  type StateKey,
  type StateStore,
  type StateTransaction,
  type TaskId,
  type TaskRecord,
} from "@tegojs/contracts";
import { satisfiesVersionRange } from "./capabilities/version.js";
import { validatePermissionGrant } from "./permissions/permission-set.js";

export interface RuntimeArtifactInstaller {
  install(request: InstallPluginRequest, authority?: RuntimeAuthority): Promise<PluginInstallation>;
}

export interface RuntimeTaskOperations {
  run(request: RunTaskRequest): Promise<TaskRecord>;
  status(taskId: TaskId): Promise<TaskRecord | undefined>;
  wait(taskId: TaskId): Promise<TaskRecord>;
  cancel(taskId: TaskId): Promise<TaskRecord>;
}

interface LocatedInstallation {
  readonly installation: PluginInstallation;
  readonly storageId: string;
}

export interface RuntimeOperationControllerOptions {
  readonly clock: Clock;
  readonly state?: StateStore;
  readonly artifactService?: RuntimeArtifactInstaller;
  readonly tasks?: RuntimeTaskOperations;
  readonly authority?: () => RuntimeAuthority | undefined;
  readonly wake?: (authority: RuntimeAuthority) => void | Promise<void>;
}

const deploymentKey = (identity: PluginDeploymentIdentity): StateKey<PluginDeployment> => ({
  namespace: "tego",
  collection: "deployments",
  id: `${identity.applicationId}/${identity.pluginId}`,
});

function conflictCode(error: unknown): string | undefined {
  return (
    diagnosticCode(error) ??
    (typeof error === "object" &&
    error !== null &&
    "diagnostic" in error &&
    typeof (error as { diagnostic?: { code?: unknown } }).diagnostic?.code === "string"
      ? (error as { diagnostic: { code: string } }).diagnostic.code
      : undefined)
  );
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function sameDesired(left: PluginDeployment, right: DeployPluginRequest): boolean {
  return (
    left.applicationId === right.applicationId &&
    left.pluginId === right.pluginId &&
    left.artifactDigest === right.artifactDigest &&
    left.essential === right.essential &&
    canonical(left.configuration) === canonical(right.configuration) &&
    canonical(left.permissionGrants) === canonical(right.permissionGrants) &&
    canonical(left.capabilityBindings) === canonical(right.capabilityBindings)
  );
}

export class RuntimeOperationController implements RuntimeOperations {
  readonly #clock: Clock;
  readonly #state: StateStore | undefined;
  readonly #artifacts: RuntimeArtifactInstaller | undefined;
  readonly #tasks: RuntimeTaskOperations | undefined;
  readonly #authority: () => RuntimeAuthority | undefined;
  readonly #wake: (authority: RuntimeAuthority) => void | Promise<void>;
  #available = false;
  #acceptingMutations = false;
  #recovered: readonly PersistedOperationJournalEntry[] = [];

  constructor(options: Clock | RuntimeOperationControllerOptions) {
    const normalized: RuntimeOperationControllerOptions =
      "now" in options ? { clock: options } : options;
    this.#clock = normalized.clock;
    this.#state = normalized.state;
    this.#artifacts = normalized.artifactService;
    this.#tasks = normalized.tasks;
    this.#authority = normalized.authority ?? (() => undefined);
    this.#wake = normalized.wake ?? (() => undefined);
  }

  get accepting(): boolean {
    return this.#acceptingMutations;
  }

  setRecovered(entries: readonly PersistedOperationJournalEntry[]): void {
    this.#recovered = structuredClone(entries);
  }

  open(): void {
    this.openReadOnly();
    this.openMutations();
  }

  openReadOnly(): void {
    this.#available = true;
  }

  openMutations(): void {
    this.#acceptingMutations = true;
  }

  closeMutations(): void {
    this.#acceptingMutations = false;
  }

  close(): void {
    this.#available = false;
    this.#acceptingMutations = false;
  }

  async installPlugin(input: InstallPluginRequest): Promise<PluginInstallation> {
    const authority = this.#requireAuthority();
    const service = this.#artifacts;
    if (service === undefined) throw this.#unconfigured("artifact installation");
    const request = parseInstallPluginRequest(input);
    this.#assertAuthority(authority);
    const installed = parsePluginInstallation(await service.install(request, authority));
    this.#assertAuthority(authority);
    return structuredClone(installed);
  }

  async deployPlugin(input: DeployPluginRequest): Promise<PluginDeployment> {
    const authority = this.#requireAuthority();
    const state = this.#requireState();
    const request = parseDeployPluginRequest(input);
    const located = await this.#findInstallation(request);
    const installation = located.installation;
    this.#validateDeployment(request, installation);
    const key = deploymentKey(request);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      this.#assertAuthority(authority);
      try {
        const result = await state.transact(
          { fencing: this.#fencing(authority) },
          async (transaction) => {
            this.#assertAuthority(authority);
            const durableInstallation = await transaction.get<PluginInstallation>({
              namespace: "tego",
              collection: "installations",
              id: `${installation.pluginId}@${installation.version}@${installation.digest}`,
            });
            if (durableInstallation === undefined) {
              throw this.#deploymentError(
                "DEPLOYMENT_ARTIFACT_NOT_INSTALLED",
                "The selected artifact installation no longer exists",
                request,
              );
            }
            const transactionInstallation = parsePluginInstallation(durableInstallation.value);
            if (
              located.storageId !==
                `${transactionInstallation.pluginId}@${transactionInstallation.version}@${transactionInstallation.digest}` ||
              transactionInstallation.pluginId !== request.pluginId ||
              transactionInstallation.digest !== request.artifactDigest ||
              transactionInstallation.manifest.pluginId !== request.pluginId ||
              transactionInstallation.manifest.version !== transactionInstallation.version
            ) {
              throw this.#deploymentError(
                "DEPLOYMENT_ARTIFACT_NOT_INSTALLED",
                "The selected artifact installation identity changed",
                request,
              );
            }
            this.#validateDeployment(request, transactionInstallation);
            for (const [name, binding] of Object.entries(request.capabilityBindings)) {
              const provider = await transaction.get(deploymentKey(binding));
              if (provider === undefined) {
                throw this.#deploymentError(
                  "DEPLOYMENT_CAPABILITY_BINDING_MISSING",
                  "A capability binding refers to a missing deployment",
                  request,
                );
              }
              const parsedProvider = parsePluginDeployment(provider.value);
              if (
                parsedProvider.applicationId !== binding.applicationId ||
                parsedProvider.pluginId !== binding.pluginId ||
                parsedProvider.state !== "active"
              ) {
                throw this.#deploymentError(
                  "DEPLOYMENT_CAPABILITY_BINDING_INVALID",
                  "A capability binding refers to an invalid provider deployment",
                  request,
                );
              }
              await this.#validateProviderBinding(
                transaction,
                name,
                parsedProvider,
                transactionInstallation,
                request,
              );
            }
            const existing = await transaction.get(key);
            if (existing !== undefined) {
              const current = parsePluginDeployment(existing.value);
              if (sameDesired(current, request)) {
                return { deployment: current, changed: false };
              }
            }
            const generation = String(
              existing === undefined
                ? 1n
                : BigInt(parsePluginDeployment(existing.value).generation) + 1n,
            );
            const deployment = parsePluginDeployment({
              applicationId: request.applicationId,
              pluginId: request.pluginId,
              version: transactionInstallation.version,
              artifactDigest: request.artifactDigest,
              generation,
              state: "active",
              essential: request.essential,
              configuration: request.configuration,
              permissionGrants: request.permissionGrants,
              capabilityBindings: request.capabilityBindings,
            });
            await transaction.put(key, deployment, {
              expectedRevision: existing?.revision ?? "absent",
            });
            return { deployment, changed: true };
          },
        );
        this.#assertAuthority(authority);
        const existingBefore = await state.read(key);
        this.#assertAuthority(authority);
        if (existingBefore === undefined) throw this.#unconfigured("deployment persistence");
        const persisted = parsePluginDeployment(existingBefore.value);
        if (
          persisted.generation === result.deployment.generation &&
          sameDesired(persisted, request)
        ) {
          if (result.changed) {
            this.#assertAuthority(authority);
            await this.#wake(authority);
            this.#assertAuthority(authority);
          }
          return structuredClone(persisted);
        }
      } catch (error) {
        if (conflictCode(error) === "STATE_REVISION_CONFLICT") continue;
        throw error;
      }
    }
    throw this.#deploymentError(
      "DEPLOYMENT_CONCURRENT_UPDATE",
      "Deployment could not be committed after concurrent updates",
      request,
    );
  }

  async pluginStatus(input: PluginDeploymentIdentity): Promise<PluginDeploymentStatus> {
    this.#requireAvailable();
    const state = this.#requireState();
    const identity = parsePluginDeploymentIdentity(input);
    const [desired, observation] = await Promise.all([
      state.read(deploymentKey(identity)),
      state.read({
        namespace: "tego",
        collection: "deployment-observations",
        id: `${identity.applicationId}/${identity.pluginId}`,
      }),
    ]);
    return parsePluginDeploymentStatus({
      identity,
      ...(desired === undefined ? {} : { desired: desired.value }),
      ...(observation === undefined ? {} : { observation: observation.value }),
    });
  }

  async runTask(input: RunTaskRequest): Promise<TaskRecord> {
    const authority = this.#requireAuthority();
    const tasks = this.#requireTasks();
    const request = parseRunTaskRequest(input);
    this.#assertAuthority(authority);
    return structuredClone(parseTaskRecord(await tasks.run(request)));
  }

  async taskStatus(taskId: TaskId): Promise<TaskRecord | undefined> {
    this.#requireAvailable();
    const record = await this.#requireTasks().status(parseTaskId(taskId));
    return record === undefined ? undefined : structuredClone(parseTaskRecord(record));
  }

  async waitTask(taskId: TaskId): Promise<TaskRecord> {
    this.#requireAvailable();
    return structuredClone(parseTaskRecord(await this.#requireTasks().wait(parseTaskId(taskId))));
  }

  async cancelTask(taskId: TaskId): Promise<TaskRecord> {
    this.#requireAuthority();
    return structuredClone(parseTaskRecord(await this.#requireTasks().cancel(parseTaskId(taskId))));
  }

  async recoveredOperations(): Promise<readonly PersistedOperationJournalEntry[]> {
    this.#requireAvailable();
    return structuredClone(this.#recovered);
  }

  async #findInstallation(request: DeployPluginRequest): Promise<LocatedInstallation> {
    for await (const stored of this.#requireState().scan<PluginInstallation>({
      namespace: "tego",
      collection: "installations",
    })) {
      const installation = parsePluginInstallation(stored.value);
      if (
        installation.pluginId === request.pluginId &&
        installation.digest === request.artifactDigest
      ) {
        return { installation, storageId: stored.key.id };
      }
    }
    throw this.#deploymentError(
      "DEPLOYMENT_ARTIFACT_NOT_INSTALLED",
      "Deployment artifact is not installed for this plugin",
      request,
    );
  }

  #validateDeployment(request: DeployPluginRequest, installation: PluginInstallation): void {
    const decision = validatePermissionGrant(
      installation.manifest.permissions,
      request.permissionGrants,
    );
    if (!decision.allowed) {
      throw this.#deploymentError(
        "DEPLOYMENT_PERMISSION_GRANT_INVALID",
        "Deployment permission grant exceeds the plugin manifest",
        request,
      );
    }
    const required = new Set(
      installation.manifest.capabilities.requires.map((capability) => capability.name),
    );
    for (const name of Object.keys(request.capabilityBindings)) {
      if (!required.has(name)) {
        throw this.#deploymentError(
          "DEPLOYMENT_CAPABILITY_BINDING_INVALID",
          "Capability binding is not declared by the plugin manifest",
          request,
        );
      }
    }
  }

  async #validateProviderBinding(
    transaction: StateTransaction,
    name: string,
    provider: PluginDeployment,
    consumer: PluginInstallation,
    request: DeployPluginRequest,
  ): Promise<void> {
    const requirement = consumer.manifest.capabilities.requires.find(
      (candidate) => candidate.name === name,
    );
    if (requirement === undefined) {
      throw this.#deploymentError(
        "DEPLOYMENT_CAPABILITY_BINDING_INVALID",
        "Capability binding is not declared by the consumer",
        request,
      );
    }
    for await (const stored of transaction.scan<PluginInstallation>({
      namespace: "tego",
      collection: "installations",
    })) {
      const installation = parsePluginInstallation(stored.value);
      if (
        installation.pluginId !== provider.pluginId ||
        installation.digest !== provider.artifactDigest
      ) {
        continue;
      }
      if (
        stored.key.id !==
          `${installation.pluginId}@${installation.version}@${installation.digest}` ||
        provider.version !== installation.version ||
        installation.manifest.pluginId !== installation.pluginId ||
        installation.manifest.version !== installation.version
      ) {
        break;
      }
      const provided = installation.manifest.capabilities.provides.find(
        (candidate) => candidate.name === name,
      );
      if (
        provided !== undefined &&
        satisfiesVersionRange(provided.protocolVersion, requirement.protocolRange)
      ) {
        return;
      }
      break;
    }
    throw this.#deploymentError(
      "DEPLOYMENT_CAPABILITY_BINDING_INVALID",
      "Capability provider does not satisfy the declared protocol range",
      request,
    );
  }

  #requireAvailable(): void {
    if (!this.#available) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "BOOTSTRAP_NOT_READY",
          message: "Runtime operations are unavailable until recovery completes",
          source: { kind: "runtime", id: "operations" },
          details: { acceptingOperations: false },
          observedAt: this.#clock.now().toISOString(),
        }),
      );
    }
  }

  #requireAuthority(): RuntimeAuthority {
    const authority = this.#authority();
    if (!this.#acceptingMutations || authority === undefined) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "COORDINATION_NOT_LEADER",
          message: "Runtime mutation requires active leadership",
          source: { kind: "coordination", id: "operations" },
          observedAt: this.#clock.now().toISOString(),
        }),
      );
    }
    return structuredClone(authority);
  }

  #assertAuthority(expected: RuntimeAuthority): void {
    const current = this.#authority();
    if (current?.resource !== expected.resource || current.epoch !== expected.epoch) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "COORDINATION_FENCE_REJECTED",
          message: "Runtime authority changed while the operation was active",
          source: { kind: "coordination", id: expected.resource },
          observedAt: this.#clock.now().toISOString(),
        }),
      );
    }
  }

  #requireState(): StateStore {
    if (this.#state === undefined) throw this.#unconfigured("state");
    return this.#state;
  }

  #requireTasks(): RuntimeTaskOperations {
    if (this.#tasks === undefined) throw this.#unconfigured("task service");
    return this.#tasks;
  }

  #fencing(authority: RuntimeAuthority): StateFencing {
    return { resource: authority.resource, epoch: authority.epoch };
  }

  #unconfigured(capability: string): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "BOOTSTRAP_SERVICE_UNCONFIGURED",
        message: `Runtime ${capability} service is not configured`,
        source: { kind: "runtime", id: "operations" },
        observedAt: this.#clock.now().toISOString(),
      }),
    );
  }

  #deploymentError(
    code: `DEPLOYMENT_${string}`,
    message: string,
    request: DeployPluginRequest,
  ): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code,
        message,
        source: {
          kind: "deployment",
          id: `${request.applicationId}/${request.pluginId}`,
        },
        observedAt: this.#clock.now().toISOString(),
      }),
    );
  }
}
