import { DiagnosticError, runtimeDiagnostic } from "./diagnostic.js";
import { type OperationId, parseOperationId, parseRevision, type Revision } from "./identity.js";
import { type JsonObject, serializeWireValue } from "./json.js";

export const runtimeSnapshotDefaultLimit = 25;
export const runtimeSnapshotMaxLimit = 100;
export const runtimeSnapshotMaxBytes = 768 * 1_024;

export interface RuntimeSnapshotOperationCursor extends JsonObject {
  readonly revision: Revision;
  readonly operationId: OperationId;
}

export interface RuntimeSnapshotCursors extends JsonObject {
  readonly deployments?: string;
  readonly installations?: string;
  readonly instances?: string;
  readonly operations?: RuntimeSnapshotOperationCursor;
  readonly tasks?: string;
}

export interface RuntimeSnapshotProjection extends JsonObject {
  readonly deploymentConfiguration?: boolean;
  readonly taskInput?: boolean;
  readonly taskOutput?: boolean;
}

export interface RuntimeSnapshotRequest extends JsonObject {
  readonly limit?: number;
  readonly cursors?: RuntimeSnapshotCursors;
  readonly projection?: RuntimeSnapshotProjection;
}

export interface RuntimeSnapshotStateRecord extends JsonObject {
  readonly id: string;
  readonly revision: Revision;
  readonly value: JsonObject;
}

export interface RuntimeSnapshotOperationRecord extends JsonObject {
  readonly operationId: OperationId;
  readonly kind: string;
  readonly status: "completed" | "executing" | "failed" | "planned";
  readonly updatedAt: string;
  readonly revision: Revision;
}

export interface RuntimeSnapshotStatePage extends JsonObject {
  readonly items: readonly RuntimeSnapshotStateRecord[];
  readonly nextCursor?: string;
}

export interface RuntimeSnapshotOperationPage extends JsonObject {
  readonly items: readonly RuntimeSnapshotOperationRecord[];
  readonly nextCursor?: RuntimeSnapshotOperationCursor;
}

export interface RuntimeSnapshotResponse extends JsonObject {
  readonly installations: RuntimeSnapshotStatePage;
  readonly deployments: RuntimeSnapshotStatePage;
  readonly instances: RuntimeSnapshotStatePage;
  readonly operations: RuntimeSnapshotOperationPage;
  readonly tasks: RuntimeSnapshotStatePage;
}

function snapshotError(message: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "PROTOCOL_OPERATION_INVALID",
      message,
      source: { kind: "protocol", id: "runtime-snapshot" },
    }),
  );
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw snapshotError(`${name} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw snapshotError("Runtime snapshot fields do not match the contract");
  }
}

function optionalCursor(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw snapshotError(`${name} must be a non-empty string`);
  }
  return value;
}

function operationCursor(value: unknown): RuntimeSnapshotOperationCursor {
  const cursor = objectValue(value, "operations cursor");
  exactKeys(cursor, ["revision", "operationId"]);
  return {
    revision: parseRevision(cursor.revision),
    operationId: parseOperationId(cursor.operationId),
  };
}

export function parseRuntimeSnapshotRequest(input: unknown): RuntimeSnapshotRequest {
  const value = objectValue(input, "Runtime snapshot request");
  exactKeys(value, [], ["limit", "cursors", "projection"]);
  if (
    value.limit !== undefined &&
    (!Number.isSafeInteger(value.limit) ||
      (value.limit as number) < 1 ||
      (value.limit as number) > runtimeSnapshotMaxLimit)
  ) {
    throw snapshotError(
      `Runtime snapshot limit must be an integer between 1 and ${runtimeSnapshotMaxLimit}`,
    );
  }
  const cursors =
    value.cursors === undefined
      ? undefined
      : (() => {
          const inputCursors = objectValue(value.cursors, "Runtime snapshot cursors");
          exactKeys(
            inputCursors,
            [],
            ["deployments", "installations", "instances", "operations", "tasks"],
          );
          const parsed: {
            deployments?: string;
            installations?: string;
            instances?: string;
            operations?: RuntimeSnapshotOperationCursor;
            tasks?: string;
          } = {};
          const deployments = optionalCursor(inputCursors.deployments, "deployments cursor");
          const installations = optionalCursor(inputCursors.installations, "installations cursor");
          const instances = optionalCursor(inputCursors.instances, "instances cursor");
          const tasks = optionalCursor(inputCursors.tasks, "tasks cursor");
          if (deployments !== undefined) parsed.deployments = deployments;
          if (installations !== undefined) parsed.installations = installations;
          if (instances !== undefined) parsed.instances = instances;
          if (inputCursors.operations !== undefined) {
            parsed.operations = operationCursor(inputCursors.operations);
          }
          if (tasks !== undefined) parsed.tasks = tasks;
          return parsed;
        })();
  const projection =
    value.projection === undefined
      ? undefined
      : (() => {
          const inputProjection = objectValue(value.projection, "Runtime snapshot projection");
          exactKeys(inputProjection, [], ["deploymentConfiguration", "taskInput", "taskOutput"]);
          for (const [key, enabled] of Object.entries(inputProjection)) {
            if (typeof enabled !== "boolean") {
              throw snapshotError(`Runtime snapshot projection ${key} must be boolean`);
            }
          }
          return structuredClone(inputProjection) as RuntimeSnapshotProjection;
        })();
  return {
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
    ...(cursors === undefined ? {} : { cursors }),
    ...(projection === undefined ? {} : { projection }),
  };
}

function stateRecord(value: unknown): RuntimeSnapshotStateRecord {
  const record = objectValue(value, "Runtime snapshot state record");
  exactKeys(record, ["id", "revision", "value"]);
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw snapshotError("Runtime snapshot record ID must be a non-empty string");
  }
  const projected = serializeWireValue(record.value);
  if (typeof projected !== "object" || projected === null || Array.isArray(projected)) {
    throw snapshotError("Runtime snapshot record value must be an object");
  }
  return {
    id: record.id,
    revision: parseRevision(record.revision),
    value: projected as JsonObject,
  };
}

function operationRecord(value: unknown): RuntimeSnapshotOperationRecord {
  const record = objectValue(value, "Runtime snapshot operation record");
  exactKeys(record, ["operationId", "kind", "status", "updatedAt", "revision"]);
  if (
    typeof record.kind !== "string" ||
    record.kind.length === 0 ||
    (record.status !== "completed" &&
      record.status !== "executing" &&
      record.status !== "failed" &&
      record.status !== "planned") ||
    typeof record.updatedAt !== "string"
  ) {
    throw snapshotError("Runtime snapshot operation record is invalid");
  }
  return {
    operationId: parseOperationId(record.operationId),
    kind: record.kind,
    status: record.status,
    updatedAt: record.updatedAt,
    revision: parseRevision(record.revision),
  };
}

function statePage(value: unknown): RuntimeSnapshotStatePage {
  const page = objectValue(value, "Runtime snapshot state page");
  exactKeys(page, ["items"], ["nextCursor"]);
  if (!Array.isArray(page.items))
    throw snapshotError("Runtime snapshot page items must be an array");
  const items = page.items.map((item) => stateRecord(item));
  const nextCursor = optionalCursor(page.nextCursor, "next cursor");
  return nextCursor === undefined ? { items } : { items, nextCursor };
}

function operationsPage(value: unknown): RuntimeSnapshotOperationPage {
  const page = objectValue(value, "Runtime snapshot operations page");
  exactKeys(page, ["items"], ["nextCursor"]);
  if (!Array.isArray(page.items))
    throw snapshotError("Runtime snapshot page items must be an array");
  return {
    items: page.items.map((item) => operationRecord(item)),
    ...(page.nextCursor === undefined ? {} : { nextCursor: operationCursor(page.nextCursor) }),
  };
}

export function parseRuntimeSnapshotResponse(input: unknown): RuntimeSnapshotResponse {
  const serialized = serializeWireValue(input);
  if (new TextEncoder().encode(JSON.stringify(serialized)).byteLength > runtimeSnapshotMaxBytes) {
    throw snapshotError("Runtime snapshot response exceeds the serialized size limit");
  }
  const value = objectValue(serialized, "Runtime snapshot response");
  exactKeys(value, ["installations", "deployments", "instances", "operations", "tasks"]);
  return {
    installations: statePage(value.installations),
    deployments: statePage(value.deployments),
    instances: statePage(value.instances),
    operations: operationsPage(value.operations),
    tasks: statePage(value.tasks),
  };
}
