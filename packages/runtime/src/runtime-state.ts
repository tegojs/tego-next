import { DiagnosticError, runtimeDiagnostic, type RuntimeLifecycleState } from "@tegojs/contracts";

const transitions: Readonly<Record<RuntimeLifecycleState, readonly RuntimeLifecycleState[]>> = {
  created: ["failed", "opening", "stopping"],
  opening: ["failed", "recovering", "stopping"],
  recovering: ["electing", "failed", "stopping"],
  electing: ["failed", "running", "stopping"],
  running: ["draining", "failed"],
  draining: ["failed", "stopping"],
  stopping: ["failed", "stopped"],
  stopped: [],
  failed: ["stopping"],
};

export function transitionRuntimeState(
  current: RuntimeLifecycleState,
  next: RuntimeLifecycleState,
  observedAt: string,
): RuntimeLifecycleState {
  if (transitions[current].includes(next)) {
    return next;
  }
  throw new DiagnosticError(
    runtimeDiagnostic({
      code: "LIFECYCLE_TRANSITION_INVALID",
      message: `Runtime cannot transition from ${current} to ${next}`,
      source: { kind: "runtime", id: "lifecycle" },
      details: { current, next },
      observedAt,
    }),
  );
}
