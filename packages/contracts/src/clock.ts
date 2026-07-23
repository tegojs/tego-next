export interface Clock {
  now(): Date;
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
}
