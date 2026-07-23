import type { MessageId, Sequence, SessionId } from "./identity.js";

export type WorkerProtocolVersion = "1.0";
export type WorkerMessageType =
  | "artifact.prepare"
  | "artifact.prepared"
  | "heartbeat"
  | "hello"
  | "session.reconcile"
  | "task.acknowledge"
  | "task.assign"
  | "task.cancel"
  | "task.result"
  | "worker.register";

export interface WorkerEnvelope<T = unknown> {
  readonly protocol: WorkerProtocolVersion;
  readonly messageId: MessageId;
  readonly sessionId: SessionId;
  readonly sequence: Sequence;
  readonly correlationId?: MessageId;
  readonly type: WorkerMessageType;
  readonly sentAt: string;
  readonly payload: T;
}
