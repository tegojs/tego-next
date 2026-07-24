import type { DriverHealth, RuntimeLifecycleState } from "@tegojs/contracts";

export interface DeploymentReadiness {
  readonly desired: boolean;
  readonly essential: boolean;
  readonly ready: boolean;
}

export interface RuntimeReadinessInput {
  readonly lifecycle: RuntimeLifecycleState;
  readonly drivers: readonly DriverHealth[];
  readonly deployments: readonly DeploymentReadiness[];
}

export function isRuntimeReady(input: RuntimeReadinessInput): boolean {
  return (
    input.lifecycle === "running" &&
    input.drivers.every((health) => health.status !== "unhealthy") &&
    input.deployments.every(
      (deployment) => !deployment.desired || !deployment.essential || deployment.ready,
    )
  );
}
