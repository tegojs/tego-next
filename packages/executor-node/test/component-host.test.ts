import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createExecutionBinding,
  type JsonValue,
  type PluginManifest,
  parseApplicationId,
  parseArtifactDigest,
  parseAttemptId,
  parseCapabilityName,
  parseComponentId,
  parseComponentInstanceId,
  parseGeneration,
  parsePluginId,
  parsePluginManifest,
  parseRuntimeId,
  parseTaskId,
  type SecretProvider,
} from "@tegojs/contracts";
import {
  ComponentHost,
  type ComponentHostCommand,
  type ComponentHostOptions,
  type ComponentHostResult,
  cloneComponentHostValue,
  type PrepareComponentHostCommand,
  parseComponentHostCommand,
} from "../src/index.js";

const digest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
const otherDigest = parseArtifactDigest(`sha256:${"b".repeat(64)}`);
const futureDeadline = "2099-01-01T00:00:00.000Z";
const componentTarget = {
  instanceId: parseComponentInstanceId("app-01.org.example.component.component.g1"),
  deploymentGeneration: parseGeneration("1"),
  artifactDigest: digest,
  executor: { id: "component-host", type: "process" },
} as const;

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
    readonly isolated?: boolean;
    readonly permissions?: PluginManifest["permissions"];
    readonly provides?: PluginManifest["capabilities"]["provides"];
  } = {},
): Promise<ArtifactFixture> {
  const directory = await mkdtemp(
    options.isolated
      ? join(tmpdir(), "tego-component-host-")
      : join(process.cwd(), ".tego-component-host-"),
  );
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
    capabilities: { provides: options.provides ?? [], requires: [] },
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

function allowedOptions(
  fixture: ArtifactFixture,
  overrides: Partial<ComponentHostOptions> = {},
): ComponentHostOptions {
  return {
    logger: {
      debug() {},
      error() {},
      info() {},
      warn() {},
    },
    events: { emit: async () => {} },
    artifactResolver: {
      resolve: async (artifactDigest) => ({
        artifactDigest,
        artifactRoot: fixture.directory,
        manifest: fixture.manifest,
      }),
    },
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

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds = 100): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("operation did not return promptly")), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function attachmentLimitResult(
  t: TestContext,
  attachments: readonly ArrayBuffer[],
): Promise<{
  readonly observedAttachmentLength: number | undefined;
  readonly result: ComponentHostResult;
  readonly runCalls: number;
}> {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async (context) => {
          await context.events.emit("run.called", context.attachments.length);
          return "ran";
        }
      });
    `,
  );
  let observedAttachmentLength: number | undefined;
  let runCalls = 0;
  const host = new ComponentHost(
    allowedOptions(fixture, {
      events: {
        emit: async (type, payload) => {
          if (type === "run.called") {
            runCalls += 1;
            observedAttachmentLength = payload as number;
          }
        },
      },
    }),
  );
  assert.equal((await host.handle(prepareCommand(fixture))).ok, true);
  assert.equal(
    (
      await host.handle(
        command("import", "import-attachment-limit", {
          artifactDigest: digest,
        }),
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await host.handle(
        command("start", "start-attachment-limit", {
          artifactDigest: digest,
        }),
      )
    ).ok,
    true,
  );
  const result = await host.handle(
    command("run", "run-attachment-limit", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("task-attachment-limit"),
        attemptId: parseAttemptId("attempt-attachment-limit"),
        target: componentTarget,
        applicationId: parseApplicationId("app-01"),
        pluginId: parsePluginId("org.example.component"),
        componentId: parseComponentId("component"),
        input: null,
        deadline: futureDeadline,
        orphanPolicy: "cancel",
      },
    }),
    attachments,
  );
  return { observedAttachmentLength, result, runCalls };
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
  assert.throws(
    () => cloneComponentHostValue(Array.from({ length: 99_999 }, () => Number.MAX_VALUE)),
    /wire size|bounded|limit/u,
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

test("provider capability invocation commands preserve the exact bounded wire contract", () => {
  const invocation = {
    protocol: "1.0",
    commandId: "invoke-capability-01",
    deadline: futureDeadline,
    type: "invokeCapability",
    payload: {
      artifactDigest: digest,
      invocation: {
        invocationId: "operation-01",
        identity: { name: "org.example.echo", protocolVersion: "1.0.0" },
        method: "echo",
        input: { message: "hello" },
      },
    },
  };

  assert.deepEqual(parseComponentHostCommand(invocation), invocation);
  assert.throws(
    () =>
      parseComponentHostCommand({
        ...invocation,
        payload: {
          ...invocation.payload,
          invocation: { ...invocation.payload.invocation, invocationId: "" },
        },
      }),
    /invocation|OperationId/u,
  );
  assert.throws(
    () =>
      parseComponentHostCommand({
        ...invocation,
        payload: {
          ...invocation.payload,
          invocation: {
            ...invocation.payload.invocation,
            input: "x".repeat(1024 * 1024 + 1),
          },
        },
      }),
    /bounded|limit|size/u,
  );
});

test("@spec:plugin-deployment/sdk-runtime-import/isolated-artifact-loads-host-sdk", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      import { defineComponent } from "@tegojs/plugin-sdk";
      export default defineComponent({
        kind: "task",
        run: async (_context, input) => input,
      });
    `,
    { isolated: true },
  );
  const host = new ComponentHost(allowedOptions(fixture));

  assert.equal((await host.handle(prepareCommand(fixture))).ok, true);
  assert.equal(
    (await host.handle(command("import", "isolated-import", { artifactDigest: digest }))).ok,
    true,
  );
  assert.equal(
    (await host.handle(command("start", "isolated-start", { artifactDigest: digest }))).ok,
    true,
  );
  const input = { isolated: true };
  const result = await host.handle(
    command("run", "isolated-run", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("isolated-task"),
        attemptId: parseAttemptId("isolated-attempt"),
        target: componentTarget,
        applicationId: parseApplicationId("app-01"),
        pluginId: parsePluginId("org.example.component"),
        componentId: parseComponentId("component"),
        input,
        deadline: futureDeadline,
        orphanPolicy: "cancel",
      },
    }),
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((result.value as { readonly output?: JsonValue }).output, input);
});

test("component host rejects excessive attachment count before plugin execution", async (t) => {
  const { result, runCalls } = await attachmentLimitResult(
    t,
    Array.from({ length: 65 }, () => new ArrayBuffer(0)),
  );

  assert.equal(runCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "PROTOCOL_COMPONENT_HOST_COMMAND_INVALID");
});

test("component host rejects an oversized attachment before plugin execution", async (t) => {
  const { result, runCalls } = await attachmentLimitResult(t, [new ArrayBuffer(1024 * 1024 + 1)]);

  assert.equal(runCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "PROTOCOL_COMPONENT_HOST_COMMAND_INVALID");
});

test("component host rejects oversized aggregate attachments before plugin execution", async (t) => {
  const { result, runCalls } = await attachmentLimitResult(t, [
    new ArrayBuffer(512 * 1024 + 1),
    new ArrayBuffer(512 * 1024 + 1),
  ]);

  assert.equal(runCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "PROTOCOL_COMPONENT_HOST_COMMAND_INVALID");
});

test("component host measures attachment internal slots instead of spoofed byteLength", async (t) => {
  class SpoofedArrayBuffer extends ArrayBuffer {
    override get byteLength(): number {
      return 0;
    }
  }
  const attachment = new SpoofedArrayBuffer(2 * 1024 * 1024);
  const { result, runCalls } = await attachmentLimitResult(t, [attachment]);

  assert.equal(runCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "PROTOCOL_COMPONENT_HOST_COMMAND_INVALID");
});

test("component host rejects attachments whose native byte length cannot be read", async (t) => {
  const attachment = new Proxy(new ArrayBuffer(0), {});
  const { result, runCalls } = await attachmentLimitResult(t, [attachment]);

  assert.equal(runCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "PROTOCOL_COMPONENT_HOST_COMMAND_INVALID");
});

test("component host rejects excessive attachment count before inspecting elements", async (t) => {
  let reads = 0;
  const attachments = new Array<ArrayBuffer>(65);
  Object.defineProperty(attachments, "64", {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      throw new Error("attachment element must not be inspected");
    },
  });
  const { result, runCalls } = await attachmentLimitResult(t, attachments);

  assert.equal(reads, 0);
  assert.equal(runCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "PROTOCOL_COMPONENT_HOST_COMMAND_INVALID");
});

test("component host freezes attachment count before inspecting elements", async (t) => {
  const attachment = new ArrayBuffer(0);
  const attachments = [attachment];
  Object.defineProperty(attachments, "0", {
    configurable: true,
    enumerable: true,
    get() {
      attachments.push(...Array.from({ length: 64 }, () => new ArrayBuffer(0)));
      return attachment;
    },
  });
  const { observedAttachmentLength, result, runCalls } = await attachmentLimitResult(
    t,
    attachments,
  );

  assert.equal(attachments.length, 65);
  assert.equal(runCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(observedAttachmentLength, 1);
});

test("component host rejects a non-primitive attachment count before inspecting elements", async (t) => {
  let conversions = 0;
  let elementReads = 0;
  const attachments = new Proxy([new ArrayBuffer(0)], {
    get(target, property, receiver) {
      if (property === "length") {
        return {
          [Symbol.toPrimitive]() {
            conversions += 1;
            return conversions === 1 ? 0 : 65;
          },
        };
      }
      if (property === "0") elementReads += 1;
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as readonly ArrayBuffer[];

  const { result, runCalls } = await attachmentLimitResult(t, attachments);

  assert.equal(conversions, 0);
  assert.equal(elementReads, 0);
  assert.equal(runCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "PROTOCOL_COMPONENT_HOST_COMMAND_INVALID");
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
  const host = new ComponentHost(allowedOptions(fixture));

  const prepared = await host.handle(prepareCommand(fixture));
  assert.equal(prepared.ok, true);
  assert.equal(Reflect.get(globalThis, marker), undefined);

  const wrongDigest = await host.handle(
    command("import", "import-wrong", {
      artifactDigest: otherDigest,
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
  assert.equal(undeclared.diagnostics[0]?.code, "PROTOCOL_COMPONENT_HOST_COMMAND_INVALID");
  assert.equal(Reflect.get(globalThis, marker), undefined);

  const imported = await host.handle(
    command("import", "import-01", {
      artifactDigest: digest,
    }),
  );
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(Reflect.get(globalThis, marker), 1);
});

test("import rejects a prepared root replaced by a symlink without evaluating replacement code", async (t) => {
  const fixture = await artifactFixture(
    t,
    'export default { protocol: "tego.component/1.0", kind: "task" };',
  );
  const marker = `__tegoArtifactReplacement_${Date.now().toString(36)}`;
  const replacement = await mkdtemp(join(process.cwd(), ".tego-component-replacement-"));
  const original = `${fixture.directory}-original`;
  t.after(() => rm(replacement, { force: true, recursive: true }));
  t.after(() => rm(original, { force: true, recursive: true }));
  await mkdir(join(replacement, "components"), { recursive: true });
  await writeFile(
    join(replacement, "components/component.js"),
    `
      globalThis.${marker} = (globalThis.${marker} ?? 0) + 1;
      export default { protocol: "tego.component/1.0", kind: "task" };
    `,
  );
  const host = new ComponentHost(allowedOptions(fixture));
  assert.equal((await host.handle(prepareCommand(fixture))).ok, true);

  await rename(fixture.directory, original);
  await symlink(replacement, fixture.directory, "dir");
  const imported = await host.handle(
    command("import", "import-replaced-root", { artifactDigest: digest }),
  );

  assert.equal(imported.ok, false);
  assert.equal(imported.diagnostics[0]?.code, "ARTIFACT_ROOT_IDENTITY_MISMATCH");
  assert.equal(Reflect.get(globalThis, marker), undefined);
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
  const escapedFixture = {
    directory,
    manifest: invalidManifest as unknown as PluginManifest,
  };
  const escapedHost = new ComponentHost(allowedOptions(escapedFixture));
  const escaped = await escapedHost.handle(prepareCommand(escapedFixture));
  assert.equal(escaped.ok, false);
  assert.equal(Reflect.get(globalThis, escapedMarker), undefined);

  const symlinkFixture = await artifactFixture(t, "export default {};", {
    entrypoint: "components/link.js",
  });
  await rm(join(symlinkFixture.directory, "components/link.js"));
  await symlink(outside, join(symlinkFixture.directory, "components/link.js"));
  const symlinkHost = new ComponentHost(allowedOptions(symlinkFixture));
  assert.equal((await symlinkHost.handle(prepareCommand(symlinkFixture))).ok, true);
  const symlinkResult = await symlinkHost.handle(
    command("import", "import-symlink", {
      artifactDigest: digest,
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
  const commonJsFixture = { ...commonJs, manifest: commonJsManifest };
  const commonJsHost = new ComponentHost(allowedOptions(commonJsFixture));
  const commonJsResult = await commonJsHost.handle(prepareCommand(commonJsFixture));
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
    allowedOptions(fixture, {
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

test("only an identical command id shares an active transition", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        start: async (context) => context.events.emit("start.blocked", null)
      });
    `,
  );
  const gate = deferred();
  let starts = 0;
  const host = new ComponentHost(
    allowedOptions(fixture, {
      events: {
        emit: async () => {
          starts += 1;
          await gate.promise;
        },
      },
    }),
  );
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-serialize", {
      artifactDigest: digest,
    }),
  );

  const firstCommand = command("start", "start-concurrent-first", {
    artifactDigest: digest,
  });
  const first = host.handle(firstCommand);
  await new Promise((resolve) => setImmediate(resolve));

  const duplicate = host.handle(firstCommand);
  assert.equal(starts, 1);

  let concurrent: ComponentHostResult;
  try {
    concurrent = await within(
      host.handle(
        command("start", "start-concurrent-second", {
          artifactDigest: digest,
        }),
      ),
    );
  } finally {
    gate.resolve();
  }
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.diagnostics[0]?.code, "LIFECYCLE_TRANSITION_IN_PROGRESS");
  assert.deepEqual(duplicateResult, firstResult);
  assert.equal(starts, 1);
});

test("failed drain preserves state and remains retryable", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        drain: async (context) => context.events.emit("drain", null)
      });
    `,
  );
  let calls = 0;
  const host = new ComponentHost(
    allowedOptions(fixture, {
      events: {
        emit: async (type) => {
          if (type !== "drain") return;
          calls += 1;
          if (calls === 1) throw new Error("drain failed");
        },
      },
    }),
  );
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-retry", {
      artifactDigest: digest,
    }),
  );
  await host.handle(command("start", "start-retry", { artifactDigest: digest }));

  const firstDrain = await host.handle(
    command("drain", "drain-failed", { artifactDigest: digest }),
  );
  assert.equal(firstDrain.ok, false);
  assert.equal(firstDrain.state, "started");
  const secondDrain = await host.handle(
    command("drain", "drain-retry", { artifactDigest: digest }),
  );
  assert.equal(secondDrain.ok, true);
  assert.equal(secondDrain.state, "draining");
  assert.equal(calls, 2);
});

test("failed stop cleanup is terminal and repeats its canonical result without rerunning cleanup", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        start: async (context) => {
          context.disposables.add(() => context.events.emit("dispose", null));
        },
        run: async () => "ran",
        stop: async (context) => context.events.emit("stop", null)
      });
    `,
  );
  const calls = { dispose: 0, stop: 0 };
  const host = new ComponentHost(
    allowedOptions(fixture, {
      events: {
        emit: async (type) => {
          if (type !== "dispose" && type !== "stop") return;
          calls[type] += 1;
          throw new Error(`${type} failed`);
        },
      },
    }),
  );
  await host.handle(prepareCommand(fixture));
  await host.handle(command("import", "import-terminal-stop", { artifactDigest: digest }));
  await host.handle(command("start", "start-terminal-stop", { artifactDigest: digest }));
  await host.handle(command("drain", "drain-terminal-stop", { artifactDigest: digest }));

  const first = await host.handle(
    command("stop", "stop-terminal-first", { artifactDigest: digest }),
  );
  const repeated = await host.handle(
    command("stop", "stop-terminal-repeated", { artifactDigest: digest }),
  );

  assert.equal(first.ok, false);
  assert.equal(first.state, "failed");
  assert.equal(first.diagnostics.length, 2);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.state, "failed");
  assert.deepEqual({ ...repeated, commandId: first.commandId }, first);
  assert.deepEqual(calls, { dispose: 1, stop: 1 });

  const start = await host.handle(
    command("start", "start-after-terminal-stop", { artifactDigest: digest }),
  );
  assert.equal(start.ok, false);
  assert.equal(start.state, "failed");
  const run = await host.handle(
    command("run", "run-after-terminal-stop", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("task-after-terminal-stop"),
        attemptId: parseAttemptId("attempt-after-terminal-stop"),
        target: componentTarget,
        applicationId: parseApplicationId("app-01"),
        pluginId: parsePluginId("org.example.component"),
        componentId: parseComponentId("component"),
        input: null,
        deadline: futureDeadline,
        orphanPolicy: "cancel",
      },
    }),
  );
  assert.equal(run.ok, false);
  assert.equal(run.state, "failed");
});

test("transition hook reentrancy returns promptly without waiting on the active hook", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        start: async (context) => context.events.emit("start", null),
        drain: async (context) => context.events.emit("drain", null),
        stop: async (context) => context.events.emit("stop", null)
      });
    `,
  );
  const reentrant: ComponentHostResult[] = [];
  let host!: ComponentHost;
  host = new ComponentHost(
    allowedOptions(fixture, {
      events: {
        emit: async (type) => {
          const reentrantType = type === "start" ? "drain" : type === "drain" ? "stop" : "start";
          reentrant.push(
            await within(
              host.handle(command(reentrantType, `reentrant-${type}`, { artifactDigest: digest })),
            ),
          );
        },
      },
    }),
  );
  await host.handle(prepareCommand(fixture));
  await host.handle(command("import", "import-reentrant", { artifactDigest: digest }));

  assert.equal(
    (await within(host.handle(command("start", "start-reentrant", { artifactDigest: digest })))).ok,
    true,
  );
  assert.equal(
    (await within(host.handle(command("drain", "drain-reentrant", { artifactDigest: digest })))).ok,
    true,
  );
  assert.equal(
    (await within(host.handle(command("stop", "stop-reentrant", { artifactDigest: digest })))).ok,
    true,
  );
  assert.equal(reentrant.length, 3);
  assert.ok(reentrant.every((result) => !result.ok));
  assert.ok(
    reentrant.every((result) => result.diagnostics[0]?.code === "LIFECYCLE_TRANSITION_IN_PROGRESS"),
  );
});

test("a plugin-created AsyncResource cannot self-await an active transition", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      let resource;
      export default defineComponent({
        kind: "task",
        run: async () => {
          const { AsyncResource } = await import("node:async_hooks");
          resource = new AsyncResource("plugin-precreated");
          return "prepared";
        },
        drain: async (context) => {
          if (resource === undefined) throw new Error("run must create the resource");
          try {
            await resource.runInAsyncScope(() => context.events.emit("drain.reenter", null));
          } finally {
            resource.emitDestroy();
          }
        }
      });
    `,
  );
  let host!: ComponentHost;
  let reentrant: ComponentHostResult | undefined;
  host = new ComponentHost(
    allowedOptions(fixture, {
      events: {
        emit: async (type) => {
          if (type !== "drain.reenter") return;
          reentrant = await within(
            host.handle(
              command("drain", "drain-async-resource-inner", {
                artifactDigest: digest,
              }),
            ),
          );
        },
      },
    }),
  );
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-async-resource", {
      artifactDigest: digest,
    }),
  );
  await host.handle(command("start", "start-async-resource", { artifactDigest: digest }));
  const run = await host.handle(
    command("run", "run-create-async-resource", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("task-create-async-resource"),
        attemptId: parseAttemptId("attempt-create-async-resource"),
        target: componentTarget,
        applicationId: parseApplicationId("app-01"),
        pluginId: parsePluginId("org.example.component"),
        componentId: parseComponentId("component"),
        input: null,
        deadline: futureDeadline,
        orphanPolicy: "cancel",
      },
    }),
  );
  assert.equal(run.ok, true);

  const outer = await within(
    host.handle(
      command("drain", "drain-async-resource-outer", {
        artifactDigest: digest,
      }),
    ),
  );
  assert.equal(outer.ok, true);
  assert.equal(outer.state, "draining");
  assert.equal(reentrant?.ok, false);
  assert.equal(reentrant?.diagnostics[0]?.code, "LIFECYCLE_TRANSITION_IN_PROGRESS");
});

test("drain closes run intake synchronously before its hook settles", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async () => "ran",
        drain: async (context) => context.events.emit("drain.blocked", null)
      });
    `,
  );
  const gate = deferred();
  const host = new ComponentHost(
    allowedOptions(fixture, {
      events: { emit: async () => gate.promise },
    }),
  );
  await host.handle(prepareCommand(fixture));
  await host.handle(command("import", "import-intake", { artifactDigest: digest }));
  await host.handle(command("start", "start-intake", { artifactDigest: digest }));

  const draining = host.handle(command("drain", "drain-intake", { artifactDigest: digest }));
  const run = await host.handle(
    command("run", "run-after-drain-submission", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("task-after-drain"),
        attemptId: parseAttemptId("attempt-after-drain"),
        target: componentTarget,
        applicationId: parseApplicationId("app-01"),
        pluginId: parsePluginId("org.example.component"),
        componentId: parseComponentId("component"),
        input: null,
        deadline: futureDeadline,
        orphanPolicy: "cancel",
      },
    }),
  );
  assert.equal(run.ok, false);
  assert.equal(run.diagnostics[0]?.code, "LIFECYCLE_TRANSITION_IN_PROGRESS");
  gate.resolve();
  assert.equal((await draining).ok, true);
});

test("non-cooperative runs respect hard capacity while cancel and drain remain available", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async () => new Promise(() => {})
      });
    `,
  );
  const host = new ComponentHost(allowedOptions(fixture));
  await host.handle(prepareCommand(fixture));
  await host.handle(command("import", "import-hard-capacity", { artifactDigest: digest }));
  await host.handle(command("start", "start-hard-capacity", { artifactDigest: digest }));

  const settled: ComponentHostResult[] = [];
  const pending = Array.from({ length: 270 }, (_, index) => {
    const result = host.handle(
      command("run", `run-hard-capacity-${index}`, {
        artifactDigest: digest,
        execution: {
          taskId: parseTaskId(`task-hard-capacity-${index}`),
          attemptId: parseAttemptId(`attempt-hard-capacity-${index}`),
          target: componentTarget,
          applicationId: parseApplicationId("app-01"),
          pluginId: parsePluginId("org.example.component"),
          componentId: parseComponentId("component"),
          input: index,
          deadline: futureDeadline,
          orphanPolicy: "cancel",
        },
      }),
    );
    void result.then((value) => settled.push(value));
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));

  const retention = (
    host as unknown as {
      retention(): {
        readonly commands: number;
        readonly controlCommands: number;
        readonly runs: number;
      };
    }
  ).retention();
  assert.ok(retention.commands <= 256);
  assert.ok(retention.controlCommands <= 32);
  assert.ok(retention.runs <= 256);
  assert.equal(
    settled.filter(
      (result) => result.diagnostics[0]?.code === "EXECUTOR_COMPONENT_HOST_CAPACITY_EXCEEDED",
    ).length,
    14,
  );

  const cancellation = host.handle(
    command("cancel", "cancel-at-capacity", {
      taskId: parseTaskId("task-hard-capacity-0"),
      attemptId: parseAttemptId("attempt-hard-capacity-0"),
      reason: "capacity-test",
    }),
  );
  const duringControl = (
    host as unknown as {
      retention(): {
        readonly commands: number;
        readonly controlCommands: number;
        readonly runs: number;
      };
    }
  ).retention();
  assert.ok(duringControl.commands <= 256);
  assert.ok(duringControl.controlCommands <= 32);
  assert.equal((await cancellation).ok, true);
  const firstRun = pending[0];
  assert.ok(firstRun);
  assert.equal((await firstRun).ok, true);
  assert.equal(
    (await host.handle(command("drain", "drain-at-capacity", { artifactDigest: digest }))).ok,
    true,
  );
});

test("duplicate prepare compares the complete canonical deployment fingerprint", async (t) => {
  const fixture = await artifactFixture(
    t,
    'export default { protocol: "tego.component/1.0", kind: "task" };',
  );
  const host = new ComponentHost(allowedOptions(fixture));
  assert.equal((await host.handle(prepareCommand(fixture))).ok, true);

  const changedConfiguration = prepareCommand(fixture, {
    configuration: { greeting: "changed" },
  });
  const firstConflict = await host.handle({
    ...changedConfiguration,
    commandId: "prepare-changed-configuration",
  });
  assert.equal(firstConflict.ok, false);
  assert.equal(firstConflict.diagnostics[0]?.code, "PROTOCOL_IDEMPOTENCY_CONFLICT");

  const changedRuntime = prepareCommand(fixture, {
    runtime: { executor: "thread", mode: "single-main" },
  });
  const secondConflict = await host.handle({
    ...changedRuntime,
    commandId: "prepare-changed-runtime",
  });
  assert.equal(secondConflict.ok, false);
  assert.equal(secondConflict.diagnostics[0]?.code, "PROTOCOL_IDEMPOTENCY_CONFLICT");
});

test("duplicate task attempts compare full execution fingerprints and completed caches stay bounded", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({ kind: "task", run: async (_context, input) => input });
    `,
  );
  const host = new ComponentHost(allowedOptions(fixture));
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-run-retention", {
      artifactDigest: digest,
    }),
  );
  await host.handle(command("start", "start-run-retention", { artifactDigest: digest }));

  const execution = {
    taskId: parseTaskId("task-fingerprint"),
    attemptId: parseAttemptId("attempt-fingerprint"),
    target: componentTarget,
    applicationId: parseApplicationId("app-01"),
    pluginId: parsePluginId("org.example.component"),
    componentId: parseComponentId("component"),
    input: { version: 1 },
    deadline: futureDeadline,
    orphanPolicy: "cancel",
  } as const;
  const first = await host.handle(
    command("run", "run-fingerprint-first", { artifactDigest: digest, execution }),
  );
  assert.equal(first.ok, true);

  for (const [commandId, changed] of [
    ["run-fingerprint-input", { ...execution, input: { version: 2 } }],
    ["run-fingerprint-orphan", { ...execution, orphanPolicy: "finish-and-buffer" }],
  ] as const) {
    const conflict = await host.handle(
      command("run", commandId, { artifactDigest: digest, execution: changed }),
    );
    assert.equal(conflict.ok, false);
    assert.equal(conflict.diagnostics[0]?.code, "PROTOCOL_IDEMPOTENCY_CONFLICT");
  }

  for (let index = 0; index < 300; index += 1) {
    const result = await host.handle(
      command("run", `run-retained-${index}`, {
        artifactDigest: digest,
        execution: {
          ...execution,
          taskId: parseTaskId(`task-retained-${index}`),
          attemptId: parseAttemptId(`attempt-retained-${index}`),
          input: index,
        },
      }),
    );
    assert.equal(result.ok, true);
  }
  const retention = (
    host as unknown as { retention(): { readonly commands: number; readonly runs: number } }
  ).retention();
  assert.ok(retention.commands <= 256);
  assert.ok(retention.runs <= 256);
});

test("deadline acceptance and chunked timers use the same injected clock", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async (context) => new Promise((resolve) => {
          context.cancellation.addEventListener("abort", () => resolve("late"), { once: true });
        })
      });
    `,
  );
  const timers: Array<{
    readonly callback: () => void;
    readonly delay: number;
    cancelled: boolean;
  }> = [];
  let now = Date.parse("2090-01-01T00:00:00.000Z");
  const clock = {
    now: () => new Date(now),
    setTimeout(callback: () => void, delay: number) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return Object.freeze({
        cancel: () => {
          timer.cancelled = true;
        },
      });
    },
  };
  const host = new ComponentHost(allowedOptions(fixture, { clock }));
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-clock", {
      artifactDigest: digest,
    }),
  );
  await host.handle(command("start", "start-clock", { artifactDigest: digest }));

  const maximumDelay = 2_147_483_647;
  const deadline = new Date(now + maximumDelay * 2 + 500).toISOString();
  const pending = host.handle(
    command(
      "run",
      "run-clock",
      {
        artifactDigest: digest,
        execution: {
          taskId: parseTaskId("task-clock"),
          attemptId: parseAttemptId("attempt-clock"),
          target: componentTarget,
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers[0]?.delay, maximumDelay);

  now += maximumDelay;
  timers[0]?.callback();
  assert.equal(timers[1]?.delay, maximumDelay);
  now += maximumDelay;
  timers[1]?.callback();
  assert.equal(timers[2]?.delay, 500);
  now += 500;
  timers[2]?.callback();

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal((result.value as { readonly status?: string } | undefined)?.status, "timed-out");
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
    allowedOptions(fixture, {
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
    }),
  );
  await host.handle(command("start", "start-01", { artifactDigest: digest }));
  const executionIdentity = {
    applicationId: parseApplicationId("app-01"),
    pluginId: parsePluginId("org.example.component"),
    componentId: parseComponentId("component"),
    target: componentTarget,
  };
  const binding = createExecutionBinding(executionIdentity, {
    configuration: { greeting: "hello" },
    permissionGrants: fixture.manifest.permissions,
    capabilityDefinitions: [],
    capabilityBindings: [],
  });

  const invalidRequest = await host.handle(
    command("run", "run-invalid-request", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("task-invalid"),
        attemptId: parseAttemptId("attempt-invalid"),
        ...executionIdentity,
        binding,
        input: { message: 7 },
        deadline: futureDeadline,
        orphanPolicy: "cancel",
      },
    }),
  );
  assert.equal(invalidRequest.ok, false);
  assert.equal(
    invalidRequest.diagnostics[0]?.code,
    "CAPABILITY_REQUEST_INVALID",
    JSON.stringify(invalidRequest.diagnostics),
  );
  assert.deepEqual(order, ["permission:capability", "request"]);

  order.length = 0;
  responseMode = "invalid";
  const invalidResponse = await host.handle(
    command("run", "run-invalid-response", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("task-response"),
        attemptId: parseAttemptId("attempt-response"),
        ...executionIdentity,
        binding,
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

test("provider capability commands invoke only the task provider hook", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async () => { throw new Error("run must not handle provider calls"); },
        invokeCapability: async (_context, request) => ({
          invocationId: request.invocationId,
          method: request.method,
          input: request.input
        })
      });
    `,
    {
      provides: [
        {
          name: parseCapabilityName("org.example.echo"),
          protocolVersion: "1.0.0",
          componentId: parseComponentId("component"),
          methods: ["echo"],
          requestSchema: true,
          responseSchema: true,
        },
      ],
    },
  );
  const host = new ComponentHost(allowedOptions(fixture));
  await host.handle(prepareCommand(fixture));
  await host.handle(command("import", "provider-import", { artifactDigest: digest }));
  await host.handle(command("start", "provider-start", { artifactDigest: digest }));

  const result = await host.handle(
    command("invokeCapability" as never, "provider-invoke", {
      artifactDigest: digest,
      invocation: {
        invocationId: "operation-provider-01",
        identity: { name: "org.example.echo", protocolVersion: "1.0.0" },
        method: "echo",
        input: { message: "hello" },
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    invocationId: "operation-provider-01",
    method: "echo",
    input: { message: "hello" },
  });
});

test("declared task capability providers fail import when the provider hook is missing", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async () => null
      });
    `,
    {
      provides: [
        {
          name: parseCapabilityName("org.example.echo"),
          protocolVersion: "1.0.0",
          componentId: parseComponentId("component"),
          methods: ["echo"],
          requestSchema: true,
          responseSchema: true,
        },
      ],
    },
  );
  const host = new ComponentHost(allowedOptions(fixture));
  await host.handle(prepareCommand(fixture));

  const result = await host.handle(
    command("import", "provider-missing-hook-import", { artifactDigest: digest }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "EXECUTOR_COMPONENT_DEFINITION_INVALID");
  assert.match(result.diagnostics[0]?.message ?? "", /invokeCapability|provider hook/iu);
});

test("secret values cannot cross the capability request boundary or diagnostic surface", async (t) => {
  const secret = "raw-capability-secret";
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async (context) => {
          const secret = await context.secrets.get("API_TOKEN");
          return context.capabilities.call({
            name: "org.example.echo",
            protocolVersion: "1.0.0",
            method: "echo",
            input: { secret }
          });
        }
      });
    `,
    {
      permissions: [
        { kind: "secret", names: ["API_TOKEN"] },
        {
          kind: "capability",
          capabilities: [{ name: "org.example.echo", methods: ["echo"] }],
        },
      ],
    },
  );
  let invoked = false;
  const host = new ComponentHost(
    allowedOptions(fixture, {
      secretProvider: {
        developmentOnly: true,
        open: async () => {},
        health: async () => ({
          status: "healthy",
          checkedAt: "2026-07-23T00:00:00.000Z",
        }),
        close: async () => {},
        get: async () => secret,
      },
      permissionBoundary: {
        validateGrant: (_requested, granted) => ({
          allowed: true,
          diagnostics: [],
          granted,
        }),
        authorize: () => ({ allowed: true, diagnostics: [] }),
      },
      capabilityBoundary: {
        register: () => ({ ok: true, diagnostics: [] }),
        request: (_identity: unknown, input: JsonValue) => ({
          allowed: true,
          diagnostics: [],
          value: input,
        }),
        invoke: async () => {
          invoked = true;
          return null;
        },
        response: (_identity: unknown, input: JsonValue) => ({
          allowed: true,
          diagnostics: [],
          value: input,
        }),
        clear() {},
      },
    }),
  );
  const prepared = await host.handle(prepareCommand(fixture));
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  const imported = await host.handle(
    command("import", "secret-capability-import", { artifactDigest: digest }),
  );
  assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
  const started = await host.handle(
    command("start", "secret-capability-start", { artifactDigest: digest }),
  );
  assert.equal(started.ok, true, JSON.stringify(started.diagnostics));
  const executionIdentity = {
    applicationId: parseApplicationId("app-01"),
    pluginId: parsePluginId("org.example.component"),
    componentId: parseComponentId("component"),
    target: componentTarget,
  };

  const result = await host.handle(
    command("run", "secret-capability-run", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("task-secret-capability"),
        attemptId: parseAttemptId("attempt-secret-capability"),
        ...executionIdentity,
        binding: createExecutionBinding(executionIdentity, {
          configuration: { greeting: "hello" },
          permissionGrants: fixture.manifest.permissions,
          capabilityDefinitions: [],
          capabilityBindings: [],
        }),
        input: null,
        deadline: futureDeadline,
        orphanPolicy: "cancel",
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.diagnostics[0]?.code,
    "PERMISSION_SECRET_EXFILTRATION_BLOCKED",
    JSON.stringify(result.diagnostics),
  );
  assert.equal(invoked, false);
  assert.doesNotMatch(JSON.stringify(result), /raw-capability-secret/u);
});

test("provider capability responses reject secret exfiltration before wire redaction", async (t) => {
  const secret = "raw-provider-capability-secret";
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default defineComponent({
        kind: "task",
        run: async () => null,
        invokeCapability: async (context) => ({
          value: await context.secrets.get("API_TOKEN")
        })
      });
    `,
    {
      permissions: [{ kind: "secret", names: ["API_TOKEN"] }],
      provides: [
        {
          name: parseCapabilityName("org.example.echo"),
          protocolVersion: "1.0.0",
          componentId: parseComponentId("component"),
          methods: ["echo"],
          requestSchema: true,
          responseSchema: true,
        },
      ],
    },
  );
  const host = new ComponentHost(
    allowedOptions(fixture, {
      secretProvider: {
        developmentOnly: true,
        open: async () => {},
        health: async () => ({
          status: "healthy",
          checkedAt: "2026-07-23T00:00:00.000Z",
        }),
        close: async () => {},
        get: async () => secret,
      },
      permissionBoundary: {
        validateGrant: (_requested, granted) => ({
          allowed: true,
          diagnostics: [],
          granted,
        }),
        authorize: () => ({ allowed: true, diagnostics: [] }),
      },
    }),
  );
  await host.handle(prepareCommand(fixture));
  await host.handle(command("import", "provider-secret-import", { artifactDigest: digest }));
  await host.handle(command("start", "provider-secret-start", { artifactDigest: digest }));

  const result = await host.handle(
    command("invokeCapability" as never, "provider-secret-invoke", {
      artifactDigest: digest,
      invocation: {
        invocationId: "operation-provider-secret",
        identity: { name: "org.example.echo", protocolVersion: "1.0.0" },
        method: "echo",
        input: null,
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.diagnostics[0]?.code,
    "PERMISSION_SECRET_EXFILTRATION_BLOCKED",
    JSON.stringify(result.diagnostics),
  );
  assert.doesNotMatch(JSON.stringify(result), /raw-provider-capability-secret/u);
});

test("service components explicitly reject provider capability hooks", async (t) => {
  const fixture = await artifactFixture(
    t,
    `
      const { defineComponent } = await import("@tegojs/plugin-sdk");
      export default {
        protocol: "tego.component/1.0",
        kind: "service",
        invokeCapability: async () => null
      };
    `,
    { componentId: "component" },
  );
  const component = fixture.manifest.components[0];
  if (component === undefined) throw new Error("Service fixture component is missing");
  const serviceManifest = {
    ...fixture.manifest,
    components: [{ ...component, kind: "service" as const }],
  } satisfies PluginManifest;
  const host = new ComponentHost(allowedOptions({ ...fixture, manifest: serviceManifest }));
  await host.handle(prepareCommand({ ...fixture, manifest: serviceManifest }));
  const result = await host.handle(
    command("import", "service-provider-import", { artifactDigest: digest }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "EXECUTOR_COMPONENT_DEFINITION_INVALID");
  assert.match(result.diagnostics[0]?.message ?? "", /task|unsupported/u);
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
    allowedOptions(fixture, {
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
    }),
  );
  await host.handle(command("start", "start-01", { artifactDigest: digest }));
  const runPayload = {
    artifactDigest: digest,
    execution: {
      taskId: parseTaskId("task-cancel"),
      attemptId: parseAttemptId("attempt-cancel"),
      target: componentTarget,
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
  const host = new ComponentHost(allowedOptions(fixture));
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-01", {
      artifactDigest: digest,
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
          target: componentTarget,
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
    allowedOptions(fixture, {
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
    }),
  );
  await host.handle(command("start", "start-01", { artifactDigest: digest }));
  const result = await host.handle(
    command("run", "run-secret", {
      artifactDigest: digest,
      execution: {
        taskId: parseTaskId("task-secret"),
        attemptId: parseAttemptId("attempt-secret"),
        target: componentTarget,
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
    allowedOptions(
      { ...fixture, manifest: unrequestedManifest },
      {
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
      },
    ),
  );
  const deniedPrepare = await deniedHost.handle(
    prepareCommand(
      { ...fixture, manifest: unrequestedManifest },
      { permissionGrants: [{ kind: "secret", names: ["API_TOKEN"] }] },
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
  const host = new ComponentHost(allowedOptions(fixture));
  await host.handle(prepareCommand(fixture));
  await host.handle(
    command("import", "import-01", {
      artifactDigest: digest,
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
