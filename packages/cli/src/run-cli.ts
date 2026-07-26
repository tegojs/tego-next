import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import {
  DiagnosticError,
  type JsonValue,
  parseRuntimeSnapshotResponse,
  type RuntimeStatus,
  runtimeDiagnostic,
} from "@tegojs/contracts";
import {
  executeLocalPluginCommand,
  parsePluginControlResult,
  pluginControlRequest,
} from "./commands/plugin.js";
import { startRuntimeDetached, startRuntimeForeground } from "./commands/runtime.js";
import { executeTaskCommand } from "./commands/task.js";
import { startWorkerForeground, type WorkerReadyHandler } from "./commands/worker.js";
import { type ControlClientOptions, requestControl } from "./control/client.js";
import {
  type ControlResponse,
  DEFAULT_CONTROL_TIMEOUT_MS,
  parseControlResponse,
  type RuntimeOperationName,
  sanitizeControlDiagnostic,
} from "./control/protocol.js";
import {
  type ParsedCommand,
  parseCommand,
  type RuntimeStartCommand,
  type WorkerStartCommand,
} from "./parse-command.js";

const help = `Usage: tego <command>

Commands:
  runtime start [--detach] [--json] [--data-dir <path>] [--endpoint <path>]
  runtime snapshot [--json] [--endpoint <path>]
  runtime status [--json] [--endpoint <path>]
  runtime stop [--json] [--endpoint <path>]
  plugin validate|pack|inspect|install|deploy|status
  task run|status|wait|cancel
  worker start (--connect <url> | --listen <host:port>) [--prepare <artifact>]
`;

export interface CliRunOptions {
  readonly argv: readonly string[];
  readonly stdout?: Pick<Writable, "write">;
  readonly stderr?: Pick<Writable, "write">;
  readonly requestControl?: (options: ControlClientOptions) => Promise<ControlResponse>;
  readonly monotonicNow?: () => number;
  readonly startForeground?: (command: RuntimeStartCommand) => Promise<RuntimeStatus>;
  readonly startDetached?: (command: RuntimeStartCommand) => Promise<RuntimeStatus>;
  readonly startWorker?: (
    command: WorkerStartCommand,
    onReady: WorkerReadyHandler,
  ) => Promise<void>;
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
    if (command.kind === "worker.start") {
      const workerCommand = command;
      let ready = false;
      const start = options.startWorker ?? startWorkerForeground;
      await start(workerCommand, (readiness) => {
        if (ready) throw new Error("LIFECYCLE_WORKER_READINESS_DUPLICATED");
        ready = true;
        write(stdout, readiness, workerCommand.json);
      });
      if (!ready) throw new Error("LIFECYCLE_WORKER_NOT_READY");
      return 0;
    }
    const control = options.requestControl ?? requestControl;
    const request = async (
      endpoint: string,
      operation: RuntimeOperationName,
      input: JsonValue,
      timeoutMs: number,
    ): Promise<JsonValue> => {
      const requestId = randomUUID();
      const response = parseControlResponse(
        await control({ endpoint, operation, input, timeoutMs, requestId }),
      );
      if (response.requestId !== requestId) {
        throw new DiagnosticError(
          runtimeDiagnostic({
            code: "PROTOCOL_CONTROL_REQUEST_MISMATCH",
            message: "Control response request ID does not match",
            source: { kind: "protocol", id: "cli" },
          }),
        );
      }
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
      if (!Object.hasOwn(response, "result")) {
        throw new DiagnosticError(
          runtimeDiagnostic({
            code: "PROTOCOL_CONTROL_FRAME_INVALID",
            message: "Successful control response did not contain a result",
            source: { kind: "protocol", id: "cli" },
          }),
        );
      }
      return response.result as JsonValue;
    };

    if (
      command.kind === "plugin.inspect" ||
      command.kind === "plugin.pack" ||
      command.kind === "plugin.validate"
    ) {
      write(stdout, await executeLocalPluginCommand(command), command.json);
      return 0;
    }
    if (
      command.kind === "plugin.deploy" ||
      command.kind === "plugin.install" ||
      command.kind === "plugin.status"
    ) {
      const operation = await pluginControlRequest(command);
      const result = await request(
        command.endpoint,
        operation.operation,
        operation.input,
        DEFAULT_CONTROL_TIMEOUT_MS,
      );
      write(stdout, parsePluginControlResult(command, result), command.json);
      return 0;
    }
    if (
      command.kind === "task.cancel" ||
      command.kind === "task.run" ||
      command.kind === "task.status" ||
      command.kind === "task.wait"
    ) {
      const endpoint = command.endpoint;
      write(
        stdout,
        await executeTaskCommand(
          command,
          (operation, input, timeoutMs) => request(endpoint, operation, input, timeoutMs),
          options.monotonicNow,
        ),
        command.json,
      );
      return 0;
    }
    if (command.kind === "runtime.snapshot") {
      write(
        stdout,
        parseRuntimeSnapshotResponse(
          await request(command.endpoint, command.kind, command.input, DEFAULT_CONTROL_TIMEOUT_MS),
        ),
        command.json,
      );
      return 0;
    }

    write(
      stdout,
      await request(command.endpoint, command.kind, {}, DEFAULT_CONTROL_TIMEOUT_MS),
      command.json,
    );
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
        ? sanitizeControlDiagnostic(error.diagnostic)
        : sanitizeControlDiagnostic(
            runtimeDiagnostic({
              code: "PROTOCOL_CLI_FAILED",
              message: "CLI operation failed",
              source: { kind: "protocol", id: "cli" },
            }),
          );
    stderr.write(`${JSON.stringify({ diagnostic })}\n`);
    return diagnostic.code === "PROTOCOL_COMMAND_INVALID" ? 2 : 1;
  }
}
