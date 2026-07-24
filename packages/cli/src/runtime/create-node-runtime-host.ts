import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  DiagnosticError,
  type Executor,
  parseApplicationId,
  parseArtifactDigest,
  parseNodeId,
  parseRuntimeId,
  type Runtime,
  type RuntimeConfiguration,
  type RuntimeDrivers,
  runtimeDiagnostic,
} from "@tegojs/contracts";
import { createLocalDrivers } from "@tegojs/drivers-local";
import { createPostgresDrivers } from "@tegojs/drivers-postgres";
import { ThreadExecutor } from "@tegojs/executor-node";
import { ArtifactService, createRuntimeHost, Reconciler, TaskService } from "@tegojs/runtime";
import { MemoryWorkerEpochAllocator } from "@tegojs/transport-websocket";
import type { LocalArtifactIngress } from "../control/server.js";

export interface CreateNodeRuntimeHostOptions {
  readonly applicationId: string;
  readonly dataDirectory: string;
  readonly mode: RuntimeConfiguration["mode"];
  readonly nodeId: string;
  readonly runtimeId: string;
  readonly postgresUrl?: string;
}

export interface NodeRuntimeHost {
  readonly runtime: Runtime;
  readonly artifactIngress: LocalArtifactIngress;
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
    selectExecutor: () => executor,
  });
  const epochAllocator = new MemoryWorkerEpochAllocator();
  const workers = {
    count: () => 0,
    placements: () => [],
    close: async () => {
      await executor.close();
      void epochAllocator;
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
  return { runtime, artifactIngress };
}
