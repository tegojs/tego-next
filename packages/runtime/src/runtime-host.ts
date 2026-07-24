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

export interface RuntimeHostServices {
  readonly createReconciler: (authority: RuntimeAuthority) => Reconciler;
  readonly tasks: RuntimeTaskLifecycle;
  readonly workers: RuntimeWorkerDirectory;
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
