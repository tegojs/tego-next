import {
  DiagnosticError,
  type JsonValue,
  parseTaskRecord,
  runtimeDiagnostic,
} from "@tegojs/contracts";
import type { RuntimeOperationName } from "../control/protocol.js";
import type { TaskRecordCommand, TaskRunCommand } from "../parse-command.js";

export type TaskCommand = TaskRecordCommand | TaskRunCommand;

export type TaskControlRequest = (
  operation: RuntimeOperationName,
  input: JsonValue,
  timeoutMs: number,
) => Promise<JsonValue>;

function invalidTaskResponse(): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_CONTROL_FRAME_INVALID",
      message: "Task control response did not contain a canonical task record",
      source: { kind: "protocol", id: "cli" },
    }),
  );
}

function taskRecord(result: JsonValue) {
  if (result === null) throw invalidTaskResponse();
  return parseTaskRecord(result);
}

export async function executeTaskCommand(
  command: TaskCommand,
  request: TaskControlRequest,
): Promise<JsonValue> {
  if (command.kind === "task.run") {
    const accepted = taskRecord(await request("task.run", command.input, command.timeoutMs));
    if (!command.wait || accepted.state === "terminal") return accepted;
    return taskRecord(await request("task.wait", { taskId: accepted.taskId }, command.timeoutMs));
  }

  const result = await request(command.kind, command.input, command.timeoutMs);
  if (command.kind === "task.status" && result === null) return null;
  return taskRecord(result);
}
