import type {
  Runtime,
  RuntimeAuthority,
  RuntimeConfiguration,
  RuntimeDrivers,
  RuntimeDiagnostic,
  RuntimeTaskLifecycle,
  RuntimeWorkerDirectory,
} from "@tegojs/contracts";
import { createManagedRuntime } from "./create-runtime.js";
import type { Reconciler } from "./reconcile/reconciler.js";
import type { RuntimeArtifactInstaller, RuntimeTaskOperations } from "./runtime-operations.js";

export interface RuntimeHostServices {
  readonly createReconciler: (authority: RuntimeAuthority) => Reconciler;
  readonly tasks: RuntimeTaskLifecycle;
  readonly workers: RuntimeWorkerDirectory;
  readonly artifactService?: RuntimeArtifactInstaller;
  readonly taskOperations?: RuntimeTaskOperations;
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
