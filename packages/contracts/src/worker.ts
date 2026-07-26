import type { MessageId, Sequence, SessionId } from "./identity.js";
import type { JsonObject, JsonValue } from "./json.js";

export type WorkerProtocolVersion = "1.0";
export type WorkerMessageType =
  | "artifact.prepare"
  | "artifact.prepared"
  | "authenticate"
  | "heartbeat"
  | "hello"
  | "session.ready"
  | "session.reconcile"
  | "task.acknowledge"
  | "task.assign"
  | "task.cancel"
  | "task.result"
  | "worker.register";

export interface WorkerEnvelope<T extends JsonValue = JsonValue> extends JsonObject {
  readonly protocol: WorkerProtocolVersion;
  readonly messageId: MessageId;
  readonly sessionId: SessionId;
  readonly sequence: Sequence;
  readonly correlationId: MessageId;
  readonly type: WorkerMessageType;
  readonly sentAt: string;
  readonly payload: T;
  readonly binaryBytes?: number;
  readonly binaryChunks?: number;
}
