import type { RuntimeDiagnostic } from "./diagnostic.js";
import type { Leadership } from "./drivers.js";

export interface LeadershipHandle {
  readonly leadership: Leadership;
  readonly lost: Promise<RuntimeDiagnostic>;
  release(): Promise<void>;
}
