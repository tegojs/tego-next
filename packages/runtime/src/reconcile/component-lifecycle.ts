import {
  DiagnosticError,
  runtimeDiagnostic,
  type ComponentId,
  type JsonObject,
  type PluginId,
} from "@tegojs/contracts";

export type ComponentLifecycleState =
  | "created"
  | "preparing"
  | "starting"
  | "ready"
  | "degraded"
  | "draining"
  | "stopping"
  | "stopped"
  | "failed";

export interface ComponentTransitionInput {
  readonly pluginId: PluginId;
  readonly componentId: ComponentId;
  readonly current: ComponentLifecycleState;
  readonly next: ComponentLifecycleState;
  readonly observedAt: string;
}

export interface ComponentInstanceObservation extends JsonObject {
  readonly lifecycle: ComponentLifecycleState;
  readonly observedGeneration: string;
}

export interface ComponentReadinessInput {
  readonly desired: boolean;
  readonly essential: boolean;
  readonly kernelRunning: boolean;
  readonly instances: readonly ComponentInstanceObservation[];
}

const legalTransitions: Readonly<
  Record<ComponentLifecycleState, ReadonlySet<ComponentLifecycleState>>
> = {
  created: new Set(["preparing", "draining", "failed"]),
  preparing: new Set(["starting", "draining", "failed"]),
  starting: new Set(["ready", "degraded", "draining", "failed"]),
  ready: new Set(["degraded", "draining", "failed"]),
  degraded: new Set(["ready", "draining", "failed"]),
  draining: new Set(["stopping", "failed"]),
  stopping: new Set(["stopped", "failed"]),
  stopped: new Set(),
  failed: new Set(["draining", "preparing", "starting", "stopping"]),
};

export function transitionComponentLifecycle(
  input: ComponentTransitionInput,
): ComponentLifecycleState {
  if (legalTransitions[input.current].has(input.next)) return input.next;
  throw new DiagnosticError(
    runtimeDiagnostic({
      code: "LIFECYCLE_TRANSITION_INVALID",
      message: `Component lifecycle cannot transition from ${input.current} to ${input.next}`,
      source: {
        kind: "plugin",
        id: `${input.pluginId}/${input.componentId}`,
      },
      details: {
        componentId: input.componentId,
        current: input.current,
        next: input.next,
        pluginId: input.pluginId,
      },
      observedAt: input.observedAt,
    }),
  );
}

export function componentApplicationReady(input: ComponentReadinessInput): boolean {
  if (!input.kernelRunning) return false;
  if (!input.desired || !input.essential) return true;
  return input.instances.some((instance) => instance.lifecycle === "ready");
}
