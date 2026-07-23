import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@tegojs/contracts";
import {
  createComponentContext,
  createDisposableStack,
  defineComponent,
  type ComponentContext,
} from "../src/index.js";

test("defineComponent snapshots and deeply freezes a functional definition", () => {
  const metadata = { nested: { label: "original" } };
  const run = async (_context: ComponentContext, input: JsonValue) => input;
  const definition = defineComponent({
    kind: "task",
    metadata,
    run,
  });

  metadata.nested.label = "mutated";

  assert.equal(definition.protocol, "tego.component/1.0");
  assert.equal(definition.kind, "task");
  assert.equal(definition.run, run);
  assert.deepEqual(definition.metadata, { nested: { label: "original" } });
  assert.ok(Object.isFrozen(definition));
  assert.ok(Object.isFrozen(definition.metadata));
  assert.ok(Object.isFrozen(definition.metadata?.nested));
  assert.throws(() => {
    (definition.metadata?.nested as { label: string }).label = "changed";
  }, TypeError);
});

test("defineComponent rejects class instances and accessor-backed definitions without invoking them", () => {
  class ComponentClass {
    readonly kind = "task";
    readonly run = async () => null;
  }
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "kind", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "task";
    },
  });

  assert.throws(() => defineComponent(new ComponentClass() as never), /plain object/u);
  assert.throws(() => defineComponent(accessor as never), /data propert/u);
  assert.equal(getterCalls, 0);
});

test("disposables run once in reverse order and continue after failures", async () => {
  const calls: string[] = [];
  const stack = createDisposableStack({
    diagnosticSource: { kind: "plugin", id: "component-01" },
    redact: (value: string) => value.replaceAll("secret-value", "[REDACTED]"),
  });
  stack.add(() => {
    calls.push("first");
  });
  stack.add({
    dispose: async () => {
      calls.push("second");
      throw new Error("failed with secret-value");
    },
  });
  stack.add(() => {
    calls.push("third");
  });

  const diagnostics = await stack.dispose();
  const repeated = await stack.dispose();

  assert.deepEqual(calls, ["third", "second", "first"]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "LIFECYCLE_DISPOSAL_FAILED");
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-value/u);
  assert.deepEqual(repeated, diagnostics);
  assert.ok(Object.isFrozen(diagnostics));
});

test("component context exposes only the bounded plugin surface and immutable snapshots", async () => {
  const controller = new AbortController();
  const configuration = { nested: { enabled: true }, name: "demo" };
  const logged: unknown[] = [];
  const emitted: unknown[] = [];
  const context = createComponentContext({
    identity: {
      applicationId: "app-01",
      pluginId: "org.example.echo",
      componentId: "echo",
      instanceId: "instance-01",
    },
    configuration,
    logger: {
      debug: (...values: unknown[]) => logged.push(values),
      error: (...values: unknown[]) => logged.push(values),
      info: (...values: unknown[]) => logged.push(values),
      warn: (...values: unknown[]) => logged.push(values),
    },
    events: {
      emit: async (type: string, payload: JsonValue) => {
        emitted.push({ type, payload });
      },
    },
    capabilities: {
      call: async (request: { readonly input: JsonValue }) => ({ echoed: request.input }),
    },
    lifecycle: { state: "started" },
    runtime: {
      executor: "process",
      mode: "single-main",
      runtimeId: "runtime-01",
    },
    cancellation: controller.signal,
    disposables: createDisposableStack(),
    secrets: {
      get: async (name: string) => (name === "API_TOKEN" ? "secret-value" : undefined),
    },
  });

  configuration.nested.enabled = false;

  assert.deepEqual(Object.keys(context).sort(), [
    "cancellation",
    "capabilities",
    "config",
    "disposables",
    "events",
    "identity",
    "lifecycle",
    "logger",
    "runtime",
    "secrets",
  ]);
  assert.deepEqual(context.config.get(), { name: "demo", nested: { enabled: true } });
  assert.equal(context.config.get("name"), "demo");
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.identity));
  assert.ok(Object.isFrozen(context.runtime));
  assert.ok(Object.isFrozen(context.config.get()));
  assert.equal("state" in context, false);
  assert.equal("artifacts" in context, false);
  assert.equal("filesystem" in context, false);
  assert.equal("process" in context, false);
  assert.deepEqual(
    await context.capabilities.call({
      name: "org.example.echo",
      protocolVersion: "1.0.0",
      method: "echo",
      input: { value: "hello" },
    }),
    { echoed: { value: "hello" } },
  );
  assert.equal(await context.secrets.get("API_TOKEN"), "secret-value");
  assert.equal(context.cancellation, controller.signal);
  context.logger.info("hello");
  await context.events.emit("plugin.ready", { ready: true });
  assert.equal(logged.length, 1);
  assert.deepEqual(emitted, [{ type: "plugin.ready", payload: { ready: true } }]);
});

test("component context rejects accessor and exotic configuration without invoking it", () => {
  let calls = 0;
  const configuration = Object.defineProperty({}, "token", {
    enumerable: true,
    get() {
      calls += 1;
      return "do-not-read";
    },
  });

  assert.throws(
    () =>
      createComponentContext({
        identity: {
          applicationId: "app-01",
          pluginId: "org.example.echo",
          componentId: "echo",
          instanceId: "instance-01",
        },
        configuration: configuration as never,
        logger: {
          debug() {},
          error() {},
          info() {},
          warn() {},
        },
        events: { emit: async () => {} },
        capabilities: { call: async () => null },
        lifecycle: { state: "created" },
        runtime: {
          executor: "process",
          mode: "single-main",
          runtimeId: "runtime-01",
        },
        cancellation: new AbortController().signal,
        disposables: createDisposableStack(),
        secrets: { get: async () => undefined },
      }),
    /data propert/u,
  );
  assert.equal(calls, 0);
  assert.throws(
    () =>
      createComponentContext({
        identity: {
          applicationId: "app-01",
          pluginId: "org.example.echo",
          componentId: "echo",
          instanceId: "instance-01",
        },
        configuration: new (class Configuration {})() as never,
        logger: {
          debug() {},
          error() {},
          info() {},
          warn() {},
        },
        events: { emit: async () => {} },
        capabilities: { call: async () => null },
        lifecycle: { state: "created" },
        runtime: {
          executor: "process",
          mode: "single-main",
          runtimeId: "runtime-01",
        },
        cancellation: new AbortController().signal,
        disposables: createDisposableStack(),
        secrets: { get: async () => undefined },
      }),
    /plain object/u,
  );
});
