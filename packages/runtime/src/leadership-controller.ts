import {
  DiagnosticError,
  parseLeadership,
  runtimeDiagnostic,
  serializeCause,
  type Clock,
  type CoordinationProvider,
  type Leadership,
  type LeadershipHandle,
  type RuntimeDiagnostic,
} from "@tegojs/contracts";

const initialRetryDelayMs = 100;
const maximumRetryDelayMs = 1_000;

export interface LeadershipControllerOptions {
  readonly coordination: CoordinationProvider;
  readonly clock: Clock;
  readonly resource: string;
  readonly onAcquired: (leadership: Leadership) => Promise<void>;
  readonly onLost: (leadership: Leadership) => Promise<void>;
  readonly onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void | Promise<void>;
}

type CampaignOutcome =
  | { readonly kind: "acquired"; readonly handle: LeadershipHandle }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "stopped" };

export class LeadershipController {
  readonly #options: LeadershipControllerOptions;
  readonly #stopped = Promise.withResolvers<void>();
  readonly #firstAuthority = Promise.withResolvers<void>();
  #retryAbort: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #backgroundError: unknown;
  #running = false;
  #firstAuthoritySettled = false;

  constructor(options: LeadershipControllerOptions) {
    this.#options = options;
  }

  start(): Promise<void> {
    if (this.#running) return Promise.resolve();
    if (this.#loop !== undefined) {
      return Promise.reject(new Error("LeadershipController cannot restart after stop"));
    }
    this.#running = true;
    this.#loop = this.#run()
      .catch((error: unknown) => {
        this.#backgroundError = error;
        this.#rejectFirstAuthority(error);
      })
      .finally(() => {
        this.#running = false;
      });
    return Promise.resolve();
  }

  waitForAuthority(): Promise<void> {
    return this.#firstAuthority.promise;
  }

  async stop(): Promise<void> {
    if (!this.#running) {
      await this.#loop;
      if (this.#backgroundError !== undefined) throw this.#backgroundError;
      return;
    }
    this.#running = false;
    this.#retryAbort?.abort(new Error("Leadership campaign stopped"));
    this.#resolveFirstAuthority();
    this.#stopped.resolve();
    await this.#loop;
    if (this.#backgroundError !== undefined) throw this.#backgroundError;
  }

  async #run(): Promise<void> {
    let retryDelayMs = initialRetryDelayMs;
    while (this.#running) {
      const campaign = Promise.resolve().then(() =>
        this.#options.coordination.campaign({
          resource: this.#options.resource,
        }),
      );
      const outcome = await Promise.race<CampaignOutcome>([
        campaign.then(
          (handle) => ({ kind: "acquired", handle }),
          (error: unknown) => ({ kind: "failed", error }),
        ),
        this.#stopped.promise.then(() => ({ kind: "stopped" })),
      ]);

      if (outcome.kind === "stopped") {
        void campaign
          .then((handle) => handle.release())
          .catch((error: unknown) =>
            this.#diagnose(
              "COORDINATION_LEADERSHIP_RELEASE_FAILED",
              "Late leadership acquisition could not be released",
              error,
            ),
          );
        return;
      }

      if (outcome.kind === "failed") {
        this.#diagnose("COORDINATION_CAMPAIGN_FAILED", "Leadership campaign failed", outcome.error);
        if (!(await this.#backoff(retryDelayMs))) return;
        retryDelayMs = Math.min(retryDelayMs * 2, maximumRetryDelayMs);
        continue;
      }

      const handle = outcome.handle;
      let leadership: Leadership;
      try {
        leadership = this.#validateLeadership(handle);
      } catch (error) {
        this.#emitDiagnostic(error);
        this.#rejectFirstAuthority(error);
        const releaseErrors = await this.#release(handle, "invalid leadership acquisition");
        if (releaseErrors.length > 0) throw this.#shutdownError(releaseErrors);
        return;
      }
      try {
        await this.#options.onAcquired(leadership);
        this.#resolveFirstAuthority();
      } catch (error) {
        this.#diagnose(
          "COORDINATION_LEADERSHIP_CALLBACK_FAILED",
          "Leadership acquisition callback failed",
          error,
        );
        const cleanupErrors = await this.#deactivateAndRelease(handle, leadership);
        if (cleanupErrors.length > 0) throw this.#shutdownError(cleanupErrors);
        if (!(await this.#backoff(retryDelayMs))) return;
        retryDelayMs = Math.min(retryDelayMs * 2, maximumRetryDelayMs);
        continue;
      }

      retryDelayMs = initialRetryDelayMs;
      if (!this.#running) {
        const shutdownErrors = await this.#deactivateAndRelease(handle, leadership);
        if (shutdownErrors.length > 0) throw this.#shutdownError(shutdownErrors);
        return;
      }

      const loss = await Promise.race([
        handle.lost.then(
          () => "lost" as const,
          (error: unknown) => {
            this.#diagnose("COORDINATION_CAMPAIGN_FAILED", "Leadership loss signal failed", error);
            return "lost" as const;
          },
        ),
        this.#stopped.promise.then(() => "stopped" as const),
      ]);
      if (loss === "stopped") {
        const shutdownErrors = await this.#deactivateAndRelease(handle, leadership);
        if (shutdownErrors.length > 0) throw this.#shutdownError(shutdownErrors);
        return;
      }
      const cleanupErrors = await this.#notifyLost(leadership);
      if (cleanupErrors.length > 0) throw this.#shutdownError(cleanupErrors);
    }
  }

  #validateLeadership(handle: LeadershipHandle): Leadership {
    const leadership = parseLeadership(handle.leadership);
    if (leadership.resource !== this.#options.resource) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "COORDINATION_LEADERSHIP_RESOURCE_MISMATCH",
          message: "Coordination leadership does not match the campaign resource",
          source: { kind: "coordination", id: "leadership" },
          details: {
            expectedResource: this.#options.resource,
            actualResource: leadership.resource,
          },
          observedAt: this.#options.clock.now().toISOString(),
        }),
      );
    }
    return leadership;
  }

  async #backoff(delayMs: number): Promise<boolean> {
    if (!this.#running) return false;
    const abort = new AbortController();
    this.#retryAbort = abort;
    try {
      await this.#options.clock.sleep(delayMs, abort.signal);
      return this.#running;
    } catch (error) {
      if (!this.#running || abort.signal.aborted) return false;
      throw error;
    } finally {
      if (this.#retryAbort === abort) this.#retryAbort = undefined;
    }
  }

  async #release(handle: LeadershipHandle, context: string): Promise<readonly unknown[]> {
    try {
      await handle.release();
      return [];
    } catch (error) {
      this.#diagnose(
        "COORDINATION_LEADERSHIP_RELEASE_FAILED",
        `Leadership could not be released after ${context}`,
        error,
      );
      return [error];
    }
  }

  async #deactivateAndRelease(
    handle: LeadershipHandle,
    leadership: Leadership,
  ): Promise<readonly unknown[]> {
    return [...(await this.#notifyLost(leadership)), ...(await this.#release(handle, "shutdown"))];
  }

  async #notifyLost(leadership: Leadership): Promise<readonly unknown[]> {
    try {
      await this.#options.onLost(leadership);
      return [];
    } catch (error) {
      this.#diagnose(
        "COORDINATION_LEADERSHIP_CALLBACK_FAILED",
        "Leadership loss callback failed",
        error,
      );
      return [error];
    }
  }

  #shutdownError(errors: readonly unknown[]): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "COORDINATION_LEADERSHIP_SHUTDOWN_FAILED",
        message: "Leadership shutdown did not cleanly release every owned resource",
        source: { kind: "coordination", id: this.#options.resource },
        details: { causes: errors.map((error) => serializeCause(error)) },
        observedAt: this.#options.clock.now().toISOString(),
      }),
    );
  }

  #resolveFirstAuthority(): void {
    if (this.#firstAuthoritySettled) return;
    this.#firstAuthoritySettled = true;
    this.#firstAuthority.resolve();
  }

  #rejectFirstAuthority(error: unknown): void {
    if (this.#firstAuthoritySettled) return;
    this.#firstAuthoritySettled = true;
    this.#firstAuthority.reject(error);
    void this.#firstAuthority.promise.catch(() => undefined);
  }

  #diagnose(
    code:
      | "COORDINATION_CAMPAIGN_FAILED"
      | "COORDINATION_LEADERSHIP_CALLBACK_FAILED"
      | "COORDINATION_LEADERSHIP_RELEASE_FAILED",
    message: string,
    error: unknown,
  ): void {
    const diagnostic = runtimeDiagnostic({
      code,
      message,
      source: { kind: "coordination", id: this.#options.resource },
      retryable: true,
      cause: serializeCause(error),
      observedAt: this.#options.clock.now().toISOString(),
    });
    this.#publishDiagnostic(diagnostic);
  }

  #emitDiagnostic(error: unknown): void {
    const diagnostic =
      error instanceof DiagnosticError
        ? error.diagnostic
        : runtimeDiagnostic({
            code: "COORDINATION_LEADERSHIP_INVALID",
            message: "Coordination returned invalid leadership",
            source: { kind: "coordination", id: this.#options.resource },
            cause: serializeCause(error),
            observedAt: this.#options.clock.now().toISOString(),
          });
    this.#publishDiagnostic(diagnostic);
  }

  #publishDiagnostic(diagnostic: RuntimeDiagnostic): void {
    try {
      const published = this.#options.onDiagnostic?.(diagnostic);
      void Promise.resolve(published).catch(() => undefined);
    } catch {
      // Diagnostic sink failures must not recurse or terminate the campaign loop.
    }
  }
}
