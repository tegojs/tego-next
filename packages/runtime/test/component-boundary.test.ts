import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCapabilityName,
  type CapabilityDefinition,
  type ComponentCapabilityBoundary,
  type ComponentPermissionBoundary,
  type JsonValue,
  type Permission,
} from "@tegojs/contracts";
import { createComponentBoundaries } from "../src/index.js";

const definition = {
  identity: {
    name: parseCapabilityName("org.example.echo"),
    protocolVersion: "1.0.0",
  },
  methods: ["echo"],
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

const requested = [
  {
    kind: "capability",
    capabilities: [{ name: "org.example.echo", methods: ["echo"] }],
  },
] satisfies readonly Permission[];

test("component boundaries adapt the Task 7 registry and permission gates without executor coupling", async () => {
  let invokes = 0;
  const boundaries = createComponentBoundaries({
    invoke: async (request: { readonly input: JsonValue }) => {
      invokes += 1;
      return { echo: (request.input as { readonly message: string }).message };
    },
  });
  const permission: ComponentPermissionBoundary = boundaries.permission;
  const capability: ComponentCapabilityBoundary = boundaries.capability;

  assert.equal(permission.validateGrant(requested, requested).allowed, true);
  assert.equal(
    permission.validateGrant([], requested).diagnostics[0]?.code,
    "PERMISSION_GRANT_EXCEEDS_REQUEST",
  );
  assert.equal(
    permission.authorize(requested, {
      kind: "capability",
      name: "org.example.echo",
      method: "echo",
    }).allowed,
    true,
  );
  assert.equal(
    permission.authorize([], {
      kind: "capability",
      name: "org.example.echo",
      method: "echo",
    }).allowed,
    false,
  );

  assert.equal(capability.register([definition]).ok, true);
  const invalidRequest = capability.request(definition.identity, { message: 7 });
  assert.equal(invalidRequest.allowed, false);
  assert.equal(invalidRequest.diagnostics[0]?.code, "CAPABILITY_REQUEST_INVALID");
  assert.equal(invokes, 0);

  const request = capability.request(definition.identity, { message: "hello" });
  assert.equal(request.allowed, true);
  assert.deepEqual(
    capability.response(
      definition.identity,
      (await capability.invoke({
        invocationId: "invoke-echo",
        identity: definition.identity,
        method: "echo",
        input: request.value ?? null,
      })) as JsonValue,
    ),
    {
      allowed: true,
      diagnostics: [],
      value: { echo: "hello" },
    },
  );
  assert.equal(invokes, 1);

  const invalidResponse = capability.response(definition.identity, { echo: 7 });
  assert.equal(invalidResponse.allowed, false);
  assert.equal(invalidResponse.diagnostics[0]?.code, "CAPABILITY_RESPONSE_INVALID");
  capability.clear();
  assert.equal(capability.request(definition.identity, { message: "after-clear" }).allowed, false);
});
