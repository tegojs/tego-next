import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import {
  DiagnosticError,
  type Executor,
  parseApplicationId,
  parseArtifactDigest,
  parseNodeId,
  parseRuntimeId,
  parseWorkerId,
  type Runtime,
  type RuntimeConfiguration,
  type RuntimeDrivers,
  runtimeDiagnostic,
} from "@tegojs/contracts";
import { createLocalDrivers } from "@tegojs/drivers-local";
import { createPostgresDrivers } from "@tegojs/drivers-postgres";
import { ThreadExecutor } from "@tegojs/executor-node";
import { ArtifactService, createRuntimeHost, Reconciler, TaskService } from "@tegojs/runtime";
import {
  createMainEndpoint,
  listenForMain,
  StateWorkerEpochAllocator,
} from "@tegojs/transport-websocket";
import type { LocalArtifactIngress } from "../control/server.js";

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

function unavailableComponent(): never {
  throw new DiagnosticError(
    runtimeDiagnostic({
      code: "EXECUTOR_COMPONENT_UNAVAILABLE",
      message: "The requested component has not been prepared by reconciliation",
      source: { kind: "executor", id: "node-thread" },
    }),
  );
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
  const executor: Executor = new ThreadExecutor({
    id: `${options.nodeId}:thread`,
    clock: drivers.clock,
    resolveComponent: unavailableComponent,
  });
  const tasks = new TaskService({
    state: drivers.state,
    clock: drivers.clock,
    selectExecutor: () => {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "LIFECYCLE_INSTANCE_MISSING",
          message: "No active component execution target is available",
          source: { kind: "runtime", id: options.runtimeId },
        }),
      );
    },
  });
  const epochAllocator = new StateWorkerEpochAllocator({ state: drivers.state });
  const mainEndpoint =
    options.worker === undefined
      ? undefined
      : createMainEndpoint({
          credential: options.worker.credential,
          workerId: parseWorkerId(options.worker.workerId),
          epochAllocator,
          clock: drivers.clock,
        });
  const listenerOwner =
    options.worker === undefined || mainEndpoint === undefined
      ? undefined
      : new NodeWorkerListenerOwner(() =>
          listenForMain({
            endpoint: mainEndpoint,
            host: options.worker?.host ?? "127.0.0.1",
            port: options.worker?.port ?? 0,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
        );
  const workers = {
    count: () => mainEndpoint?.activeSessionCount ?? 0,
    placements: () => [],
    close: async () => {
      const results = await Promise.allSettled([
        executor.close(),
        listenerOwner?.close(),
        mainEndpoint?.close(),
      ]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Worker listener cleanup failed");
    },
  };
  const runtime = createRuntimeHost(configuration, drivers, {
    artifactService,
    tasks,
    workers,
    createReconciler: (authority) =>
      new Reconciler({
        artifactGate: artifactService,
        authority,
        clock: drivers.clock,
        effects: {
          supportedExecutors: ["thread"],
          perform: async () => {
            throw new DiagnosticError(
              runtimeDiagnostic({
                code: "LIFECYCLE_COMPONENT_HOST_UNAVAILABLE",
                message: "Node component hosting is not configured for this deployment",
                source: { kind: "runtime", id: options.runtimeId },
              }),
            );
          },
        },
        state: drivers.state,
        workers: [],
      }),
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
