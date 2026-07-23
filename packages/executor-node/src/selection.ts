import {
  DiagnosticError,
  runtimeDiagnostic,
  type ExecutorKind,
  type WorkerResourceCeilings,
} from "@tegojs/contracts";

export interface ExecutorSelectionCandidate {
  readonly id: string;
  readonly type: ExecutorKind;
  readonly healthy: boolean;
  readonly available: boolean;
  readonly resources: WorkerResourceCeilings;
}

export interface ExecutorSelectionRequest {
  readonly supported: readonly ExecutorKind[];
  readonly granted: readonly ExecutorKind[];
  readonly resources: WorkerResourceCeilings;
  readonly preference?: readonly ExecutorKind[];
  readonly candidates: readonly ExecutorSelectionCandidate[];
}

const DEFAULT_PREFERENCE: readonly ExecutorKind[] = ["process", "remote", "thread"];

function satisfies(available: WorkerResourceCeilings, requested: WorkerResourceCeilings): boolean {
  return (
    available.cpuMillis >= requested.cpuMillis &&
    available.memoryBytes >= requested.memoryBytes &&
    available.storageBytes >= requested.storageBytes
  );
}

export function selectExecutor(request: ExecutorSelectionRequest): ExecutorSelectionCandidate {
  const supported = new Set(request.supported);
  const granted = new Set(request.granted);
  const eligible = request.candidates.filter(
    (candidate) =>
      supported.has(candidate.type) &&
      granted.has(candidate.type) &&
      candidate.healthy &&
      candidate.available &&
      satisfies(candidate.resources, request.resources),
  );
  const preference = request.preference ?? DEFAULT_PREFERENCE;
  for (const type of preference) {
    const candidate = eligible.find((value) => value.type === type);
    if (candidate !== undefined) return candidate;
  }
  const fallback = eligible[0];
  if (fallback !== undefined) return fallback;
  throw new DiagnosticError(
    runtimeDiagnostic({
      code: "EXECUTOR_SELECTION_UNAVAILABLE",
      message: "No supported, granted, healthy executor satisfies the requested resources",
      source: { kind: "executor", id: "selector" },
      details: {
        candidates: request.candidates.map((candidate) => ({
          id: candidate.id,
          type: candidate.type,
          supported: supported.has(candidate.type),
          granted: granted.has(candidate.type),
          healthy: candidate.healthy,
          available: candidate.available,
          resourcesSatisfied: satisfies(candidate.resources, request.resources),
        })),
      },
    }),
  );
}
