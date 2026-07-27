import { createHash, randomUUID } from "node:crypto";
import {
  type ArtifactDigest,
  type Clock,
  DiagnosticError,
  type ExecutorKind,
  type FencingEpoch,
  type JsonObject,
  type JsonValue,
  parseArtifactDigest,
  parseFencingEpoch,
  parseMessageId,
  parseSequence,
  parseSessionId,
  parseWorkerId,
  type RuntimeDiagnostic,
  runtimeDiagnostic,
  type SessionId,
  serializeWireValue,
  type WorkerId,
  type WorkerMessageType,
  type WorkerProtocolVersion,
} from "@tegojs/contracts";
import {
  createAuthenticationNonce,
  createAuthenticationProof,
  verifyAuthenticationProof,
  type WorkerSessionRole,
} from "./authentication.js";
import {
  createWorkerCodec,
  type WorkerCodec,
  type WorkerControlEnvelope,
  type WorkerProtocolLimitOverrides,
} from "./codec.js";

export interface WorkerRegistration extends JsonObject {
  readonly workerId: WorkerId;
  readonly labels: JsonObject;
  readonly resources: JsonObject;
  readonly executors: readonly ExecutorKind[];
  readonly preparedArtifacts: readonly ArtifactDigest[];
}

export interface WorkerSessionMessage {
  readonly messageId: string;
  readonly correlationId: string;
  readonly type: WorkerMessageType;
  readonly payload: JsonValue;
  readonly binary?: Uint8Array;
}

export type WorkerSessionState = "authenticating" | "closed" | "ready" | "unavailable";

export interface WorkerSessionSendOptions {
  readonly correlationId?: string;
  readonly binary?: Uint8Array;
}

export interface WorkerSessionRequestOptions {
  readonly binary?: Uint8Array;
  readonly timeoutMs?: number;
}

type SocketListener = (...arguments_: unknown[]) => void;
const websocketTextDecoder = new TextDecoder("utf-8", { fatal: true });
const MAXIMUM_UNSIGNED_64 = 18_446_744_073_709_551_615n;
const RESERVED_SESSION_MESSAGE_TYPES = new Set([
  "authenticate",
  "heartbeat",
  "hello",
  "session.ready",
  "worker.register",
]);

interface WebSocketTransport {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: "close" | "error" | "message", listener: SocketListener): unknown;
  off(event: "close" | "error" | "message", listener: SocketListener): unknown;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  readonly settled: () => boolean;
}

interface PendingBinary {
  readonly envelope: WorkerControlEnvelope;
  readonly chunks: Uint8Array[];
  nextChunk: number;
  receivedBytes: number;
}

interface PendingRequest {
  readonly resolve: (message: WorkerSessionMessage) => void;
  readonly reject: (error: unknown) => void;
  readonly timeout: AbortController;
}

interface RetainedReplay {
  readonly messageId: string;
  readonly fingerprint: string;
}

export interface WorkerSessionOptions {
  readonly role: WorkerSessionRole;
  readonly socket: unknown;
  readonly clock: Clock;
  readonly credential?: string;
  readonly resolveCredential?: (workerId: WorkerId) => string | undefined;
  readonly protocol?: WorkerProtocolVersion;
  readonly limits?: WorkerProtocolLimitOverrides;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly worker?: WorkerRegistration;
  readonly onRegister?: (
    session: WorkerSession,
    registration: WorkerRegistration,
  ) => FencingEpoch | Promise<FencingEpoch>;
  readonly onUnavailable?: (session: WorkerSession) => void;
  readonly onClosed?: (session: WorkerSession) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  let isSettled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value): void {
      if (!isSettled) {
        isSettled = true;
        resolvePromise(value);
      }
    },
    reject(error): void {
      if (!isSettled) {
        isSettled = true;
        rejectPromise(error);
      }
    },
    settled: () => isSettled,
  };
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`)
    .join(",")}}`;
}

function replayFingerprint(envelope: WorkerControlEnvelope): string {
  return createHash("sha256")
    .update("tego.worker-envelope-replay/1.0\0")
    .update(canonicalJson(envelope))
    .digest("hex");
}

function diagnosticError(
  code: `PROTOCOL_${string}` | `WORKER_${string}`,
  message: string,
  details?: JsonValue,
): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: code.startsWith("WORKER_") ? "worker" : "protocol", id: "session" },
      ...(details === undefined ? {} : { details }),
    }),
  );
}

function normalizeSocket(value: unknown): WebSocketTransport {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("socket must implement the WebSocket API");
  }
  const socket = value as Partial<WebSocketTransport>;
  if (
    typeof socket.readyState !== "number" ||
    typeof socket.send !== "function" ||
    typeof socket.close !== "function" ||
    typeof socket.on !== "function" ||
    typeof socket.off !== "function"
  ) {
    throw new TypeError("socket must implement the ws send/close/on/off API");
  }
  return socket as WebSocketTransport;
}

function asObject(value: JsonValue, type: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw diagnosticError("PROTOCOL_MESSAGE_INVALID", `${type} payload must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function requireExactFields(
  record: Record<string, JsonValue>,
  fields: readonly string[],
  type: string,
): void {
  const allowed = new Set(fields);
  if (Object.keys(record).some((field) => !allowed.has(field))) {
    throw diagnosticError("PROTOCOL_MESSAGE_INVALID", `${type} payload has unknown fields`);
  }
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return duration;
}

function boundedUnsigned64(value: string, name: string): string {
  const parsed = BigInt(parseSequence(value));
  if (parsed > MAXIMUM_UNSIGNED_64) {
    throw diagnosticError(
      "PROTOCOL_SEQUENCE_LIMIT_EXCEEDED",
      `${name} exceeds the unsigned 64-bit protocol limit`,
    );
  }
  return value;
}

function boundedWorkerEpoch(value: string, name: string): FencingEpoch {
  return parseFencingEpoch(boundedUnsigned64(value, name));
}

export function compareWorkerEpoch(left: FencingEpoch, right: FencingEpoch): number {
  const leftValue = BigInt(boundedUnsigned64(left, "Worker epoch"));
  const rightValue = BigInt(boundedUnsigned64(right, "Worker epoch"));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function normalizeCredential(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new TypeError("credential must be a non-empty bounded string");
  }
  return value;
}

function rejectReservedMessageType(type: string): void {
  if (RESERVED_SESSION_MESSAGE_TYPES.has(type)) {
    throw diagnosticError(
      "PROTOCOL_MESSAGE_TYPE_RESERVED",
      "Worker handshake message type is reserved for the session state machine",
    );
  }
}

function normalizeRegistration(value: WorkerRegistration): WorkerRegistration {
  const workerId = parseWorkerId(value.workerId);
  const labels = serializeWireValue(value.labels);
  const resources = serializeWireValue(value.resources);
  if (
    typeof labels !== "object" ||
    labels === null ||
    Array.isArray(labels) ||
    typeof resources !== "object" ||
    resources === null ||
    Array.isArray(resources) ||
    !Array.isArray(value.executors) ||
    value.executors.some(
      (executor) => executor !== "process" && executor !== "thread" && executor !== "remote",
    ) ||
    !Array.isArray(value.preparedArtifacts) ||
    value.preparedArtifacts.some(
      (artifact) => typeof artifact !== "string" || artifact.length === 0,
    )
  ) {
    throw diagnosticError(
      "PROTOCOL_REGISTRATION_INVALID",
      "Worker registration fields are invalid",
    );
  }
  return {
    workerId,
    labels: labels as JsonObject,
    resources: resources as JsonObject,
    executors: [...value.executors],
    preparedArtifacts: value.preparedArtifacts.map((artifact) => parseArtifactDigest(artifact)),
  };
}

function socketMessage(arguments_: readonly unknown[], maxFrameBytes: number): string | Uint8Array {
  const first = arguments_[0];
  const candidate =
    typeof first === "object" && first !== null && "data" in first && Object.hasOwn(first, "data")
      ? (first as { data: unknown }).data
      : first;
  if (typeof candidate === "string") {
    if (Buffer.byteLength(candidate, "utf8") > maxFrameBytes) {
      throw diagnosticError(
        "PROTOCOL_FRAME_TOO_LARGE",
        "Worker text frame exceeds the configured byte limit",
      );
    }
    return candidate;
  }
  const parts =
    candidate instanceof Uint8Array
      ? [candidate]
      : candidate instanceof ArrayBuffer
        ? [new Uint8Array(candidate)]
        : Array.isArray(candidate) &&
            candidate.every((part): part is Uint8Array => part instanceof Uint8Array)
          ? candidate
          : undefined;
  if (parts !== undefined) {
    let totalBytes = 0;
    for (const part of parts) {
      totalBytes += part.byteLength;
      if (totalBytes > maxFrameBytes) {
        throw diagnosticError(
          "PROTOCOL_FRAME_TOO_LARGE",
          "Worker frame exceeds the configured byte limit",
        );
      }
    }
    const bytes =
      parts.length === 1
        ? (parts[0] as Uint8Array)
        : Buffer.concat(
            parts.map((part) => Buffer.from(part)),
            totalBytes,
          );
    if (arguments_[1] === false) {
      try {
        return websocketTextDecoder.decode(bytes);
      } catch {
        throw diagnosticError("PROTOCOL_JSON_INVALID", "Worker text frame is not valid UTF-8");
      }
    }
    return bytes;
  }
  throw diagnosticError(
    "PROTOCOL_FRAME_INVALID",
    "WebSocket message must be a string or binary frame",
  );
}

function closeCode(diagnostic: RuntimeDiagnostic): number {
  if (diagnostic.code === "PROTOCOL_FRAME_TOO_LARGE") {
    return 1009;
  }
  return diagnostic.code.startsWith("PROTOCOL_") ? 1008 : 1011;
}

export class WorkerSession {
  readonly ready: Promise<void>;
  readonly #readyDeferred = deferred<void>();
  readonly #socket: WebSocketTransport;
  readonly #clock: Clock;
  #credential: string;
  readonly #resolveCredential: WorkerSessionOptions["resolveCredential"] | undefined;
  readonly #protocol: WorkerProtocolVersion;
  readonly #codec: WorkerCodec;
  readonly #role: WorkerSessionRole;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #worker: WorkerRegistration | undefined;
  readonly #onRegister: WorkerSessionOptions["onRegister"] | undefined;
  readonly #onUnavailable: WorkerSessionOptions["onUnavailable"] | undefined;
  readonly #onClosed: WorkerSessionOptions["onClosed"] | undefined;
  readonly #nonce = createAuthenticationNonce();
  readonly #abort = new AbortController();
  readonly #handshakeAbort = new AbortController();
  readonly #listeners = new Set<(message: WorkerSessionMessage) => void>();
  readonly #stateListeners = new Set<(state: WorkerSessionState) => void>();
  readonly #pendingMessages: WorkerSessionMessage[] = [];
  readonly #receivedFingerprints = new Map<string, string>();
  readonly #receivedReplayOrder: RetainedReplay[] = [];
  readonly #pendingBinary = new Map<string, PendingBinary>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #issuedRequestIds = new Set<string>();
  readonly #issuedRequestOrder: string[] = [];
  #state: WorkerSessionState = "authenticating";
  #available = false;
  #acceptingAssignments = false;
  #diagnostic?: RuntimeDiagnostic;
  #sessionId: SessionId;
  #epoch = parseFencingEpoch("0");
  #nextSequence = 0n;
  #expectedSequence = 0n;
  #remoteNonce?: string;
  #remoteRole?: WorkerSessionRole;
  #remoteHelloSessionId?: string;
  #principalWorkerId?: WorkerId;
  #principalAuthorized = false;
  #peerAuthenticated = false;
  #helloSent = false;
  #authenticationSent = false;
  #registrationSent = false;
  #registrationPending = false;
  #lastHeartbeatAt = 0;
  #pendingBinaryBytes = 0;
  #pendingMessageBytes = 0;
  #flushingPendingMessages = false;
  #detached = false;
  #closedNotified = false;

  readonly #messageListener: SocketListener = (...arguments_) => {
    this.#receive(arguments_);
  };
  readonly #closeListener: SocketListener = () => {
    this.#transportClosed();
  };
  readonly #errorListener: SocketListener = () => {
    this.#fail(diagnosticError("WORKER_TRANSPORT_ERROR", "Worker WebSocket transport failed"));
  };

  constructor(options: WorkerSessionOptions) {
    this.#role = options.role;
    this.#socket = normalizeSocket(options.socket);
    this.#clock = options.clock;
    this.#credential =
      options.credential === undefined
        ? `unauthorized-${randomUUID()}`
        : normalizeCredential(options.credential);
    this.#resolveCredential = options.resolveCredential;
    this.#protocol = options.protocol ?? "1.0";
    this.#codec = createWorkerCodec(options.limits, this.#protocol);
    this.#heartbeatIntervalMs = positiveDuration(
      options.heartbeatIntervalMs,
      5_000,
      "heartbeatIntervalMs",
    );
    this.#heartbeatTimeoutMs = positiveDuration(
      options.heartbeatTimeoutMs,
      15_000,
      "heartbeatTimeoutMs",
    );
    this.#handshakeTimeoutMs = positiveDuration(
      options.handshakeTimeoutMs,
      10_000,
      "handshakeTimeoutMs",
    );
    this.#requestTimeoutMs = positiveDuration(options.requestTimeoutMs, 15_000, "requestTimeoutMs");
    this.#worker = options.worker === undefined ? undefined : normalizeRegistration(options.worker);
    if (this.#role === "worker") {
      if (options.credential === undefined || this.#worker === undefined) {
        throw new TypeError("Worker sessions require a credential-bound Worker identity");
      }
      this.#principalWorkerId = this.#worker.workerId;
      this.#principalAuthorized = true;
    } else if (this.#resolveCredential === undefined) {
      throw new TypeError("Main sessions require a Worker credential resolver");
    }
    this.#onRegister = options.onRegister;
    this.#onUnavailable = options.onUnavailable;
    this.#onClosed = options.onClosed;
    this.#sessionId = parseSessionId(`session-${randomUUID()}`);
    this.ready = this.#readyDeferred.promise;
    void this.ready.catch(() => undefined);

    this.#socket.on("message", this.#messageListener);
    this.#socket.on("close", this.#closeListener);
    this.#socket.on("error", this.#errorListener);
    void this.#watchHandshake();
    queueMicrotask(() => {
      if (this.#state === "authenticating") {
        try {
          this.#sendHello();
        } catch (error) {
          this.#fail(
            error instanceof DiagnosticError
              ? error
              : diagnosticError("WORKER_TRANSPORT_ERROR", "Worker hello could not be sent"),
          );
        }
      }
    });
  }

  get sessionId(): SessionId {
    return this.#sessionId;
  }

  get epoch(): FencingEpoch {
    return this.#epoch;
  }

  get state(): WorkerSessionState {
    return this.#state;
  }

  get available(): boolean {
    return this.#available;
  }

  get acceptingAssignments(): boolean {
    return this.#acceptingAssignments;
  }

  get diagnostic(): RuntimeDiagnostic | undefined {
    return this.#diagnostic;
  }

  onMessage(listener: (message: WorkerSessionMessage) => void): () => void {
    this.#listeners.add(listener);
    if (!this.#flushingPendingMessages && this.#pendingMessages.length > 0) {
      this.#flushingPendingMessages = true;
      try {
        while (this.#pendingMessages.length > 0) {
          const message = this.#pendingMessages.shift() as WorkerSessionMessage;
          this.#pendingMessageBytes = Math.max(
            0,
            this.#pendingMessageBytes - this.#applicationMessageBytes(message),
          );
          try {
            listener(message);
          } catch {
            // Consumer callbacks do not participate in the authenticated protocol state machine.
          }
        }
      } finally {
        this.#flushingPendingMessages = false;
      }
    }
    return () => this.#listeners.delete(listener);
  }

  onStateChange(listener: (state: WorkerSessionState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  async send(
    type: WorkerMessageType,
    payload: JsonValue,
    options: WorkerSessionSendOptions = {},
  ): Promise<string> {
    rejectReservedMessageType(type);
    if (this.#state !== "ready" || !this.#available) {
      throw diagnosticError(
        "WORKER_SESSION_NOT_AVAILABLE",
        this.#state === "closed" ? "Worker session is closed" : "Worker session is not available",
      );
    }
    return this.#sendEnvelope(type, payload, options);
  }

  async request(
    type: WorkerMessageType,
    payload: JsonValue,
    options: WorkerSessionRequestOptions = {},
  ): Promise<WorkerSessionMessage> {
    rejectReservedMessageType(type);
    if (this.#pendingRequests.size >= this.#codec.limits.maxInflightMessages) {
      throw diagnosticError(
        "PROTOCOL_INFLIGHT_LIMIT_EXCEEDED",
        "Worker session inflight request limit was reached",
      );
    }
    if (this.#state !== "ready" || !this.#available) {
      throw diagnosticError(
        "WORKER_SESSION_NOT_AVAILABLE",
        this.#state === "closed" ? "Worker session is closed" : "Worker session is not available",
      );
    }
    const messageId = `message-${randomUUID()}`;
    const response = deferred<WorkerSessionMessage>();
    const timeout = new AbortController();
    this.#pendingRequests.set(messageId, {
      resolve: response.resolve,
      reject: response.reject,
      timeout,
    });
    this.#retainIssuedRequest(messageId);
    const timeoutMs = positiveDuration(options.timeoutMs, this.#requestTimeoutMs, "timeoutMs");
    void this.#clock
      .sleep(timeoutMs, timeout.signal)
      .then(() => {
        const pending = this.#pendingRequests.get(messageId);
        if (pending === undefined) return;
        this.#pendingRequests.delete(messageId);
        this.#pruneIssuedRequests();
        pending.reject(
          diagnosticError(
            "WORKER_REQUEST_TIMEOUT",
            "Worker application request timed out before a correlated response arrived",
          ),
        );
      })
      .catch(() => undefined);
    try {
      this.#sendEnvelope(type, payload, options, messageId);
    } catch (error) {
      this.#pendingRequests.delete(messageId);
      this.#issuedRequestIds.delete(messageId);
      timeout.abort();
      response.reject(error);
      throw error;
    }
    return response.promise;
  }

  async close(): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.#notifyState();
    this.#available = false;
    this.#acceptingAssignments = false;
    this.#abort.abort(diagnosticError("WORKER_SESSION_CLOSED", "Worker session is closed"));
    this.#handshakeAbort.abort();
    this.#readyDeferred.reject(
      diagnosticError("WORKER_SESSION_CLOSED", "Worker session closed before becoming ready"),
    );
    this.#rejectPending(
      diagnosticError("WORKER_SESSION_CLOSED", "Worker session closed before a response arrived"),
    );
    this.#socket.close(1000, "WORKER_SESSION_CLOSED");
    this.#detach();
  }

  replace(): void {
    if (this.#state === "closed" || this.#state === "unavailable") {
      return;
    }
    this.#state = "unavailable";
    this.#notifyState();
    this.#available = false;
    this.#acceptingAssignments = false;
    this.#abort.abort(diagnosticError("WORKER_SESSION_REPLACED", "Worker session was replaced"));
    this.#handshakeAbort.abort();
    this.#rejectPending(diagnosticError("WORKER_SESSION_REPLACED", "Worker session was replaced"));
    this.#onUnavailable?.(this);
    this.#socket.close(1000, "WORKER_SESSION_REPLACED");
    this.#detach();
  }

  #receive(arguments_: readonly unknown[]): void {
    if (this.#state === "closed") {
      return;
    }
    try {
      const frame = socketMessage(arguments_, this.#codec.limits.maxFrameBytes);
      if (typeof frame === "string") {
        this.#receiveControl(this.#codec.decodeControl(frame));
      } else {
        if (frame.byteLength > this.#codec.limits.maxFrameBytes) {
          throw diagnosticError(
            "PROTOCOL_FRAME_TOO_LARGE",
            "Worker binary frame exceeds the configured byte limit",
          );
        }
        this.#receiveBinary(frame);
      }
    } catch (error) {
      this.#fail(
        error instanceof DiagnosticError && error.diagnostic.code !== "WORKER_ENVELOPE_INVALID"
          ? error
          : diagnosticError(
              error instanceof DiagnosticError
                ? "PROTOCOL_MESSAGE_INVALID"
                : "PROTOCOL_FRAME_INVALID",
              error instanceof DiagnosticError
                ? "Worker control message is invalid"
                : "Worker frame could not be processed",
            ),
      );
    }
  }

  #receiveControl(envelope: WorkerControlEnvelope): void {
    const sequence = BigInt(parseSequence(envelope.sequence));
    const fingerprint = replayFingerprint(envelope);
    const retainedFingerprint = this.#receivedFingerprints.get(envelope.messageId);
    if (sequence < this.#expectedSequence) {
      if (retainedFingerprint === fingerprint) {
        return;
      }
      throw diagnosticError(
        "PROTOCOL_SEQUENCE_REPLAY",
        retainedFingerprint === undefined
          ? "Worker message sequence was replayed with a different identity"
          : "Worker message replay did not match its retained canonical content",
      );
    }
    if (sequence > this.#expectedSequence) {
      const gap = sequence - this.#expectedSequence;
      throw diagnosticError(
        gap > BigInt(this.#codec.limits.maxSequenceGap)
          ? "PROTOCOL_SEQUENCE_GAP_LIMIT_EXCEEDED"
          : "PROTOCOL_SEQUENCE_OUT_OF_ORDER",
        "Worker message sequence is not contiguous",
      );
    }
    if (retainedFingerprint !== undefined) {
      throw diagnosticError(
        "PROTOCOL_SEQUENCE_REPLAY",
        retainedFingerprint === fingerprint
          ? "Worker message identity was replayed at a different sequence"
          : "Worker message replay did not match its retained canonical content",
      );
    }
    this.#expectedSequence += 1n;
    this.#retainReplay({ messageId: envelope.messageId, fingerprint });

    if (
      this.#state === "ready" &&
      envelope.sessionId !== this.#sessionId &&
      envelope.type !== "hello"
    ) {
      throw diagnosticError(
        "PROTOCOL_SESSION_ID_MISMATCH",
        "Worker message belongs to a stale session",
      );
    }

    if (envelope.binaryBytes !== undefined) {
      if (
        this.#pendingBinary.size >= this.#codec.limits.maxPendingCorrelations ||
        this.#pendingBinaryBytes + envelope.binaryBytes > this.#codec.limits.maxBinaryBytes
      ) {
        throw diagnosticError(
          "PROTOCOL_BINARY_LIMIT_EXCEEDED",
          "Worker pending binary correlation limit was reached",
        );
      }
      this.#pendingBinary.set(envelope.messageId, {
        envelope,
        chunks: [],
        nextChunk: 0,
        receivedBytes: 0,
      });
      this.#pendingBinaryBytes += envelope.binaryBytes;
      return;
    }
    this.#dispatch(envelope);
  }

  #receiveBinary(frame: Uint8Array): void {
    const chunk = this.#codec.decodeBinary(frame);
    const pending = this.#pendingBinary.get(chunk.correlationId);
    if (pending === undefined) {
      throw diagnosticError(
        "PROTOCOL_BINARY_CORRELATION_UNKNOWN",
        "Worker binary frame has no pending control message",
      );
    }
    if (
      chunk.chunkIndex !== pending.nextChunk ||
      chunk.totalChunks !== pending.envelope.binaryChunks
    ) {
      throw diagnosticError(
        "PROTOCOL_BINARY_ORDER_INVALID",
        "Worker binary chunks are duplicated or out of order",
      );
    }
    pending.receivedBytes += chunk.payload.byteLength;
    if (
      pending.receivedBytes > (pending.envelope.binaryBytes ?? 0) ||
      pending.receivedBytes > this.#codec.limits.maxBinaryBytes
    ) {
      throw diagnosticError(
        "PROTOCOL_BINARY_LIMIT_EXCEEDED",
        "Worker binary aggregate exceeds the declared byte count",
      );
    }
    pending.chunks.push(chunk.payload);
    pending.nextChunk += 1;
    if (pending.nextChunk !== chunk.totalChunks) {
      return;
    }
    if (pending.receivedBytes !== pending.envelope.binaryBytes) {
      throw diagnosticError(
        "PROTOCOL_BINARY_INVALID",
        "Worker binary aggregate does not match its declared byte count",
      );
    }
    this.#pendingBinary.delete(chunk.correlationId);
    this.#pendingBinaryBytes -= pending.envelope.binaryBytes ?? 0;
    const binary = new Uint8Array(pending.receivedBytes);
    let offset = 0;
    for (const part of pending.chunks) {
      binary.set(part, offset);
      offset += part.byteLength;
    }
    this.#dispatch(pending.envelope, binary);
  }

  #dispatch(envelope: WorkerControlEnvelope, binary?: Uint8Array): void {
    if (envelope.type === "hello") {
      this.#receiveHello(envelope);
      return;
    }
    if (envelope.type === "authenticate") {
      this.#receiveAuthentication(envelope);
      return;
    }
    if (envelope.type === "worker.register") {
      void this.#receiveRegistration(envelope).catch((error: unknown) => {
        this.#fail(
          error instanceof DiagnosticError
            ? error
            : diagnosticError(
                "PROTOCOL_HANDSHAKE_INVALID",
                "Worker session epoch allocation failed",
              ),
        );
      });
      return;
    }
    if (envelope.type === "session.ready") {
      this.#receiveReady(envelope);
      return;
    }
    if (envelope.type === "heartbeat") {
      if (this.#role === "main" && this.#state === "ready") {
        this.#lastHeartbeatAt = this.#clock.now().getTime();
      }
      return;
    }
    if (this.#state !== "ready") {
      throw diagnosticError(
        "PROTOCOL_HANDSHAKE_INCOMPLETE",
        "Worker application message arrived before authentication completed",
      );
    }
    const message: WorkerSessionMessage = {
      messageId: envelope.messageId,
      correlationId: envelope.correlationId,
      type: envelope.type,
      payload: envelope.payload,
      ...(binary === undefined ? {} : { binary }),
    };
    if (envelope.correlationId !== envelope.messageId) {
      const request = this.#pendingRequests.get(envelope.correlationId);
      if (request !== undefined) {
        this.#pendingRequests.delete(envelope.correlationId);
        this.#pruneIssuedRequests();
        request.timeout.abort();
        request.resolve(message);
        return;
      }
      if (this.#issuedRequestIds.has(envelope.correlationId)) {
        return;
      }
      throw diagnosticError(
        "PROTOCOL_MESSAGE_INVALID",
        "Worker response correlation does not identify an issued request",
      );
    }
    if (this.#listeners.size === 0 || this.#flushingPendingMessages) {
      const bytes = this.#applicationMessageBytes(message);
      const maxPendingMessageBytes =
        this.#codec.limits.maxBinaryBytes + this.#codec.limits.maxFrameBytes;
      if (
        this.#pendingMessages.length >= this.#codec.limits.maxInflightMessages ||
        this.#pendingMessageBytes + bytes > maxPendingMessageBytes
      ) {
        throw diagnosticError(
          "PROTOCOL_INFLIGHT_LIMIT_EXCEEDED",
          "Worker session pending application message limit was reached",
        );
      }
      this.#pendingMessages.push(message);
      this.#pendingMessageBytes += bytes;
      return;
    }
    for (const listener of this.#listeners) {
      try {
        listener(message);
      } catch {
        // Consumer callbacks do not participate in the authenticated protocol state machine.
      }
    }
  }

  #applicationMessageBytes(message: WorkerSessionMessage): number {
    return (
      Buffer.byteLength(
        JSON.stringify({
          messageId: message.messageId,
          correlationId: message.correlationId,
          type: message.type,
          payload: message.payload,
        }),
        "utf8",
      ) + (message.binary?.byteLength ?? 0)
    );
  }

  #receiveHello(envelope: WorkerControlEnvelope): void {
    if (this.#remoteNonce !== undefined || this.#state !== "authenticating") {
      throw diagnosticError("PROTOCOL_HANDSHAKE_ORDER_INVALID", "Worker hello was duplicated");
    }
    const payload = asObject(envelope.payload, "hello");
    const peerIsWorker = payload.role === "worker";
    requireExactFields(
      payload,
      peerIsWorker ? ["role", "nonce", "workerId"] : ["role", "nonce"],
      "hello",
    );
    if (
      (payload.role !== "main" && payload.role !== "worker") ||
      payload.role === this.#role ||
      typeof payload.nonce !== "string" ||
      payload.nonce.length < 16 ||
      payload.nonce.length > 128
    ) {
      throw diagnosticError("PROTOCOL_HANDSHAKE_INVALID", "Worker hello is invalid");
    }
    this.#remoteRole = payload.role;
    this.#remoteNonce = payload.nonce;
    this.#remoteHelloSessionId = envelope.sessionId;
    if (this.#role === "main") {
      if (typeof payload.workerId !== "string") {
        throw diagnosticError("PROTOCOL_HANDSHAKE_INVALID", "Worker hello principal is invalid");
      }
      const workerId = parseWorkerId(payload.workerId);
      const resolvedCredential = this.#resolveCredential?.(workerId);
      this.#principalWorkerId = workerId;
      this.#principalAuthorized = resolvedCredential !== undefined;
      if (resolvedCredential !== undefined) {
        this.#credential = normalizeCredential(resolvedCredential);
      }
      this.#sessionId = parseSessionId(envelope.sessionId);
    }
    this.#sendHello();
    this.#sendAuthentication();
  }

  #sendHello(): void {
    if (this.#helloSent) {
      return;
    }
    this.#helloSent = true;
    try {
      this.#sendInternal("hello", {
        role: this.#role,
        nonce: this.#nonce,
        ...(this.#role === "worker" && this.#principalWorkerId !== undefined
          ? { workerId: this.#principalWorkerId }
          : {}),
      });
    } catch (error) {
      this.#helloSent = false;
      throw error;
    }
  }

  #sendAuthentication(): void {
    if (
      this.#authenticationSent ||
      !this.#helloSent ||
      this.#remoteNonce === undefined ||
      this.#remoteRole === undefined ||
      this.#principalWorkerId === undefined
    ) {
      return;
    }
    this.#authenticationSent = true;
    this.#sendInternal("authenticate", {
      proof: createAuthenticationProof({
        credential: this.#credential,
        workerId: this.#principalWorkerId,
        senderNonce: this.#nonce,
        receiverNonce: this.#remoteNonce,
        senderRole: this.#role,
      }),
    });
  }

  #receiveAuthentication(envelope: WorkerControlEnvelope): void {
    if (
      this.#peerAuthenticated ||
      this.#remoteNonce === undefined ||
      this.#remoteRole === undefined ||
      this.#principalWorkerId === undefined
    ) {
      throw diagnosticError(
        "PROTOCOL_HANDSHAKE_ORDER_INVALID",
        "Worker authentication arrived out of order",
      );
    }
    const payload = asObject(envelope.payload, "authenticate");
    requireExactFields(payload, ["proof"], "authenticate");
    const proofValid =
      typeof payload.proof === "string" &&
      verifyAuthenticationProof({
        credential: this.#credential,
        workerId: this.#principalWorkerId,
        senderNonce: this.#remoteNonce,
        receiverNonce: this.#nonce,
        senderRole: this.#remoteRole,
        proof: payload.proof,
      });
    if (!proofValid || !this.#principalAuthorized) {
      throw diagnosticError(
        "PROTOCOL_AUTHENTICATION_FAILED",
        "Worker session authentication failed",
      );
    }
    this.#peerAuthenticated = true;
    if (this.#role === "worker") {
      this.#sendRegistration();
    }
  }

  #sendRegistration(): void {
    if (this.#registrationSent || this.#worker === undefined || !this.#peerAuthenticated) {
      return;
    }
    this.#registrationSent = true;
    this.#sendInternal("worker.register", this.#worker);
  }

  async #receiveRegistration(envelope: WorkerControlEnvelope): Promise<void> {
    if (
      this.#role !== "main" ||
      this.#state !== "authenticating" ||
      this.#registrationPending ||
      !this.#peerAuthenticated ||
      this.#remoteRole !== "worker" ||
      this.#onRegister === undefined ||
      envelope.sessionId !== this.#remoteHelloSessionId
    ) {
      throw diagnosticError(
        "PROTOCOL_HANDSHAKE_ORDER_INVALID",
        "Worker registration arrived before authentication completed",
      );
    }
    const payload = asObject(envelope.payload, "worker.register");
    requireExactFields(
      payload,
      ["workerId", "labels", "resources", "executors", "preparedArtifacts"],
      "worker.register",
    );
    const registration = normalizeRegistration(payload as unknown as WorkerRegistration);
    if (registration.workerId !== this.#principalWorkerId) {
      throw diagnosticError(
        "PROTOCOL_AUTHENTICATION_FAILED",
        "Worker registration does not match the authenticated principal",
      );
    }
    this.#registrationPending = true;
    const epoch = await this.#onRegister(this, registration);
    if (this.#state !== "authenticating") return;
    this.#epoch = boundedWorkerEpoch(epoch, "Worker session epoch");
    this.#state = "ready";
    this.#notifyState();
    this.#available = true;
    this.#acceptingAssignments = true;
    this.#lastHeartbeatAt = this.#clock.now().getTime();
    this.#handshakeAbort.abort();
    this.#sendInternal("session.ready", { epoch: this.#epoch });
    this.#readyDeferred.resolve();
    void this.#watchHeartbeat();
  }

  #receiveReady(envelope: WorkerControlEnvelope): void {
    if (
      this.#role !== "worker" ||
      this.#state !== "authenticating" ||
      !this.#peerAuthenticated ||
      envelope.sessionId !== this.#sessionId
    ) {
      throw diagnosticError(
        "PROTOCOL_HANDSHAKE_ORDER_INVALID",
        "Worker session ready arrived before authentication completed",
      );
    }
    const payload = asObject(envelope.payload, "session.ready");
    requireExactFields(payload, ["epoch"], "session.ready");
    if (typeof payload.epoch !== "string") {
      throw diagnosticError("PROTOCOL_MESSAGE_INVALID", "session epoch must be a string");
    }
    this.#epoch = boundedWorkerEpoch(payload.epoch, "Worker session epoch");
    this.#state = "ready";
    this.#notifyState();
    this.#available = true;
    this.#acceptingAssignments = true;
    this.#handshakeAbort.abort();
    this.#readyDeferred.resolve();
    void this.#sendHeartbeats();
  }

  async #sendHeartbeats(): Promise<void> {
    try {
      while (this.#state === "ready") {
        this.#sendInternal("heartbeat", {});
        await this.#clock.sleep(this.#heartbeatIntervalMs, this.#abort.signal);
      }
    } catch {
      // Closing or replacing the session aborts its sole heartbeat sleeper.
    }
  }

  async #watchHandshake(): Promise<void> {
    try {
      await this.#clock.sleep(this.#handshakeTimeoutMs, this.#handshakeAbort.signal);
      if (this.#state === "authenticating") {
        this.#fail(
          diagnosticError(
            "PROTOCOL_HANDSHAKE_TIMEOUT",
            "Worker authentication handshake timed out",
          ),
        );
      }
    } catch {
      // A completed or closed session aborts its sole handshake sleeper.
    }
  }

  async #watchHeartbeat(): Promise<void> {
    try {
      while (this.#state === "ready") {
        const elapsed = this.#clock.now().getTime() - this.#lastHeartbeatAt;
        await this.#clock.sleep(
          Math.max(0, this.#heartbeatTimeoutMs - elapsed),
          this.#abort.signal,
        );
        if (
          this.#state === "ready" &&
          this.#clock.now().getTime() - this.#lastHeartbeatAt >= this.#heartbeatTimeoutMs
        ) {
          this.#expire();
          return;
        }
      }
    } catch {
      // Closing or replacing the session aborts its sole liveness sleeper.
    }
  }

  #expire(): void {
    if (this.#state !== "ready") {
      return;
    }
    this.#state = "unavailable";
    this.#notifyState();
    this.#available = false;
    this.#acceptingAssignments = false;
    this.#diagnostic = runtimeDiagnostic({
      code: "WORKER_HEARTBEAT_EXPIRED",
      message: "Worker heartbeat deadline expired",
      source: { kind: "worker", id: this.#sessionId },
    });
    this.#abort.abort(
      diagnosticError("WORKER_HEARTBEAT_EXPIRED", "Worker heartbeat deadline expired"),
    );
    this.#handshakeAbort.abort();
    this.#rejectPending(
      diagnosticError("WORKER_HEARTBEAT_EXPIRED", "Worker heartbeat deadline expired"),
    );
    this.#onUnavailable?.(this);
    this.#socket.close(1001, "WORKER_HEARTBEAT_EXPIRED");
    this.#detach();
  }

  #sendInternal(type: WorkerMessageType, payload: JsonValue): string {
    return this.#sendEnvelope(type, payload, {});
  }

  #sendEnvelope(
    type: WorkerMessageType,
    payload: JsonValue,
    options: WorkerSessionSendOptions,
    suppliedMessageId?: string,
  ): string {
    if (
      this.#state === "closed" ||
      this.#state === "unavailable" ||
      this.#socket.readyState !== 1
    ) {
      throw diagnosticError("WORKER_SESSION_CLOSED", "Worker session is closed");
    }
    const messageId = parseMessageId(suppliedMessageId ?? `message-${randomUUID()}`);
    const binary = options.binary;
    const maxChunkPayload = Math.max(1, this.#codec.limits.maxFrameBytes - 160);
    const binaryChunks =
      binary === undefined ? undefined : Math.ceil(binary.byteLength / maxChunkPayload);
    if (
      binary !== undefined &&
      (binary.byteLength === 0 ||
        binary.byteLength > this.#codec.limits.maxBinaryBytes ||
        binaryChunks === undefined ||
        binaryChunks > this.#codec.limits.maxBinaryChunks)
    ) {
      throw diagnosticError(
        "PROTOCOL_BINARY_LIMIT_EXCEEDED",
        "Worker binary payload exceeds configured limits",
      );
    }
    const envelope: WorkerControlEnvelope = {
      protocol: this.#protocol,
      messageId,
      sessionId: this.#sessionId,
      sequence: parseSequence(this.#nextSequence.toString()),
      correlationId: parseMessageId(options.correlationId ?? messageId),
      type,
      sentAt: this.#clock.now().toISOString(),
      payload: serializeWireValue(payload),
      ...(binary === undefined ? {} : { binaryBytes: binary.byteLength }),
      ...(binaryChunks === undefined ? {} : { binaryChunks }),
    };
    const frames: (string | Uint8Array)[] = [this.#codec.encodeControl(envelope)];
    if (binary !== undefined && binaryChunks !== undefined) {
      for (let chunkIndex = 0; chunkIndex < binaryChunks; chunkIndex += 1) {
        const start = chunkIndex * maxChunkPayload;
        frames.push(
          this.#codec.encodeBinary({
            correlationId: messageId,
            chunkIndex,
            totalChunks: binaryChunks,
            payload: binary.subarray(start, Math.min(binary.byteLength, start + maxChunkPayload)),
          }),
        );
      }
    }
    this.#nextSequence += 1n;
    try {
      for (const frame of frames) {
        this.#socket.send(frame);
      }
    } catch {
      const error = diagnosticError(
        "WORKER_TRANSPORT_ERROR",
        "Worker WebSocket transport could not send a frame",
      );
      this.#fail(error);
      throw error;
    }
    return messageId;
  }

  #retainReplay(replay: RetainedReplay): void {
    this.#receivedFingerprints.set(replay.messageId, replay.fingerprint);
    this.#receivedReplayOrder.push(replay);
    while (this.#receivedReplayOrder.length > this.#codec.limits.replayRetention) {
      const removed = this.#receivedReplayOrder.shift();
      if (removed !== undefined) {
        this.#receivedFingerprints.delete(removed.messageId);
      }
    }
  }

  #retainIssuedRequest(messageId: string): void {
    this.#issuedRequestIds.add(messageId);
    this.#issuedRequestOrder.push(messageId);
    this.#pruneIssuedRequests();
  }

  #pruneIssuedRequests(): void {
    const retention = this.#codec.limits.replayRetention + this.#codec.limits.maxInflightMessages;
    while (this.#issuedRequestIds.size > retention) {
      const removed = this.#issuedRequestOrder.shift();
      if (removed === undefined) {
        return;
      }
      if (this.#pendingRequests.has(removed)) {
        this.#issuedRequestOrder.push(removed);
        continue;
      }
      this.#issuedRequestIds.delete(removed);
    }
  }

  #fail(error: DiagnosticError): void {
    if (this.#state === "closed" || this.#state === "unavailable") {
      return;
    }
    this.#diagnostic = error.diagnostic;
    this.#state = "closed";
    this.#notifyState();
    this.#available = false;
    this.#acceptingAssignments = false;
    this.#abort.abort(error);
    this.#handshakeAbort.abort();
    this.#readyDeferred.reject(error);
    this.#rejectPending(error);
    this.#socket.close(closeCode(error.diagnostic), error.diagnostic.code);
    this.#detach();
  }

  #transportClosed(): void {
    if (this.#state === "closed" || this.#state === "unavailable") {
      this.#detach();
      return;
    }
    this.#state = "closed";
    this.#notifyState();
    this.#available = false;
    this.#acceptingAssignments = false;
    const error = diagnosticError("WORKER_SESSION_CLOSED", "Worker WebSocket session closed", {
      category: "transport-closed",
    });
    this.#diagnostic = error.diagnostic;
    this.#abort.abort(error);
    this.#handshakeAbort.abort();
    this.#readyDeferred.reject(error);
    this.#rejectPending(error);
    this.#detach();
  }

  #rejectPending(error: DiagnosticError): void {
    for (const request of this.#pendingRequests.values()) {
      request.timeout.abort();
      request.reject(error);
    }
    this.#pendingRequests.clear();
    this.#issuedRequestIds.clear();
    this.#issuedRequestOrder.length = 0;
    this.#pendingBinary.clear();
    this.#pendingBinaryBytes = 0;
  }

  #detach(): void {
    if (this.#detached) {
      return;
    }
    this.#detached = true;
    this.#socket.off("message", this.#messageListener);
    this.#socket.off("close", this.#closeListener);
    this.#socket.off("error", this.#errorListener);
    this.#listeners.clear();
    this.#stateListeners.clear();
    this.#pendingMessages.length = 0;
    this.#pendingMessageBytes = 0;
    if (!this.#closedNotified) {
      this.#closedNotified = true;
      this.#onClosed?.(this);
    }
  }

  #notifyState(): void {
    for (const listener of this.#stateListeners) {
      try {
        listener(this.#state);
      } catch {
        // Consumer state observers do not participate in protocol liveness.
      }
    }
  }
}
