import type { OperationId } from "@tegojs/contracts";

export interface RetryDelayInput {
  readonly attempt: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly operationId: OperationId;
}

function operationHash(operationId: OperationId): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < operationId.length; index += 1) {
    hash ^= operationId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function deterministicRetryDelay(input: RetryDelayInput): number {
  if (
    !Number.isSafeInteger(input.attempt) ||
    input.attempt <= 0 ||
    !Number.isSafeInteger(input.baseDelayMs) ||
    input.baseDelayMs <= 0 ||
    !Number.isSafeInteger(input.maxDelayMs) ||
    input.maxDelayMs < input.baseDelayMs
  ) {
    throw new RangeError("Retry delay inputs must be positive bounded integers");
  }
  const exponent = Math.min(input.attempt - 1, 52);
  const exponential = Math.min(input.maxDelayMs, input.baseDelayMs * 2 ** exponent);
  if (exponential >= input.maxDelayMs) return input.maxDelayMs;
  const jitterRange = Math.max(1, Math.floor(exponential / 4));
  return Math.min(input.maxDelayMs, exponential + (operationHash(input.operationId) % jitterRange));
}
