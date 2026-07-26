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

export interface RuntimeHostServices {
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

export type RuntimeHost = Runtime;

export function createRuntimeHost(
  configuration: RuntimeConfiguration,
  drivers: RuntimeDrivers,
  services: RuntimeHostServices,
): RuntimeHost {
  return createManagedRuntime(configuration, drivers, services);
}
