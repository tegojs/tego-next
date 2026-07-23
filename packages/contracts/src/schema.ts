import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import {
  type DiagnosticCode,
  DiagnosticError,
  type DiagnosticSource,
  runtimeDiagnostic,
} from "./diagnostic.js";
import type { ExecutionRequest } from "./execution.js";
import { type JsonObject, type JsonValue, serializeWireValue } from "./json.js";
import type { PluginManifest } from "./plugin.js";
import type { WorkerEnvelope } from "./worker.js";

export type JsonSchema = boolean | Readonly<Record<string, unknown>>;

export interface SchemaIssue {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: JsonObject;
  readonly schemaPath: string;
}

const IDENTITY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const DECIMAL_PATTERN = "^(?:0|[1-9]\\d*)$";
const SEMVER_PATTERN =
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$";

const pluginManifestSchema = {
  $id: "https://tegojs.dev/schemas/plugin-manifest-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "pluginId",
    "version",
    "contractRange",
    "nodeRange",
    "moduleFormat",
    "components",
    "permissions",
    "capabilities",
  ],
  properties: {
    schemaVersion: { const: "1.0" },
    pluginId: { $ref: "#/$defs/identity" },
    version: { type: "string", pattern: SEMVER_PATTERN },
    contractRange: { type: "string", minLength: 1 },
    nodeRange: { type: "string", minLength: 1 },
    moduleFormat: { const: "esm" },
    architectures: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    components: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["componentId", "kind", "entrypoint", "executors"],
        properties: {
          componentId: { $ref: "#/$defs/identity" },
          kind: { enum: ["service", "task"] },
          entrypoint: {
            type: "string",
            pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+\\.js$",
          },
          executors: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { enum: ["process", "remote", "thread"] },
          },
        },
      },
    },
    permissions: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    capabilities: {
      type: "object",
      additionalProperties: false,
      required: ["provides", "requires"],
      properties: {
        provides: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "protocolVersion"],
            properties: {
              name: { $ref: "#/$defs/identity" },
              protocolVersion: { type: "string", minLength: 1 },
            },
          },
        },
        requires: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "protocolRange"],
            properties: {
              name: { $ref: "#/$defs/identity" },
              protocolRange: { type: "string", minLength: 1 },
              optional: { type: "boolean" },
              lossPolicy: { enum: ["degrade", "fail", "suspend"] },
            },
          },
        },
      },
    },
    metadata: { type: "object" },
  },
  $defs: {
    identity: { type: "string", pattern: IDENTITY_PATTERN },
  },
} as const;

const executionRequestSchema = {
  $id: "https://tegojs.dev/schemas/execution-request-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "taskId",
    "attemptId",
    "applicationId",
    "pluginId",
    "componentId",
    "input",
    "deadline",
    "orphanPolicy",
  ],
  properties: {
    taskId: { $ref: "#/$defs/identity" },
    attemptId: { $ref: "#/$defs/identity" },
    applicationId: { $ref: "#/$defs/identity" },
    pluginId: { $ref: "#/$defs/identity" },
    componentId: { $ref: "#/$defs/identity" },
    input: true,
    deadline: { type: "string", format: "date-time" },
    orphanPolicy: { enum: ["cancel", "finish-and-buffer", "finish-and-persist"] },
  },
  $defs: {
    identity: { type: "string", pattern: IDENTITY_PATTERN },
  },
} as const;

const workerEnvelopeSchema = {
  $id: "https://tegojs.dev/schemas/worker-envelope-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["protocol", "messageId", "sessionId", "sequence", "type", "sentAt", "payload"],
  properties: {
    protocol: { const: "1.0" },
    messageId: { $ref: "#/$defs/identity" },
    sessionId: { $ref: "#/$defs/identity" },
    sequence: { type: "string", pattern: DECIMAL_PATTERN },
    correlationId: { $ref: "#/$defs/identity" },
    type: {
      enum: [
        "artifact.prepare",
        "artifact.prepared",
        "heartbeat",
        "hello",
        "session.reconcile",
        "task.acknowledge",
        "task.assign",
        "task.cancel",
        "task.result",
        "worker.register",
      ],
    },
    sentAt: { type: "string", format: "date-time" },
    payload: true,
  },
  $defs: {
    identity: { type: "string", pattern: IDENTITY_PATTERN },
  },
} as const;

const ajv = new Ajv2020Module.default({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
addFormatsModule.default(ajv);

const validatePluginManifest = ajv.compile(pluginManifestSchema);
const validateExecutionRequest = ajv.compile(executionRequestSchema);
const validateWorkerEnvelope = ajv.compile(workerEnvelopeSchema);
const schemaCache = new WeakMap<Readonly<Record<string, unknown>>, ValidateFunction>();

function issueFromAjv(error: ErrorObject): SchemaIssue {
  return {
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "schema validation failed",
    params: serializeWireValue(error.params) as JsonObject,
    schemaPath: error.schemaPath,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedIssues(errors: ErrorObject[] | null | undefined): SchemaIssue[] {
  return (errors ?? [])
    .map(issueFromAjv)
    .sort(
      (left, right) =>
        compareText(left.instancePath, right.instancePath) ||
        compareText(left.keyword, right.keyword) ||
        compareText(left.schemaPath, right.schemaPath) ||
        compareText(left.message, right.message),
    );
}

function validationError(
  code: DiagnosticCode,
  message: string,
  source: DiagnosticSource,
  errors: ErrorObject[] | null | undefined,
): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source,
      details: serializeWireValue({ issues: sortedIssues(errors) }),
    }),
  );
}

function parseWithValidator<T>(
  validate: ValidateFunction,
  input: unknown,
  code: DiagnosticCode,
  message: string,
  source: DiagnosticSource,
): T {
  if (!validate(input)) {
    throw validationError(code, message, source, validate.errors);
  }
  return input as T;
}

function field(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  return (input as Record<string, unknown>)[key];
}

function compatibilityError(code: DiagnosticCode, message: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "artifact", id: "manifest.json" },
    }),
  );
}

export function parsePluginManifest(input: unknown): PluginManifest {
  const moduleFormat = field(input, "moduleFormat");
  if (moduleFormat !== undefined && moduleFormat !== "esm") {
    throw compatibilityError(
      "ARTIFACT_MODULE_FORMAT_UNSUPPORTED",
      `Plugin module format ${String(moduleFormat)} is unsupported; expected esm`,
    );
  }
  const schemaVersion = field(input, "schemaVersion");
  if (schemaVersion !== undefined && schemaVersion !== "1.0") {
    throw compatibilityError(
      "ARTIFACT_SCHEMA_VERSION_UNSUPPORTED",
      `Plugin schema version ${String(schemaVersion)} is unsupported`,
    );
  }
  return parseWithValidator(
    validatePluginManifest,
    input,
    "ARTIFACT_MANIFEST_INVALID",
    "Plugin manifest is invalid",
    { kind: "artifact", id: "manifest.json" },
  );
}

export function parseExecutionRequest(input: unknown): ExecutionRequest {
  return parseWithValidator(
    validateExecutionRequest,
    input,
    "EXECUTOR_REQUEST_INVALID",
    "Execution request is invalid",
    { kind: "executor", id: "request" },
  );
}

export function parseWorkerEnvelope<T = JsonValue>(input: unknown): WorkerEnvelope<T> {
  const protocol = field(input, "protocol");
  if (protocol !== undefined && protocol !== "1.0") {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "WORKER_PROTOCOL_UNSUPPORTED",
        message: `Worker protocol ${String(protocol)} is unsupported`,
        source: { kind: "worker", id: "envelope" },
      }),
    );
  }
  return parseWithValidator(
    validateWorkerEnvelope,
    input,
    "WORKER_ENVELOPE_INVALID",
    "Worker envelope is invalid",
    { kind: "worker", id: "envelope" },
  );
}

function compileSchema(schema: JsonSchema): ValidateFunction {
  if (typeof schema === "boolean") {
    return ajv.compile(schema);
  }
  const cached = schemaCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const validate = ajv.compile(schema);
    schemaCache.set(schema, validate);
    return validate;
  } catch (error) {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "PROTOCOL_SCHEMA_INVALID",
        message: "JSON Schema could not be compiled",
        source: { kind: "schema" },
        cause:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: "UnknownCause", message: String(error) },
      }),
    );
  }
}

export function parseSchema<T>(schema: JsonSchema, input: unknown): T {
  const validate = compileSchema(schema);
  if (!validate(input)) {
    throw validationError(
      "PROTOCOL_SCHEMA_VALIDATION_FAILED",
      "Value does not satisfy the JSON Schema",
      { kind: "schema" },
      validate.errors,
    );
  }
  return input as T;
}
