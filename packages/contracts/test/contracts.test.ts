import assert from "node:assert/strict";
import test from "node:test";

import {
  type CapabilityBinding,
  type CapabilityDefinition,
  type CapabilityIdentity,
  createExecutionBinding,
  DiagnosticError,
  type DriverHealth,
  diagnosticCode,
  type ExecutionRequest,
  type ExecutionResult,
  type JsonSchema,
  type JsonValue,
  type Leadership,
  type Permission,
  type PluginDeployment,
  type PluginInstallation,
  type PluginManifest,
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseCapabilityBinding,
  parseCapabilityDefinition,
  parseCapabilityIdentity,
  parseCapabilityName,
  parseComponentId,
  parseComponentInstanceId,
  parseDriverHealth,
  parseExecutionRequest,
  parseExecutionResult,
  parseExecutorId,
  parseFencingEpoch,
  parseGeneration,
  parseLeadership,
  parseMessageId,
  parseNodeId,
  parsePluginDeployment,
  parsePluginId,
  parsePluginInstallation,
  parsePluginManifest,
  parseRuntimeConfiguration,
  parseRuntimeDiagnostic,
  parseRuntimeEvent,
  parseRuntimeId,
  parseRuntimeStatus,
  parseSchema,
  parseSequence,
  parseSessionId,
  parseTaskExecutionTarget,
  parseTaskId,
  parseTaskRecord,
  parseWorkerEnvelope,
  type RuntimeConfiguration,
  type RuntimeDiagnostic,
  type RuntimeEvent,
  type RuntimeStatus,
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
  permissions: [
    {
      kind: "capability",
      capabilities: [{ name: "org.example.echo", methods: ["read", "write"] }],
    },
    { kind: "executor", executors: ["process", "remote", "thread"] },
    { kind: "network", hosts: ["example.com"], ports: [443], methods: ["GET", "POST"] },
    { kind: "filesystem", roots: [{ path: "/data", access: ["read", "write"] }] },
    { kind: "secret", names: ["api-key"] },
    { kind: "environment", names: ["TEGO_MODE"] },
    {
      kind: "worker",
      labels: { zone: "edge-a" },
      resources: { cpuMillis: 1_000, memoryBytes: 1_048_576, storageBytes: 1_048_576 },
    },
  ] satisfies readonly Permission[],
  capabilities: {
    provides: [],
    requires: [],
  },
} satisfies PluginManifest;

const validExecutionTarget = {
  instanceId: parseComponentInstanceId("detector.org.example.echo.echo.1"),
  deploymentGeneration: parseGeneration("1"),
  artifactDigest: parseArtifactDigest(
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  ),
  executor: { id: "executor-01", type: "process" },
} as const;

const validExecutionIdentity = {
  applicationId: parseApplicationId("detector"),
  pluginId: parsePluginId("org.example.echo"),
  componentId: parseComponentId("echo"),
  target: validExecutionTarget,
} as const;

const validExecutionRequest = {
  taskId: parseTaskId("task-01"),
  attemptId: parseAttemptId("attempt-01"),
  ...validExecutionIdentity,
  binding: createExecutionBinding(validExecutionIdentity, {
    configuration: { nested: { enabled: true } },
    permissionGrants: validManifest.permissions,
    capabilityDefinitions: [],
    capabilityBindings: [],
  }),
  input: { message: "hello" },
  deadline: "2026-07-23T12:00:00.000Z",
  orphanPolicy: "finish-and-buffer",
} satisfies ExecutionRequest;

const validWorkerEnvelope = {
  protocol: "1.0",
  messageId: parseMessageId("message-01"),
  sessionId: parseSessionId("session-01"),
  sequence: parseSequence("1"),
  correlationId: parseMessageId("message-01"),
  type: "task.assign",
  sentAt: "2026-07-23T11:59:00.000Z",
  payload: validExecutionRequest,
} satisfies WorkerEnvelope<ExecutionRequest>;

const validRuntimeConfiguration = {
  mode: "single-main",
  runtimeId: parseRuntimeId("medical-device-01"),
  applicationId: parseApplicationId("detector"),
  nodeId: parseNodeId("main-01"),
} satisfies RuntimeConfiguration;

const validDriverHealth = {
  status: "healthy",
  checkedAt: "2026-07-23T12:00:00.000Z",
} satisfies DriverHealth;

const validLeadership = {
  resource: "runtime:medical-device-01",
  epoch: parseFencingEpoch("3"),
} satisfies Leadership;

const validRuntimeStatus = {
  identity: {
    runtimeId: validRuntimeConfiguration.runtimeId,
    applicationId: validRuntimeConfiguration.applicationId,
    nodeId: validRuntimeConfiguration.nodeId,
  },
  mode: validRuntimeConfiguration.mode,
  lifecycle: "running",
  liveness: true,
  readiness: true,
  acceptingOperations: true,
  drivers: [
    { name: "state", health: validDriverHealth },
    { name: "coordination", health: validDriverHealth },
    { name: "artifacts", health: validDriverHealth },
  ],
  counts: {
    deployments: 0,
    installations: 0,
    recoverableOperations: 0,
    tasks: 0,
    workers: 0,
  },
  authority: validLeadership,
} satisfies RuntimeStatus;

const validRuntimeEvent = {
  type: "runtime.lifecycle",
  previous: "electing",
  current: "running",
  occurredAt: "2026-07-23T12:00:00.000Z",
} satisfies RuntimeEvent;

const validInstallation = {
  pluginId: validManifest.pluginId,
  version: validManifest.version,
  digest: parseArtifactDigest(
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ),
  manifest: validManifest,
  installedAt: "2026-07-23T11:00:00.000Z",
  signature: {
    algorithm: "Ed25519",
    keyId: "release-key-01",
    verified: true,
  },
} satisfies PluginInstallation;

const validDeployment = {
  applicationId: validExecutionRequest.applicationId,
  pluginId: validManifest.pluginId,
  version: validManifest.version,
  artifactDigest: validInstallation.digest,
  generation: parseGeneration("4"),
  state: "active",
  essential: true,
  configuration: { threshold: 0.75 },
  permissionGrants: [
    {
      kind: "capability",
      capabilities: [{ name: "org.example.echo", methods: ["read"] }],
    },
  ],
  capabilityBindings: {
    "org.example.echo": {
      applicationId: validExecutionRequest.applicationId,
      pluginId: validManifest.pluginId,
    },
  },
} satisfies PluginDeployment;

const validCapabilityIdentity = {
  name: parseCapabilityName("org.example.echo"),
  protocolVersion: "1.0.0",
} satisfies CapabilityIdentity;

const validCapabilityDefinition = {
  identity: validCapabilityIdentity,
  requestSchema: {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: { message: { type: "string" } },
  },
  responseSchema: {
    type: "object",
    additionalProperties: false,
    required: ["echo"],
    properties: { echo: { type: "string" } },
  },
} satisfies CapabilityDefinition;

const validCapabilityBinding = {
  capability: validCapabilityIdentity,
  providerDeployment: {
    applicationId: validExecutionRequest.applicationId,
    pluginId: validManifest.pluginId,
  },
} satisfies CapabilityBinding;

const validDiagnostic = {
  code: "STATE_REVISION_CONFLICT",
  severity: "error",
  message: "Revision does not match",
  source: { kind: "state", id: "deployment-01" },
  retryable: true,
  details: { expected: "3", actual: "4" },
  cause: { name: "ConflictError", message: "stale revision", code: "SQLITE_BUSY" },
  observedAt: "2026-07-23T12:00:01.000Z",
} satisfies RuntimeDiagnostic;

const validExecutionResult = {
  taskId: validExecutionRequest.taskId,
  attemptId: validExecutionRequest.attemptId,
  status: "succeeded",
  output: { message: "hello" },
  executor: {
    kind: "thread",
    metadata: { threadId: 7 },
  },
  startedAt: "2026-07-23T12:00:00.000Z",
  completedAt: "2026-07-23T12:00:01.000Z",
} satisfies ExecutionResult;

function roundTrip<T>(value: unknown, parse: (input: unknown) => T): T {
  const wireValue = serializeWireValue(value);
  const decoded = JSON.parse(JSON.stringify(wireValue)) as JsonValue;
  return parse(decoded);
}

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

test("plugin permission contracts are structured and empty arrays remain valid", () => {
  assert.deepEqual(parsePluginManifest(validManifest), validManifest);
  assert.deepEqual(parsePluginManifest({ ...validManifest, permissions: [] }).permissions, []);
  assert.deepEqual(
    parsePluginDeployment({ ...validDeployment, permissionGrants: [] }).permissionGrants,
    [],
  );
  assert.throws(
    () => parsePluginManifest({ ...validManifest, permissions: ["network:*"] }),
    (error: unknown) => diagnosticCode(error) === "ARTIFACT_MANIFEST_INVALID",
  );
  assert.throws(
    () => parsePluginDeployment({ ...validDeployment, permissionGrants: ["network:*"] }),
    (error: unknown) => diagnosticCode(error) === "DEPLOYMENT_RECORD_INVALID",
  );
  assert.throws(
    () =>
      parsePluginManifest({
        ...validManifest,
        permissions: [{ kind: "filesystem", roots: [{ path: "/data folder", access: ["read"] }] }],
      }),
    (error: unknown) => diagnosticCode(error) === "ARTIFACT_MANIFEST_INVALID",
  );
  for (const path of ["/.", "/../etc", "/data/../etc"]) {
    assert.throws(
      () =>
        parsePluginManifest({
          ...validManifest,
          permissions: [{ kind: "filesystem", roots: [{ path, access: ["read"] }] }],
        }),
      (error: unknown) => diagnosticCode(error) === "ARTIFACT_MANIFEST_INVALID",
      path,
    );
  }
});

test("execution request validation preserves JsonValue payloads", () => {
  assert.deepEqual(parseExecutionRequest(validExecutionRequest), validExecutionRequest);
  assert.throws(
    () => parseExecutionRequest({ ...validExecutionRequest, input: undefined }),
    (error: unknown) => diagnosticCode(error) === "EXECUTOR_REQUEST_INVALID",
  );
});

test("execution binding canonicalization is deterministic and target-bound", () => {
  const content = {
    configuration: { secret: "never-log-this", nested: { enabled: true } },
    permissionGrants: [
      { kind: "secret" as const, names: ["zeta", "alpha"] },
      { kind: "executor" as const, executors: ["thread" as const, "process" as const] },
    ],
    capabilityDefinitions: [],
    capabilityBindings: [],
  };
  const reordered = createExecutionBinding(validExecutionIdentity, {
    ...content,
    permissionGrants: [
      { kind: "executor", executors: ["process", "thread"] },
      { kind: "secret", names: ["alpha", "zeta"] },
    ],
  });
  const canonical = createExecutionBinding(validExecutionIdentity, content);
  assert.deepEqual(reordered, canonical);

  const nextTarget = {
    ...validExecutionTarget,
    deploymentGeneration: parseGeneration("2"),
  };
  assert.throws(
    () =>
      parseExecutionRequest({
        ...validExecutionRequest,
        target: nextTarget,
        binding: canonical,
      }),
    (error: unknown) => {
      assert.equal(diagnosticCode(error), "PROTOCOL_EXECUTION_BINDING_INVALID");
      assert.doesNotMatch(JSON.stringify(error), /never-log-this/u);
      return true;
    },
  );
});

test("task execution targets share one strict persisted and wire contract", () => {
  assert.deepEqual(
    parseTaskExecutionTarget(validExecutionRequest.target),
    validExecutionRequest.target,
  );
  assert.throws(
    () =>
      parseExecutionRequest({
        ...validExecutionRequest,
        target: {
          ...validExecutionRequest.target,
          executor: {
            ...validExecutionRequest.target.executor,
            workerId: "worker-01",
          },
        },
      }),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_EXECUTION_TARGET_INVALID",
  );
  assert.throws(
    () =>
      parseExecutionRequest({
        ...validExecutionRequest,
        target: {
          ...validExecutionRequest.target,
          executor: { id: "remote-01", type: "remote" },
        },
      }),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_EXECUTION_TARGET_INVALID",
  );
  assert.throws(
    () =>
      parseTaskExecutionTarget({
        ...validExecutionRequest.target,
        instanceId: "x".repeat(129),
      }),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_IDENTITY_INVALID",
  );
});

test("executor identifiers use one bounded wire-safe parser", () => {
  const executorId = "node-01:thread/worker:process";
  const target = {
    ...validExecutionRequest.target,
    executor: { ...validExecutionRequest.target.executor, id: executorId },
  };

  assert.equal(parseExecutorId(executorId), executorId);
  assert.equal(
    parseExecutionRequest({
      ...validExecutionRequest,
      target,
      binding: createExecutionBinding(
        { ...validExecutionIdentity, target },
        validExecutionRequest.binding,
      ),
    }).target.executor.id,
    executorId,
  );
  for (const invalid of [
    "",
    "/absolute",
    "trailing/",
    "node/../process",
    "node process",
    `node-${"x".repeat(124)}`,
  ]) {
    assert.throws(() => parseExecutorId(invalid), { name: "DiagnosticError" });
  }
});

test("executor identifiers preserve legacy trailing delimiters in recovered task records", () => {
  for (const executorId of ["legacy.", "legacy_", "legacy-"]) {
    const target = {
      ...validExecutionRequest.target,
      executor: { ...validExecutionRequest.target.executor, id: executorId },
    };
    const record = parseTaskRecord({
      taskId: validExecutionRequest.taskId,
      attemptId: validExecutionRequest.attemptId,
      request: {
        applicationId: validExecutionRequest.applicationId,
        pluginId: validExecutionRequest.pluginId,
        componentId: validExecutionRequest.componentId,
        input: validExecutionRequest.input,
        deadline: validExecutionRequest.deadline,
        orphanPolicy: validExecutionRequest.orphanPolicy,
      },
      state: "accepted",
      createdAt: validExecutionRequest.deadline,
      updatedAt: validExecutionRequest.deadline,
      target,
      executor: { id: executorId, type: "process" },
    });

    assert.equal(record.target?.executor.id, executorId);
    assert.equal(record.executor?.id, executorId);
  }
});

test("deployment generations are bounded to uint64", () => {
  assert.equal(parseGeneration("18446744073709551615"), "18446744073709551615");
  assert.throws(() => parseGeneration("18446744073709551616"), {
    name: "DiagnosticError",
  });
  assert.throws(
    () =>
      parseExecutionRequest({
        ...validExecutionRequest,
        target: {
          ...validExecutionRequest.target,
          deploymentGeneration: "18446744073709551616",
        },
      }),
    { name: "DiagnosticError" },
  );
});

test("task records reject inconsistent target and legacy executor bindings", () => {
  const base = {
    taskId: validExecutionRequest.taskId,
    attemptId: validExecutionRequest.attemptId,
    request: {
      applicationId: validExecutionRequest.applicationId,
      pluginId: validExecutionRequest.pluginId,
      componentId: validExecutionRequest.componentId,
      input: validExecutionRequest.input,
      deadline: validExecutionRequest.deadline,
      orphanPolicy: validExecutionRequest.orphanPolicy,
    },
    state: "accepted",
    createdAt: validExecutionRequest.deadline,
    updatedAt: validExecutionRequest.deadline,
    target: validExecutionRequest.target,
  } as const;

  assert.deepEqual(
    parseTaskRecord({
      ...base,
      executor: {
        id: validExecutionRequest.target.executor.id,
        type: validExecutionRequest.target.executor.type,
      },
    }).target,
    validExecutionRequest.target,
  );
  assert.throws(
    () =>
      parseTaskRecord({
        ...base,
        executor: { id: "other:process", type: "process" },
      }),
    /legacy executor/u,
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

test("worker envelope correlation is mandatory and preserves uint64 sequences", () => {
  const { correlationId: _correlationId, ...withoutCorrelation } = validWorkerEnvelope;
  assert.throws(
    () => parseWorkerEnvelope(withoutCorrelation),
    (error: unknown) => diagnosticCode(error) === "WORKER_ENVELOPE_INVALID",
  );

  const maximumSequenceEnvelope = {
    ...validWorkerEnvelope,
    sequence: parseSequence("18446744073709551615"),
    correlationId: parseMessageId("correlation-maximum-sequence"),
  };
  assert.deepEqual(parseWorkerEnvelope(maximumSequenceEnvelope), maximumSequenceEnvelope);
});

test("the public Worker envelope owns handshake and binary wire metadata", () => {
  const authentication = {
    ...validWorkerEnvelope,
    type: "authenticate",
    payload: { proof: "proof" },
  } satisfies WorkerEnvelope;
  assert.deepEqual(parseWorkerEnvelope(authentication), authentication);

  const binary = {
    ...validWorkerEnvelope,
    type: "session.reconcile",
    payload: { running: [] },
    binaryBytes: 128,
    binaryChunks: 2,
  } satisfies WorkerEnvelope;
  assert.deepEqual(parseWorkerEnvelope(binary), binary);
  assert.throws(
    () => parseWorkerEnvelope({ ...binary, binaryChunks: undefined }),
    (error: unknown) => diagnosticCode(error) === "WORKER_ENVELOPE_INVALID",
  );
  assert.throws(
    () => parseWorkerEnvelope({ ...binary, type: "not.a.worker.message" }),
    (error: unknown) => diagnosticCode(error) === "WORKER_ENVELOPE_INVALID",
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

test("every exported public wire contract survives serialization and validating reconstruction", () => {
  assert.deepEqual(
    roundTrip(validRuntimeConfiguration, parseRuntimeConfiguration),
    validRuntimeConfiguration,
  );
  assert.deepEqual(roundTrip(validDriverHealth, parseDriverHealth), validDriverHealth);
  assert.deepEqual(roundTrip(validLeadership, parseLeadership), validLeadership);
  assert.deepEqual(roundTrip(validRuntimeStatus, parseRuntimeStatus), validRuntimeStatus);
  assert.deepEqual(roundTrip(validRuntimeEvent, parseRuntimeEvent), validRuntimeEvent);
  assert.deepEqual(roundTrip(validManifest, parsePluginManifest), validManifest);
  assert.deepEqual(roundTrip(validInstallation, parsePluginInstallation), validInstallation);
  assert.deepEqual(roundTrip(validDeployment, parsePluginDeployment), validDeployment);
  assert.deepEqual(
    roundTrip(validCapabilityIdentity, parseCapabilityIdentity),
    validCapabilityIdentity,
  );
  assert.deepEqual(
    roundTrip(validCapabilityDefinition, parseCapabilityDefinition),
    validCapabilityDefinition,
  );
  assert.deepEqual(
    roundTrip(validCapabilityBinding, parseCapabilityBinding),
    validCapabilityBinding,
  );
  assert.deepEqual(roundTrip(validExecutionRequest, parseExecutionRequest), validExecutionRequest);
  assert.deepEqual(roundTrip(validExecutionResult, parseExecutionResult), validExecutionResult);
  assert.deepEqual(roundTrip(validWorkerEnvelope, parseWorkerEnvelope), validWorkerEnvelope);
  assert.deepEqual(roundTrip(validDiagnostic, parseRuntimeDiagnostic), validDiagnostic);
});

test("indeterminate execution is a non-retryable terminal observation", () => {
  const { output: _output, ...base } = validExecutionResult;
  const indeterminate = {
    ...base,
    status: "indeterminate",
    diagnostic: {
      ...validDiagnostic,
      retryable: false,
    },
  };

  assert.deepEqual(roundTrip(indeterminate, parseExecutionResult), indeterminate);

  for (const invalid of [
    { ...base, status: "indeterminate" },
    {
      ...base,
      status: "indeterminate",
      diagnostic: validDiagnostic,
    },
    {
      ...base,
      status: "indeterminate",
      output: { message: "unproven" },
      diagnostic: { ...validDiagnostic, retryable: false },
    },
  ]) {
    assert.throws(
      () => parseExecutionResult(invalid),
      (error: unknown) => diagnosticCode(error) === "EXECUTOR_RESULT_INVALID",
    );
  }
});

test("runtime boundary validators reject malformed health, authority, status, and events", () => {
  for (const [value, parse, code] of [
    [{ status: "unknown", checkedAt: 1n }, parseDriverHealth, "PROTOCOL_DRIVER_HEALTH_INVALID"],
    [{ resource: "", epoch: "not-decimal" }, parseLeadership, "COORDINATION_LEADERSHIP_INVALID"],
    [
      { ...validRuntimeStatus, readiness: 1n },
      parseRuntimeStatus,
      "PROTOCOL_RUNTIME_STATUS_INVALID",
    ],
    [{ ...validRuntimeEvent, occurredAt: 1n }, parseRuntimeEvent, "PROTOCOL_RUNTIME_EVENT_INVALID"],
  ] as const) {
    assert.throws(
      () => parse(value),
      (error: unknown) => diagnosticCode(error) === code,
    );
  }
});

test("JSON-bearing contract fields reject non-JSON values recursively", () => {
  assert.throws(
    () => parsePluginManifest({ ...validManifest, metadata: { nested: { revision: 1n } } }),
    (error: unknown) => diagnosticCode(error) === "ARTIFACT_MANIFEST_INVALID",
  );
  assert.throws(
    () =>
      parseExecutionRequest({
        ...validExecutionRequest,
        input: { nested: [{ revision: 1n }] },
      }),
    (error: unknown) => diagnosticCode(error) === "EXECUTOR_REQUEST_INVALID",
  );
  assert.throws(
    () => parseWorkerEnvelope({ ...validWorkerEnvelope, payload: { revision: 1n } }),
    (error: unknown) => diagnosticCode(error) === "WORKER_ENVELOPE_INVALID",
  );
});

test("execution request validation rejects accessor-backed arrays without invoking getters", () => {
  let getterInvoked = false;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterInvoked = true;
      return "must-not-run";
    },
  });
  accessorArray.length = 1;

  let validationError: unknown;
  try {
    parseExecutionRequest({ ...validExecutionRequest, input: accessorArray });
  } catch (error) {
    validationError = error;
  }

  assert.equal(getterInvoked, false);
  assert.equal(diagnosticCode(validationError), "EXECUTOR_REQUEST_INVALID");
});

test("WorkerEnvelope payloads are statically constrained to JsonValue", () => {
  // @ts-expect-error bigint is not a valid wire payload
  const invalidEnvelope = null as unknown as WorkerEnvelope<{ revision: bigint }>;
  assert.equal(invalidEnvelope, null);
});

test("serializeWireValue preserves an own __proto__ property without prototype pollution", () => {
  const input: Record<string, unknown> = {};
  Object.defineProperty(input, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { polluted: true },
    writable: true,
  });

  const serialized = serializeWireValue(input);

  assert.equal(Object.getPrototypeOf(serialized), Object.prototype);
  assert.equal(Object.hasOwn(serialized as object, "__proto__"), true);
  assert.equal((Object.prototype as { polluted?: boolean }).polluted, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(serialized)), {
    ["__proto__"]: { polluted: true },
  });
});

test("serializeWireValue rejects sparse and extended arrays", () => {
  const sparseArray = new Array(1);
  const extendedArray: unknown[] & { extra?: boolean } = ["value"];
  extendedArray.extra = true;

  assert.throws(
    () => serializeWireValue(sparseArray),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_WIRE_VALUE_INVALID",
  );
  assert.throws(
    () => serializeWireValue(extendedArray),
    (error: unknown) => diagnosticCode(error) === "PROTOCOL_WIRE_VALUE_INVALID",
  );
});
