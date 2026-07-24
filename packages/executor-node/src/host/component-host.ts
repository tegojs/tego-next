import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  DiagnosticError,
  parseArtifactDigest,
  parsePluginManifest,
  runtimeDiagnostic,
  type ArtifactDigest,
  type ComponentCapabilityBoundary,
  type ComponentCapabilityDiagnostic,
  type ComponentPermissionBoundary,
  type ComponentPermissionDiagnostic,
  type DiagnosticCode,
  type JsonObject,
  type JsonValue,
  type PluginManifest,
  type RuntimeDiagnostic,
  type SecretProvider,
} from "@tegojs/contracts";
import {
  loadPreparedComponent,
  prepareArtifactBinding,
  type LoadedComponentDefinition,
  type PreparedArtifactBinding,
} from "./component-loader.js";
import {
  cloneComponentHostValue,
  COMPONENT_HOST_ATTACHMENT_COUNT_LIMIT,
  COMPONENT_HOST_PROTOCOL,
  COMPONENT_HOST_WIRE_BYTE_LIMIT,
  parseComponentHostCommand,
  parseComponentHostResult,
  type ComponentHostCommand,
  type ComponentHostResult,
  type ComponentHostState,
  type ArtifactComponentHostCommand,
  type PrepareComponentHostPayload,
  type RunComponentHostCommand,
} from "./protocol.js";

export type ComponentHostPermissionBoundary = ComponentPermissionBoundary;
export type ComponentHostCapabilityBoundary = ComponentCapabilityBoundary;

export interface ComponentHostLogger {
  debug(...values: readonly unknown[]): void;
  error(...values: readonly unknown[]): void;
  info(...values: readonly unknown[]): void;
  warn(...values: readonly unknown[]): void;
}

export interface ComponentHostEvents {
  emit(type: string, payload: JsonValue): Promise<void>;
}

export interface ResolvedComponentArtifact {
  readonly artifactDigest: ArtifactDigest;
  readonly artifactRoot: string;
  readonly manifest: PluginManifest;
}

export interface ComponentArtifactResolver {
  /**
   * Resolves a digest to an immutable artifact-store root. The trusted store
   * owns content immutability for the lifetime of the returned digest.
   */
  resolve(artifactDigest: ArtifactDigest): Promise<ResolvedComponentArtifact>;
}

export interface ComponentHostTimer {
  cancel(): void;
}

export interface ComponentHostClock {
  now(): Date;
  setTimeout(callback: () => void, delay: number): ComponentHostTimer;
}

export interface ComponentHostOptions {
  readonly logger: ComponentHostLogger;
  readonly events: ComponentHostEvents;
  readonly artifactResolver: ComponentArtifactResolver;
  readonly permissionBoundary: ComponentPermissionBoundary;
  readonly capabilityBoundary: ComponentCapabilityBoundary;
  readonly secretProvider?: SecretProvider;
  readonly clock?: ComponentHostClock;
}

interface PreparedComponent {
  readonly payload: PrepareComponentHostPayload;
  readonly artifact: PreparedArtifactBinding;
  readonly manifest: PluginManifest;
  readonly entrypoint: string;
  readonly kind: "service" | "task";
  readonly fingerprint: string;
  readonly generation: number;
}

interface CachedCommand {
  readonly fingerprint: string;
  readonly result: Promise<ComponentHostResult>;
  settled: boolean;
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly fingerprint: string;
  cancellation: "cancelled" | "timed-out" | undefined;
  result: Promise<JsonValue>;
  settled: boolean;
}

interface ActiveTransition {
  readonly result: Promise<ComponentHostResult>;
}

interface RunAttachmentLease {
  readonly fingerprint: string;
  readonly reader: {
    readonly length: number;
    get(index: number):
      | {
          readonly byteLength: number;
          bytes(): Uint8Array;
        }
      | undefined;
  };
  revoke(): void;
}

type HookName = "drain" | "health" | "run" | "start" | "stop";

const SENSITIVE_KEY = /(?:credential|password|secret|token)/iu;
const DIAGNOSTIC_CODE =
  /^(?:BOOTSTRAP|ARTIFACT|DEPLOYMENT|CAPABILITY|PERMISSION|LIFECYCLE|EXECUTOR|WORKER|COORDINATION|STATE|PROTOCOL)_[A-Z0-9_]+$/u;
const MAX_TIMER_DELAY = 2_147_483_647;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
export const COMPONENT_HOST_COMMAND_RETENTION_LIMIT = 256;
export const COMPONENT_HOST_CONTROL_COMMAND_RETENTION_LIMIT = 32;
export const COMPONENT_HOST_RUN_RETENTION_LIMIT = 256;
const CONTROL_COMMANDS = new Set<ComponentHostCommand["type"]>(["cancel", "drain", "stop"]);
const TRANSITION_COMMANDS = new Set<ComponentHostCommand["type"]>([
  "prepare",
  "import",
  "start",
  "drain",
  "stop",
]);

const SYSTEM_CLOCK: ComponentHostClock = Object.freeze({
  now: () => new Date(),
  setTimeout(callback: () => void, delay: number): ComponentHostTimer {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  },
});

function freezeJson<T extends JsonValue>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const item of Array.isArray(value) ? value : Object.values(value)) freezeJson(item);
  return Object.freeze(value);
}

function taskKey(taskId: string, attemptId: string): string {
  return `${taskId.length}:${taskId}${attemptId}`;
}

function armDeadline(
  deadline: string,
  clock: ComponentHostClock,
  onDeadline: () => void,
): () => void {
  let timer: ComponentHostTimer | undefined;
  let cancelled = false;
  const schedule = (): void => {
    if (cancelled) return;
    const remaining = Date.parse(deadline) - clock.now().getTime();
    if (remaining <= 0) {
      onDeadline();
      return;
    }
    timer = clock.setTimeout(
      remaining > MAX_TIMER_DELAY ? schedule : onDeadline,
      Math.min(remaining, MAX_TIMER_DELAY),
    );
  };
  schedule();
  return () => {
    cancelled = true;
    timer?.cancel();
  };
}

export class ComponentHost {
  readonly #options: ComponentHostOptions;
  readonly #clock: ComponentHostClock;
  readonly #commands = new Map<string, CachedCommand>();
  readonly #controlCommands = new Map<string, CachedCommand>();
  readonly #runs = new Map<string, ActiveRun>();
  readonly #secretValues = new Set<string>();
  #activeTransition: ActiveTransition | undefined;
  #acceptingRuns = false;
  #state: ComponentHostState = "new";
  #prepared: PreparedComponent | undefined;
  #definition: LoadedComponentDefinition | undefined;
  #disposables: ReturnType<ComponentHost["createDisposables"]> | undefined;
  #stopOutcome: ComponentHostResult | undefined;

  constructor(options: ComponentHostOptions) {
    this.#options = options;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
  }

  async handle(
    input: unknown,
    attachmentInput: readonly ArrayBuffer[] = [],
  ): Promise<ComponentHostResult> {
    let command: ComponentHostCommand;
    try {
      command = parseComponentHostCommand(input);
    } catch (error) {
      return this.#failure("invalid", "invalid", error);
    }
    let attachments: RunAttachmentLease;
    try {
      if (!Array.isArray(attachmentInput))
        throw this.#protocolError("Component host attachments must be an array");
      attachments = this.#attachments(attachmentInput, command.type === "run");
    } catch (error) {
      return this.#failure(command.commandId, command.type, error);
    }
    const fingerprint = `${JSON.stringify(command)}:${attachments.fingerprint}`;
    const cached =
      this.#commands.get(command.commandId) ?? this.#controlCommands.get(command.commandId);
    if (cached !== undefined) {
      if (cached.fingerprint === fingerprint) {
        attachments.revoke();
        const cache = this.#commands.has(command.commandId)
          ? this.#commands
          : this.#controlCommands;
        this.#touch(cache, command.commandId, cached);
        return cached.result;
      }
      attachments.revoke();
      return this.#failure(
        command.commandId,
        command.type,
        new DiagnosticError(
          runtimeDiagnostic({
            code: "PROTOCOL_IDEMPOTENCY_CONFLICT",
            message: "Command identity was reused with different content",
            source: { kind: "protocol", id: command.commandId },
            observedAt: this.#now(),
          }),
        ),
      );
    }
    const control = CONTROL_COMMANDS.has(command.type);
    const cache = control ? this.#controlCommands : this.#commands;
    const limit = control
      ? COMPONENT_HOST_CONTROL_COMMAND_RETENTION_LIMIT
      : COMPONENT_HOST_COMMAND_RETENTION_LIMIT;
    if (!this.#makeRoom(cache, limit)) {
      attachments.revoke();
      return this.#failure(
        command.commandId,
        command.type,
        this.#diagnosticError(
          "EXECUTOR_COMPONENT_HOST_CAPACITY_EXCEEDED",
          "Component host command capacity is exhausted",
        ),
      );
    }
    const dispatched = TRANSITION_COMMANDS.has(command.type)
      ? this.#submitTransition(command)
      : this.#dispatch(command, attachments);
    const result = dispatched.then((value) => this.#validateResult(value));
    const entry: CachedCommand = { fingerprint, result, settled: false };
    cache.set(command.commandId, entry);
    void result.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      },
    );
    void result.finally(() => attachments.revoke()).catch(() => undefined);
    return result;
  }

  retention(): Readonly<{ commands: number; controlCommands: number; runs: number }> {
    return Object.freeze({
      commands: this.#commands.size,
      controlCommands: this.#controlCommands.size,
      runs: this.#runs.size,
    });
  }

  #touch<T>(cache: Map<string, T>, key: string, value: T): void {
    cache.delete(key);
    cache.set(key, value);
  }

  #makeRoom<T extends { readonly settled: boolean }>(
    cache: Map<string, T>,
    limit: number,
  ): boolean {
    while (cache.size >= limit) {
      const settled = [...cache].find(([, value]) => value.settled);
      if (settled === undefined) return false;
      cache.delete(settled[0]);
    }
    return true;
  }

  #submitTransition(command: ComponentHostCommand): Promise<ComponentHostResult> {
    const active = this.#activeTransition;
    if (active !== undefined) {
      return Promise.resolve(
        this.#failure(
          command.commandId,
          command.type,
          this.#diagnosticError(
            "LIFECYCLE_TRANSITION_IN_PROGRESS",
            "Another lifecycle transition is already in progress",
          ),
        ),
      );
    }
    const acceptingRuns = this.#acceptingRuns;
    if (command.type === "drain" || command.type === "stop") {
      this.#acceptingRuns = false;
    }
    let result!: Promise<ComponentHostResult>;
    result = Promise.resolve()
      .then(() => this.#dispatch(command))
      .then((outcome) => {
        if (
          !outcome.ok &&
          outcome.state !== "failed" &&
          (command.type === "drain" || command.type === "stop")
        ) {
          this.#acceptingRuns = acceptingRuns;
        }
        return outcome;
      })
      .finally(() => {
        if (this.#activeTransition?.result === result) {
          this.#activeTransition = undefined;
        }
      });
    this.#activeTransition = { result };
    return result;
  }

  async #dispatch(
    command: ComponentHostCommand,
    attachments?: RunAttachmentLease,
  ): Promise<ComponentHostResult> {
    if (Date.parse(command.deadline) <= Date.parse(this.#now())) {
      return this.#failure(
        command.commandId,
        command.type,
        new DiagnosticError(
          runtimeDiagnostic({
            code: "EXECUTOR_COMMAND_DEADLINE_EXCEEDED",
            message: "Component host command deadline has elapsed",
            source: { kind: "executor", id: command.commandId },
            observedAt: this.#now(),
          }),
        ),
      );
    }
    try {
      switch (command.type) {
        case "prepare":
          return await this.#prepare(command);
        case "import":
          return await this.#import(command);
        case "start":
          return await this.#start(command);
        case "health":
          return await this.#health(command);
        case "run":
          return await this.#run(command, attachments ?? this.#attachments([]));
        case "drain":
          return await this.#drain(command);
        case "stop":
          return await this.#stop(command);
        case "cancel":
          return this.#cancel(command);
      }
    } catch (error) {
      return this.#failure(command.commandId, command.type, error);
    }
  }

  async #prepare(
    command: Extract<ComponentHostCommand, { readonly type: "prepare" }>,
  ): Promise<ComponentHostResult> {
    const payload = command.payload;
    const fingerprint = JSON.stringify(payload);
    if (this.#state !== "new") {
      if (this.#prepared?.fingerprint === fingerprint) {
        return this.#success(command, { status: "prepared" });
      }
      throw this.#idempotencyError(
        "Prepare request was repeated with different deployment content",
      );
    }
    const resolved = await this.#options.artifactResolver.resolve(payload.artifactDigest);
    const resolvedDigest = parseArtifactDigest(resolved.artifactDigest);
    const manifest = parsePluginManifest(resolved.manifest);
    if (resolvedDigest !== payload.artifactDigest) {
      throw this.#diagnosticError(
        "ARTIFACT_DIGEST_MISMATCH",
        "Artifact resolver returned a different immutable digest",
      );
    }
    if (!isAbsolute(resolved.artifactRoot)) {
      throw this.#diagnosticError(
        "ARTIFACT_ENTRY_OUTSIDE_ROOT",
        "Prepared artifact root must be absolute",
      );
    }
    const artifact = await prepareArtifactBinding(resolvedDigest, resolved.artifactRoot);
    if (
      payload.identity.pluginId !== manifest.pluginId ||
      payload.identity.componentId !== payload.componentId
    ) {
      throw this.#diagnosticError(
        "DEPLOYMENT_COMPONENT_IDENTITY_MISMATCH",
        "Prepared component identity does not match the manifest request",
      );
    }
    const component = manifest.components.find(
      (candidate) => candidate.componentId === payload.componentId,
    );
    if (component === undefined) {
      throw this.#diagnosticError(
        "ARTIFACT_ENTRY_UNDECLARED",
        "Prepared component is not declared by the manifest",
      );
    }
    const grant = this.#options.permissionBoundary.validateGrant(
      manifest.permissions,
      payload.permissionGrants,
    );
    if (!grant.allowed) throw this.#boundaryError(grant.diagnostics, "permission");
    const registration = this.#options.capabilityBoundary.register(payload.capabilityDefinitions);
    if (!registration.ok) {
      throw this.#boundaryError(registration.diagnostics, "capability");
    }
    this.#prepared = {
      payload: freezeJson(payload),
      artifact,
      manifest,
      entrypoint: component.entrypoint,
      kind: component.kind,
      fingerprint,
      generation: 1,
    };
    this.#disposables = this.createDisposables();
    this.#state = "prepared";
    return this.#success(command, { status: "prepared" });
  }

  async #import(
    command: Extract<ComponentHostCommand, { readonly type: "import" }>,
  ): Promise<ComponentHostResult> {
    if (this.#state === "imported" || this.#state === "started" || this.#state === "draining") {
      this.#assertDigest(command.payload.artifactDigest);
      return this.#success(command, { status: "imported" });
    }
    if (this.#state !== "prepared" || this.#prepared === undefined) {
      throw this.#lifecycleError("import", "prepared");
    }
    this.#assertDigest(command.payload.artifactDigest);
    this.#definition = await loadPreparedComponent({
      prepared: this.#prepared.artifact,
      entrypoint: this.#prepared.entrypoint,
      expectedKind: this.#prepared.kind,
    });
    this.#state = "imported";
    return this.#success(command, { status: "imported" });
  }

  async #start(command: ArtifactComponentHostCommand): Promise<ComponentHostResult> {
    this.#assertDigest(command.payload.artifactDigest);
    if (this.#state === "started" || this.#state === "draining") {
      return this.#success(command, { status: "started" });
    }
    if (this.#state !== "imported") throw this.#lifecycleError("start", "imported");
    await this.#invokeLifecycleHook("start", command.deadline);
    this.#state = "started";
    this.#acceptingRuns = true;
    return this.#success(command, { status: "started" });
  }

  async #health(command: ArtifactComponentHostCommand): Promise<ComponentHostResult> {
    this.#assertDigest(command.payload.artifactDigest);
    if (!["imported", "started", "draining"].includes(this.#state)) {
      throw this.#lifecycleError("health", "imported, started, or draining");
    }
    const value =
      this.#definition?.health === undefined
        ? { status: "healthy" }
        : await this.#invokeHook("health", command.deadline);
    return this.#success(command, this.#wireOutput(value));
  }

  async #run(
    command: RunComponentHostCommand,
    attachments: RunAttachmentLease,
  ): Promise<ComponentHostResult> {
    this.#assertDigest(command.payload.artifactDigest);
    if (!this.#acceptingRuns) {
      if (this.#activeTransition !== undefined) {
        throw this.#diagnosticError(
          "LIFECYCLE_TRANSITION_IN_PROGRESS",
          "Component run intake is closed while a lifecycle transition is in progress",
        );
      }
      throw this.#lifecycleError("run", "started with open run intake");
    }
    if (this.#state !== "started") throw this.#lifecycleError("run", "started");
    const execution = command.payload.execution;
    if (
      command.deadline !== execution.deadline ||
      execution.applicationId !== this.#prepared?.payload.identity.applicationId ||
      execution.pluginId !== this.#prepared.payload.identity.pluginId ||
      execution.componentId !== this.#prepared.payload.identity.componentId
    ) {
      throw this.#diagnosticError(
        "EXECUTOR_REQUEST_IDENTITY_MISMATCH",
        "Execution request does not match the prepared component or command deadline",
      );
    }
    const key = taskKey(execution.taskId, execution.attemptId);
    const fingerprint = JSON.stringify({
      artifactDigest: command.payload.artifactDigest,
      execution,
      generation: this.#prepared.generation,
      attachments: attachments.fingerprint,
    });
    const existing = this.#runs.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw this.#idempotencyError(
          "Task attempt identity was reused with different execution content",
        );
      }
      this.#touch(this.#runs, key, existing);
      return this.#success(command, await existing.result);
    }
    if (this.#definition?.run === undefined) {
      throw this.#diagnosticError(
        "EXECUTOR_COMPONENT_HOOK_MISSING",
        "Task component does not define a run hook",
      );
    }
    if (!this.#makeRoom(this.#runs, COMPONENT_HOST_RUN_RETENTION_LIMIT)) {
      throw this.#diagnosticError(
        "EXECUTOR_COMPONENT_HOST_CAPACITY_EXCEEDED",
        "Component host run capacity is exhausted",
      );
    }
    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      fingerprint,
      cancellation: undefined,
      result: Promise.resolve(null),
      settled: false,
    };
    active.result = this.#executeRun(command, active, attachments);
    this.#runs.set(key, active);
    void active.result.then(
      () => {
        active.settled = true;
      },
      () => {
        active.settled = true;
      },
    );
    return this.#success(command, await active.result);
  }

  async #executeRun(
    command: RunComponentHostCommand,
    active: ActiveRun,
    attachments: RunAttachmentLease,
  ): Promise<JsonValue> {
    const execution = command.payload.execution;
    const clearDeadline = armDeadline(execution.deadline, this.#clock, () => {
      active.cancellation = "timed-out";
      active.controller.abort("deadline");
    });
    const context = this.#context(active.controller.signal, "started", attachments.reader);
    const hook = Promise.resolve()
      .then(() => this.#definition?.run?.(context, execution.input))
      .then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
    const aborted = new Promise<{ readonly kind: "aborted" }>((resolve) => {
      active.controller.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
        once: true,
      });
    });
    const outcome = await Promise.race([hook, aborted]);
    clearDeadline();
    if (outcome.kind === "aborted") {
      return {
        taskId: execution.taskId,
        attemptId: execution.attemptId,
        status: active.cancellation ?? "cancelled",
      };
    }
    if (outcome.kind === "error") throw outcome.error;
    return {
      taskId: execution.taskId,
      attemptId: execution.attemptId,
      status: "succeeded",
      output: this.#wireOutput(outcome.value),
    };
  }

  async #drain(command: ArtifactComponentHostCommand): Promise<ComponentHostResult> {
    this.#assertDigest(command.payload.artifactDigest);
    if (this.#state === "draining") return this.#success(command, { status: "draining" });
    if (this.#state !== "started") throw this.#lifecycleError("drain", "started");
    await this.#invokeLifecycleHook("drain", command.deadline, "draining");
    this.#state = "draining";
    return this.#success(command, { status: "draining" });
  }

  async #stop(command: ArtifactComponentHostCommand): Promise<ComponentHostResult> {
    this.#assertDigest(command.payload.artifactDigest);
    if (this.#stopOutcome !== undefined) {
      return this.#forCommand(this.#stopOutcome, command);
    }
    if (!["prepared", "imported", "draining"].includes(this.#state)) {
      throw this.#lifecycleError("stop", "prepared, imported, or draining");
    }
    const diagnostics: RuntimeDiagnostic[] = [];
    if (this.#definition !== undefined) {
      try {
        await this.#invokeLifecycleHook("stop", command.deadline, this.#state);
      } catch (error) {
        diagnostics.push(this.#asDiagnostic(error));
      }
    }
    diagnostics.push(...((await this.#disposables?.dispose()) ?? []));
    this.#options.capabilityBoundary.clear();
    this.#acceptingRuns = false;
    this.#state = diagnostics.length === 0 ? "stopped" : "failed";
    this.#stopOutcome =
      diagnostics.length === 0
        ? this.#success(command, { status: "stopped" })
        : this.#result(command.commandId, command.type, false, undefined, diagnostics);
    return this.#stopOutcome;
  }

  #cancel(
    command: Extract<ComponentHostCommand, { readonly type: "cancel" }>,
  ): ComponentHostResult {
    const active = this.#runs.get(taskKey(command.payload.taskId, command.payload.attemptId));
    if (active === undefined || active.controller.signal.aborted) {
      return this.#success(command, {
        taskId: command.payload.taskId,
        attemptId: command.payload.attemptId,
        cancelled: false,
      });
    }
    active.cancellation = "cancelled";
    active.controller.abort(command.payload.reason ?? "cancelled");
    return this.#success(command, {
      taskId: command.payload.taskId,
      attemptId: command.payload.attemptId,
      cancelled: true,
    });
  }

  async #invokeLifecycleHook(
    name: Exclude<HookName, "health" | "run">,
    deadline: string,
    lifecycle: ComponentHostState = this.#state,
  ) {
    const hook = this.#definition?.[name];
    if (hook === undefined) return;
    await this.#invokeHook(name, deadline, lifecycle);
  }

  async #invokeHook(
    name: Exclude<HookName, "run">,
    deadline: string,
    lifecycle: ComponentHostState = this.#state,
  ): Promise<unknown> {
    const hook = this.#definition?.[name];
    if (hook === undefined) return undefined;
    const controller = new AbortController();
    const clearDeadline = armDeadline(deadline, this.#clock, () => controller.abort("deadline"));
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => hook(this.#context(controller.signal, lifecycle)))
        .then(
          (value) => ({ kind: "value" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }),
        ),
      new Promise<{ readonly kind: "deadline" }>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve({ kind: "deadline" }), {
          once: true,
        });
      }),
    ]);
    clearDeadline();
    if (outcome.kind === "deadline") {
      throw this.#diagnosticError(
        "EXECUTOR_COMMAND_DEADLINE_EXCEEDED",
        `Component ${name} hook exceeded its deadline`,
      );
    }
    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  }

  #context(
    signal: AbortSignal,
    lifecycle: ComponentHostState,
    attachments: RunAttachmentLease["reader"] = this.#attachments([]).reader,
  ): object {
    const prepared = this.#prepared;
    const disposables = this.#disposables;
    if (prepared === undefined || disposables === undefined) {
      throw this.#lifecycleError("context", "prepared");
    }
    const configuration = prepared.payload.configuration;
    const config = Object.freeze({
      get(key?: string): JsonValue | undefined {
        if (key === undefined) return configuration;
        if (
          typeof configuration !== "object" ||
          configuration === null ||
          Array.isArray(configuration)
        ) {
          return undefined;
        }
        const objectConfiguration = configuration as JsonObject;
        return Object.hasOwn(objectConfiguration, key) ? objectConfiguration[key] : undefined;
      },
    });
    return Object.freeze({
      attachments,
      identity: prepared.payload.identity,
      config,
      logger: this.#logger(),
      events: Object.freeze({
        emit: async (type: string, payload: JsonValue) => {
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(type)) {
            throw this.#diagnosticError(
              "PROTOCOL_COMPONENT_EVENT_INVALID",
              "Component event type is invalid",
            );
          }
          await this.#options.events.emit(type, this.#redactJson(cloneComponentHostValue(payload)));
        },
      }),
      capabilities: Object.freeze({
        call: (request: unknown) => this.#capabilityCall(request),
      }),
      lifecycle: Object.freeze({ state: lifecycle }),
      runtime: Object.freeze({
        runtimeId: prepared.payload.identity.runtimeId,
        ...prepared.payload.runtime,
      }),
      cancellation: signal,
      disposables,
      secrets: Object.freeze({
        get: (name: string) => this.#secret(name),
      }),
    });
  }

  #attachments(
    input: readonly ArrayBuffer[],
    allowAttachments = true,
  ): RunAttachmentLease {
    let rawCount: unknown;
    try {
      rawCount = Reflect.get(input, "length");
    } catch {
      throw this.#protocolError("Component host attachment count is invalid");
    }
    if (
      typeof rawCount !== "number" ||
      !Number.isSafeInteger(rawCount) ||
      rawCount < 0
    ) {
      throw this.#protocolError("Component host attachment count is invalid");
    }
    const count = rawCount;
    if (count > COMPONENT_HOST_ATTACHMENT_COUNT_LIMIT) {
      throw this.#protocolError(
        `Component host attachments exceed the count limit of ${COMPONENT_HOST_ATTACHMENT_COUNT_LIMIT}`,
      );
    }
    if (!allowAttachments && count > 0) {
      throw this.#protocolError("Component host attachments are only valid for run commands");
    }
    let totalBytes = 0;
    const validated: { readonly buffer: ArrayBuffer; readonly byteLength: number }[] = [];
    for (let index = 0; index < count; index += 1) {
      let buffer: unknown;
      try {
        buffer = input[index];
      } catch {
        throw this.#protocolError("Component host attachment elements must be data");
      }
      if (!(buffer instanceof ArrayBuffer)) {
        throw this.#protocolError("Component host attachments must be ArrayBuffers");
      }
      let byteLength: number;
      try {
        if (ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined) throw new TypeError();
        byteLength = Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, buffer, []);
      } catch {
        throw this.#protocolError("Component host attachment byte length is invalid");
      }
      if (byteLength > COMPONENT_HOST_WIRE_BYTE_LIMIT) {
        throw this.#protocolError(
          `Component host attachment exceeds the byte limit of ${COMPONENT_HOST_WIRE_BYTE_LIMIT}`,
        );
      }
      totalBytes += byteLength;
      if (totalBytes > COMPONENT_HOST_WIRE_BYTE_LIMIT) {
        throw this.#protocolError(
          `Component host attachments exceed the aggregate byte limit of ${COMPONENT_HOST_WIRE_BYTE_LIMIT}`,
        );
      }
      validated.push({ buffer, byteLength });
    }
    let values: Uint8Array[];
    try {
      values = validated.map(({ buffer, byteLength }) =>
        new Uint8Array(buffer, 0, byteLength).slice(),
      );
    } catch {
      throw this.#protocolError("Component host attachment bytes are invalid");
    }
    const hash = createHash("sha256");
    const countFrame = Buffer.allocUnsafe(4);
    countFrame.writeUInt32BE(values.length);
    hash.update(countFrame);
    for (const value of values) {
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(value.byteLength);
      hash.update(length);
      hash.update(value);
    }
    let active = true;
    const items = values.map((value) =>
      Object.freeze({
        byteLength: value.byteLength,
        bytes(): Uint8Array {
          if (!active) throw new Error("Component run attachments are no longer available");
          return value.slice();
        },
      }),
    );
    return {
      fingerprint: hash.digest("hex"),
      reader: Object.freeze({
        length: items.length,
        get(index: number) {
          if (!active) throw new Error("Component run attachments are no longer available");
          return Number.isSafeInteger(index) && index >= 0 ? items[index] : undefined;
        },
      }),
      revoke() {
        active = false;
        for (const value of values) value.fill(0);
      },
    };
  }

  async #capabilityCall(input: unknown): Promise<JsonValue> {
    const requestValue = cloneComponentHostValue(input);
    if (typeof requestValue !== "object" || requestValue === null || Array.isArray(requestValue)) {
      throw this.#diagnosticError(
        "CAPABILITY_REQUEST_INVALID",
        "Capability call must be an object",
      );
    }
    const request = requestValue as JsonObject;
    const fields = Object.keys(request).sort();
    if (
      fields.join(",") !== "input,method,name,protocolVersion" ||
      typeof request.name !== "string" ||
      typeof request.protocolVersion !== "string" ||
      typeof request.method !== "string" ||
      request.input === undefined
    ) {
      throw this.#diagnosticError(
        "CAPABILITY_REQUEST_INVALID",
        "Capability call fields are invalid",
      );
    }
    const requestInput = request.input;
    if (this.#containsSecret(requestInput)) {
      throw this.#diagnosticError(
        "PERMISSION_SECRET_EXFILTRATION_BLOCKED",
        "Secret values cannot be sent through capability calls",
      );
    }
    const prepared = this.#prepared;
    if (prepared === undefined) throw this.#lifecycleError("capability", "prepared");
    const permission = this.#options.permissionBoundary.authorize(
      prepared.payload.permissionGrants,
      { kind: "capability", name: request.name, method: request.method },
    );
    if (!permission.allowed) throw this.#boundaryError(permission.diagnostics, "permission");
    const identity = { name: request.name, protocolVersion: request.protocolVersion };
    const requestDecision = this.#options.capabilityBoundary.request(identity, requestInput);
    if (!requestDecision.allowed || requestDecision.value === undefined) {
      throw this.#boundaryError(requestDecision.diagnostics, "capability");
    }
    const response = cloneComponentHostValue(
      await this.#options.capabilityBoundary.invoke({
        identity,
        method: request.method,
        input: requestDecision.value,
      }),
    );
    const responseDecision = this.#options.capabilityBoundary.response(identity, response);
    if (!responseDecision.allowed || responseDecision.value === undefined) {
      throw this.#boundaryError(responseDecision.diagnostics, "capability");
    }
    return freezeJson(responseDecision.value);
  }

  async #secret(name: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
      throw this.#diagnosticError("PERMISSION_SECRET_NAME_INVALID", "Secret name is invalid");
    }
    const prepared = this.#prepared;
    if (prepared === undefined) throw this.#lifecycleError("secret", "prepared");
    const requested = prepared.manifest.permissions.some(
      (permission) => permission.kind === "secret" && permission.names.includes(name),
    );
    if (!requested) {
      throw this.#diagnosticError(
        "PERMISSION_SECRET_NOT_REQUESTED",
        "Secret was not requested by the plugin manifest",
      );
    }
    const permission = this.#options.permissionBoundary.authorize(
      prepared.payload.permissionGrants,
      { kind: "secret", name },
    );
    if (!permission.allowed) throw this.#boundaryError(permission.diagnostics, "permission");
    if (this.#options.secretProvider === undefined) {
      throw this.#diagnosticError(
        "BOOTSTRAP_SECRET_PROVIDER_UNAVAILABLE",
        "Secret provider is unavailable",
      );
    }
    const value = await this.#options.secretProvider.get(name);
    if (value !== undefined) {
      if (typeof value !== "string") {
        throw this.#diagnosticError(
          "BOOTSTRAP_SECRET_PROVIDER_INVALID",
          "Secret provider returned an invalid value",
        );
      }
      if (value.length > 0) this.#secretValues.add(value);
    }
    return value;
  }

  createDisposables() {
    const items: Array<() => Promise<void> | void> = [];
    let result: Promise<readonly RuntimeDiagnostic[]> | undefined;
    return Object.freeze({
      add: (input: unknown): void => {
        if (result !== undefined) throw new Error("Cannot add a disposable after disposal");
        if (typeof input === "function") {
          items.push(input as () => Promise<void> | void);
          return;
        }
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          throw new TypeError("Disposable must be a function or plain object");
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, "dispose");
        if (
          Object.getPrototypeOf(input) !== Object.prototype ||
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor) ||
          typeof descriptor.value !== "function"
        ) {
          throw new TypeError("Disposable object must expose a dispose data function");
        }
        items.push(descriptor.value as () => Promise<void> | void);
      },
      dispose: (): Promise<readonly RuntimeDiagnostic[]> => {
        result ??= (async () => {
          const diagnostics: RuntimeDiagnostic[] = [];
          for (const dispose of items.splice(0).reverse()) {
            try {
              await dispose();
            } catch (error) {
              diagnostics.push(
                this.#asDiagnostic(
                  error,
                  "LIFECYCLE_DISPOSAL_FAILED",
                  "Component disposable failed",
                ),
              );
            }
          }
          return Object.freeze(diagnostics);
        })();
        return result;
      },
      get disposed(): boolean {
        return result !== undefined;
      },
    });
  }

  #logger(): ComponentHostLogger {
    const send =
      (level: keyof ComponentHostLogger) =>
      (...values: readonly unknown[]): void => {
        this.#options.logger[level](...values.map((value) => this.#safeLogValue(value)));
      };
    return Object.freeze({
      debug: send("debug"),
      error: send("error"),
      info: send("info"),
      warn: send("warn"),
    });
  }

  #safeLogValue(value: unknown): unknown {
    if (typeof value === "string") return this.#redactText(value);
    if (value instanceof Error) {
      return {
        name: this.#redactText(value.name),
        message: this.#redactText(value.message),
      };
    }
    try {
      return this.#redactJson(cloneComponentHostValue(value));
    } catch {
      return "[UNSERIALIZABLE]";
    }
  }

  #redactText(value: string): string {
    let result = value;
    for (const secret of this.#secretValues) result = result.replaceAll(secret, "[REDACTED]");
    return result;
  }

  #redactJson(value: JsonValue): JsonValue {
    if (typeof value === "string") return this.#redactText(value);
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) return value.map((item) => this.#redactJson(item));
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : this.#redactJson(item);
    }
    return result;
  }

  #containsSecret(value: JsonValue): boolean {
    if (typeof value === "string") {
      return [...this.#secretValues].some((secret) => secret.length > 0 && value.includes(secret));
    }
    if (typeof value !== "object" || value === null) return false;
    return (Array.isArray(value) ? value : Object.values(value)).some((item) =>
      this.#containsSecret(item),
    );
  }

  #wireOutput(value: unknown): JsonValue {
    return freezeJson(this.#redactJson(cloneComponentHostValue(value)));
  }

  #assertDigest(actual: ArtifactDigest): void {
    const expected = this.#prepared?.payload.artifactDigest;
    if (expected === undefined) throw this.#lifecycleError("artifact", "prepared");
    if (actual !== expected) {
      throw this.#diagnosticError(
        "ARTIFACT_DIGEST_MISMATCH",
        "Command artifact digest does not match the prepared immutable artifact",
      );
    }
  }

  #success(command: ComponentHostCommand, value: JsonValue): ComponentHostResult {
    return this.#result(command.commandId, command.type, true, value, []);
  }

  #forCommand(result: ComponentHostResult, command: ComponentHostCommand): ComponentHostResult {
    return {
      ...result,
      commandId: command.commandId,
      type: command.type,
    };
  }

  #failure(
    commandId: string,
    type: ComponentHostResult["type"],
    error: unknown,
  ): ComponentHostResult {
    return this.#result(commandId, type, false, undefined, [this.#asDiagnostic(error)]);
  }

  #result(
    commandId: string,
    type: ComponentHostResult["type"],
    ok: boolean,
    value: JsonValue | undefined,
    diagnostics: readonly RuntimeDiagnostic[],
  ): ComponentHostResult {
    return {
      protocol: COMPONENT_HOST_PROTOCOL,
      commandId,
      type,
      ok,
      state: this.#state,
      ...(value === undefined ? {} : { value }),
      diagnostics: diagnostics.map((diagnostic) => this.#redactDiagnostic(diagnostic)),
    };
  }

  #validateResult(result: ComponentHostResult): ComponentHostResult {
    try {
      return parseComponentHostResult(result);
    } catch (error) {
      return parseComponentHostResult(this.#failure("invalid", "invalid", error));
    }
  }

  #boundaryError(
    diagnostics: readonly (ComponentCapabilityDiagnostic | ComponentPermissionDiagnostic)[],
    source: "capability" | "permission",
  ): DiagnosticError {
    const first = diagnostics[0];
    const code =
      first !== undefined && DIAGNOSTIC_CODE.test(first.code)
        ? (first.code as DiagnosticCode)
        : source === "capability"
          ? "CAPABILITY_BOUNDARY_REJECTED"
          : "PERMISSION_BOUNDARY_REJECTED";
    return new DiagnosticError(
      runtimeDiagnostic({
        code,
        message: first?.message ?? `${source} boundary rejected the operation`,
        source: {
          kind: source === "capability" ? "capability" : "deployment",
          id: "component-host",
        },
        details: {
          diagnostics: this.#redactJson(cloneComponentHostValue(diagnostics)),
        },
        observedAt: this.#now(),
      }),
    );
  }

  #diagnosticError(code: DiagnosticCode, message: string): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code,
        message,
        source: { kind: "executor", id: "component-host" },
        observedAt: this.#now(),
      }),
    );
  }

  #protocolError(message: string): DiagnosticError {
    return new DiagnosticError(
      runtimeDiagnostic({
        code: "PROTOCOL_COMPONENT_HOST_COMMAND_INVALID",
        message,
        source: { kind: "protocol", id: "component-host" },
        observedAt: this.#now(),
      }),
    );
  }

  #idempotencyError(message: string): DiagnosticError {
    return this.#diagnosticError("PROTOCOL_IDEMPOTENCY_CONFLICT", message);
  }

  #lifecycleError(operation: string, expected: string): DiagnosticError {
    return this.#diagnosticError(
      "LIFECYCLE_TRANSITION_INVALID",
      `Cannot ${operation} while component is ${this.#state}; expected ${expected}`,
    );
  }

  #asDiagnostic(
    error: unknown,
    code: DiagnosticCode = "EXECUTOR_COMPONENT_HOOK_FAILED",
    message = "Component hook failed",
  ): RuntimeDiagnostic {
    if (error instanceof DiagnosticError) return this.#redactDiagnostic(error.diagnostic);
    if (error instanceof Error) {
      return runtimeDiagnostic({
        code,
        message,
        source: { kind: "executor", id: "component-host" },
        cause: {
          name: this.#redactText(error.name),
          message: this.#redactText(error.message),
          ...(error.stack === undefined ? {} : { stack: this.#redactText(error.stack) }),
        },
        observedAt: this.#now(),
      });
    }
    return runtimeDiagnostic({
      code,
      message,
      source: { kind: "executor", id: "component-host" },
      cause: {
        name: "UnknownCause",
        message: "Non-Error value thrown by component hook",
      },
      observedAt: this.#now(),
    });
  }

  #redactDiagnostic(diagnostic: RuntimeDiagnostic): RuntimeDiagnostic {
    return {
      ...diagnostic,
      message: this.#redactText(diagnostic.message),
      ...(diagnostic.details === undefined
        ? {}
        : { details: this.#redactJson(diagnostic.details) }),
      ...(diagnostic.cause === undefined
        ? {}
        : {
            cause: {
              ...diagnostic.cause,
              name: this.#redactText(diagnostic.cause.name),
              message: this.#redactText(diagnostic.cause.message),
              ...(diagnostic.cause.stack === undefined
                ? {}
                : { stack: this.#redactText(diagnostic.cause.stack) }),
            },
          }),
    };
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
