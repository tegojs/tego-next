import { randomUUID } from "node:crypto";
import {
  DiagnosticError,
  parseSequence,
  parseSessionId,
  parseWorkerId,
  runtimeDiagnostic,
  serializeWireValue,
  type Clock,
  type JsonObject,
  type JsonValue,
  type RuntimeDiagnostic,
  type SessionId,
  type WorkerId,
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
  readonly executors: readonly string[];
  readonly preparedArtifacts: readonly string[];
}

export interface WorkerSessionMessage {
  readonly messageId: string;
  readonly correlationId?: string;
  readonly type: string;
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
}

type SocketListener = (...arguments_: unknown[]) => void;
const websocketTextDecoder = new TextDecoder("utf-8", { fatal: true });

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
}

export interface WorkerSessionOptions {
  readonly role: WorkerSessionRole;
  readonly socket: unknown;
  readonly clock: Clock;
  readonly credential: string;
  readonly protocol?: string;
  readonly limits?: WorkerProtocolLimitOverrides;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly worker?: WorkerRegistration;
  readonly onRegister?: (session: WorkerSession, registration: WorkerRegistration) => string;
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

function normalizeCredential(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new TypeError("credential must be a non-empty bounded string");
  }
  return value;
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
    value.executors.some((executor) => typeof executor !== "string" || executor.length === 0) ||
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
    preparedArtifacts: [...value.preparedArtifacts],
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

function closeDetails(arguments_: readonly unknown[]): {
  readonly code: number;
  readonly reason: string;
} {
  const first = arguments_[0];
  if (typeof first === "object" && first !== null && "code" in first) {
    const event = first as { code?: unknown; reason?: unknown };
    return {
      code: typeof event.code === "number" ? event.code : 1006,
      reason: typeof event.reason === "string" ? event.reason : "",
    };
  }
  const second = arguments_[1];
  return {
    code: typeof first === "number" ? first : 1006,
    reason:
      typeof second === "string"
        ? second
        : second instanceof Uint8Array
          ? Buffer.from(second).toString("utf8")
          : "",
  };
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
  readonly #credential: string;
  readonly #protocol: string;
  readonly #codec: WorkerCodec;
  readonly #role: WorkerSessionRole;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #worker: WorkerRegistration | undefined;
  readonly #onRegister: WorkerSessionOptions["onRegister"] | undefined;
  readonly #onUnavailable: WorkerSessionOptions["onUnavailable"] | undefined;
  readonly #onClosed: WorkerSessionOptions["onClosed"] | undefined;
  readonly #nonce = createAuthenticationNonce();
  readonly #abort = new AbortController();
  readonly #handshakeAbort = new AbortController();
  readonly #listeners = new Set<(message: WorkerSessionMessage) => void>();
  readonly #receivedIds = new Set<string>();
  readonly #receivedIdOrder: string[] = [];
  readonly #pendingBinary = new Map<string, PendingBinary>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  #state: WorkerSessionState = "authenticating";
  #available = false;
  #acceptingAssignments = false;
  #diagnostic?: RuntimeDiagnostic;
  #sessionId: SessionId;
  #epoch = "0";
  #nextSequence = 0n;
  #expectedSequence = 0n;
  #remoteNonce?: string;
  #remoteRole?: WorkerSessionRole;
  #remoteHelloSessionId?: string;
  #peerAuthenticated = false;
  #authenticationSent = false;
  #registrationSent = false;
  #lastHeartbeatAt = 0;
  #pendingBinaryBytes = 0;
  #detached = false;
  #closedNotified = false;

  readonly #messageListener: SocketListener = (...arguments_) => {
    this.#receive(arguments_);
  };
  readonly #closeListener: SocketListener = (...arguments_) => {
    this.#transportClosed(closeDetails(arguments_));
  };
  readonly #errorListener: SocketListener = () => {
    this.#fail(diagnosticError("WORKER_TRANSPORT_ERROR", "Worker WebSocket transport failed"));
  };

  constructor(options: WorkerSessionOptions) {
    this.#role = options.role;
    this.#socket = normalizeSocket(options.socket);
    this.#clock = options.clock;
    this.#credential = normalizeCredential(options.credential);
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
    this.#worker = options.worker === undefined ? undefined : normalizeRegistration(options.worker);
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
          this.#sendInternal("hello", {
            role: this.#role,
            nonce: this.#nonce,
          });
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

  get epoch(): string {
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
    return () => this.#listeners.delete(listener);
  }

  async send(
    type: string,
    payload: JsonValue,
    options: WorkerSessionSendOptions = {},
  ): Promise<string> {
    if (this.#state !== "ready" || !this.#available) {
      throw diagnosticError(
        "WORKER_SESSION_NOT_AVAILABLE",
        this.#state === "closed" ? "Worker session is closed" : "Worker session is not available",
      );
    }
    return this.#sendEnvelope(type, payload, options);
  }

  async request(
    type: string,
    payload: JsonValue,
    options: WorkerSessionRequestOptions = {},
  ): Promise<WorkerSessionMessage> {
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
    this.#pendingRequests.set(messageId, {
      resolve: response.resolve,
      reject: response.reject,
    });
    try {
      this.#sendEnvelope(type, payload, options, messageId);
    } catch (error) {
      this.#pendingRequests.delete(messageId);
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
        error instanceof DiagnosticError
          ? error
          : diagnosticError("PROTOCOL_FRAME_INVALID", "Worker frame could not be processed"),
      );
    }
  }

  #receiveControl(envelope: WorkerControlEnvelope): void {
    const sequence = BigInt(parseSequence(envelope.sequence));
    if (sequence < this.#expectedSequence) {
      if (this.#receivedIds.has(envelope.messageId)) {
        return;
      }
      throw diagnosticError(
        "PROTOCOL_SEQUENCE_REPLAY",
        "Worker message sequence was replayed with a different identity",
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
    this.#expectedSequence += 1n;
    if (this.#receivedIds.has(envelope.messageId)) {
      return;
    }
    this.#retainMessageId(envelope.messageId);

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
      this.#receiveRegistration(envelope);
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
      ...(envelope.correlationId === undefined ? {} : { correlationId: envelope.correlationId }),
      type: envelope.type,
      payload: envelope.payload,
      ...(binary === undefined ? {} : { binary }),
    };
    const request =
      envelope.correlationId === undefined
        ? undefined
        : this.#pendingRequests.get(envelope.correlationId);
    if (request !== undefined) {
      this.#pendingRequests.delete(envelope.correlationId as string);
      request.resolve(message);
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

  #receiveHello(envelope: WorkerControlEnvelope): void {
    if (this.#remoteNonce !== undefined || this.#state !== "authenticating") {
      throw diagnosticError("PROTOCOL_HANDSHAKE_ORDER_INVALID", "Worker hello was duplicated");
    }
    const payload = asObject(envelope.payload, "hello");
    requireExactFields(payload, ["role", "nonce"], "hello");
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
      this.#sessionId = parseSessionId(envelope.sessionId);
    }
    this.#sendAuthentication();
  }

  #sendAuthentication(): void {
    if (
      this.#authenticationSent ||
      this.#remoteNonce === undefined ||
      this.#remoteRole === undefined
    ) {
      return;
    }
    this.#authenticationSent = true;
    this.#sendInternal("authenticate", {
      proof: createAuthenticationProof({
        credential: this.#credential,
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
      this.#remoteRole === undefined
    ) {
      throw diagnosticError(
        "PROTOCOL_HANDSHAKE_ORDER_INVALID",
        "Worker authentication arrived out of order",
      );
    }
    const payload = asObject(envelope.payload, "authenticate");
    requireExactFields(payload, ["proof"], "authenticate");
    if (
      typeof payload.proof !== "string" ||
      !verifyAuthenticationProof({
        credential: this.#credential,
        senderNonce: this.#remoteNonce,
        receiverNonce: this.#nonce,
        senderRole: this.#remoteRole,
        proof: payload.proof,
      })
    ) {
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

  #receiveRegistration(envelope: WorkerControlEnvelope): void {
    if (
      this.#role !== "main" ||
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
    this.#epoch = parseSequence(this.#onRegister(this, registration));
    this.#state = "ready";
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
    this.#epoch = parseSequence(payload.epoch);
    this.#state = "ready";
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

  #sendInternal(type: string, payload: JsonValue): string {
    return this.#sendEnvelope(type, payload, {});
  }

  #sendEnvelope(
    type: string,
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
    const messageId = suppliedMessageId ?? `message-${randomUUID()}`;
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
      sequence: this.#nextSequence.toString(),
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
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

  #retainMessageId(messageId: string): void {
    this.#receivedIds.add(messageId);
    this.#receivedIdOrder.push(messageId);
    while (this.#receivedIdOrder.length > this.#codec.limits.replayRetention) {
      const removed = this.#receivedIdOrder.shift();
      if (removed !== undefined) {
        this.#receivedIds.delete(removed);
      }
    }
  }

  #fail(error: DiagnosticError): void {
    if (this.#state === "closed" || this.#state === "unavailable") {
      return;
    }
    this.#diagnostic = error.diagnostic;
    this.#state = "closed";
    this.#available = false;
    this.#acceptingAssignments = false;
    this.#abort.abort(error);
    this.#handshakeAbort.abort();
    this.#readyDeferred.reject(error);
    this.#rejectPending(error);
    this.#socket.close(closeCode(error.diagnostic), error.diagnostic.code);
    this.#detach();
  }

  #transportClosed(details: { readonly code: number; readonly reason: string }): void {
    if (this.#state !== "unavailable") {
      this.#state = "closed";
    }
    this.#available = false;
    this.#acceptingAssignments = false;
    const error = diagnosticError("WORKER_SESSION_CLOSED", "Worker WebSocket session closed", {
      code: details.code,
      reason: details.reason.slice(0, 128),
    });
    this.#abort.abort(error);
    this.#handshakeAbort.abort();
    this.#readyDeferred.reject(error);
    this.#rejectPending(error);
    this.#detach();
  }

  #rejectPending(error: DiagnosticError): void {
    for (const request of this.#pendingRequests.values()) {
      request.reject(error);
    }
    this.#pendingRequests.clear();
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
    if (!this.#closedNotified) {
      this.#closedNotified = true;
      this.#onClosed?.(this);
    }
  }
}
