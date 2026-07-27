import type {
  Runtime,
  RuntimeAuthority,
  RuntimeConfiguration,
  RuntimeDiagnostic,
  RuntimeDrivers,
  RuntimeTaskLifecycle,
  RuntimeWorkerDirectory,
} from "@tegojs/contracts";
import { createManagedRuntime } from "./create-runtime.js";
import type { Reconciler } from "./reconcile/reconciler.js";
import type { RuntimeArtifactInstaller, RuntimeTaskOperations } from "./runtime-operations.js";

export interface RuntimeAuthorityAdmission {
  open(authority: RuntimeAuthority): void;
  close(authority: RuntimeAuthority): void;
}

export interface RuntimeHostServices {
  readonly authorityAdmission: RuntimeAuthorityAdmission;
  readonly createReconciler: (
    authority: RuntimeAuthority,
    context: {
      readonly currentAuthority: () => RuntimeAuthority | undefined;
      readonly onBackgroundError: (error: unknown) => void;
    },
  ) => Reconciler;
  readonly tasks: RuntimeTaskLifecycle & RuntimeTaskOperations;
  readonly workers: RuntimeWorkerDirectory;
  readonly artifactService?: RuntimeArtifactInstaller;
  readonly onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void | Promise<void>;
}

export interface RuntimeObservedStatus {
  readonly deploymentCount: number;
  readonly installationCount: number;
  readonly deploymentReadiness: readonly {
    readonly essential: boolean;
    readonly ready: boolean;
  }[];
}

export interface RuntimeObservedStatusReader {
  read(): Promise<RuntimeObservedStatus>;
}

export type RuntimeHost = Runtime;

export function createRuntimeHost(
  configuration: RuntimeConfiguration,
  drivers: RuntimeDrivers,
  services: RuntimeHostServices,
): RuntimeHost {
  return createManagedRuntime(configuration, drivers, services);
}
