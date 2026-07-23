import { DiagnosticError, runtimeDiagnostic } from "@tegojs/contracts";
import { PROCESS_EXECUTOR_MAX_FRAME_BYTES } from "./framing.js";

export const PROCESS_OUTBOUND_MAX_QUEUED_FRAMES = 64;
export const PROCESS_OUTBOUND_MAX_QUEUED_BYTES = PROCESS_EXECUTOR_MAX_FRAME_BYTES * 2;

export type ProcessOutboundPriority = "diagnostic" | "required";

interface ProcessOutboundWriterOptions {
  readonly encode: (value: Record<string, unknown>) => Uint8Array;
  readonly write: (bytes: Uint8Array) => Promise<void>;
}

interface PendingWrite {
  readonly value: Record<string, unknown>;
  readonly retainedBytes: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function queueCapacityError(): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "EXECUTOR_OUTPUT_QUEUE_CAPACITY_EXCEEDED",
      message: "Process outbound queue capacity is exhausted",
      source: { kind: "executor", id: "process-executor" },
    }),
  );
}

function invalidFrameError(): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_PROCESS_FRAME_INVALID",
      message: "Process outbound frame is not JSON-safe",
      source: { kind: "protocol", id: "process-executor" },
    }),
  );
}

function snapshot(value: Record<string, unknown>): {
  readonly value: Record<string, unknown>;
  readonly retainedBytes: number;
} {
  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) throw invalidFrameError();
    serialized = candidate;
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw invalidFrameError();
  }
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidFrameError();
  }
  return {
    value: parsed as Record<string, unknown>,
    retainedBytes: Buffer.byteLength(serialized, "utf8"),
  };
}

export class ProcessOutboundWriter {
  readonly #options: ProcessOutboundWriterOptions;
  readonly #queue: PendingWrite[] = [];
  readonly #flushWaiters = new Set<() => void>();
  #active = false;
  #pendingCount = 0;
  #pendingBytes = 0;
  #droppedDiagnostics = 0;

  constructor(options: ProcessOutboundWriterOptions) {
    this.#options = options;
  }

  get pendingCount(): number {
    return this.#pendingCount;
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  get droppedDiagnostics(): number {
    return this.#droppedDiagnostics;
  }

  send(value: Record<string, unknown>, priority: ProcessOutboundPriority): Promise<void> {
    let admitted: ReturnType<typeof snapshot>;
    try {
      admitted = snapshot(value);
    } catch (error) {
      return Promise.reject(error);
    }
    if (
      this.#pendingCount >= PROCESS_OUTBOUND_MAX_QUEUED_FRAMES ||
      admitted.retainedBytes > PROCESS_OUTBOUND_MAX_QUEUED_BYTES - this.#pendingBytes
    ) {
      if (priority === "diagnostic") {
        this.#droppedDiagnostics += 1;
        return Promise.resolve();
      }
      return Promise.reject(queueCapacityError());
    }
    this.#pendingCount += 1;
    this.#pendingBytes += admitted.retainedBytes;
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({
        value: admitted.value,
        retainedBytes: admitted.retainedBytes,
        resolve,
        reject,
      });
      this.#start();
    });
  }

  flush(): Promise<void> {
    if (this.#pendingCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#flushWaiters.add(resolve);
    });
  }

  #start(): void {
    if (this.#active) return;
    this.#active = true;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      for (;;) {
        const pending = this.#queue.shift();
        if (pending === undefined) return;
        try {
          await this.#options.write(this.#options.encode(pending.value));
          pending.resolve();
        } catch (error) {
          pending.reject(error);
        } finally {
          this.#pendingCount -= 1;
          this.#pendingBytes -= pending.retainedBytes;
        }
      }
    } finally {
      this.#active = false;
      if (this.#pendingCount === 0) {
        for (const resolve of this.#flushWaiters) resolve();
        this.#flushWaiters.clear();
      } else {
        this.#start();
      }
    }
  }
}
