import {
  type ArtifactDigest,
  type ArtifactStorageLimits,
  type Clock,
  DiagnosticError,
  type JsonValue,
  runtimeDiagnostic,
} from "@tego/contracts";

export interface ArtifactQuotaReservation {
  commit(): Promise<void>;
  release(): Promise<void>;
}

export interface LocalArtifactQuotaOptions {
  readonly namespace: string;
  readonly limits: ArtifactStorageLimits;
  readonly clock: Clock;
}

class LocalReservation implements ArtifactQuotaReservation {
  readonly quota: LocalArtifactQuota;
  readonly digest: ArtifactDigest;
  bytes: number;
  state: "active" | "committed" | "released" = "active";

  constructor(quota: LocalArtifactQuota, digest: ArtifactDigest, bytes: number) {
    this.quota = quota;
    this.digest = digest;
    this.bytes = bytes;
  }

  commit(): Promise<void> {
    return this.quota.commit(this);
  }

  release(): Promise<void> {
    return this.quota.release(this);
  }
}

export class LocalArtifactQuota {
  readonly #namespace: string;
  readonly #limits: ArtifactStorageLimits;
  readonly #clock: Clock;
  readonly #committed = new Map<ArtifactDigest, number>();
  readonly #reservations = new Set<LocalReservation>();
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: LocalArtifactQuotaOptions) {
    this.#namespace = options.namespace;
    this.#limits = options.limits;
    this.#clock = options.clock;
  }

  restore(artifacts: ReadonlyMap<ArtifactDigest, number>): Promise<void> {
    return this.#serialized(() => {
      this.#assertOpen();
      let total = 0;
      for (const [digest, bytes] of artifacts) {
        if (bytes > this.#limits.maxArtifactBytes) {
          throw this.#error(
            "ARTIFACT_SIZE_LIMIT_EXCEEDED",
            "Existing artifact exceeds the configured per-artifact limit",
            {
              digest,
              namespace: this.#namespace,
              artifactBytes: bytes,
              maximumBytes: this.#limits.maxArtifactBytes,
            },
          );
        }
        total += bytes;
      }
      if (total > this.#limits.maxNamespaceBytes) {
        throw this.#namespaceError(undefined, 0, total, 0);
      }
      this.#committed.clear();
      for (const [digest, bytes] of artifacts) this.#committed.set(digest, bytes);
    });
  }

  reserve(digest: ArtifactDigest, bytes: number): Promise<ArtifactQuotaReservation> {
    return this.#serialized(() => {
      this.#assertOpen();
      const reservation = new LocalReservation(this, digest, bytes);
      this.#assertCapacity(reservation, bytes);
      this.#reservations.add(reservation);
      return reservation;
    });
  }

  resize(reservation: ArtifactQuotaReservation, bytes: number): Promise<void> {
    return this.#serialized(() => {
      const local = this.#localReservation(reservation);
      this.#assertOpen();
      this.#assertActive(local);
      this.#assertCapacity(local, bytes);
      local.bytes = bytes;
    });
  }

  publish(
    reservation: ArtifactQuotaReservation,
    targetExists: () => Promise<boolean>,
    operation: (duplicate: boolean) => Promise<void>,
  ): Promise<void> {
    return this.#serialized(async () => {
      const local = this.#localReservation(reservation);
      this.#assertOpen();
      this.#assertActive(local);
      const duplicate = await targetExists();
      if (!duplicate) this.#assertPublishCapacity(local);
      try {
        await operation(duplicate);
      } catch (error) {
        if (!duplicate && (await targetExists().catch(() => false))) {
          this.#committed.set(local.digest, local.bytes);
          local.state = "committed";
          this.#reservations.delete(local);
        }
        throw error;
      }
      if (!duplicate) this.#committed.set(local.digest, local.bytes);
      local.state = "committed";
      this.#reservations.delete(local);
    });
  }

  committedBytes(): Promise<number> {
    return this.#serialized(() => this.#committedTotal());
  }

  commit(reservation: LocalReservation): Promise<void> {
    return this.#serialized(() => {
      this.#assertOwned(reservation);
      if (reservation.state !== "active") return;
      this.#committed.set(reservation.digest, reservation.bytes);
      reservation.state = "committed";
      this.#reservations.delete(reservation);
    });
  }

  release(reservation: LocalReservation): Promise<void> {
    return this.#serialized(() => {
      this.#assertOwned(reservation);
      if (reservation.state !== "active") return;
      reservation.state = "released";
      this.#reservations.delete(reservation);
    });
  }

  close(): Promise<void> {
    return this.#serialized(() => {
      this.#closed = true;
      for (const reservation of this.#reservations) reservation.state = "released";
      this.#reservations.clear();
    });
  }

  #assertCapacity(reservation: LocalReservation, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("Artifact reservation bytes must be a non-negative safe integer");
    }
    if (bytes > this.#limits.maxArtifactBytes) {
      throw this.#error(
        "ARTIFACT_SIZE_LIMIT_EXCEEDED",
        "Artifact exceeds the configured per-artifact limit",
        {
          digest: reservation.digest,
          namespace: this.#namespace,
          artifactBytes: bytes,
          maximumBytes: this.#limits.maxArtifactBytes,
        },
      );
    }
    if (this.#committed.has(reservation.digest)) return;
    const reservedBytes = this.#reservedTotal(reservation, bytes);
    const committedBytes = this.#committedTotal();
    if (committedBytes + reservedBytes > this.#limits.maxNamespaceBytes) {
      throw this.#namespaceError(reservation.digest, bytes, committedBytes, reservedBytes);
    }
  }

  #assertPublishCapacity(reservation: LocalReservation): void {
    const previous = this.#committed.get(reservation.digest) ?? 0;
    const committedBytes = this.#committedTotal() - previous;
    const reservedBytes = this.#reservedTotalForOtherDigests(reservation.digest);
    const projectedBytes = committedBytes + reservedBytes + reservation.bytes;
    if (projectedBytes > this.#limits.maxNamespaceBytes) {
      throw this.#namespaceError(
        reservation.digest,
        reservation.bytes,
        committedBytes,
        reservedBytes + reservation.bytes,
      );
    }
  }

  #reservedTotal(replacement: LocalReservation, replacementBytes: number): number {
    const maximumByDigest = new Map<ArtifactDigest, number>();
    for (const reservation of this.#reservations) {
      if (reservation.state !== "active" || this.#committed.has(reservation.digest)) continue;
      const bytes = reservation === replacement ? replacementBytes : reservation.bytes;
      maximumByDigest.set(
        reservation.digest,
        Math.max(maximumByDigest.get(reservation.digest) ?? 0, bytes),
      );
    }
    if (!this.#reservations.has(replacement) && !this.#committed.has(replacement.digest)) {
      maximumByDigest.set(
        replacement.digest,
        Math.max(maximumByDigest.get(replacement.digest) ?? 0, replacementBytes),
      );
    }
    let total = 0;
    for (const bytes of maximumByDigest.values()) total += bytes;
    return total;
  }

  #reservedTotalForOtherDigests(digest: ArtifactDigest): number {
    const maximumByDigest = new Map<ArtifactDigest, number>();
    for (const reservation of this.#reservations) {
      if (
        reservation.state !== "active" ||
        reservation.digest === digest ||
        this.#committed.has(reservation.digest)
      ) {
        continue;
      }
      maximumByDigest.set(
        reservation.digest,
        Math.max(maximumByDigest.get(reservation.digest) ?? 0, reservation.bytes),
      );
    }
    let total = 0;
    for (const bytes of maximumByDigest.values()) total += bytes;
    return total;
  }

  #committedTotal(): number {
    let total = 0;
    for (const bytes of this.#committed.values()) total += bytes;
    return total;
  }

  #localReservation(reservation: ArtifactQuotaReservation): LocalReservation {
    if (!(reservation instanceof LocalReservation)) {
      throw new TypeError("Artifact quota reservation belongs to another implementation");
    }
    this.#assertOwned(reservation);
    return reservation;
  }

  #assertOwned(reservation: LocalReservation): void {
    if (reservation.quota !== this) {
      throw new TypeError("Artifact quota reservation belongs to another quota");
    }
  }

  #assertActive(reservation: LocalReservation): void {
    if (reservation.state !== "active") {
      throw new Error("Artifact quota reservation is no longer active");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Artifact quota is closed");
  }

  #namespaceError(
    digest: ArtifactDigest | undefined,
    artifactBytes: number,
    committedBytes: number,
    reservedBytes: number,
  ): DiagnosticError {
    return this.#error(
      "ARTIFACT_NAMESPACE_QUOTA_EXCEEDED",
      "Artifact namespace exceeds the configured storage quota",
      {
        ...(digest === undefined ? {} : { digest }),
        namespace: this.#namespace,
        artifactBytes,
        committedBytes,
        reservedBytes,
        maximumBytes: this.#limits.maxNamespaceBytes,
      },
    );
  }

  #error(code: `ARTIFACT_${string}`, message: string, details: JsonValue): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code,
        message,
        source: { kind: "artifact", id: "filesystem-artifact-store" },
        details,
        observedAt: this.#clock.now().toISOString(),
      }),
    );
  }

  #serialized<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
