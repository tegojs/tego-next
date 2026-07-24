import type { Clock } from "./clock.js";
import type { LeadershipHandle } from "./coordination.js";
import type { ArtifactDigest, FencingEpoch, Revision } from "./identity.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { DriverHealth, StateStore, StorageScope } from "./state.js";
import type { SecretProvider } from "./secrets.js";
import type { ProcessHost } from "./process-host.js";

export interface ManagedDriver {
  open(): Promise<void>;
  health(): Promise<DriverHealth>;
  close(): Promise<void>;
}

export interface CampaignRequest {
  readonly resource: string;
}

export interface Leadership extends JsonObject {
  readonly resource: string;
  readonly epoch: FencingEpoch;
}

export interface LeaseRequest {
  readonly resource: string;
  readonly owner: string;
  readonly durationMs: number;
}

export interface Lease {
  readonly resource: string;
  readonly owner: string;
  readonly epoch: FencingEpoch;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface CompareAndSetRequest<T extends JsonValue> {
  readonly key: string;
  readonly expectedRevision?: Revision | "absent";
  readonly value: T;
}

export interface CasResult<T extends JsonValue> {
  readonly applied: boolean;
  readonly value?: T;
  readonly revision?: Revision;
}

export interface CoordinationWatchRequest {
  readonly cursor: Revision;
}

export interface CoordinationChange {
  readonly key: string;
  readonly revision: Revision;
  readonly value: JsonValue;
}

export interface CoordinationProvider extends ManagedDriver {
  readonly scope: "distributed" | "local";
  campaign(request: CampaignRequest): Promise<LeadershipHandle>;
  acquireLease(request: LeaseRequest): Promise<Lease>;
  nextEpoch(resource: string): Promise<FencingEpoch>;
  compareAndSet<T extends JsonValue>(request: CompareAndSetRequest<T>): Promise<CasResult<T>>;
  watch(request: CoordinationWatchRequest): AsyncIterable<CoordinationChange>;
}

export interface ArtifactStore extends ManagedDriver {
  readonly scope: StorageScope;
  put(digest: ArtifactDigest, source: AsyncIterable<Uint8Array>): Promise<void>;
  read(digest: ArtifactDigest): AsyncIterable<Uint8Array>;
}

export interface RuntimeDrivers {
  readonly state: StateStore;
  readonly coordination: CoordinationProvider;
  readonly artifacts: ArtifactStore;
  readonly processHost: ProcessHost;
  readonly secrets: SecretProvider;
  readonly clock: Clock;
}
