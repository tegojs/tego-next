import { join, resolve } from "node:path";
import { cwd } from "node:process";
import { parseArgs } from "node:util";
import { DiagnosticError, type RuntimeMode, runtimeDiagnostic } from "@tegojs/contracts";

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

export interface HelpCommand {
  readonly kind: "help";
}

export type ParsedCommand =
  | HelpCommand
  | RuntimeStartCommand
  | RuntimeStatusCommand
  | RuntimeStopCommand;

export function defaultDataDirectory(): string {
  return resolve(process.env.TEGO_DATA_DIR ?? join(cwd(), ".tego"));
}

export function defaultControlEndpoint(dataDirectory = defaultDataDirectory()): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\tego-${Buffer.from(dataDirectory).toString("hex").slice(-32)}`;
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

export function parseCommand(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { kind: "help" };
  if (argv[0] !== "runtime") {
    throw commandError("Unknown command", { command: argv[0] ?? "" });
  }
  switch (argv[1]) {
    case "start":
      return parseStart(argv.slice(2));
    case "status":
      return { kind: "runtime.status", ...parseLifecycleOptions(argv.slice(2)) };
    case "stop":
      return { kind: "runtime.stop", ...parseLifecycleOptions(argv.slice(2)) };
    default:
      throw commandError("Unknown runtime command", { command: argv[1] ?? "" });
  }
}
