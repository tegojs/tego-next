import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseComponentId,
  parsePluginId,
  parsePluginManifest,
  parseRuntimeId,
  parseTaskId,
  type JsonValue,
  type PluginManifest,
  type SecretProvider,
} from "@tegojs/contracts";
import {
  ComponentHost,
  parseComponentHostCommand,
  type ComponentHostCommand,
  type ComponentHostOptions,
  type PrepareComponentHostCommand,
} from "../src/index.js";

const digest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
const otherDigest = parseArtifactDigest(`sha256:${"b".repeat(64)}`);
const futureDeadline = "2099-01-01T00:00:00.000Z";

interface ArtifactFixture {
  readonly directory: string;
  readonly manifest: PluginManifest;
}

async function artifactFixture(
  t: TestContext,
  source: string,
  options: {
    readonly componentId?: string;
    readonly entrypoint?: string;
    readonly permissions?: PluginManifest["permissions"];
  } = {},
): Promise<ArtifactFixture> {
  const directory = await mkdtemp(join(process.cwd(), ".tego-component-host-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const entrypoint = options.entrypoint ?? "components/component.js";
  const path = join(directory, ...entrypoint.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, source);
  const manifest = parsePluginManifest({
    schemaVersion: "1.0",
    pluginId: "org.example.component",
    version: "1.0.0",
    contractRange: "^1.0.0",
    nodeRange: ">=26.0.0 <27",
    moduleFormat: "esm",
    components: [
      {
        componentId: options.componentId ?? "component",
        kind: "task",
        entrypoint,
        executors: ["process"],
      },
    ],
    permissions: options.permissions ?? [],
    capabilities: { provides: [], requires: [] },
  });
  return { directory: await realpath(directory), manifest };
}

function prepareCommand(
  fixture: ArtifactFixture,
  overrides: Partial<PrepareComponentHostCommand["payload"]> = {},
): PrepareComponentHostCommand {
  return {
    protocol: "1.0",
    commandId: "prepare-01",
    deadline: futureDeadline,
    type: "prepare",
    payload: {
      artifactDigest: digest,
      artifactRoot: fixture.directory,
      manifest: fixture.manifest,
      componentId: parseComponentId("component"),
      identity: {
        runtimeId: parseRuntimeId("runtime-01"),
        applicationId: parseApplicationId("app-01"),
        pluginId: parsePluginId("org.example.component"),
        componentId: parseComponentId("component"),
        instanceId: "instance-01",
      },
      configuration: { greeting: "hello" },
      permissionGrants: fixture.manifest.permissions,
      capabilityDefinitions: [],
      runtime: { executor: "process", mode: "single-main" },
      ...overrides,
    },
  };
}

function command(
  type: Exclude<ComponentHostCommand["type"], "prepare">,
  commandId: string,
  payload: JsonValue,
  deadline = futureDeadline,
): ComponentHostCommand {
  return {
    protocol: "1.0",
    commandId,
    deadline,
    type,
    payload,
  } as ComponentHostCommand;
}

function allowedOptions(overrides: Partial<ComponentHostOptions> = {}): ComponentHostOptions {
  return {
    logger: {
      debug() {},
      error() {},
      info() {},
      warn() {},
    },
    events: { emit: async () => {} },
    permissionBoundary: {
      authorize: () => ({ allowed: true, diagnostics: [] }),
      validateGrant: (requested, granted) => {
        const requestedValues = new Set(requested.map((value) => JSON.stringify(value)));
        return granted.every((value) => requestedValues.has(JSON.stringify(value)))
          ? { allowed: true, diagnostics: [], granted }
          : {
              allowed: false,
              diagnostics: [
                {
                  code: "PERMISSION_GRANT_EXCEEDS_REQUEST",
                  message: "Grant exceeds request",
                  path: "$/permissionGrants",
                },
              ],
            };
      },
    },
    capabilityBoundary: {
      register: () => ({ ok: true, diagnostics: [] }),
      request: (_identity: unknown, input: JsonValue) => ({
        allowed: true,
        diagnostics: [],
        value: input,
      }),
      invoke: async (request: { readonly input: JsonValue }) => request.input,
      response: (_identity: unknown, input: JsonValue) => ({
        allowed: true,
        diagnostics: [],
        value: input,
      }),
      clear() {},
    },
    ...overrides,
  };
}

test("host command protocol is versioned, strict, JSON-safe, and bounded", () => {
  const valid = {
    protocol: "1.0",
    commandId: "health-01",
    deadline: futureDeadline,
    type: "health",
    payload: { artifactDigest: digest },
  };
  assert.deepEqual(parseComponentHostCommand(valid), valid);
  assert.throws(() => parseComponentHostCommand({ ...valid, protocol: "2.0" }), /unsupported/u);
  assert.throws(() => parseComponentHostCommand({ ...valid, extra: true }), /fields/u);
  assert.throws(() => parseComponentHostCommand({ ...valid, deadline: "not-a-date" }), /deadline/u);
  assert.throws(
    () =>
      parseComponentHostCommand({
        ...valid,
        payload: { value: "x".repeat(1024 * 1024 + 1) },
      }),
    /bounded|large|limit/u,
  );

  let calls = 0;
  const accessor = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      calls += 1;
      return "health";
    },
  });
  assert.throws(() => parseComponentHostCommand(accessor), /data propert/u);
  assert.equal(calls, 0);
});

test("prepare and import commands cannot nominate replaceable artifact locations", () => {
  const prepare = {
    protocol: "1.0",
    commandId: "prepare-trusted-artifact",
    deadline: futureDeadline,
    type: "prepare",
    payload: {
      artifactDigest: digest,
      componentId: parseComponentId("component"),
      identity: {
        runtimeId: parseRuntimeId("runtime-01"),
        applicationId: parseApplicationId("app-01"),
        pluginId: parsePluginId("org.example.component"),
        componentId: parseComponentId("component"),
        instanceId: "instance-01",
      },
      configuration: { greeting: "hello" },
      permissionGrants: [],
      capabilityDefinitions: [],
      runtime: { executor: "process", mode: "single-main" },
    },
  };

  assert.deepEqual(parseComponentHostCommand(prepare), prepare);
  assert.throws(
    () =>
      parseComponentHostCommand({
        ...prepare,
        payload: { ...prepare.payload, artifactRoot: "/replaceable/root" },
      }),
    /fields/u,
  );
  assert.deepEqual(
    parseComponentHostCommand({
      protocol: "1.0",
      commandId: "import-trusted-artifact",
      deadline: futureDeadline,
      type: "import",
      payload: { artifactDigest: digest },
    }),
    {
      protocol: "1.0",
      commandId: "import-trusted-artifact",
      deadline: futureDeadline,
      type: "import",
      payload: { artifactDigest: digest },
    },
  );
  assert.throws(
    () =>
      parseComponentHostCommand({
        protocol: "1.0",
        commandId: "import-untrusted-entry",
        deadline: futureDeadline,
        type: "import",
        payload: { artifactDigest: digest, entrypoint: "components/replacement.js" },
      }),
    /fields/u,
  );
});

test("prepare has no module side effects and import is confined to the prepared digest and declared ESM entry", async (t) => {
  const marker = `__tegoPreparedSideEffect_${Date.now().toString(36)}`;
  const fixture = await artifactFixture(
    t,
    `
      globalThis.${marker} = (globalThis.${marker} ?? 0) + 1;
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({ kind: "task", run: async (_context, input) => input });
    `,
  );
  const host = new ComponentHost(allowedOptions());

  const prepared = await host.handle(prepareCommand(fixture));
  assert.equal(prepared.ok, true);
  assert.equal(Reflect.get(globalThis, marker), undefined);

  const wrongDigest = await host.handle(
    command("import", "import-wrong", {
      artifactDigest: otherDigest,
      entrypoint: "components/component.js",
    }),
  );
  assert.equal(wrongDigest.ok, false);
  assert.equal(wrongDigest.diagnostics[0]?.code, "ARTIFACT_DIGEST_MISMATCH");
  assert.equal(Reflect.get(globalThis, marker), undefined);

  const undeclared = await host.handle(
    command("import", "import-undeclared", {
      artifactDigest: digest,
      entrypoint: "components/other.js",
    }),
  );
  assert.equal(undeclared.ok, false);
  assert.equal(undeclared.diagnostics[0]?.code, "ARTIFACT_ENTRY_UNDECLARED");
  assert.equal(Reflect.get(globalThis, marker), undefined);

  const imported = await host.handle(
    command("import", "import-01", {
      artifactDigest: digest,
      entrypoint: "components/component.js",
    }),
  );
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(Reflect.get(globalThis, marker), 1);
});

test("loader rejects path escape, symlink escape, and CommonJS before import side effects", async (t) => {
  const escapedMarker = `__tegoEscapedSideEffect_${Date.now().toString(36)}`;
  const directory = await mkdtemp(join(process.cwd(), ".tego-component-confined-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const outside = join(directory, "..", `${escapedMarker}.js`);
  await writeFile(outside, `globalThis.${escapedMarker} = true; export default {};`);
  t.after(() => rm(outside, { force: true }));
  const invalidManifest = {
    schemaVersion: "1.0",
    pluginId: "org.example.component",
    version: "1.0.0",
    contractRange: "^1.0.0",
    nodeRange: ">=26.0.0 <27",
    moduleFormat: "esm",
    components: [
      {
        componentId: "component",
        kind: "task",
        entrypoint: `../${escapedMarker}.js`,
        executors: ["process"],
      },
    ],
    permissions: [],
    capabilities: { provides: [], requires: [] },
  };
  const escapedHost = new ComponentHost(allowedOptions());
  const escaped = await escapedHost.handle(
    prepareCommand(
      { directory, manifest: invalidManifest as unknown as PluginManifest },
      { manifest: invalidManifest as unknown as PluginManifest },
    ),
  );
  assert.equal(escaped.ok, false);
  assert.equal(Reflect.get(globalThis, escapedMarker), undefined);

  const symlinkFixture = await artifactFixture(t, "export default {};", {
    entrypoint: "components/link.js",
  });
  await rm(join(symlinkFixture.directory, "components/link.js"));
  await symlink(outside, join(symlinkFixture.directory, "components/link.js"));
  const symlinkHost = new ComponentHost(allowedOptions());
  assert.equal((await symlinkHost.handle(prepareCommand(symlinkFixture))).ok, true);
  const symlinkResult = await symlinkHost.handle(
    command("import", "import-symlink", {
      artifactDigest: digest,
      entrypoint: "components/link.js",
    }),
  );
  assert.equal(symlinkResult.ok, false);
  assert.equal(symlinkResult.diagnostics[0]?.code, "ARTIFACT_ENTRY_OUTSIDE_ROOT");
  assert.equal(Reflect.get(globalThis, escapedMarker), undefined);

  const commonJsMarker = `__tegoCommonJsSideEffect_${Date.now().toString(36)}`;
  const commonJs = await artifactFixture(t, "export default {};");
  await writeFile(
    join(commonJs.directory, "components/component.cjs"),
    `globalThis.${commonJsMarker} = true; module.exports = {};`,
  );
  const commonJsManifest = {
    ...commonJs.manifest,
    components: [
      {
        ...commonJs.manifest.components[0],
        entrypoint: "components/component.cjs",
      },
    ],
  } as unknown as PluginManifest;
  const commonJsHost = new ComponentHost(allowedOptions());
  const commonJsResult = await commonJsHost.handle(
    prepareCommand({ ...commonJs, manifest: commonJsManifest }, { manifest: commonJsManifest }),
  );
  assert.equal(commonJsResult.ok, false);
  assert.equal(commonJsResult.diagnostics[0]?.code, "ARTIFACT_MANIFEST_INVALID");
  assert.equal(Reflect.get(globalThis, commonJsMarker), undefined);
});

test("component lifecycle order and command idempotency are enforced without duplicate hooks", async (t) => {
  const events: Array<{ type: string; payload: JsonValue }> = [];
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        start: async (context) => context.events.emit("hook", { name: "start" }),
        health: async () => ({ status: "healthy" }),
        run: async (_context, input) => input,
        drain: async (context) => context.events.emit("hook", { name: "drain" }),
        stop: async (context) => context.events.emit("hook", { name: "stop" })
      });
    `,
  );
  const host = new ComponentHost(
    allowedOptions({
      events: {
        emit: async (type: string, payload: JsonValue) => {
          events.push({ type, payload });
        },
      },
    }),
  );

  const premature = await host.handle(
    command("start", "start-premature", { artifactDigest: digest }),
  );
  assert.equal(premature.ok, false);
  assert.equal(premature.diagnostics[0]?.code, "LIFECYCLE_TRANSITION_INVALID");

  assert.equal((await host.handle(prepareCommand(fixture))).ok, true);
  assert.equal(
    (
      await host.handle(
        command("import", "import-01", {
          artifactDigest: digest,
          entrypoint: "components/component.js",
        }),
      )
    ).ok,
    true,
  );
  const start = command("start", "start-01", { artifactDigest: digest });
  const firstStart = await host.handle(start);
  const duplicateStart = await host.handle(start);
  const idempotentStart = await host.handle(
    command("start", "start-02", { artifactDigest: digest }),
  );
  assert.deepEqual(duplicateStart, firstStart);
  assert.equal(idempotentStart.ok, true);
  assert.equal(
    events.filter((event) => (event.payload as { readonly name?: string }).name === "start").length,
    1,
  );

  const conflict = await host.handle(command("health", "start-01", { artifactDigest: digest }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.diagnostics[0]?.code, "PROTOCOL_IDEMPOTENCY_CONFLICT");

  const health = await host.handle(command("health", "health-01", { artifactDigest: digest }));
  assert.equal(health.ok, true);
  assert.deepEqual(health.value, { status: "healthy" });

  const stopBeforeDrain = await host.handle(
    command("stop", "stop-premature", { artifactDigest: digest }),
  );
  assert.equal(stopBeforeDrain.ok, false);
  assert.equal(stopBeforeDrain.diagnostics[0]?.code, "LIFECYCLE_TRANSITION_INVALID");
  assert.equal(
    (await host.handle(command("drain", "drain-01", { artifactDigest: digest }))).ok,
    true,
  );
  assert.equal(
    (await host.handle(command("stop", "stop-01", { artifactDigest: digest }))).ok,
    true,
  );
  assert.deepEqual(
    events.map((event) => (event.payload as { readonly name?: string }).name),
    ["start", "drain", "stop"],
  );
});

test("capability calls are forced through permission, request, invoke, and response gates", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async (context, input) => context.capabilities.call({
          name: "org.example.echo",
          protocolVersion: "1.0.0",
          method: "echo",
          input
        })
      });
    `,
    {
      permissions: [
        {
          kind: "capability",
          capabilities: [{ name: "org.example.echo", methods: ["echo"] }],
        },
      ],
    },
  );
  const order: string[] = [];
  let responseMode: "invalid" | "valid" = "valid";
  const host = new ComponentHost(
    allowedOptions({
      permissionBoundary: {
        validateGrant: (_requested, granted) => ({
          allowed: true,
          diagnostics: [],
          granted,
        }),
        authorize: (_grants: unknown, attempt: { readonly kind: string }) => {
          order.push(`permission:${attempt.kind}`);
          return { allowed: true, diagnostics: [] };
        },
      },
      capabilityBoundary: {
        register: () => ({ ok: true, diagnostics: [] }),
        request: (_identity: unknown, input: JsonValue) => {
          order.push("request");
          if (
            typeof input !== "object" ||
            input === null ||
            Array.isArray(input) ||
            typeof (input as { readonly message?: unknown }).message !== "string"
          ) {
            return {
              allowed: false,
              diagnostics: [{ code: "CAPABILITY_REQUEST_INVALID", message: "invalid request" }],
            };
          }
          return { allowed: true, diagnostics: [], value: input };
        },
        invoke: async (request: { readonly input: JsonValue }) => {
          order.push("invoke");
          return { echo: request.input };
        },
        response: (_identity: unknown, input: JsonValue) => {
          order.push("response");
          return responseMode === "valid"
            ? { allowed: true, diagnostics: [], value: input }
            : {
                allowed: false,
                diagnostics: [{ code: "CAPABILITY_RESPONSE_INVALID", message: "invalid response" }],
              };
        },
        clear() {},
      },
    }),
  );
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-01", {
      artifactDigest: digest,
      entrypoint: "components/component.js",
    }),
  );
  await host.handle(command("start", "start-01", { artifactDigest: digest }));

  const invalidRequest = await host.handle(
    command("run", "run-invalid-request", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("task-invalid"),
        attemptId: parseAttemptId("attempt-invalid"),
        applicationId: parseApplicationId("app-01"),
        pluginId: parsePluginId("org.example.component"),
        componentId: parseComponentId("component"),
        input: { message: 7 },
        deadline: futureDeadline,
        orphanPolicy: "cancel",
      },
    }),
  );
  assert.equal(invalidRequest.ok, false);
  assert.deepEqual(order, ["permission:capability", "request"]);

  order.length = 0;
  responseMode = "invalid";
  const invalidResponse = await host.handle(
    command("run", "run-invalid-response", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("task-response"),
        attemptId: parseAttemptId("attempt-response"),
        applicationId: parseApplicationId("app-01"),
        pluginId: parsePluginId("org.example.component"),
        componentId: parseComponentId("component"),
        input: { message: "hello" },
        deadline: futureDeadline,
        orphanPolicy: "cancel",
      },
    }),
  );
  assert.equal(invalidResponse.ok, false);
  assert.deepEqual(order, ["permission:capability", "request", "invoke", "response"]);
  assert.equal(invalidResponse.diagnostics[0]?.code, "CAPABILITY_RESPONSE_INVALID");
});

test("duplicate task attempts execute once and cooperative cancellation reaches the hook", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async (context) => {
          await context.events.emit("run.started", {});
          return new Promise((resolve) => {
            context.cancellation.addEventListener("abort", () => resolve("aborted"), { once: true });
          });
        }
      });
    `,
  );
  const started = Promise.withResolvers<void>();
  let starts = 0;
  const host = new ComponentHost(
    allowedOptions({
      events: {
        emit: async (type: string) => {
          if (type === "run.started") {
            starts += 1;
            started.resolve();
          }
        },
      },
    }),
  );
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-01", {
      artifactDigest: digest,
      entrypoint: "components/component.js",
    }),
  );
  await host.handle(command("start", "start-01", { artifactDigest: digest }));
  const runPayload = {
    artifactDigest: digest,
    execution: {
      taskId: parseTaskId("task-cancel"),
      attemptId: parseAttemptId("attempt-cancel"),
      applicationId: parseApplicationId("app-01"),
      pluginId: parsePluginId("org.example.component"),
      componentId: parseComponentId("component"),
      input: null,
      deadline: futureDeadline,
      orphanPolicy: "cancel",
    },
  };
  const first = host.handle(command("run", "run-01", runPayload));
  const duplicate = host.handle(command("run", "run-02", runPayload));
  await started.promise;
  const cancelled = await host.handle(
    command("cancel", "cancel-01", {
      taskId: parseTaskId("task-cancel"),
      attemptId: parseAttemptId("attempt-cancel"),
      reason: "operator",
    }),
  );
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

  assert.equal(cancelled.ok, true);
  assert.equal(starts, 1);
  assert.equal(firstResult.ok, true);
  assert.equal(
    (firstResult.value as { readonly status?: string } | undefined)?.status,
    "cancelled",
  );
  assert.deepEqual(duplicateResult.value, firstResult.value);
  assert.equal(JSON.stringify(firstResult).includes("aborted"), false);
});

test("deadline aborts a running hook and returns a deterministic timed-out result", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async (context) => new Promise((resolve) => {
          context.cancellation.addEventListener("abort", () => resolve("late-output"), { once: true });
        })
      });
    `,
  );
  const host = new ComponentHost(allowedOptions());
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-01", {
      artifactDigest: digest,
      entrypoint: "components/component.js",
    }),
  );
  await host.handle(command("start", "start-01", { artifactDigest: digest }));
  const deadline = new Date(Date.now() + 40).toISOString();
  const result = await host.handle(
    command(
      "run",
      "run-deadline",
      {
        artifactDigest: digest,
        execution: {
          taskId: parseTaskId("task-deadline"),
          attemptId: parseAttemptId("attempt-deadline"),
          applicationId: parseApplicationId("app-01"),
          pluginId: parsePluginId("org.example.component"),
          componentId: parseComponentId("component"),
          input: null,
          deadline,
          orphanPolicy: "cancel",
        },
      },
      deadline,
    ),
  );
  assert.equal(result.ok, true);
  assert.equal((result.value as { readonly status?: string } | undefined)?.status, "timed-out");
  assert.equal(JSON.stringify(result).includes("late-output"), false);
});

test("secret access requires manifest request and deployment grant and never leaks values", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async (context) => {
          const value = await context.secrets.get("API_TOKEN");
          context.logger.info("token", value);
          throw new Error("failed with " + value);
        }
      });
    `,
    { permissions: [{ kind: "secret", names: ["API_TOKEN"] }] },
  );
  const secretValue = "top-secret-value";
  let gets = 0;
  const provider: SecretProvider = {
    developmentOnly: true,
    open: async () => {},
    health: async () => ({
      status: "healthy",
      checkedAt: "2026-07-23T00:00:00.000Z",
    }),
    close: async () => {},
    get: async () => {
      gets += 1;
      return secretValue;
    },
  };
  const logs: unknown[] = [];
  const host = new ComponentHost(
    allowedOptions({
      logger: {
        debug: (...values: unknown[]) => logs.push(values),
        error: (...values: unknown[]) => logs.push(values),
        info: (...values: unknown[]) => logs.push(values),
        warn: (...values: unknown[]) => logs.push(values),
      },
      secretProvider: provider,
      permissionBoundary: {
        validateGrant: (_requested, granted) => ({
          allowed: true,
          diagnostics: [],
          granted,
        }),
        authorize: (
          _grants: unknown,
          attempt: { readonly kind: string; readonly name?: string },
        ) =>
          attempt.kind === "secret" && attempt.name === "API_TOKEN"
            ? { allowed: true, diagnostics: [] }
            : {
                allowed: false,
                diagnostics: [
                  {
                    code: "PERMISSION_GRANT_EXCEEDS_REQUEST",
                    message: "denied",
                    path: "$/attempt",
                  },
                ],
              },
      },
    }),
  );
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-01", {
      artifactDigest: digest,
      entrypoint: "components/component.js",
    }),
  );
  await host.handle(command("start", "start-01", { artifactDigest: digest }));
  const result = await host.handle(
    command("run", "run-secret", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("task-secret"),
        attemptId: parseAttemptId("attempt-secret"),
        applicationId: parseApplicationId("app-01"),
        pluginId: parsePluginId("org.example.component"),
        componentId: parseComponentId("component"),
        input: null,
        deadline: futureDeadline,
        orphanPolicy: "cancel",
      },
    }),
  );

  assert.equal(gets, 1);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /top-secret-value/u);
  assert.doesNotMatch(JSON.stringify(logs), /top-secret-value/u);
  assert.match(JSON.stringify(logs), /\[REDACTED\]/u);

  const unrequestedManifest = parsePluginManifest({
    ...fixture.manifest,
    permissions: [],
  });
  const deniedHost = new ComponentHost(
    allowedOptions({
      secretProvider: provider,
      permissionBoundary: {
        authorize: () => ({ allowed: true, diagnostics: [] }),
        validateGrant: () => ({
          allowed: false,
          diagnostics: [
            {
              code: "PERMISSION_GRANT_EXCEEDS_REQUEST",
              message: "Grant exceeds request",
              path: "$/permissionGrants",
            },
          ],
        }),
      },
    }),
  );
  const deniedPrepare = await deniedHost.handle(
    prepareCommand(
      { ...fixture, manifest: unrequestedManifest },
      {
        manifest: unrequestedManifest,
        permissionGrants: [{ kind: "secret", names: ["API_TOKEN"] }],
      },
    ),
  );
  assert.equal(deniedPrepare.ok, false);
  assert.equal(deniedPrepare.diagnostics[0]?.code, "PERMISSION_GRANT_EXCEEDS_REQUEST");
  assert.equal(gets, 1);
});

test("thrown Error and non-Error values become redacted RuntimeDiagnostic results", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        start: async () => { throw { reason: "non-error-token", nested: { password: "private" } }; }
      });
    `,
  );
  const host = new ComponentHost(allowedOptions());
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-01", {
      artifactDigest: digest,
      entrypoint: "components/component.js",
    }),
  );
  const result = await host.handle(command("start", "start-01", { artifactDigest: digest }));
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "EXECUTOR_COMPONENT_HOOK_FAILED");
  assert.equal(result.diagnostics[0]?.cause?.name, "UnknownCause");
  assert.doesNotMatch(JSON.stringify(result), /private/u);
  assert.doesNotMatch(JSON.stringify(result), /password/u);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
