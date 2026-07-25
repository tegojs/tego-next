import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DiagnosticError,
  parseArtifactDigest,
  parseExecutionRequest,
  parseExecutionResult,
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
  requestFingerprint,
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
const WORKER_ATTEMPT_STATES = new Set(["acknowledged", "expired", "running", "terminal"] as const);
const WORKER_ATTEMPT_FIELDS = new Set([
  "acknowledgedAt",
  "cancellation",
  "epoch",
  "fingerprint",
  "request",
  "result",
  "revision",
  "state",
  "updatedAt",
  "workerId",
]);

function attemptStateId(
  workerId: WorkerId,
  taskId: ExecutionRequest["taskId"],
  attemptId: ExecutionRequest["attemptId"],
): string {
  return `${workerId}:${taskId.length}:${taskId}${attemptId}`;
}

function parseAttemptTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`Persisted Worker attempt ${field} is invalid`);
  }
  return value;
}

function parsePersistedAttempt(
  value: unknown,
  options: {
    readonly expectedAttemptId?: ExecutionRequest["attemptId"];
    readonly expectedStateId: string;
    readonly expectedTaskId?: ExecutionRequest["taskId"];
    readonly workerId: WorkerId;
  },
): RemoteAttemptRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Persisted Worker attempt must be an object");
  }
  const fields = value as Readonly<Record<string, unknown>>;
  for (const field of Object.keys(fields)) {
    if (!WORKER_ATTEMPT_FIELDS.has(field)) {
      throw new Error("Persisted Worker attempt contains an unknown field");
    }
  }
  const workerId = parseWorkerId(fields.workerId);
  if (workerId !== options.workerId) {
    throw new Error("Persisted Worker attempt belongs to a different Worker");
  }
  const request = parseExecutionRequest(fields.request);
  if (
    (options.expectedTaskId !== undefined && request.taskId !== options.expectedTaskId) ||
    (options.expectedAttemptId !== undefined && request.attemptId !== options.expectedAttemptId) ||
    attemptStateId(workerId, request.taskId, request.attemptId) !== options.expectedStateId
  ) {
    throw new Error("Persisted Worker attempt identity does not match its state key");
  }
  const fingerprint = requestFingerprint(request);
  if (fields.fingerprint !== fingerprint) {
    throw new Error("Persisted Worker attempt fingerprint does not match its request");
  }
  if (
    typeof fields.state !== "string" ||
    !WORKER_ATTEMPT_STATES.has(fields.state as "acknowledged" | "expired" | "running" | "terminal")
  ) {
    throw new Error("Persisted Worker attempt state is invalid");
  }
  const state = fields.state as "acknowledged" | "expired" | "running" | "terminal";
  const epoch = parseAttemptRevision(fields.epoch);
  const revision = parseAttemptRevision(fields.revision);
  const updatedAt = parseAttemptTimestamp(fields.updatedAt, "updatedAt");
  const result = fields.result === undefined ? undefined : parseExecutionResult(fields.result);
  if (
    result !== undefined &&
    (result.taskId !== request.taskId || result.attemptId !== request.attemptId)
  ) {
    throw new Error("Persisted Worker attempt result identity does not match its request");
  }
  if ((state === "terminal" || state === "expired") !== (result !== undefined)) {
    throw new Error("Persisted Worker attempt state and result are inconsistent");
  }
  const acknowledgedAt =
    fields.acknowledgedAt === undefined
      ? undefined
      : parseAttemptTimestamp(fields.acknowledgedAt, "acknowledgedAt");
  if (acknowledgedAt !== undefined && state !== "terminal" && state !== "expired") {
    throw new Error("Persisted Worker attempt acknowledgement state is invalid");
  }
  const cancellation = fields.cancellation;
  if (cancellation !== undefined && cancellation !== "cancelled" && cancellation !== "timed-out") {
    throw new Error("Persisted Worker attempt cancellation is invalid");
  }
  return {
    workerId,
    request,
    fingerprint,
    state,
    epoch,
    updatedAt,
    revision,
    ...(result === undefined ? {} : { result }),
    ...(acknowledgedAt === undefined ? {} : { acknowledgedAt }),
    ...(cancellation === undefined ? {} : { cancellation }),
  };
}

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
    const snapshot = parsePersistedAttempt(record, {
      expectedAttemptId: record.request.attemptId,
      expectedStateId: key.id,
      expectedTaskId: record.request.taskId,
      workerId: this.#workerId,
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
    const key = this.#key(record.request.taskId, record.request.attemptId);
    const validated = parsePersistedAttempt(record, {
      expectedAttemptId: record.request.attemptId,
      expectedStateId: key.id,
      expectedTaskId: record.request.taskId,
      workerId: this.#workerId,
    });
    if (condition.expectedRevision !== null) {
      parseAttemptRevision(condition.expectedRevision);
    }
    if (condition.expectedEpoch !== undefined) {
      parseAttemptRevision(condition.expectedEpoch);
    }
    const committed = await this.#state.transact({}, async (transaction) => {
      const current = await transaction.get(key);
      const currentRecord =
        current === undefined
          ? undefined
          : parsePersistedAttempt(current.value, {
              expectedAttemptId: record.request.attemptId,
              expectedStateId: key.id,
              expectedTaskId: record.request.taskId,
              workerId: this.#workerId,
            });
      if (
        (condition.expectedRevision === null && current !== undefined) ||
        (condition.expectedRevision !== null &&
          currentRecord?.revision !== condition.expectedRevision) ||
        (condition.expectedEpoch !== undefined &&
          currentRecord !== undefined &&
          currentRecord.epoch !== condition.expectedEpoch)
      ) {
        return null;
      }
      const snapshot = cloneRecord({
        ...validated,
        revision: incrementRevision(currentRecord?.revision ?? "0"),
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
    const key = this.#key(taskId, attemptId);
    const record = await this.#state.read(key);
    return record === undefined
      ? undefined
      : parsePersistedAttempt(record.value, {
          expectedAttemptId: attemptId,
          expectedStateId: key.id,
          expectedTaskId: taskId,
          workerId: this.#workerId,
        });
  }

  async list(workerId: WorkerId): Promise<readonly RemoteAttemptRecord[]> {
    if (parseWorkerId(workerId) !== this.#workerId) return [];
    const records: RemoteAttemptRecord[] = [];
    for await (const record of this.#state.scan<RemoteAttemptRecord>({
      namespace: "tego",
      collection: WORKER_ATTEMPT_COLLECTION,
      idPrefix: `${this.#workerId}:`,
    })) {
      records.push(
        parsePersistedAttempt(record.value, {
          expectedStateId: record.key.id,
          workerId: this.#workerId,
        }),
      );
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
      id: attemptStateId(this.#workerId, taskId, attemptId),
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
        target: request.target,
        artifactDigest: artifact.digest,
        artifactRoot: artifact.root,
        manifest: artifact.manifest,
        runtimeId,
        instanceId: request.target.instanceId,
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

function hasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
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
    await runtime.initialize();
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
