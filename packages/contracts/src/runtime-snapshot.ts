import { DiagnosticError, runtimeDiagnostic } from "./diagnostic.js";
import { type OperationId, parseOperationId, parseRevision, type Revision } from "./identity.js";
import { type JsonObject, serializeWireValue } from "./json.js";

export const runtimeSnapshotDefaultLimit = 25;
export const runtimeSnapshotMaxLimit = 100;
export const runtimeSnapshotMaxBytes = 768 * 1_024;

export type RuntimeSnapshotSection =
  | "deployments"
  | "installations"
  | "instances"
  | "operations"
  | "tasks";

export interface RuntimeSnapshotCursors extends JsonObject {
  readonly deployments?: string;
  readonly installations?: string;
  readonly instances?: string;
  readonly operations?: string;
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
  readonly nextCursor?: string;
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

function optionalCursor(
  value: unknown,
  name: string,
  section: RuntimeSnapshotSection,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw snapshotError(`${name} must be a non-empty string`);
  }
  parseRuntimeSnapshotCursor(value, section);
  return value;
}

const snapshotCursorPrefix = "tego.snapshot.v1.";

export interface ParsedRuntimeSnapshotStateCursor {
  readonly section: Exclude<RuntimeSnapshotSection, "operations">;
  readonly afterId: string;
}

export interface ParsedRuntimeSnapshotOperationCursor {
  readonly section: "operations";
  readonly after: {
    readonly revision: Revision;
    readonly operationId: OperationId;
  };
}

export type ParsedRuntimeSnapshotCursor =
  | ParsedRuntimeSnapshotOperationCursor
  | ParsedRuntimeSnapshotStateCursor;

function cursorToken(section: RuntimeSnapshotSection, position: JsonObject): string {
  const payload = JSON.stringify({ version: 1, section, position });
  return `${snapshotCursorPrefix}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

export function createRuntimeSnapshotStateCursor(
  section: Exclude<RuntimeSnapshotSection, "operations">,
  afterId: string,
): string {
  if (afterId.length === 0) throw snapshotError("Runtime snapshot cursor ID must not be empty");
  return cursorToken(section, { id: afterId });
}

export function createRuntimeSnapshotOperationCursor(
  revision: Revision,
  operationId: OperationId,
): string {
  return cursorToken("operations", { revision, operationId });
}

export function parseRuntimeSnapshotCursor(
  token: string,
  expectedSection: Exclude<RuntimeSnapshotSection, "operations">,
): ParsedRuntimeSnapshotStateCursor;
export function parseRuntimeSnapshotCursor(
  token: string,
  expectedSection: "operations",
): ParsedRuntimeSnapshotOperationCursor;
export function parseRuntimeSnapshotCursor(
  token: string,
  expectedSection: RuntimeSnapshotSection,
): ParsedRuntimeSnapshotCursor;
export function parseRuntimeSnapshotCursor(
  token: string,
  expectedSection: RuntimeSnapshotSection,
): ParsedRuntimeSnapshotCursor {
  if (!token.startsWith(snapshotCursorPrefix) || token.length > 8_192) {
    throw snapshotError("Runtime snapshot cursor is invalid");
  }
  const encoded = token.slice(snapshotCursorPrefix.length);
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw snapshotError("Runtime snapshot cursor is invalid");
  }
  if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
    throw snapshotError("Runtime snapshot cursor is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw snapshotError("Runtime snapshot cursor is invalid");
  }
  const value = objectValue(parsed, "Runtime snapshot cursor");
  exactKeys(value, ["version", "section", "position"]);
  if (value.version !== 1 || value.section !== expectedSection) {
    throw snapshotError("Runtime snapshot cursor does not match its section");
  }
  const position = objectValue(value.position, "Runtime snapshot cursor position");
  if (expectedSection === "operations") {
    exactKeys(position, ["revision", "operationId"]);
    return {
      section: "operations",
      after: {
        revision: parseRevision(position.revision),
        operationId: parseOperationId(position.operationId),
      },
    };
  }
  exactKeys(position, ["id"]);
  if (typeof position.id !== "string" || position.id.length === 0) {
    throw snapshotError("Runtime snapshot cursor ID must not be empty");
  }
  return {
    section: expectedSection,
    afterId: position.id,
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
            operations?: string;
            tasks?: string;
          } = {};
          const deployments = optionalCursor(
            inputCursors.deployments,
            "deployments cursor",
            "deployments",
          );
          const installations = optionalCursor(
            inputCursors.installations,
            "installations cursor",
            "installations",
          );
          const instances = optionalCursor(inputCursors.instances, "instances cursor", "instances");
          const operations = optionalCursor(
            inputCursors.operations,
            "operations cursor",
            "operations",
          );
          const tasks = optionalCursor(inputCursors.tasks, "tasks cursor", "tasks");
          if (deployments !== undefined) parsed.deployments = deployments;
          if (installations !== undefined) parsed.installations = installations;
          if (instances !== undefined) parsed.instances = instances;
          if (operations !== undefined) parsed.operations = operations;
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

function statePage(
  value: unknown,
  section: Exclude<RuntimeSnapshotSection, "operations">,
): RuntimeSnapshotStatePage {
  const page = objectValue(value, "Runtime snapshot state page");
  exactKeys(page, ["items"], ["nextCursor"]);
  if (!Array.isArray(page.items))
    throw snapshotError("Runtime snapshot page items must be an array");
  const items = page.items.map((item) => stateRecord(item));
  const nextCursor = optionalCursor(page.nextCursor, "next cursor", section);
  return nextCursor === undefined ? { items } : { items, nextCursor };
}

function operationsPage(value: unknown): RuntimeSnapshotOperationPage {
  const page = objectValue(value, "Runtime snapshot operations page");
  exactKeys(page, ["items"], ["nextCursor"]);
  if (!Array.isArray(page.items))
    throw snapshotError("Runtime snapshot page items must be an array");
  const items = page.items.map((item) => operationRecord(item));
  const nextCursor = optionalCursor(page.nextCursor, "next cursor", "operations");
  return nextCursor === undefined ? { items } : { items, nextCursor };
}

export function parseRuntimeSnapshotResponse(input: unknown): RuntimeSnapshotResponse {
  const serialized = serializeWireValue(input);
  if (new TextEncoder().encode(JSON.stringify(serialized)).byteLength > runtimeSnapshotMaxBytes) {
    throw snapshotError("Runtime snapshot response exceeds the serialized size limit");
  }
  const value = objectValue(serialized, "Runtime snapshot response");
  exactKeys(value, ["installations", "deployments", "instances", "operations", "tasks"]);
  return {
    installations: statePage(value.installations, "installations"),
    deployments: statePage(value.deployments, "deployments"),
    instances: statePage(value.instances, "instances"),
    operations: operationsPage(value.operations),
    tasks: statePage(value.tasks, "tasks"),
  };
}
