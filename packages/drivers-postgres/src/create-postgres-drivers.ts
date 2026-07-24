import type { ArtifactStore, CoordinationProvider, StateStore } from "@tegojs/contracts";
import { PostgresArtifactStore } from "./postgres-artifact-store.js";
import { PostgresCoordinationProvider } from "./postgres-coordination.js";
import { PostgresStateStore } from "./postgres-state-store.js";
import { assertPostgresOptions, type PostgresConnectionOptions } from "./shared.js";

export interface PostgresDrivers {
  readonly state: StateStore;
  readonly coordination: CoordinationProvider;
  readonly artifacts: ArtifactStore;
}

export function createPostgresDrivers(options: PostgresConnectionOptions): PostgresDrivers {
  assertPostgresOptions(options);
  return {
    state: new PostgresStateStore(options),
    coordination: new PostgresCoordinationProvider(options),
    artifacts: new PostgresArtifactStore(options),
  };
}
