import type { Clock } from "@tegojs/contracts";

interface Sleeper {
  readonly dueAt: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  removeAbortListener?: () => void;
}

export class FakeClock implements Clock {
  readonly #origin: number;
  #elapsed = 0;
  #sleepers: Sleeper[] = [];

  constructor(now: Date = new Date(0)) {
    this.#origin = now.getTime();
  }

  now(): Date {
    return new Date(this.#origin + this.#elapsed);
  }

  sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      return Promise.reject(new RangeError("delayMs must be a finite non-negative number"));
    }
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason);
    }

    return new Promise<void>((resolve, reject) => {
      const sleeper: Sleeper = {
        dueAt: this.#origin + this.#elapsed + delayMs,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };

      if (signal !== undefined) {
        const abort = () => {
          this.#sleepers = this.#sleepers.filter((candidate) => candidate !== sleeper);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        sleeper.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }

      this.#sleepers.push(sleeper);
      this.#resolveDueSleepers();
    });
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("milliseconds must be a finite non-negative number");
    }
    this.#elapsed += milliseconds;
    this.#resolveDueSleepers();
  }

  #resolveDueSleepers(): void {
    const now = this.#origin + this.#elapsed;
    const due = this.#sleepers
      .filter((sleeper) => sleeper.dueAt <= now)
      .sort((left, right) => left.dueAt - right.dueAt);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.dueAt > now);

    for (const sleeper of due) {
      sleeper.removeAbortListener?.();
      sleeper.resolve();
    }
  }
}
