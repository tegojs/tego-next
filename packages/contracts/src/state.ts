import type { FencingEpoch, MessageId, OperationId, Revision } from "./identity.js";
import type { JsonObject, JsonValue } from "./json.js";

export interface StateKey<_T extends JsonValue> {
  readonly namespace: string;
  readonly collection: string;
  readonly id: string;
}

export interface Versioned<T extends JsonValue> {
  readonly value: T;
  readonly revision: Revision;
}

export interface ScannedState<T extends JsonValue> extends Versioned<T> {
  readonly key: StateKey<T>;
}

export interface StateQuery<_T extends JsonValue> {
  readonly namespace: string;
  readonly collection: string;
  readonly idPrefix?: string;
  /**
   * Excludes this identifier. Results begin at the first matching record whose
   * identifier is greater in ECMAScript code-unit order.
   */
  readonly afterId?: string;
  readonly limit?: number;
}

export const STATE_QUERY_MAX_LIMIT = 100;

export function isPortableStateString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) {
      return false;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!Number.isInteger(trailing) || trailing < 0xdc00 || trailing > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function stateStringOrderKey(value: string): Uint8Array {
  if (!isPortableStateString(value)) {
    throw new TypeError("State strings must not contain NUL or ill-formed Unicode");
  }
  const key = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    key[index * 2] = codeUnit >>> 8;
    key[index * 2 + 1] = codeUnit & 0xff;
  }
  return key;
}

export interface StateChange {
  readonly revision: Revision;
  readonly key: StateKey<JsonValue>;
  readonly kind: "delete" | "put";
  readonly value?: JsonValue;
}

export type ExpectedRevision = Revision | "absent" | undefined;
export type StorageScope = "local" | "shared";

export interface StateWriteOptions {
  readonly expectedRevision?: ExpectedRevision;
}

export interface StateFencing extends JsonObject {
  readonly resource: string;
  readonly epoch: FencingEpoch;
}

interface StateTransactionBaseOptions {
  readonly fencing?: StateFencing;
}

export interface NonIdempotentStateTransactionOptions extends StateTransactionBaseOptions {
  readonly idempotencyKey?: undefined;
  readonly idempotencyFingerprint?: undefined;
}

export interface IdempotentStateTransactionOptions extends StateTransactionBaseOptions {
  readonly idempotencyKey: string;
  readonly idempotencyFingerprint: string;
}

export type StateTransactionOptions =
  | IdempotentStateTransactionOptions
  | NonIdempotentStateTransactionOptions;

export interface OperationJournalEntry {
  readonly operationId: OperationId;
  readonly kind: string;
  readonly status: "completed" | "executing" | "failed" | "planned";
  readonly state: JsonValue;
  readonly updatedAt: string;
}

export interface PersistedOperationJournalEntry extends OperationJournalEntry {
  readonly revision: Revision;
}

export interface OperationJournalCursor {
  readonly revision: Revision;
  readonly operationId: OperationId;
}

export interface OperationJournalQuery {
  /**
   * Excludes the cursor itself. Results begin at the first non-terminal entry
   * whose `(revision, operationId)` position is greater than this position.
   */
  readonly after?: OperationJournalCursor;
  readonly limit?: number;
}

export function compareOperationJournalCursors(
  left: OperationJournalCursor,
  right: OperationJournalCursor,
): -1 | 0 | 1 {
  const revisionOrder =
    BigInt(left.revision) < BigInt(right.revision)
      ? -1
      : BigInt(left.revision) > BigInt(right.revision)
        ? 1
        : 0;
  if (revisionOrder !== 0) {
    return revisionOrder;
  }
  return left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0;
}

export interface OutboxMessage extends JsonObject {
  readonly messageId: MessageId;
  readonly operationId: OperationId;
  readonly topic: string;
  readonly payload: JsonValue;
  readonly createdAt: string;
  readonly availableAt: string;
}

export const OUTBOX_TOPIC_MAX_LENGTH = 128;
export const OUTBOX_PAYLOAD_MAX_BYTES = 1_048_576;

export interface OutboxClaimRequest {
  readonly owner: string;
  readonly leaseDurationMs: number;
  readonly limit?: number;
  readonly topic?: string;
  readonly fencing?: StateFencing;
}

export interface OutboxClaim extends JsonObject {
  readonly message: OutboxMessage;
  readonly owner: string;
  readonly claimEpoch: FencingEpoch;
  readonly attempt: number;
  readonly claimedAt: string;
  readonly expiresAt: string;
}

export type OutboxAcknowledgementOutcome = "completed" | "retry";

export interface OutboxAcknowledgementRequest {
  readonly messageId: MessageId;
  readonly owner: string;
  readonly claimEpoch: FencingEpoch;
  readonly outcome: OutboxAcknowledgementOutcome;
  readonly retryAt?: string;
  readonly fencing?: StateFencing;
}

export interface OutboxAcknowledgement extends JsonObject {
  readonly messageId: MessageId;
  readonly outcome: OutboxAcknowledgementOutcome;
  readonly attempt: number;
  readonly acknowledgedAt: string;
  readonly duplicate: boolean;
  readonly retryAt?: string;
}

export interface DriverHealth extends JsonObject {
  readonly status: "degraded" | "healthy" | "unhealthy";
  readonly checkedAt: string;
  readonly message?: string;
}

export interface StateTransaction {
  get<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined>;
  scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>>;
  put<T extends JsonValue>(key: StateKey<T>, value: T, options: StateWriteOptions): Promise<void>;
  delete<T extends JsonValue>(key: StateKey<T>, options: StateWriteOptions): Promise<void>;
  appendOperation(entry: OperationJournalEntry): Promise<void>;
  enqueueOutbox(message: OutboxMessage): Promise<void>;
}

export interface StateStore {
  readonly scope: StorageScope;
  open(): Promise<void>;
  transact<T extends JsonValue>(
    options: StateTransactionOptions,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T>;
  read<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined>;
  scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>>;
  scanOperationHistory(
    query?: OperationJournalQuery,
  ): AsyncIterable<PersistedOperationJournalEntry>;
  scanOperations(query?: OperationJournalQuery): AsyncIterable<PersistedOperationJournalEntry>;
  scanRecoverableOperations(
    query?: OperationJournalQuery,
  ): AsyncIterable<PersistedOperationJournalEntry>;
  claimOutbox(request: OutboxClaimRequest): Promise<readonly OutboxClaim[]>;
  acknowledgeOutbox(request: OutboxAcknowledgementRequest): Promise<OutboxAcknowledgement>;
  watch(cursor: Revision): AsyncIterable<StateChange>;
  health(): Promise<DriverHealth>;
  close(): Promise<void>;
}
