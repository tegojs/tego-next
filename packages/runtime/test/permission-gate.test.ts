import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCapabilityName, type CapabilityDefinition, type Permission } from "@tegojs/contracts";
import {
  gateCapabilityRequest,
  gateCapabilityResponse,
  gatePermission,
  validatePermissionGrant,
} from "../src/index.js";

const requested = [
  {
    kind: "capability",
    capabilities: [{ name: "org.example.echo", methods: ["write", "read", "read"] }],
  },
  { kind: "executor", executors: ["thread", "process", "thread"] },
  {
    kind: "network",
    hosts: ["EXAMPLE.com.", "xn--bcher-kva.example"],
    ports: [443, 80, 443],
    methods: ["POST", "GET", "GET"],
  },
  {
    kind: "filesystem",
    roots: [
      { path: "/data/reports", access: ["write", "read"] },
      { path: "/data", access: ["read"] },
    ],
  },
  { kind: "secret", names: ["api_key", "signing-key", "api_key"] },
  { kind: "environment", names: ["TEGO_MODE", "LANG", "LANG"] },
  {
    kind: "worker",
    labels: { zone: "edge-a", accelerator: "gpu" },
    resources: { cpuMillis: 2_000, memoryBytes: 1_073_741_824, storageBytes: 10_000_000 },
  },
] satisfies readonly Permission[];

const granted = [
  {
    kind: "capability",
    capabilities: [{ name: "org.example.echo", methods: ["read"] }],
  },
  { kind: "executor", executors: ["process"] },
  { kind: "network", hosts: ["example.com"], ports: [443], methods: ["GET"] },
  {
    kind: "filesystem",
    roots: [{ path: "/data/reports/daily", access: ["read"] }],
  },
  { kind: "secret", names: ["api_key"] },
  { kind: "environment", names: ["LANG"] },
  {
    kind: "worker",
    labels: { accelerator: "gpu", zone: "edge-a" },
    resources: { cpuMillis: 1_000, memoryBytes: 536_870_912, storageBytes: 1_000_000 },
  },
] satisfies readonly Permission[];

test("@spec:plugin-deployment/pre-execution-deployment-gate/granted-permissions-exceed-request", () => {
  const allowed = validatePermissionGrant(requested, granted);
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.diagnostics, []);
  assert.deepEqual(allowed.granted, [
    {
      kind: "capability",
      capabilities: [{ name: "org.example.echo", methods: ["read"] }],
    },
    { kind: "environment", names: ["LANG"] },
    { kind: "executor", executors: ["process"] },
    {
      kind: "filesystem",
      roots: [{ path: "/data/reports/daily", access: ["read"] }],
    },
    { kind: "network", hosts: ["example.com"], methods: ["GET"], ports: [443] },
    { kind: "secret", names: ["api_key"] },
    {
      kind: "worker",
      labels: { accelerator: "gpu", zone: "edge-a" },
      resources: { cpuMillis: 1_000, memoryBytes: 536_870_912, storageBytes: 1_000_000 },
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(allowed)), allowed);

  for (const wider of [
    [{ kind: "network", hosts: ["evil.example"], ports: [443], methods: ["GET"] }],
    [{ kind: "filesystem", roots: [{ path: "/database", access: ["read"] }] }],
    [{ kind: "executor", executors: ["remote"] }],
    [{ kind: "secret", names: ["other"] }],
    [{ kind: "environment", names: ["NODE_OPTIONS"] }],
    [
      {
        kind: "worker",
        labels: { accelerator: "gpu", zone: "edge-b" },
        resources: { cpuMillis: 1_000, memoryBytes: 1, storageBytes: 1 },
      },
    ],
    [
      {
        kind: "worker",
        labels: { accelerator: "gpu", zone: "edge-a" },
        resources: { cpuMillis: 2_001, memoryBytes: 1, storageBytes: 1 },
      },
    ],
  ] as const) {
    const decision = validatePermissionGrant(requested, wider);
    assert.equal(decision.allowed, false);
    assert.equal(decision.diagnostics[0]?.code, "PERMISSION_GRANT_EXCEEDS_REQUEST");
  }
});

test("permission inputs reject duplicate entries and invalid canonical forms", () => {
  for (const invalid of [
    [
      { kind: "executor", executors: ["process"] },
      { kind: "executor", executors: ["thread"] },
    ],
    [{ kind: "network", hosts: ["*.example.com"], ports: [443], methods: ["GET"] }],
    [{ kind: "network", hosts: ["bad host"], ports: [443], methods: ["GET"] }],
    [{ kind: "network", hosts: ["example.com"], ports: [0], methods: ["GET"] }],
    [{ kind: "network", hosts: ["example.com"], ports: [443], methods: ["TRACE"] }],
    [{ kind: "filesystem", roots: [{ path: "/data/../etc", access: ["read"] }] }],
    [{ kind: "filesystem", roots: [{ path: "C:\\data", access: ["read"] }] }],
    [{ kind: "secret", names: ["../secret"] }],
    [{ kind: "environment", names: ["NODE-OPTIONS"] }],
    [
      {
        kind: "worker",
        labels: { zone: "edge-a" },
        resources: { cpuMillis: Number.NaN, memoryBytes: 1, storageBytes: 1 },
      },
    ],
  ]) {
    const decision = validatePermissionGrant(invalid as readonly Permission[], []);
    assert.equal(decision.allowed, false);
    assert.equal(decision.diagnostics[0]?.code, "PERMISSION_ENVELOPE_INVALID");
  }
});

test("permission canonicalization treats case and IDNA equivalents without widening grants", () => {
  const decision = validatePermissionGrant(
    [
      {
        kind: "network",
        hosts: ["bücher.example"],
        ports: [443],
        methods: ["GET"],
      },
    ],
    [
      {
        kind: "network",
        hosts: ["XN--BCHER-KVA.EXAMPLE."],
        ports: [443],
        methods: ["get"],
      },
    ],
  );
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.granted, [
    {
      kind: "network",
      hosts: ["xn--bcher-kva.example"],
      methods: ["GET"],
      ports: [443],
    },
  ]);
});

test("permission call gates enforce all seven boundaries without prefix broadening", () => {
  const valid = validatePermissionGrant(requested, granted);
  assert.equal(valid.allowed, true);
  assert.ok(valid.granted);

  const calls = [
    [{ kind: "capability", name: "org.example.echo", method: "read" }, true],
    [{ kind: "capability", name: "org.example.echo", method: "write" }, false],
    [{ kind: "executor", executor: "process" }, true],
    [{ kind: "executor", executor: "thread" }, false],
    [{ kind: "network", host: "EXAMPLE.COM.", port: 443, method: "get" }, true],
    [{ kind: "network", host: "evil.example", port: 443, method: "GET" }, false],
    [{ kind: "filesystem", path: "/data/reports/daily/a.txt", access: "read" }, true],
    [{ kind: "filesystem", path: "/data/reports/dailyish/a.txt", access: "read" }, false],
    [{ kind: "filesystem", path: "/data/reports/daily/a.txt", access: "write" }, false],
    [{ kind: "secret", name: "api_key" }, true],
    [{ kind: "secret", name: "signing-key" }, false],
    [{ kind: "environment", name: "LANG" }, true],
    [{ kind: "environment", name: "TEGO_MODE" }, false],
    [
      {
        kind: "worker",
        labels: { zone: "edge-a", accelerator: "gpu" },
        resources: { cpuMillis: 900, memoryBytes: 500_000_000, storageBytes: 500_000 },
      },
      true,
    ],
    [
      {
        kind: "worker",
        labels: { zone: "edge-a", accelerator: "gpu", extra: "not-granted" },
        resources: { cpuMillis: 900, memoryBytes: 500_000_000, storageBytes: 500_000 },
      },
      false,
    ],
  ] as const;

  for (const [attempt, expected] of calls) {
    assert.equal(gatePermission(valid.granted, attempt).allowed, expected, JSON.stringify(attempt));
  }
});

test("capability request and response payload gates return structured diagnostics", () => {
  const definition = {
    identity: {
      name: parseCapabilityName("org.example.echo"),
      protocolVersion: "1.0.0",
    },
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

  assert.deepEqual(gateCapabilityRequest(definition, { message: "hello" }), {
    allowed: true,
    diagnostics: [],
    value: { message: "hello" },
  });
  assert.equal(gateCapabilityRequest(definition, { message: 7 }).allowed, false);
  assert.equal(gateCapabilityResponse(definition, { echo: "hello" }).allowed, true);
  const invalid = gateCapabilityResponse(definition, { echo: 7 });
  assert.equal(invalid.allowed, false);
  assert.equal(invalid.diagnostics[0]?.code, "CAPABILITY_RESPONSE_INVALID");

  const badSchema = {
    ...definition,
    requestSchema: { type: "unknown-json-schema-type" },
  } as unknown as CapabilityDefinition;
  assert.equal(
    gateCapabilityRequest(badSchema, { message: "hello" }).diagnostics[0]?.code,
    "CAPABILITY_SCHEMA_INVALID",
  );
});

test("payload gates reject accessors and exotic prototypes without invoking user code", () => {
  const definition = {
    identity: {
      name: parseCapabilityName("org.example.echo"),
      protocolVersion: "1.0.0",
    },
    requestSchema: true,
    responseSchema: true,
  } satisfies CapabilityDefinition;

  let invoked = false;
  const accessor = {};
  Object.defineProperty(accessor, "message", {
    enumerable: true,
    get() {
      invoked = true;
      return "unsafe";
    },
  });

  assert.equal(gateCapabilityRequest(definition, accessor).allowed, false);
  assert.equal(invoked, false);
  assert.equal(gateCapabilityRequest(definition, new (class Payload {})()).allowed, false);

  const polluted = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}');
  const result = gateCapabilityRequest(definition, polluted);
  assert.equal(result.allowed, true);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("permission call gates reject accessors without invoking user code", () => {
  let invoked = false;
  const attempt = { kind: "network", host: "example.com", port: 443 };
  Object.defineProperty(attempt, "method", {
    enumerable: true,
    get() {
      invoked = true;
      return "GET";
    },
  });

  const result = gatePermission(granted, attempt as never);
  assert.equal(result.allowed, false);
  assert.equal(result.diagnostics[0]?.code, "PERMISSION_ENVELOPE_INVALID");
  assert.equal(invoked, false);
});
