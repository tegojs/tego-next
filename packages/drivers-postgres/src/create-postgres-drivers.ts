import type {
  ArtifactStorageLimits,
  ArtifactStore,
  ClusterTime,
  CoordinationProvider,
  StateStore,
} from "@tego/contracts";
import { PostgresArtifactStore } from "./postgres-artifact-store.js";
import { PostgresCoordinationProvider } from "./postgres-coordination.js";
import { PostgresStateStore } from "./postgres-state-store.js";
import { assertPostgresOptions, type PostgresConnectionOptions } from "./shared.js";

export interface PostgresDrivers {
  readonly state: StateStore;
  readonly coordination: CoordinationProvider;
  readonly artifacts: ArtifactStore;
  readonly clusterTime: ClusterTime;
}

export interface CreatePostgresDriversOptions extends PostgresConnectionOptions {
  readonly artifactLimits?: Partial<ArtifactStorageLimits>;
}

export function createPostgresDrivers(options: CreatePostgresDriversOptions): PostgresDrivers {
  assertPostgresOptions(options);
  const state = new PostgresStateStore(options);
  return {
    state,
    coordination: new PostgresCoordinationProvider(options),
    artifacts: new PostgresArtifactStore({
      connectionString: options.connectionString,
      ...(options.connectionTimeoutMillis === undefined
        ? {}
        : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
      namespace: options.namespace,
      ...(options.artifactLimits === undefined ? {} : { limits: options.artifactLimits }),
    }),
    clusterTime: state,
  };
}
