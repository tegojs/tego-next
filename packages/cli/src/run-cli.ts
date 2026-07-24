import type { Writable } from "node:stream";
import {
  DiagnosticError,
  type RuntimeStatus,
  runtimeDiagnostic,
  serializeCause,
} from "@tegojs/contracts";
import { startRuntimeDetached, startRuntimeForeground } from "./commands/runtime.js";
import { type ControlClientOptions, requestControl } from "./control/client.js";
import { type ControlResponse, DEFAULT_CONTROL_TIMEOUT_MS } from "./control/protocol.js";
import { type ParsedCommand, parseCommand, type RuntimeStartCommand } from "./parse-command.js";

const help = `Usage: tego <command>

Commands:
  runtime start [--detach] [--json] [--data-dir <path>] [--endpoint <path>]
  runtime status [--json] [--endpoint <path>]
  runtime stop [--json] [--endpoint <path>]
`;

export interface CliRunOptions {
  readonly argv: readonly string[];
  readonly stdout?: Pick<Writable, "write">;
  readonly stderr?: Pick<Writable, "write">;
  readonly requestControl?: (options: ControlClientOptions) => Promise<ControlResponse>;
  readonly startForeground?: (command: RuntimeStartCommand) => Promise<RuntimeStatus>;
  readonly startDetached?: (command: RuntimeStartCommand) => Promise<RuntimeStatus>;
}

function write(stream: Pick<Writable, "write">, value: unknown, json: boolean): void {
  if (json || typeof value !== "string") {
    stream.write(`${JSON.stringify(value)}\n`);
  } else {
    stream.write(`${value}\n`);
  }
}

export async function runCli(options: CliRunOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let command: ParsedCommand | undefined;
  try {
    command = parseCommand(options.argv);
    if (command.kind === "help") {
      stdout.write(help);
      return 0;
    }
    if (command.kind === "runtime.start") {
      const start = command.detach
        ? (options.startDetached ?? startRuntimeDetached)
        : (options.startForeground ?? startRuntimeForeground);
      write(stdout, await start(command), command.json);
      return 0;
    }
    const control = options.requestControl ?? requestControl;
    const response = await control({
      endpoint: command.endpoint,
      operation: command.kind,
      input: {},
      timeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
    });
    if (!response.ok) {
      throw new DiagnosticError(
        response.diagnostic ??
          runtimeDiagnostic({
            code: "PROTOCOL_CONTROL_FRAME_INVALID",
            message: "Control response did not contain a diagnostic",
            source: { kind: "protocol", id: "cli" },
          }),
      );
    }
    write(stdout, response.result ?? null, command.json);
    return 0;
  } catch (error) {
    const connectionCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    if (
      command?.kind === "runtime.stop" &&
      (connectionCode === "ENOENT" || connectionCode === "ECONNREFUSED")
    ) {
      write(stdout, { alreadyStopped: true, stopped: true }, command.json);
      return 0;
    }
    const diagnostic =
      error instanceof DiagnosticError
        ? error.diagnostic
        : runtimeDiagnostic({
            code: "PROTOCOL_CLI_FAILED",
            message: error instanceof Error ? error.message : String(error),
            source: { kind: "protocol", id: "cli" },
            cause: serializeCause(error),
          });
    stderr.write(`${JSON.stringify({ diagnostic })}\n`);
    return diagnostic.code === "PROTOCOL_COMMAND_INVALID" ? 2 : 1;
  }
}
