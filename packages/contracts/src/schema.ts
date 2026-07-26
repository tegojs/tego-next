import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { CapabilityBinding, CapabilityDefinition, CapabilityIdentity } from "./capability.js";
import {
  type DiagnosticCode,
  DiagnosticError,
  type DiagnosticSource,
  type RuntimeDiagnostic,
  runtimeDiagnostic,
} from "./diagnostic.js";
import {
  type ExecutionRequest,
  type ExecutionResult,
  parseTaskExecutionTarget,
} from "./execution.js";
import type { Leadership } from "./drivers.js";
import { type JsonObject, type JsonValue, serializeWireValue } from "./json.js";
import type { PluginDeployment, PluginInstallation, PluginManifest } from "./plugin.js";
import type { Permission } from "./permission.js";
import type { RuntimeConfiguration, RuntimeEvent, RuntimeStatus } from "./runtime.js";
import type { DriverHealth } from "./state.js";
import type { WorkerEnvelope } from "./worker.js";

export type JsonSchema = boolean | JsonObject;

export interface SchemaIssue {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: JsonObject;
  readonly schemaPath: string;
}

const IDENTITY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const EXECUTOR_ID_PATTERN =
  "^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,126}[A-Za-z0-9._-])?$";
const DECIMAL_PATTERN = "^(?:0|[1-9]\\d*)$";
const SEMVER_PATTERN =
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$";
const DIAGNOSTIC_CODE_PATTERN =
  "^(?:BOOTSTRAP|ARTIFACT|DEPLOYMENT|CAPABILITY|PERMISSION|LIFECYCLE|EXECUTOR|WORKER|COORDINATION|STATE|PROTOCOL)_.+$";
const JSON_VALUE_SCHEMA_ID = "https://tegojs.dev/schemas/json-value.json";
const DIAGNOSTIC_SCHEMA_ID = "https://tegojs.dev/schemas/runtime-diagnostic-1.0.json";
const PLUGIN_MANIFEST_SCHEMA_ID = "https://tegojs.dev/schemas/plugin-manifest-1.0.json";
const CAPABILITY_IDENTITY_SCHEMA_ID = "https://tegojs.dev/schemas/capability-identity-1.0.json";
const PERMISSION_SET_SCHEMA_ID = "https://tegojs.dev/schemas/permission-set-1.0.json";
const PORTABLE_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const ENVIRONMENT_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]{0,127}$";
const LOGICAL_ROOT_PATTERN =
  "^/(?!(?:\\.{1,2})(?:/|$))(?!.*\\/(?:\\.{1,2})(?:/|$))(?:[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)?$";

function isJsonValue(input: unknown, ancestors = new Set<object>()): boolean {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return true;
  }
  if (typeof input !== "object" || ancestors.has(input)) {
    return false;
  }

  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor) ||
          !isJsonValue(descriptor.value, ancestors)
        ) {
          return false;
        }
      }
      return Reflect.ownKeys(input).every(
        (key) =>
          key === "length" ||
          (typeof key === "string" && /^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < input.length),
      );
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isJsonValue(descriptor.value, ancestors)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    ancestors.delete(input);
  }
}

const jsonValueSchema = {
  $id: JSON_VALUE_SCHEMA_ID,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  tegoJsonValue: true,
} as const;

const jsonObjectSchema = {
  type: "object",
  tegoJsonValue: true,
  additionalProperties: { $ref: JSON_VALUE_SCHEMA_ID },
} as const;

const permissionSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "capabilities"],
      properties: {
        kind: { const: "capability" },
        capabilities: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "methods"],
            properties: {
              name: { type: "string", pattern: IDENTITY_PATTERN },
              methods: {
                type: "array",
                items: { type: "string", pattern: PORTABLE_NAME_PATTERN },
              },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "executors"],
      properties: {
        kind: { const: "executor" },
        executors: {
          type: "array",
          items: { enum: ["process", "remote", "thread"] },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "hosts", "ports", "methods"],
      properties: {
        kind: { const: "network" },
        hosts: { type: "array", items: { type: "string", minLength: 1 } },
        ports: {
          type: "array",
          items: { type: "integer", minimum: 1, maximum: 65_535 },
        },
        methods: {
          type: "array",
          items: {
            enum: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "roots"],
      properties: {
        kind: { const: "filesystem" },
        roots: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "access"],
            properties: {
              path: { type: "string", pattern: LOGICAL_ROOT_PATTERN },
              access: {
                type: "array",
                items: { enum: ["read", "write"] },
              },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "names"],
      properties: {
        kind: { const: "secret" },
        names: {
          type: "array",
          items: { type: "string", pattern: PORTABLE_NAME_PATTERN },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "names"],
      properties: {
        kind: { const: "environment" },
        names: {
          type: "array",
          items: { type: "string", pattern: ENVIRONMENT_NAME_PATTERN },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "labels", "resources"],
      properties: {
        kind: { const: "worker" },
        labels: {
          type: "object",
          propertyNames: { pattern: PORTABLE_NAME_PATTERN },
          additionalProperties: { type: "string", pattern: PORTABLE_NAME_PATTERN },
        },
        resources: {
          type: "object",
          additionalProperties: false,
          required: ["cpuMillis", "memoryBytes", "storageBytes"],
          properties: {
            cpuMillis: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            memoryBytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            storageBytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
      },
    },
  ],
} as const;

const permissionSetSchema = {
  $id: PERMISSION_SET_SCHEMA_ID,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "array",
  items: permissionSchema,
} as const;

const pluginManifestSchema = {
  $id: PLUGIN_MANIFEST_SCHEMA_ID,
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
      items: permissionSchema,
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
              protocolVersion: { type: "string", pattern: SEMVER_PATTERN },
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
    metadata: jsonObjectSchema,
  },
  $defs: {
    identity: { type: "string", pattern: IDENTITY_PATTERN },
  },
} as const;

const runtimeConfigurationSchema = {
  $id: "https://tegojs.dev/schemas/runtime-configuration-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["mode", "runtimeId", "applicationId", "nodeId"],
  properties: {
    mode: { enum: ["multi-main", "single-main"] },
    runtimeId: { $ref: "#/$defs/identity" },
    applicationId: { $ref: "#/$defs/identity" },
    nodeId: { $ref: "#/$defs/identity" },
  },
  $defs: {
    identity: { type: "string", pattern: IDENTITY_PATTERN },
  },
} as const;

const driverHealthSchema = {
  $id: "https://tegojs.dev/schemas/driver-health-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["status", "checkedAt"],
  properties: {
    status: { enum: ["degraded", "healthy", "unhealthy"] },
    checkedAt: { type: "string", format: "date-time" },
    message: { type: "string" },
  },
} as const;

const leadershipSchema = {
  $id: "https://tegojs.dev/schemas/leadership-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["resource", "epoch"],
  properties: {
    resource: { type: "string", minLength: 1 },
    epoch: { type: "string", pattern: DECIMAL_PATTERN },
  },
} as const;

const runtimeLifecycleStates = [
  "created",
  "opening",
  "recovering",
  "electing",
  "running",
  "draining",
  "stopping",
  "stopped",
  "failed",
] as const;

const runtimeStatusSchema = {
  $id: "https://tegojs.dev/schemas/runtime-status-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "identity",
    "mode",
    "lifecycle",
    "liveness",
    "readiness",
    "acceptingOperations",
    "drivers",
    "counts",
  ],
  properties: {
    identity: {
      type: "object",
      additionalProperties: false,
      required: ["runtimeId", "applicationId", "nodeId"],
      properties: {
        runtimeId: { type: "string", pattern: IDENTITY_PATTERN },
        applicationId: { type: "string", pattern: IDENTITY_PATTERN },
        nodeId: { type: "string", pattern: IDENTITY_PATTERN },
      },
    },
    mode: { enum: ["multi-main", "single-main"] },
    lifecycle: { enum: runtimeLifecycleStates },
    liveness: { type: "boolean" },
    readiness: { type: "boolean" },
    acceptingOperations: { type: "boolean" },
    drivers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "health"],
        properties: {
          name: { enum: ["artifacts", "coordination", "processHost", "secrets", "state"] },
          health: { $ref: driverHealthSchema.$id },
        },
      },
    },
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["deployments", "installations", "recoverableOperations", "tasks", "workers"],
      properties: {
        deployments: { type: "integer", minimum: 0 },
        installations: { type: "integer", minimum: 0 },
        recoverableOperations: { type: "integer", minimum: 0 },
        tasks: { type: "integer", minimum: 0 },
        workers: { type: "integer", minimum: 0 },
      },
    },
    authority: { $ref: leadershipSchema.$id },
  },
} as const;

const runtimeEventSchema = {
  $id: "https://tegojs.dev/schemas/runtime-event-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["type", "previous", "current", "occurredAt"],
  properties: {
    type: { const: "runtime.lifecycle" },
    previous: { enum: runtimeLifecycleStates },
    current: { enum: runtimeLifecycleStates },
    occurredAt: { type: "string", format: "date-time" },
  },
} as const;

const runtimeDiagnosticSchema = {
  $id: DIAGNOSTIC_SCHEMA_ID,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["code", "severity", "message", "source", "retryable", "observedAt"],
  properties: {
    code: { type: "string", pattern: DIAGNOSTIC_CODE_PATTERN },
    severity: { enum: ["error", "info", "warning"] },
    message: { type: "string", minLength: 1 },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: {
          enum: [
            "artifact",
            "capability",
            "coordination",
            "deployment",
            "executor",
            "plugin",
            "protocol",
            "runtime",
            "schema",
            "state",
            "worker",
          ],
        },
        id: { type: "string", minLength: 1 },
      },
    },
    retryable: { type: "boolean" },
    details: { $ref: JSON_VALUE_SCHEMA_ID },
    cause: {
      type: "object",
      additionalProperties: false,
      required: ["name", "message"],
      properties: {
        name: { type: "string", minLength: 1 },
        message: { type: "string" },
        code: { type: "string", minLength: 1 },
        stack: { type: "string" },
      },
    },
    observedAt: { type: "string", format: "date-time" },
  },
} as const;

const pluginInstallationSchema = {
  $id: "https://tegojs.dev/schemas/plugin-installation-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["pluginId", "version", "digest", "manifest", "installedAt"],
  properties: {
    pluginId: { type: "string", pattern: IDENTITY_PATTERN },
    version: { type: "string", pattern: SEMVER_PATTERN },
    digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    manifest: { $ref: PLUGIN_MANIFEST_SCHEMA_ID },
    installedAt: { type: "string", format: "date-time" },
    signature: {
      type: "object",
      additionalProperties: false,
      required: ["algorithm", "keyId", "verified"],
      properties: {
        algorithm: { const: "Ed25519" },
        keyId: { type: "string", pattern: IDENTITY_PATTERN },
        verified: { type: "boolean" },
      },
    },
  },
} as const;

const pluginDeploymentSchema = {
  $id: "https://tegojs.dev/schemas/plugin-deployment-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "applicationId",
    "pluginId",
    "version",
    "artifactDigest",
    "generation",
    "state",
    "essential",
    "configuration",
    "permissionGrants",
    "capabilityBindings",
  ],
  properties: {
    applicationId: { type: "string", pattern: IDENTITY_PATTERN },
    pluginId: { type: "string", pattern: IDENTITY_PATTERN },
    version: { type: "string", pattern: SEMVER_PATTERN },
    artifactDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    generation: { type: "string", pattern: DECIMAL_PATTERN },
    state: { enum: ["active", "disabled"] },
    essential: { type: "boolean" },
    configuration: { $ref: JSON_VALUE_SCHEMA_ID },
    permissionGrants: {
      type: "array",
      items: permissionSchema,
    },
    capabilityBindings: {
      type: "object",
      tegoJsonValue: true,
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["applicationId", "pluginId"],
        properties: {
          applicationId: { type: "string", pattern: IDENTITY_PATTERN },
          pluginId: { type: "string", pattern: IDENTITY_PATTERN },
        },
      },
    },
  },
} as const;

const capabilityIdentitySchema = {
  $id: CAPABILITY_IDENTITY_SCHEMA_ID,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["name", "protocolVersion"],
  properties: {
    name: { type: "string", pattern: IDENTITY_PATTERN },
    protocolVersion: { type: "string", pattern: SEMVER_PATTERN },
  },
} as const;

const capabilityDefinitionSchema = {
  $id: "https://tegojs.dev/schemas/capability-definition-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["identity", "requestSchema", "responseSchema"],
  properties: {
    identity: { $ref: CAPABILITY_IDENTITY_SCHEMA_ID },
    requestSchema: {
      anyOf: [{ type: "boolean" }, jsonObjectSchema],
    },
    responseSchema: {
      anyOf: [{ type: "boolean" }, jsonObjectSchema],
    },
  },
} as const;

const capabilityBindingSchema = {
  $id: "https://tegojs.dev/schemas/capability-binding-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["capability", "providerDeployment"],
  properties: {
    capability: { $ref: CAPABILITY_IDENTITY_SCHEMA_ID },
    providerDeployment: {
      type: "object",
      additionalProperties: false,
      required: ["applicationId", "pluginId"],
      properties: {
        applicationId: { type: "string", pattern: IDENTITY_PATTERN },
        pluginId: { type: "string", pattern: IDENTITY_PATTERN },
      },
    },
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
    "target",
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
    target: {
      type: "object",
      additionalProperties: false,
      required: ["instanceId", "deploymentGeneration", "artifactDigest", "executor"],
      properties: {
        instanceId: { $ref: "#/$defs/identity" },
        deploymentGeneration: { type: "string", pattern: DECIMAL_PATTERN, maxLength: 20 },
        artifactDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        executor: {
          type: "object",
          additionalProperties: false,
          required: ["id", "type"],
          properties: {
            id: { type: "string", pattern: EXECUTOR_ID_PATTERN },
            type: { enum: ["process", "remote", "thread"] },
            workerId: { $ref: "#/$defs/identity" },
          },
        },
      },
    },
    applicationId: { $ref: "#/$defs/identity" },
    pluginId: { $ref: "#/$defs/identity" },
    componentId: { $ref: "#/$defs/identity" },
    input: { $ref: JSON_VALUE_SCHEMA_ID },
    deadline: { type: "string", format: "date-time" },
    orphanPolicy: { enum: ["cancel", "finish-and-buffer", "finish-and-persist"] },
  },
  $defs: {
    identity: { type: "string", pattern: IDENTITY_PATTERN },
  },
} as const;

const executionResultSchema = {
  $id: "https://tegojs.dev/schemas/execution-result-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["taskId", "attemptId", "status", "executor", "startedAt", "completedAt"],
  properties: {
    taskId: { type: "string", pattern: IDENTITY_PATTERN },
    attemptId: { type: "string", pattern: IDENTITY_PATTERN },
    status: {
      enum: ["cancelled", "failed", "indeterminate", "rejected", "succeeded", "timed-out"],
    },
    output: { $ref: JSON_VALUE_SCHEMA_ID },
    diagnostic: { $ref: DIAGNOSTIC_SCHEMA_ID },
    executor: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { enum: ["process", "remote", "thread"] },
        workerId: { type: "string", pattern: IDENTITY_PATTERN },
        metadata: jsonObjectSchema,
      },
    },
    startedAt: { type: "string", format: "date-time" },
    completedAt: { type: "string", format: "date-time" },
  },
  allOf: [
    {
      if: {
        required: ["status"],
        properties: {
          status: { const: "indeterminate" },
        },
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
      then: {
        required: ["diagnostic"],
        properties: {
          output: false,
          diagnostic: {
            allOf: [
              { $ref: DIAGNOSTIC_SCHEMA_ID },
              {
                type: "object",
                required: ["retryable"],
                properties: {
                  retryable: { const: false },
                },
              },
            ],
          },
        },
      },
    },
  ],
} as const;

const workerEnvelopeSchema = {
  $id: "https://tegojs.dev/schemas/worker-envelope-1.0.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  dependentRequired: {
    binaryBytes: ["binaryChunks"],
    binaryChunks: ["binaryBytes"],
  },
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
        "authenticate",
        "heartbeat",
        "hello",
        "session.ready",
        "session.reconcile",
        "task.acknowledge",
        "task.assign",
        "task.cancel",
        "task.result",
        "worker.register",
      ],
    },
    sentAt: { type: "string", format: "date-time" },
    payload: { $ref: JSON_VALUE_SCHEMA_ID },
    binaryBytes: { type: "integer", minimum: 0 },
    binaryChunks: { type: "integer", minimum: 1 },
  },
  $defs: {
    identity: { type: "string", pattern: IDENTITY_PATTERN },
  },
} as const;

function createAjv(): InstanceType<typeof Ajv2020Module.default> {
  const instance = new Ajv2020Module.default({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  addFormatsModule.default(instance);
  instance.addKeyword({
    keyword: "tegoJsonValue",
    schemaType: "boolean",
    errors: false,
    validate: (enabled: boolean, data: unknown) => !enabled || isJsonValue(data),
  });
  return instance;
}

const ajv = createAjv();

const validateJsonValue = ajv.compile(jsonValueSchema);
const validateRuntimeConfiguration = ajv.compile(runtimeConfigurationSchema);
const validateDriverHealth = ajv.compile(driverHealthSchema);
const validateLeadership = ajv.compile(leadershipSchema);
const validateRuntimeStatus = ajv.compile(runtimeStatusSchema);
const validateRuntimeEvent = ajv.compile(runtimeEventSchema);
const validateRuntimeDiagnostic = ajv.compile(runtimeDiagnosticSchema);
const validatePermissionSet = ajv.compile(permissionSetSchema);
const validatePluginManifest = ajv.compile(pluginManifestSchema);
const validatePluginInstallation = ajv.compile(pluginInstallationSchema);
const validatePluginDeployment = ajv.compile(pluginDeploymentSchema);
const validateCapabilityIdentity = ajv.compile(capabilityIdentitySchema);
const validateCapabilityDefinition = ajv.compile(capabilityDefinitionSchema);
const validateCapabilityBinding = ajv.compile(capabilityBindingSchema);
const validateExecutionRequest = ajv.compile(executionRequestSchema);
const validateExecutionResult = ajv.compile(executionResultSchema);
const validateWorkerEnvelope = ajv.compile(workerEnvelopeSchema);
const schemaCache = new WeakMap<JsonObject, ValidateFunction>();

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
  if (!validateJsonValue(input)) {
    throw validationError(code, message, source, validateJsonValue.errors);
  }
  if (!validate(input)) {
    throw validationError(code, message, source, validate.errors);
  }
  return input as T;
}

function field(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
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

export function parseRuntimeConfiguration(input: unknown): RuntimeConfiguration {
  return parseWithValidator(
    validateRuntimeConfiguration,
    input,
    "BOOTSTRAP_CONFIGURATION_INVALID",
    "Runtime configuration is invalid",
    { kind: "runtime", id: "configuration" },
  );
}

export function parseDriverHealth(input: unknown): DriverHealth {
  return parseWithValidator(
    validateDriverHealth,
    input,
    "PROTOCOL_DRIVER_HEALTH_INVALID",
    "Driver health is invalid",
    { kind: "protocol", id: "driver-health" },
  );
}

export function parseLeadership(input: unknown): Leadership {
  return parseWithValidator(
    validateLeadership,
    input,
    "COORDINATION_LEADERSHIP_INVALID",
    "Coordination leadership is invalid",
    { kind: "coordination", id: "leadership" },
  );
}

export function parseRuntimeStatus(input: unknown): RuntimeStatus {
  return parseWithValidator(
    validateRuntimeStatus,
    input,
    "PROTOCOL_RUNTIME_STATUS_INVALID",
    "Runtime status is invalid",
    { kind: "protocol", id: "runtime-status" },
  );
}

export function parseRuntimeEvent(input: unknown): RuntimeEvent {
  return parseWithValidator(
    validateRuntimeEvent,
    input,
    "PROTOCOL_RUNTIME_EVENT_INVALID",
    "Runtime event is invalid",
    { kind: "protocol", id: "runtime-event" },
  );
}

export function parseRuntimeDiagnostic(input: unknown): RuntimeDiagnostic {
  return parseWithValidator(
    validateRuntimeDiagnostic,
    input,
    "PROTOCOL_DIAGNOSTIC_INVALID",
    "Runtime diagnostic is invalid",
    { kind: "protocol", id: "diagnostic" },
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

export function parsePermissionSet(input: unknown): readonly Permission[] {
  return parseWithValidator(
    validatePermissionSet,
    input,
    "PERMISSION_ENVELOPE_INVALID",
    "Permission envelope is invalid",
    { kind: "deployment", id: "permissions" },
  );
}

export function parsePluginInstallation(input: unknown): PluginInstallation {
  return parseWithValidator(
    validatePluginInstallation,
    input,
    "ARTIFACT_INSTALLATION_INVALID",
    "Plugin installation is invalid",
    { kind: "artifact", id: "installation" },
  );
}

export function parsePluginDeployment(input: unknown): PluginDeployment {
  return parseWithValidator(
    validatePluginDeployment,
    input,
    "DEPLOYMENT_RECORD_INVALID",
    "Plugin deployment is invalid",
    { kind: "deployment", id: "desired-state" },
  );
}

export function parseCapabilityIdentity(input: unknown): CapabilityIdentity {
  return parseWithValidator(
    validateCapabilityIdentity,
    input,
    "CAPABILITY_IDENTITY_INVALID",
    "Capability identity is invalid",
    { kind: "capability", id: "identity" },
  );
}

export function parseCapabilityDefinition(input: unknown): CapabilityDefinition {
  return parseWithValidator(
    validateCapabilityDefinition,
    input,
    "CAPABILITY_DEFINITION_INVALID",
    "Capability definition is invalid",
    { kind: "capability", id: "definition" },
  );
}

export function parseCapabilityBinding(input: unknown): CapabilityBinding {
  return parseWithValidator(
    validateCapabilityBinding,
    input,
    "CAPABILITY_BINDING_INVALID",
    "Capability binding is invalid",
    { kind: "capability", id: "binding" },
  );
}

export function parseExecutionRequest(input: unknown): ExecutionRequest {
  const parsed = parseWithValidator<ExecutionRequest>(
    validateExecutionRequest,
    input,
    "EXECUTOR_REQUEST_INVALID",
    "Execution request is invalid",
    { kind: "executor", id: "request" },
  );
  parseTaskExecutionTarget(parsed.target);
  return parsed;
}

export function parseExecutionResult(input: unknown): ExecutionResult {
  return parseWithValidator(
    validateExecutionResult,
    input,
    "EXECUTOR_RESULT_INVALID",
    "Execution result is invalid",
    { kind: "executor", id: "result" },
  );
}

export function parseWorkerEnvelope<T extends JsonValue = JsonValue>(
  input: unknown,
): WorkerEnvelope<T> {
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

function compileCachedSchema(schema: JsonSchema): ValidateFunction {
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
  const validate = compileCachedSchema(schema);
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

export interface SchemaValidator<T = JsonValue> {
  parse(input: unknown): T;
}

export function compileSchemaValidator<T = JsonValue>(schema: JsonSchema): SchemaValidator<T> {
  if (!validateJsonValue(schema)) {
    throw validationError(
      "PROTOCOL_SCHEMA_INVALID",
      "JSON Schema is not safe JSON data",
      { kind: "schema" },
      validateJsonValue.errors,
    );
  }
  let validate: ValidateFunction;
  try {
    validate = createAjv().compile(schema);
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
  return {
    parse(input: unknown): T {
      if (!validateJsonValue(input)) {
        throw validationError(
          "PROTOCOL_SCHEMA_VALIDATION_FAILED",
          "Value does not satisfy the JSON Schema",
          { kind: "schema" },
          validateJsonValue.errors,
        );
      }
      if (!validate(input)) {
        throw validationError(
          "PROTOCOL_SCHEMA_VALIDATION_FAILED",
          "Value does not satisfy the JSON Schema",
          { kind: "schema" },
          validate.errors,
        );
      }
      return input as T;
    },
  };
}
