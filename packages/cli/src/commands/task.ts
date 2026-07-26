import {
  DiagnosticError,
  type JsonValue,
  parseTaskRecord,
  runtimeDiagnostic,
  serializeWireValue,
} from "@tegojs/contracts";
import {
  DEFAULT_CONTROL_TIMEOUT_MS,
  type RuntimeOperationName,
  sanitizeControlValue,
} from "../control/protocol.js";
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

function requestMismatch(message: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_CONTROL_REQUEST_MISMATCH",
      message,
      source: { kind: "protocol", id: "cli" },
    }),
  );
}

function timeoutExpired(): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_CONTROL_TIMEOUT",
      message: "Task command timeout expired before wait could start",
      source: { kind: "protocol", id: "cli" },
    }),
  );
}

function taskRecord(result: JsonValue) {
  if (result === null) throw invalidTaskResponse();
  return parseTaskRecord(result);
}

function sameWireValue(left: JsonValue, right: JsonValue): boolean {
  const normalize = (value: JsonValue) =>
    serializeWireValue(sanitizeControlValue(serializeWireValue(value)));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export async function executeTaskCommand(
  command: TaskCommand,
  request: TaskControlRequest,
  monotonicNow: () => number = () => performance.now(),
): Promise<JsonValue> {
  if (command.kind === "task.run") {
    const startedAt = monotonicNow();
    const accepted = taskRecord(
      await request(
        "task.run",
        command.input,
        Math.min(command.timeoutMs, DEFAULT_CONTROL_TIMEOUT_MS),
      ),
    );
    if (!sameWireValue(accepted.request, command.input)) {
      throw requestMismatch("Task run response request does not match the submitted request");
    }
    if (!command.wait || accepted.state === "terminal") return accepted;
    const elapsed = Math.max(0, monotonicNow() - startedAt);
    const remaining = Math.floor(command.timeoutMs - elapsed);
    if (!Number.isSafeInteger(remaining) || remaining < 1) throw timeoutExpired();
    const completed = taskRecord(
      await request("task.wait", { taskId: accepted.taskId }, remaining),
    );
    if (
      completed.taskId !== accepted.taskId ||
      completed.attemptId !== accepted.attemptId ||
      !sameWireValue(completed.request, accepted.request)
    ) {
      throw requestMismatch("Task wait response identity does not match the accepted task");
    }
    return completed;
  }

  const result = await request(command.kind, command.input, command.timeoutMs);
  if (command.kind === "task.status" && result === null) return null;
  const record = taskRecord(result);
  if (record.taskId !== command.input.taskId) {
    throw requestMismatch("Task response identity does not match the requested task");
  }
  return record;
}
