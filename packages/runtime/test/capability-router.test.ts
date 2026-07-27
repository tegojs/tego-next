import assert from "node:assert/strict";
import test from "node:test";
import {
  DiagnosticError,
  parseApplicationId,
  parseArtifactDigest,
  parseCapabilityName,
  parseComponentId,
  parseComponentInstanceId,
  parseGeneration,
  parsePluginId,
  type CapabilityBinding,
  type JsonValue,
  type Permission,
  type TaskExecutionTarget,
} from "@tegojs/contracts";
import {
  CapabilityRouter,
  type CapabilityRoute,
  type ComponentInstanceIdentity,
} from "../src/capabilities/router.js";

const capability = parseCapabilityName("org.example.echo");
const consumer: ComponentInstanceIdentity = {
  applicationId: parseApplicationId("app"),
  pluginId: parsePluginId("consumer"),
  componentId: parseComponentId("consumer-task"),
  target: {
    instanceId: parseComponentInstanceId("consumer-instance"),
    deploymentGeneration: parseGeneration(1),
    artifactDigest: parseArtifactDigest(`sha256:${"1".repeat(64)}`),
    executor: { id: "consumer-thread", type: "thread" },
  },
};
const providerTarget: TaskExecutionTarget = {
  instanceId: parseComponentInstanceId("provider-instance"),
  deploymentGeneration: parseGeneration(3),
  artifactDigest: parseArtifactDigest(`sha256:${"2".repeat(64)}`),
  executor: { id: "provider-process", type: "process" },
};
const capabilityBinding: CapabilityBinding = {
  capability: { name: capability, protocolVersion: "1.0.0" },
  providerDeployment: {
    applicationId: parseApplicationId("app"),
    pluginId: parsePluginId("provider"),
  },
};
const grants: readonly Permission[] = [
  {
    kind: "capability",
    capabilities: [{ name: capability, methods: ["echo"] }],
  },
];

function route(overrides: Partial<CapabilityRoute> = {}): CapabilityRoute {
  return {
    consumer,
    consumerBindingFingerprint: "consumer-binding",
    permissionGrants: grants,
    binding: capabilityBinding,
    provision: {
      identity: { name: capability, protocolVersion: "1.0.0" },
      componentId: parseComponentId("provider-task"),
      methods: ["echo"],
      requestSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
      responseSchema: {
        type: "object",
        additionalProperties: false,
        required: ["echoed"],
        properties: { echoed: { type: "string" } },
      },
    },
    provider: {
      applicationId: parseApplicationId("app"),
      pluginId: parsePluginId("provider"),
      componentId: parseComponentId("provider-task"),
      target: providerTarget,
      activation: "4",
      bindingFingerprint: "provider-binding",
    },
    routeRevision: "route-7",
    ...overrides,
  };
}

function call(input: JsonValue = { value: "hello" }, invocationId = "invoke-1") {
  return {
    invocationId,
    identity: { name: capability, protocolVersion: "1.0.0" },
    method: "echo",
    input,
  };
}

test("capability router validates and dispatches an exact provider route", async () => {
  const dispatched: CapabilityRoute[] = [];
  const router = new CapabilityRouter({
    resolve: async () => route(),
    revalidate: async (candidate) => candidate.routeRevision === "route-7",
    dispatch: async (candidate, invocation) => {
      dispatched.push(candidate);
      return { echoed: (invocation.input as { value: string }).value };
    },
  });

  assert.deepEqual(await router.invoke(consumer, call()), { echoed: "hello" });
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0]?.provider.target, providerTarget);
  assert.equal(dispatched[0]?.provider.activation, "4");
});

test("capability router rejects invalid requests before provider code", async () => {
  let dispatched = false;
  const router = new CapabilityRouter({
    resolve: async () => route(),
    revalidate: async () => true,
    dispatch: async () => {
      dispatched = true;
      return { echoed: "unreachable" };
    },
  });

  await assert.rejects(
    router.invoke(consumer, call({ value: 42 })),
    (error: unknown) =>
      error instanceof DiagnosticError &&
      error.diagnostic.code === "CAPABILITY_REQUEST_INVALID",
  );
  assert.equal(dispatched, false);
});

test("capability router rejects invalid provider responses", async () => {
  const router = new CapabilityRouter({
    resolve: async () => route(),
    revalidate: async () => true,
    dispatch: async () => ({ echoed: 42 }),
  });

  await assert.rejects(
    router.invoke(consumer, call()),
    (error: unknown) =>
      error instanceof DiagnosticError &&
      error.diagnostic.code === "CAPABILITY_RESPONSE_INVALID",
  );
});

test("capability router denies undeclared methods and missing grants", async () => {
  for (const candidate of [
    { route: route(), method: "delete" },
    { route: route({ permissionGrants: [] }), method: "echo" },
  ]) {
    const router = new CapabilityRouter({
      resolve: async () => candidate.route,
      revalidate: async () => true,
      dispatch: async () => ({ echoed: "unreachable" }),
    });
    await assert.rejects(
      router.invoke(consumer, { ...call(), method: candidate.method }),
      (error: unknown) =>
        error instanceof DiagnosticError &&
        (error.diagnostic.code === "CAPABILITY_METHOD_UNAVAILABLE" ||
          error.diagnostic.code === "PERMISSION_CAPABILITY_DENIED"),
    );
  }
});

test("capability router revalidates the durable binding before dispatch", async () => {
  let dispatched = false;
  const router = new CapabilityRouter({
    resolve: async () => route(),
    revalidate: async () => false,
    dispatch: async () => {
      dispatched = true;
      return { echoed: "unreachable" };
    },
  });

  await assert.rejects(
    router.invoke(consumer, call()),
    (error: unknown) =>
      error instanceof DiagnosticError &&
      error.diagnostic.code === "CAPABILITY_BINDING_STALE",
  );
  assert.equal(dispatched, false);
});

test("capability invocation identity deduplicates matching calls and rejects equivocation", async () => {
  const deferred = Promise.withResolvers<JsonValue>();
  let dispatches = 0;
  const router = new CapabilityRouter({
    resolve: async () => route(),
    revalidate: async () => true,
    dispatch: async () => {
      dispatches += 1;
      return deferred.promise;
    },
  });

  const first = router.invoke(consumer, call());
  const replay = router.invoke(consumer, call());
  await assert.rejects(
    router.invoke(consumer, call({ value: "different" })),
    (error: unknown) =>
      error instanceof DiagnosticError &&
      error.diagnostic.code === "PROTOCOL_IDEMPOTENCY_CONFLICT",
  );
  deferred.resolve({ echoed: "hello" });
  assert.deepEqual(await Promise.all([first, replay]), [
    { echoed: "hello" },
    { echoed: "hello" },
  ]);
  assert.equal(dispatches, 1);
});
