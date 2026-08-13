import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ArtifactStorageLimits, Clock, RuntimeDrivers } from "@tego/contracts";
import { DevelopmentSecretProvider } from "./development-secret-provider.js";
import { FilesystemArtifactStore } from "./filesystem-artifact-store.js";
import { LocalCoordinationProvider } from "./local-coordination.js";
import { NodeProcessHost } from "./node-process-host.js";
import { SqliteStateStore } from "./sqlite/sqlite-state-store.js";

const systemClock: Clock = {
  now: () => new Date(),
  sleep: async (delayMs, signal) => {
    await delay(delayMs, undefined, signal === undefined ? undefined : { signal });
  },
};

export interface CreateLocalDriversOptions {
  readonly dataDirectory: string;
  readonly namespace: string;
  readonly artifactLimits?: Partial<ArtifactStorageLimits>;
  readonly clock?: Clock;
  readonly developmentSecrets?: Readonly<Record<string, string>>;
}

export async function createLocalDrivers(
  options: CreateLocalDriversOptions,
): Promise<RuntimeDrivers> {
  if (options.dataDirectory.length === 0) {
    throw new TypeError("dataDirectory must not be empty");
  }
  await mkdir(options.dataDirectory, { recursive: true });
  const clock = options.clock ?? systemClock;
  return {
    state: new SqliteStateStore({
      databasePath: join(options.dataDirectory, "state.sqlite"),
      clock,
    }),
    coordination: new LocalCoordinationProvider({ clock }),
    artifacts: new FilesystemArtifactStore({
      rootDirectory: options.dataDirectory,
      namespace: options.namespace,
      ...(options.artifactLimits === undefined ? {} : { limits: options.artifactLimits }),
      clock,
    }),
    processHost: new NodeProcessHost({ clock }),
    secrets: new DevelopmentSecretProvider({
      values: options.developmentSecrets ?? {},
      clock,
    }),
    clock,
  };
}
