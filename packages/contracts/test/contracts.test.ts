import assert from "node:assert/strict";
import test from "node:test";

import {
  DiagnosticError,
  diagnosticCode,
  type ExecutionRequest,
  type JsonSchema,
  type PluginManifest,
  parseApplicationId,
  parseAttemptId,
  parseComponentId,
  parseExecutionRequest,
  parseMessageId,
  parsePluginId,
  parsePluginManifest,
  parseRuntimeId,
  parseSchema,
  parseSequence,
  parseSessionId,
  parseTaskId,
  parseWorkerEnvelope,
  serializeWireValue,
  type WorkerEnvelope,
} from "../src/index.js";

const validManifest = {
  schemaVersion: "1.0",
  pluginId: parsePluginId("org.example.echo"),
  version: "1.2.3",
  contractRange: "^1.0.0",
  nodeRange: ">=26.5.0 <27",
  moduleFormat: "esm",
  components: [
    {
      componentId: parseComponentId("echo"),
      kind: "task",
      entrypoint: "components/echo.js",
      executors: ["thread", "process", "remote"],
    },
  ],
  permissions: [],
  capabilities: {
    provides: [],
    requires: [],
  },
} satisfies PluginManifest;

const validExecutionRequest = {
  taskId: parseTaskId("task-01"),
  attemptId: parseAttemptId("attempt-01"),
  applicationId: parseApplicationId("detector"),
  pluginId: parsePluginId("org.example.echo"),
  componentId: parseComponentId("echo"),
  input: { message: "hello" },
  deadline: "2026-07-23T12:00:00.000Z",
  orphanPolicy: "finish-and-buffer",
} satisfies ExecutionRequest;

const validWorkerEnvelope = {
  protocol: "1.0",
  messageId: parseMessageId("message-01"),
  sessionId: parseSessionId("session-01"),
  sequence: parseSequence("1"),
  type: "task.assign",
  sentAt: "2026-07-23T11:59:00.000Z",
  payload: validExecutionRequest,
} satisfies WorkerEnvelope<ExecutionRequest>;

test("branded identities are constructed only after validation", () => {
  assert.equal(parseRuntimeId("medical-device-01"), "medical-device-01");
  assert.equal(parseApplicationId("detector"), "detector");
  assert.throws(
    () => parseRuntimeId("../escape"),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_IDENTITY_INVALID",
  );
});

test("@spec:plugin-artifacts/runtime-compatibility-validation/unsupported-commonjs-artifact", () => {
  const commonJsManifest = { ...validManifest, moduleFormat: "commonjs" };

  assert.throws(
    () => parsePluginManifest(commonJsManifest),
    (error: unknown) => diagnosticCode(error) === "ARTIFACT_MODULE_FORMAT_UNSUPPORTED",
  );
});

test("plugin manifest validation reports deterministically sorted Ajv issues", () => {
  assert.throws(
    () =>
      parsePluginManifest({
        ...validManifest,
        pluginId: "",
        version: "not-semver",
        components: [{ ...validManifest.components[0], componentId: "" }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DiagnosticError);
      assert.equal(error.diagnostic.code, "ARTIFACT_MANIFEST_INVALID");
      assert.deepEqual(error.diagnostic.details, {
        issues: [
          {
            instancePath: "/components/0/componentId",
            keyword: "pattern",
            message: 'must match pattern "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"',
            params: { pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
            schemaPath: "#/$defs/identity/pattern",
          },
          {
            instancePath: "/pluginId",
            keyword: "pattern",
            message: 'must match pattern "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"',
            params: { pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
            schemaPath: "#/$defs/identity/pattern",
          },
          {
            instancePath: "/version",
            keyword: "pattern",
            message:
              'must match pattern "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"',
            params: {
              pattern:
                "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$",
            },
            schemaPath: "#/properties/version/pattern",
          },
        ],
      });
      return true;
    },
  );
});

test("execution request validation preserves JsonValue payloads", () => {
  assert.deepEqual(parseExecutionRequest(validExecutionRequest), validExecutionRequest);
  assert.throws(
    () => parseExecutionRequest({ ...validExecutionRequest, input: undefined }),
    (error: unknown) => diagnosticCode(error) === "EXECUTOR_REQUEST_INVALID",
  );
});

test("@spec:worker-protocol/versioned-reliable-message-envelope/unsupported-protocol-version", () => {
  assert.throws(
    () => parseWorkerEnvelope({ protocol: "2.0" }),
    (error: unknown) => diagnosticCode(error) === "WORKER_PROTOCOL_UNSUPPORTED",
  );
});

test("worker envelopes preserve decimal sequence values and payloads", () => {
  assert.deepEqual(parseWorkerEnvelope(validWorkerEnvelope), validWorkerEnvelope);
  assert.throws(
    () =>
      parseWorkerEnvelope({
        ...validWorkerEnvelope,
        sequence: "01",
        sentAt: "not-a-date",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DiagnosticError);
      assert.equal(error.diagnostic.code, "WORKER_ENVELOPE_INVALID");
      const details = error.diagnostic.details as {
        issues: Array<{ instancePath: string; keyword: string }>;
      };
      assert.deepEqual(
        details.issues.map(({ instancePath, keyword }) => ({ instancePath, keyword })),
        [
          { instancePath: "/sentAt", keyword: "format" },
          { instancePath: "/sequence", keyword: "pattern" },
        ],
      );
      return true;
    },
  );
});

test("parseSchema supports strict JSON Schema 2020 formats", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["email"],
    properties: {
      email: { type: "string", format: "email" },
    },
  } as const satisfies JsonSchema;

  assert.deepEqual(parseSchema<{ email: string }>(schema, { email: "operator@example.com" }), {
    email: "operator@example.com",
  });
  assert.throws(
    () => parseSchema(schema, { email: "invalid" }),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_SCHEMA_VALIDATION_FAILED",
  );
});

test("serializeWireValue converts supported runtime values into JSON data", () => {
  const value = serializeWireValue({
    revision: 18n,
    observedAt: new Date("2026-07-23T12:00:00.000Z"),
    bytes: new Uint8Array([0, 127, 255]),
    nested: [{ enabled: true }, null],
  });

  assert.deepEqual(value, {
    revision: "18",
    observedAt: "2026-07-23T12:00:00.000Z",
    bytes: "AH//",
    nested: [{ enabled: true }, null],
  });
  assert.throws(
    () => serializeWireValue({ invalid: Number.NaN }),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_WIRE_VALUE_INVALID",
  );
  assert.throws(
    () => serializeWireValue({ invalid: undefined }),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_WIRE_VALUE_INVALID",
  );
});
