import type { ExecutionResult } from "@tegojs/contracts";
import { attemptKey, cloneJson, jsonBytes, positiveLimit, remoteError } from "./remote-protocol.js";

export interface ResultBufferOptions {
  readonly maxCount?: number;
  readonly maxBytes?: number;
}

interface BufferedResult {
  readonly result: ExecutionResult;
  readonly bytes: number;
}

export class ResultBuffer {
  readonly #maxCount: number;
  readonly #maxBytes: number;
  readonly #entries = new Map<string, BufferedResult>();
  #bytes = 0;

  constructor(options: ResultBufferOptions = {}) {
    this.#maxCount = positiveLimit(options.maxCount, 256, "maxResultCount");
    this.#maxBytes = positiveLimit(options.maxBytes, 1024 * 1024, "maxResultBytes");
  }

  get count(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  put(result: ExecutionResult): void {
    const key = attemptKey(result.taskId, result.attemptId);
    const bytes = jsonBytes(result);
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (JSON.stringify(existing.result) !== JSON.stringify(result)) {
        throw remoteError(
          "EXECUTOR_REMOTE_RESULT_CONFLICT",
          "Remote terminal result conflicts with the retained attempt",
          "result-buffer",
          result.completedAt,
        );
      }
      return;
    }
    if (this.#entries.size >= this.#maxCount || this.#bytes + bytes > this.#maxBytes) {
      throw remoteError(
        "EXECUTOR_REMOTE_RESULT_BUFFER_EXHAUSTED",
        "Remote unacknowledged result buffer is exhausted",
        "result-buffer",
        result.completedAt,
        {
          count: this.#entries.size,
          bytes: this.#bytes,
          resultBytes: bytes,
          maxCount: this.#maxCount,
          maxBytes: this.#maxBytes,
        },
      );
    }
    const snapshot = cloneJson(result);
    this.#entries.set(key, { result: snapshot, bytes });
    this.#bytes += bytes;
  }

  get(
    taskId: ExecutionResult["taskId"],
    attemptId: ExecutionResult["attemptId"],
  ): ExecutionResult | undefined {
    const entry = this.#entries.get(attemptKey(taskId, attemptId));
    return entry === undefined ? undefined : cloneJson(entry.result);
  }

  acknowledge(taskId: ExecutionResult["taskId"], attemptId: ExecutionResult["attemptId"]): void {
    const key = attemptKey(taskId, attemptId);
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }

  list(): readonly ExecutionResult[] {
    return [...this.#entries.values()].map(({ result }) => cloneJson(result));
  }
}
