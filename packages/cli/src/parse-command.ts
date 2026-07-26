import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { join, resolve, win32 } from "node:path";
import { cwd } from "node:process";
import { parseArgs } from "node:util";
import {
  type DeployPluginRequest,
  DiagnosticError,
  type JsonValue,
  parseDeployPluginRequest,
  parsePermissionSet,
  parsePluginDeploymentIdentity,
  parseRunTaskRequest,
  parseTaskId,
  parseWorkerId,
  type RunTaskRequest,
  type RuntimeMode,
  type RuntimeSnapshotRequest,
  runtimeDiagnostic,
  runtimeOperationMaxBytes,
} from "@tegojs/contracts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface RuntimeStartCommand {
  readonly kind: "runtime.start";
  readonly applicationId: string;
  readonly dataDirectory: string;
  readonly detach: boolean;
  readonly endpoint: string;
  readonly json: boolean;
  readonly mode: RuntimeMode;
  readonly nodeId: string;
  readonly runtimeId: string;
  readonly postgresUrl?: string;
}

export interface RuntimeStatusCommand {
  readonly kind: "runtime.status";
  readonly endpoint: string;
  readonly json: boolean;
}

export interface RuntimeStopCommand {
  readonly kind: "runtime.stop";
  readonly endpoint: string;
  readonly json: boolean;
}

export interface RuntimeSnapshotCommand {
  readonly kind: "runtime.snapshot";
  readonly endpoint: string;
  readonly input: RuntimeSnapshotRequest;
  readonly json: boolean;
}

export interface PluginValidateCommand {
  readonly kind: "plugin.validate";
  readonly json: boolean;
  readonly pluginDirectory: string;
}

export interface PluginPackCommand {
  readonly kind: "plugin.pack";
  readonly artifactPath: string;
  readonly build: boolean;
  readonly json: boolean;
  readonly keyId?: string;
  readonly pluginDirectory: string;
  readonly privateKeyPath?: string;
  readonly signaturePath?: string;
}

export interface PluginInspectCommand {
  readonly kind: "plugin.inspect";
  readonly artifactPath: string;
  readonly json: boolean;
}

export interface PluginInstallCommand {
  readonly kind: "plugin.install";
  readonly artifactPath: string;
  readonly endpoint: string;
  readonly json: boolean;
}

export interface PluginDeployCommand {
  readonly kind: "plugin.deploy";
  readonly endpoint: string;
  readonly input: DeployPluginRequest;
  readonly json: boolean;
}

export interface PluginStatusCommand {
  readonly kind: "plugin.status";
  readonly endpoint: string;
  readonly input: ReturnType<typeof parsePluginDeploymentIdentity>;
  readonly json: boolean;
}

export interface TaskRunCommand {
  readonly kind: "task.run";
  readonly endpoint: string;
  readonly input: RunTaskRequest;
  readonly json: boolean;
  readonly timeoutMs: number;
  readonly wait: boolean;
}

export interface TaskRecordCommand {
  readonly kind: "task.cancel" | "task.status" | "task.wait";
  readonly endpoint: string;
  readonly input: { readonly taskId: ReturnType<typeof parseTaskId> };
  readonly json: boolean;
  readonly timeoutMs: number;
}

interface WorkerStartCommandBase {
  readonly kind: "worker.start";
  readonly credential: string;
  readonly dataDirectory: string;
  readonly json: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly prepare: readonly string[];
  readonly resources: import("@tegojs/contracts").WorkerResourceCeilings;
  readonly workerId: string;
}

export interface WorkerConnectStartCommand extends WorkerStartCommandBase {
  readonly direction: "connect";
  readonly url: string;
}

export interface WorkerListenStartCommand extends WorkerStartCommandBase {
  readonly direction: "listen";
  readonly host: string;
  readonly port: number;
}

export type WorkerStartCommand = WorkerConnectStartCommand | WorkerListenStartCommand;

export interface HelpCommand {
  readonly kind: "help";
}

export type ParsedCommand =
  | HelpCommand
  | PluginDeployCommand
  | PluginInspectCommand
  | PluginInstallCommand
  | PluginPackCommand
  | PluginStatusCommand
  | PluginValidateCommand
  | RuntimeStartCommand
  | RuntimeSnapshotCommand
  | RuntimeStatusCommand
  | RuntimeStopCommand
  | TaskRecordCommand
  | TaskRunCommand
  | WorkerStartCommand;

export function defaultDataDirectory(): string {
  return resolve(process.env.TEGO_DATA_DIR ?? join(cwd(), ".tego"));
}

export interface DefaultControlEndpointOptions {
  readonly platform?: NodeJS.Platform;
  readonly runtimeScope?: string;
  readonly userScope?: string;
}

function defaultUserScope(): string {
  const userId = process.getuid?.();
  return userId === undefined ? userInfo().username : String(userId);
}

export function defaultControlEndpoint(
  dataDirectory = defaultDataDirectory(),
  options: DefaultControlEndpointOptions = {},
): string {
  if ((options.platform ?? process.platform) === "win32") {
    const normalizedDirectory = win32
      .normalize(win32.resolve(dataDirectory))
      .toLocaleLowerCase("en-US");
    const identity = JSON.stringify({
      dataDirectory: normalizedDirectory,
      runtimeScope: options.runtimeScope ?? "main",
      userScope: options.userScope ?? defaultUserScope(),
    });
    const digest = createHash("sha256").update(identity).digest("hex");
    return `\\\\.\\pipe\\tego-${digest}`;
  }
  return join(dataDirectory, "control.sock");
}

function commandError(message: string, details?: Record<string, string>): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_COMMAND_INVALID",
      message,
      source: { kind: "protocol", id: "cli" },
      ...(details === undefined ? {} : { details }),
    }),
  );
}

function parseJson(value: string, name: string): JsonValue {
  if (Buffer.byteLength(value, "utf8") > runtimeOperationMaxBytes) {
    throw commandError(`${name} exceeds the serialized size limit`);
  }
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw commandError(`${name} must be valid JSON`);
  }
}

function requirePositional(positionals: readonly string[], index: number, name: string): string {
  const value = positionals[index];
  if (value === undefined || value.length === 0) throw commandError(`${name} is required`);
  return value;
}

function assertNoExtraPositionals(positionals: readonly string[], expected: number): void {
  if (positionals.length > expected) {
    throw commandError("Command has unexpected positional arguments");
  }
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TIMER_DELAY_MS) {
    throw commandError(`${name} must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
  }
  return parsed;
}

function parseLifecycleOptions(arguments_: readonly string[]): {
  readonly endpoint: string;
  readonly json: boolean;
} {
  try {
    const parsed = parseArgs({
      args: [...arguments_],
      allowPositionals: false,
      options: {
        endpoint: { type: "string" },
        json: { type: "boolean", default: false },
      },
      strict: true,
    });
    return {
      endpoint: parsed.values.endpoint ?? defaultControlEndpoint(),
      json: parsed.values.json ?? false,
    };
  } catch (error) {
    throw commandError("Runtime command options are invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseStart(arguments_: readonly string[]): RuntimeStartCommand {
  try {
    const parsed = parseArgs({
      args: [...arguments_],
      allowPositionals: false,
      options: {
        "application-id": { type: "string" },
        "data-dir": { type: "string" },
        detach: { type: "boolean", default: false },
        endpoint: { type: "string" },
        json: { type: "boolean", default: false },
        mode: { type: "string", default: "single-main" },
        "node-id": { type: "string" },
        "postgres-url": { type: "string" },
        "runtime-id": { type: "string" },
      },
      strict: true,
    });
    if (parsed.values.mode !== "single-main" && parsed.values.mode !== "multi-main") {
      throw commandError("Runtime mode must be single-main or multi-main");
    }
    const dataDirectory = resolve(parsed.values["data-dir"] ?? defaultDataDirectory());
    return {
      kind: "runtime.start",
      applicationId: parsed.values["application-id"] ?? "application-default",
      dataDirectory,
      detach: parsed.values.detach ?? false,
      endpoint: parsed.values.endpoint ?? defaultControlEndpoint(dataDirectory),
      json: parsed.values.json ?? false,
      mode: parsed.values.mode,
      nodeId: parsed.values["node-id"] ?? `node-${String(process.pid)}`,
      runtimeId: parsed.values["runtime-id"] ?? "runtime-default",
      ...(parsed.values["postgres-url"] === undefined
        ? {}
        : { postgresUrl: parsed.values["postgres-url"] }),
    };
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw commandError("Runtime start options are invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parsePlugin(arguments_: readonly string[]): ParsedCommand {
  const subcommand = arguments_[0];
  const commandArguments = arguments_.slice(1);
  try {
    if (subcommand === "validate") {
      const parsed = parseArgs({
        args: [...commandArguments],
        allowPositionals: true,
        options: { json: { type: "boolean", default: false } },
        strict: true,
      });
      assertNoExtraPositionals(parsed.positionals, 1);
      return {
        kind: "plugin.validate",
        json: parsed.values.json ?? false,
        pluginDirectory: resolve(requirePositional(parsed.positionals, 0, "Plugin directory")),
      };
    }
    if (subcommand === "pack") {
      const parsed = parseArgs({
        args: [...commandArguments],
        allowNegative: true,
        allowPositionals: true,
        options: {
          build: { type: "boolean", default: true },
          json: { type: "boolean", default: false },
          "key-id": { type: "string" },
          output: { type: "string" },
          "private-key": { type: "string" },
          "signature-output": { type: "string" },
        },
        strict: true,
      });
      assertNoExtraPositionals(parsed.positionals, 1);
      const pluginDirectory = resolve(requirePositional(parsed.positionals, 0, "Plugin directory"));
      const keyId = parsed.values["key-id"];
      const privateKeyPath = parsed.values["private-key"];
      if ((keyId === undefined) !== (privateKeyPath === undefined)) {
        throw commandError("--key-id and --private-key must be provided together");
      }
      if (parsed.values["signature-output"] !== undefined && keyId === undefined) {
        throw commandError("--signature-output requires --key-id and --private-key");
      }
      return {
        kind: "plugin.pack",
        artifactPath: resolve(parsed.values.output ?? `${pluginDirectory}.tego`),
        build: parsed.values.build ?? true,
        json: parsed.values.json ?? false,
        pluginDirectory,
        ...(keyId === undefined ? {} : { keyId }),
        ...(privateKeyPath === undefined ? {} : { privateKeyPath: resolve(privateKeyPath) }),
        ...(parsed.values["signature-output"] === undefined
          ? {}
          : { signaturePath: resolve(parsed.values["signature-output"]) }),
      };
    }
    if (subcommand === "inspect" || subcommand === "install") {
      const parsed = parseArgs({
        args: [...commandArguments],
        allowPositionals: true,
        options: {
          endpoint: { type: "string" },
          json: { type: "boolean", default: false },
        },
        strict: true,
      });
      assertNoExtraPositionals(parsed.positionals, 1);
      const artifactPath = resolve(requirePositional(parsed.positionals, 0, "Artifact path"));
      if (subcommand === "inspect") {
        if (parsed.values.endpoint !== undefined) {
          throw commandError("Plugin inspect does not accept --endpoint");
        }
        return {
          kind: "plugin.inspect",
          artifactPath,
          json: parsed.values.json ?? false,
        };
      }
      return {
        kind: "plugin.install",
        artifactPath,
        endpoint: parsed.values.endpoint ?? defaultControlEndpoint(),
        json: parsed.values.json ?? false,
      };
    }
    if (subcommand === "deploy") {
      const parsed = parseArgs({
        args: [...commandArguments],
        allowPositionals: true,
        options: {
          "application-id": { type: "string", default: "application-default" },
          "capability-bindings": { type: "string", default: "{}" },
          configuration: { type: "string", default: "{}" },
          digest: { type: "string" },
          endpoint: { type: "string" },
          essential: { type: "boolean", default: false },
          json: { type: "boolean", default: false },
          permissions: { type: "string", default: "[]" },
        },
        strict: true,
      });
      assertNoExtraPositionals(parsed.positionals, 1);
      const input = parseDeployPluginRequest({
        applicationId: parsed.values["application-id"],
        pluginId: requirePositional(parsed.positionals, 0, "Plugin ID"),
        artifactDigest: parsed.values.digest ?? "",
        essential: parsed.values.essential ?? false,
        configuration: parseJson(parsed.values.configuration ?? "{}", "Plugin configuration"),
        permissionGrants: parseJson(parsed.values.permissions ?? "[]", "Permission grants"),
        capabilityBindings: parseJson(
          parsed.values["capability-bindings"] ?? "{}",
          "Capability bindings",
        ),
      });
      return {
        kind: "plugin.deploy",
        endpoint: parsed.values.endpoint ?? defaultControlEndpoint(),
        input,
        json: parsed.values.json ?? false,
      };
    }
    if (subcommand === "status") {
      const parsed = parseArgs({
        args: [...commandArguments],
        allowPositionals: true,
        options: {
          "application-id": { type: "string", default: "application-default" },
          endpoint: { type: "string" },
          json: { type: "boolean", default: false },
        },
        strict: true,
      });
      assertNoExtraPositionals(parsed.positionals, 1);
      return {
        kind: "plugin.status",
        endpoint: parsed.values.endpoint ?? defaultControlEndpoint(),
        input: parsePluginDeploymentIdentity({
          applicationId: parsed.values["application-id"],
          pluginId: requirePositional(parsed.positionals, 0, "Plugin ID"),
        }),
        json: parsed.values.json ?? false,
      };
    }
    throw commandError("Unknown plugin command", { command: subcommand ?? "" });
  } catch (error) {
    if (error instanceof DiagnosticError && error.diagnostic.code === "PROTOCOL_COMMAND_INVALID") {
      throw error;
    }
    throw commandError("Plugin command options are invalid", {
      cause:
        error instanceof DiagnosticError
          ? error.diagnostic.code
          : error instanceof Error
            ? error.message
            : String(error),
    });
  }
}

function parseTaskTarget(target: string): {
  readonly componentId: string;
  readonly pluginId: string;
} {
  const separator = target.lastIndexOf("/");
  if (separator <= 0 || separator === target.length - 1) {
    throw commandError("Task target must be <plugin-id>/<component-id>");
  }
  return {
    pluginId: target.slice(0, separator),
    componentId: target.slice(separator + 1),
  };
}

function parseTask(arguments_: readonly string[]): ParsedCommand {
  const subcommand = arguments_[0];
  const commandArguments = arguments_.slice(1);
  try {
    if (subcommand === "run") {
      const parsed = parseArgs({
        args: [...commandArguments],
        allowPositionals: true,
        options: {
          "application-id": { type: "string", default: "application-default" },
          deadline: { type: "string" },
          endpoint: { type: "string" },
          input: { type: "string", default: "null" },
          json: { type: "boolean", default: false },
          "no-wait": { type: "boolean", default: false },
          "operation-id": { type: "string" },
          "orphan-policy": { type: "string", default: "cancel" },
          "timeout-ms": { type: "string" },
        },
        strict: true,
      });
      assertNoExtraPositionals(parsed.positionals, 1);
      const target = parseTaskTarget(requirePositional(parsed.positionals, 0, "Task target"));
      const deadline =
        parsed.values.deadline ?? new Date(Date.now() + 5 * 60 * 1_000).toISOString();
      const input = parseRunTaskRequest({
        applicationId: parsed.values["application-id"],
        pluginId: target.pluginId,
        componentId: target.componentId,
        input: parseJson(parsed.values.input ?? "null", "Task input"),
        deadline,
        orphanPolicy: parsed.values["orphan-policy"],
        ...(parsed.values["operation-id"] === undefined
          ? {}
          : { operationId: parsed.values["operation-id"] }),
      });
      if (Date.parse(input.deadline) <= Date.now()) {
        throw commandError("Task deadline must be in the future");
      }
      return {
        kind: "task.run",
        endpoint: parsed.values.endpoint ?? defaultControlEndpoint(),
        input,
        json: parsed.values.json ?? false,
        timeoutMs: positiveInteger(
          parsed.values["timeout-ms"],
          Math.min(MAX_TIMER_DELAY_MS, Date.parse(deadline) - Date.now() + 5_000),
          "--timeout-ms",
        ),
        wait: !(parsed.values["no-wait"] ?? false),
      };
    }
    if (subcommand === "status" || subcommand === "wait" || subcommand === "cancel") {
      const parsed = parseArgs({
        args: [...commandArguments],
        allowPositionals: true,
        options: {
          endpoint: { type: "string" },
          json: { type: "boolean", default: false },
          "timeout-ms": { type: "string" },
        },
        strict: true,
      });
      assertNoExtraPositionals(parsed.positionals, 1);
      return {
        kind: `task.${subcommand}`,
        endpoint: parsed.values.endpoint ?? defaultControlEndpoint(),
        input: {
          taskId: parseTaskId(requirePositional(parsed.positionals, 0, "Task ID")),
        },
        json: parsed.values.json ?? false,
        timeoutMs: positiveInteger(
          parsed.values["timeout-ms"],
          subcommand === "wait" ? 5 * 60 * 1_000 : 5_000,
          "--timeout-ms",
        ),
      };
    }
    throw commandError("Unknown task command", { command: subcommand ?? "" });
  } catch (error) {
    if (error instanceof DiagnosticError && error.diagnostic.code === "PROTOCOL_COMMAND_INVALID") {
      throw error;
    }
    throw commandError("Task command options are invalid", {
      cause:
        error instanceof DiagnosticError
          ? error.diagnostic.code
          : error instanceof Error
            ? error.message
            : String(error),
    });
  }
}

function parseWorker(arguments_: readonly string[]): WorkerStartCommand {
  if (arguments_[0] !== "start") {
    throw commandError("Unknown worker command", { command: arguments_[0] ?? "" });
  }
  try {
    const parsed = parseArgs({
      args: [...arguments_.slice(1)],
      allowPositionals: false,
      options: {
        connect: { type: "string" },
        credential: { type: "string" },
        "data-dir": { type: "string" },
        json: { type: "boolean", default: false },
        labels: { type: "string" },
        listen: { type: "string" },
        prepare: { type: "string", multiple: true },
        resources: { type: "string" },
        "worker-id": { type: "string" },
      },
      strict: true,
    });
    const connect = parsed.values.connect;
    const listen = parsed.values.listen;
    if ((connect === undefined) === (listen === undefined)) {
      throw commandError("Worker start requires exactly one of --connect or --listen");
    }
    const credential = parsed.values.credential ?? process.env.TEGO_WORKER_CREDENTIAL;
    if (credential === undefined || credential.trim().length === 0) {
      throw commandError("Worker start requires --credential or TEGO_WORKER_CREDENTIAL");
    }
    const configuredWorkerId = parsed.values["worker-id"];
    if (configuredWorkerId === undefined || configuredWorkerId.length === 0) {
      throw commandError("Worker start requires --worker-id");
    }
    const workerId = parseWorkerId(configuredWorkerId);
    const workerPermission = parsePermissionSet([
      {
        kind: "worker",
        labels: parseJson(parsed.values.labels ?? "{}", "Worker labels"),
        resources: parseJson(
          parsed.values.resources ?? '{"cpuMillis":0,"memoryBytes":0,"storageBytes":0}',
          "Worker resources",
        ),
      },
    ])[0];
    if (workerPermission?.kind !== "worker") {
      throw commandError("Worker labels and resources are invalid");
    }
    const base = {
      kind: "worker.start" as const,
      credential,
      dataDirectory: resolve(
        parsed.values["data-dir"] ?? join(defaultDataDirectory(), "workers", workerId),
      ),
      json: parsed.values.json ?? false,
      labels: workerPermission.labels,
      prepare: (parsed.values.prepare ?? []).map((path) => resolve(path)),
      resources: workerPermission.resources,
      workerId,
    };
    if (connect !== undefined) {
      const url = new URL(connect);
      if (
        (url.protocol !== "ws:" && url.protocol !== "wss:") ||
        url.username.length > 0 ||
        url.password.length > 0
      ) {
        throw commandError("--connect must be a credential-free ws: or wss: URL");
      }
      return { ...base, direction: "connect", url: url.href };
    }
    const address = new URL(`ws://${listen as string}`);
    if (
      address.username.length > 0 ||
      address.password.length > 0 ||
      address.pathname !== "/" ||
      address.search.length > 0 ||
      address.hash.length > 0 ||
      address.port.length === 0
    ) {
      throw commandError("--listen must be a host and port");
    }
    const port = Number(address.port);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw commandError("--listen port must be between 0 and 65535");
    }
    return {
      ...base,
      direction: "listen",
      host: address.hostname,
      port,
    };
  } catch (error) {
    if (error instanceof DiagnosticError && error.diagnostic.code === "PROTOCOL_COMMAND_INVALID") {
      throw error;
    }
    throw commandError("Worker start options are invalid", {
      cause:
        error instanceof DiagnosticError
          ? error.diagnostic.code
          : error instanceof Error
            ? error.message
            : String(error),
    });
  }
}

export function parseCommand(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { kind: "help" };
  if (argv[0] === "plugin") return parsePlugin(argv.slice(1));
  if (argv[0] === "task") return parseTask(argv.slice(1));
  if (argv[0] === "worker") return parseWorker(argv.slice(1));
  if (argv[0] === "runtime") {
    switch (argv[1]) {
      case "start":
        return parseStart(argv.slice(2));
      case "status":
        return { kind: "runtime.status", ...parseLifecycleOptions(argv.slice(2)) };
      case "snapshot":
        return {
          kind: "runtime.snapshot",
          input: {},
          ...parseLifecycleOptions(argv.slice(2)),
        };
      case "stop":
        return { kind: "runtime.stop", ...parseLifecycleOptions(argv.slice(2)) };
      default:
        throw commandError("Unknown runtime command", { command: argv[1] ?? "" });
    }
  }
  throw commandError("Unknown command", { command: argv[0] ?? "" });
}
