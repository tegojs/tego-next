import type { Clock } from "@tegojs/contracts";

export const systemWorkerClock: Clock = {
  now: () => new Date(),
  sleep(delayMs, signal): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      return Promise.reject(new RangeError("delayMs must be a finite non-negative number"));
    }
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason);
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        operation();
      };
      const timeout = setTimeout(() => finish(resolve), delayMs);
      const abort = () => finish(() => reject(signal?.reason));
      signal?.addEventListener("abort", abort, { once: true });
      timeout.unref();
    });
  },
};
