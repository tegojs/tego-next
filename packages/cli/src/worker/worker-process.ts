import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DiagnosticError,
  parseArtifactDigest,
  parseWorkerId,
  runtimeDiagnostic,
  serializeWireValue,
  type ArtifactDigest,
  type ExecutionRequest,
  type Executor,
  type ExecutorCapabilities,
  type Permission,
  type PluginComponent,
  type RuntimeDrivers,
  type StateKey,
  type StateStore,
  type WorkerId,
} from "@tegojs/contracts";
import { createLocalDrivers } from "@tegojs/drivers-local";
import {
  ProcessExecutor,
  ThreadExecutor,
  type ResolvedThreadComponent,
} from "@tegojs/executor-node";
import { ArtifactService, PreparedArtifactCache, type PreparedArtifact } from "@tegojs/runtime";
import {
  connectWorker,
  createWorkerEndpoint,
  listenForWorker,
  parseAttemptRevision,
  WorkerRuntime,
  type RemoteAttemptCommitCondition,
  type RemoteAttemptRecord,
  type RemoteAttemptStore,
  type WebSocketListener,
  type WorkerAssignmentRejection,
  type WorkerSession,
} from "@tegojs/transport-websocket";
import type { WorkerStartCommand } from "../parse-command.js";

const WORKER_ATTEMPT_COLLECTION = "worker-attempts";

function cloneRecord(record: RemoteAttemptRecord): RemoteAttemptRecord {
  return serializeWireValue(record) as unknown as RemoteAttemptRecord;
}

function incrementRevision(value: string): string {
  return (BigInt(parseAttemptRevision(value)) + 1n).toString();
}

export interface StateRemoteAttemptStoreOptions {
  readonly state: StateStore;
  readonly workerId: WorkerId;
}

export class StateRemoteAttemptStore implements RemoteAttemptStore {
  readonly #state: StateStore;
  readonly #workerId: WorkerId;

  constructor(options: StateRemoteAttemptStoreOptions) {
    this.#state = options.state;
    this.#workerId = parseWorkerId(options.workerId);
  }

  async save(record: RemoteAttemptRecord): Promise<void> {
    this.#assertWorker(record.workerId);
    const key = this.#key(record.request.taskId, record.request.attemptId);
    const snapshot = cloneRecord({
      ...record,
      revision: parseAttemptRevision(record.revision),
    });
    await this.#state.transact({}, async (transaction) => {
      const current = await transaction.get(key);
      await transaction.put(key, snapshot, {
        expectedRevision: current?.revision ?? "absent",
      });
      return null;
    });
  }

  async commit(
    record: RemoteAttemptRecord,
    condition: RemoteAttemptCommitCondition,
  ): Promise<RemoteAttemptRecord | undefined> {
    this.#assertWorker(record.workerId);
    parseAttemptRevision(record.revision);
    if (condition.expectedRevision !== null) {
      parseAttemptRevision(condition.expectedRevision);
    }
    const key = this.#key(record.request.taskId, record.request.attemptId);
    const committed = await this.#state.transact({}, async (transaction) => {
      const current = await transaction.get(key);
      if (
        (condition.expectedRevision === null && current !== undefined) ||
        (condition.expectedRevision !== null &&
          current?.value.revision !== condition.expectedRevision) ||
        (condition.expectedEpoch !== undefined &&
          current !== undefined &&
          current.value.epoch !== condition.expectedEpoch)
      ) {
        return null;
      }
      const snapshot = cloneRecord({
        ...record,
        revision: incrementRevision(current?.value.revision ?? "0"),
      });
      await transaction.put(key, snapshot, {
        expectedRevision: current?.revision ?? "absent",
      });
      return snapshot;
    });
    return committed === null ? undefined : cloneRecord(committed);
  }

  async delete(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): Promise<void> {
    const key = this.#key(taskId, attemptId);
    await this.#state.transact({}, async (transaction) => {
      const current = await transaction.get(key);
      if (current !== undefined) {
        await transaction.delete(key, { expectedRevision: current.revision });
      }
      return null;
    });
  }

  async load(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): Promise<RemoteAttemptRecord | undefined> {
    const record = await this.#state.read(this.#key(taskId, attemptId));
    return record === undefined ? undefined : cloneRecord(record.value);
  }

  async list(workerId: WorkerId): Promise<readonly RemoteAttemptRecord[]> {
    if (parseWorkerId(workerId) !== this.#workerId) return [];
    const records: RemoteAttemptRecord[] = [];
    for await (const record of this.#state.scan<RemoteAttemptRecord>({
      namespace: "tego",
      collection: WORKER_ATTEMPT_COLLECTION,
      idPrefix: `${this.#workerId}:`,
    })) {
      records.push(cloneRecord(record.value));
    }
    return records;
  }

  #assertWorker(workerId: WorkerId): void {
    if (parseWorkerId(workerId) !== this.#workerId) {
      throw new Error("Remote attempt record belongs to a different Worker");
    }
  }

  #key(
    taskId: ExecutionRequest["taskId"],
    attemptId: ExecutionRequest["attemptId"],
  ): StateKey<RemoteAttemptRecord> {
    return {
      namespace: "tego",
      collection: WORKER_ATTEMPT_COLLECTION,
      id: `${this.#workerId}:${taskId.length}:${taskId}${attemptId}`,
    };
  }
}

export interface PreparedArtifactSelection {
  readonly digests: readonly ArtifactDigest[];
  resolveComponent(request: ExecutionRequest): ResolvedThreadComponent;
  selectExecutorKind(request: ExecutionRequest): "process" | "thread";
  validateAssignment(request: ExecutionRequest): WorkerAssignmentRejection | undefined;
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
    const artifact = (byPlugin.get(request.pluginId) as readonly [PreparedArtifact])[0];
    const component = artifact.manifest.components.find(
      (candidate) => candidate.componentId === request.componentId,
    ) as PluginComponent;
    return { artifact, component };
  };

  const validateAssignment = (request: ExecutionRequest): WorkerAssignmentRejection | undefined => {
    const candidates = byPlugin.get(request.pluginId) ?? [];
    if (candidates.length === 0) {
      return artifactSelectionError("No prepared artifact matches the assignment plugin");
    }
    if (candidates.length !== 1) {
      return artifactSelectionError("Multiple prepared artifacts match the assignment plugin");
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

  return Object.freeze({
    digests,
    validateAssignment,
    selectExecutorKind(request: ExecutionRequest) {
      const { component } = select(request);
      return component.executors.includes("thread") ? "thread" : "process";
    },
    resolveComponent(request: ExecutionRequest) {
      const { artifact, component } = select(request);
      const executorKind = component.executors.includes("thread") ? "thread" : "process";
      const permissionGrants: readonly Permission[] = [
        {
          kind: "executor",
          executors: [executorKind],
        },
      ];
      return {
        artifactDigest: artifact.digest,
        artifactRoot: artifact.root,
        manifest: artifact.manifest,
        runtimeId,
        instanceId: `${request.applicationId}-${request.pluginId}-${request.componentId}`,
        configuration: {},
        permissionGrants,
        capabilityDefinitions: [],
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
  const cleanupErrors: unknown[] = [];
  try {
    await openWorkerDrivers(drivers);
    prepared = await prepareArtifacts(command.prepare, drivers, command.dataDirectory);
    const selection = createPreparedArtifactSelection(prepared.artifacts, `worker-${workerId}`);
    thread = new ThreadExecutor({
      id: `${workerId}:thread`,
      clock: drivers.clock,
      resolveComponent: (request) => selection.resolveComponent(request),
      secretProvider: drivers.secrets,
    });
    processExecutor = new ProcessExecutor({
      id: `${workerId}:process`,
      clock: drivers.clock,
      processHost: drivers.processHost,
      resolveComponent: (request) => selection.resolveComponent(request),
      secretProvider: drivers.secrets,
    });
    const executors = new Map<"process" | "thread", Executor>([
      ["thread", thread],
      ["process", processExecutor],
    ]);
    const capabilities = await Promise.all([thread.probe(), processExecutor.probe()]);
    runtime = new WorkerRuntime({
      workerId,
      clock: drivers.clock,
      attemptStore: new StateRemoteAttemptStore({ state: drivers.state, workerId }),
      preparedArtifacts: () => selection.digests,
      selectExecutor: (request) => {
        const executor = executors.get(selection.selectExecutorKind(request));
        if (executor === undefined)
          throw new Error("Prepared local Worker executor is unavailable");
        return executor;
      },
      validateAssignment: selection.validateAssignment,
    });
    endpoint = createWorkerEndpoint({
      credential: command.credential,
      workerId,
      registration: {
        labels: {},
        resources: {},
        executors: capabilities.map((capability) => capability.type),
        preparedArtifacts: selection.digests,
      },
    });

    let url: URL;
    if (command.direction === "listen") {
      listener = await listenForWorker({
        endpoint,
        host: command.host,
        port: command.port,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onSession: async (accepted) => runtime?.attach(accepted),
      });
      url = listener.url;
    } else {
      url = new URL(command.url);
      session = await connectWorker({
        endpoint,
        url,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await session.ready;
      await runtime.attach(session);
    }
    await options.onReady?.({
      type: "worker.ready",
      pid: process.pid,
      direction: command.direction,
      url: url.href,
      workerId,
      executors: capabilities,
    });
    await waitForAbort(options.signal);
  } finally {
    const settle = async (operation: () => Promise<void> | undefined): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await settle(async () => runtime?.close());
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
