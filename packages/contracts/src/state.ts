import type { FencingEpoch, MessageId, OperationId, Revision } from "./identity.js";
import type { JsonValue } from "./json.js";

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
}

export interface StateChange {
  readonly revision: Revision;
  readonly key: StateKey<JsonValue>;
  readonly kind: "delete" | "put";
  readonly value?: JsonValue;
}

export type ExpectedRevision = Revision | "absent" | undefined;

export interface StateWriteOptions {
  readonly expectedRevision?: ExpectedRevision;
}

export interface StateTransactionOptions {
  readonly idempotencyKey?: string;
  readonly fencing?: {
    readonly resource: string;
    readonly epoch: FencingEpoch;
  };
}

export interface OperationJournalEntry {
  readonly operationId: OperationId;
  readonly kind: string;
  readonly status: "completed" | "executing" | "failed" | "planned";
  readonly state: JsonValue;
  readonly updatedAt: string;
}

export interface OutboxMessage {
  readonly messageId: MessageId;
  readonly topic: string;
  readonly payload: JsonValue;
  readonly createdAt: string;
}

export interface DriverHealth {
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
  open(): Promise<void>;
  transact<T extends JsonValue>(
    options: StateTransactionOptions,
    work: (transaction: StateTransaction) => Promise<T>,
  ): Promise<T>;
  read<T extends JsonValue>(key: StateKey<T>): Promise<Versioned<T> | undefined>;
  scan<T extends JsonValue>(query: StateQuery<T>): AsyncIterable<ScannedState<T>>;
  watch(cursor: Revision): AsyncIterable<StateChange>;
  health(): Promise<DriverHealth>;
  close(): Promise<void>;
}
