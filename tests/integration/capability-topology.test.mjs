import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createNodeRuntimeHost,
  packPlugin,
  parseCommand,
  runWorkerProcess,
} from "@tegojs/cli";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const examplePlugin = join(root, "examples/echo-plugin");
const capabilityName = "org.example.capability.echo";
const deadlineMs = 5_000;

async function makeTreeOwnerWritable(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const child = join(directory, entry.name);
        await chmod(child, 0o700);
        await makeTreeOwnerWritable(child);
      }),
  );
}

async function eventually(operation, description) {
  const signal = AbortSignal.timeout(deadlineMs);
  while (!signal.aborted) {
    const value = await operation();
    if (value !== undefined) return value;
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  }
  throw new Error(`EVENTUALLY_TIMEOUT:${description}`);
}

async function preparePlugin(workspace, role) {
  const pluginDirectory = join(workspace, role);
  const artifactPath = join(workspace, `${role}.tego`);
  await cp(examplePlugin, pluginDirectory, { recursive: true });
  const provider = role === "provider";
  const pluginId = `org.example.capability-${role}`;
  const componentId = `${role}-task`;
  await writeFile(
    join(pluginDirectory, "src", "component.ts"),
    provider
      ? `import { defineComponent } from "@tegojs/plugin-sdk";

export default defineComponent({
  kind: "task",
  invokeCapability(context, request) {
    return {
      activation: context.identity.instanceId,
      componentId: context.identity.componentId,
      executor: context.runtime.executor,
      input: request.input,
      method: request.method,
    };
  },
  run() {
    throw new Error("provider run hook must not handle capability calls");
  },
});
`
      : `import { defineComponent } from "@tegojs/plugin-sdk";

export default defineComponent({
  kind: "task",
  run(context, input) {
    return context.capabilities.call({
      name: ${JSON.stringify(capabilityName)},
      protocolVersion: "1.0.0",
      method: "echo",
      input,
    });
  },
});
`,
  );
  const manifestPath = join(pluginDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.pluginId = pluginId;
  manifest.contractRange = ">=0.0.0 <1.0.0";
  manifest.components = [
    {
      componentId,
      kind: "task",
      entrypoint: "components/component.js",
      executors: ["process", "thread", "remote"],
    },
  ];
  manifest.permissions = [
    { kind: "executor", executors: ["process", "thread", "remote"] },
    ...(provider
      ? []
      : [
          {
            kind: "capability",
            capabilities: [{ name: capabilityName, methods: ["echo"] }],
          },
        ]),
  ];
  manifest.capabilities = provider
    ? {
        provides: [
          {
            name: capabilityName,
            protocolVersion: "1.0.0",
            componentId,
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
              required: ["activation", "componentId", "executor", "input", "method"],
              properties: {
                activation: { type: "string" },
                componentId: { const: componentId },
                executor: { enum: ["process", "remote", "thread"] },
                input: {
                  type: "object",
                  additionalProperties: false,
                  required: ["value"],
                  properties: { value: { type: "string" } },
                },
                method: { const: "echo" },
              },
            },
          },
        ],
        requires: [],
      }
    : {
        provides: [],
        requires: [{ name: capabilityName, protocolRange: "^1.0.0" }],
      };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const packed = await packPlugin({ artifactPath, pluginDirectory });
  return { artifactPath, componentId, digest: packed.digest, pluginId };
}

async function waitReady(runtime, pluginId, generation) {
  return eventually(async () => {
    const status = await runtime.operations.pluginStatus({
      applicationId: "capability-app",
      pluginId,
    });
    return status.desired?.generation === generation && status.observation?.status === "ready"
      ? status
      : undefined;
  }, `${pluginId}@${generation} ready`);
}

async function deploy(runtime, plugin, executor, capabilityPermission = false) {
  const deployed = await runtime.operations.deployPlugin({
    applicationId: "capability-app",
    pluginId: plugin.pluginId,
    artifactDigest: plugin.digest,
    essential: true,
    configuration: {},
    permissionGrants: [
      { kind: "executor", executors: [executor] },
      ...(capabilityPermission
        ? [
            {
              kind: "capability",
              capabilities: [{ name: capabilityName, methods: ["echo"] }],
            },
          ]
        : []),
    ],
    capabilityBindings: {},
  });
  await waitReady(runtime, plugin.pluginId, deployed.generation);
}

test("capability topology routes task consumers to exact task providers across local executors", async () => {
  const workspace = await mkdtemp(join(root, ".tego-capability-topology-"));
  const dataDirectory = await mkdtemp(join(tmpdir(), "tego-capability-topology-"));
  let host;
  try {
    const provider = await preparePlugin(workspace, "provider");
    const consumer = await preparePlugin(workspace, "consumer");
    host = await createNodeRuntimeHost({
      applicationId: "capability-app",
      dataDirectory,
      mode: "single-main",
      nodeId: "capability-node",
      runtimeId: "capability-runtime",
    });
    await host.runtime.start();
    for (const plugin of [provider, consumer]) {
      await host.artifactIngress.putPath(plugin.artifactPath);
      await host.runtime.operations.installPlugin({ digest: plugin.digest });
    }

    for (const [index, [consumerExecutor, providerExecutor]] of [
      ["thread", "process"],
      ["process", "thread"],
    ].entries()) {
      await deploy(host.runtime, provider, providerExecutor, false);
      await deploy(host.runtime, consumer, consumerExecutor, true);
      const input = { value: `topology-${index}` };
      const accepted = await host.runtime.operations.runTask({
        applicationId: "capability-app",
        pluginId: consumer.pluginId,
        componentId: consumer.componentId,
        input,
        deadline: new Date(Date.now() + deadlineMs).toISOString(),
        orphanPolicy: "finish-and-persist",
        operationId: `capability-topology-${index}`,
      });
      const completed = await host.runtime.operations.waitTask(accepted.taskId);
      assert.equal(
        completed.result?.status,
        "succeeded",
        JSON.stringify(completed.result?.diagnostic),
      );
      const snapshot = await host.runtime.operations.snapshot({});
      const providerInstance = snapshot.instances.items
        .map((item) => item.value)
        .find(
          (instance) =>
            instance.pluginId === provider.pluginId &&
            instance.componentId === provider.componentId &&
            instance.lifecycle === "ready",
        );
      assert.ok(providerInstance);
      assert.deepEqual(completed.result?.output, {
        activation: providerInstance.instanceId,
        componentId: provider.componentId,
        executor: providerExecutor,
        input,
        method: "echo",
      });
    }
  } finally {
    await host?.runtime.stop().catch(() => undefined);
    // Prepared artifacts are intentionally immutable while live. The runtime is
    // fully stopped above, so restore directory ownership permissions only for
    // deterministic test cleanup.
    await makeTreeOwnerWritable(dataDirectory);
    await rm(workspace, { force: true, recursive: true });
    await rm(dataDirectory, { force: true, recursive: true });
  }
});

test("capability topology routes through an exact materialized remote Worker activation", async () => {
  const workspace = await mkdtemp(join(root, ".tego-capability-remote-"));
  const mainDataDirectory = await mkdtemp(join(tmpdir(), "tego-capability-main-"));
  const workerDataDirectory = await mkdtemp(join(tmpdir(), "tego-capability-worker-"));
  const controller = new AbortController();
  let host;
  let workerRunning;
  try {
    const provider = await preparePlugin(workspace, "provider");
    const consumer = await preparePlugin(workspace, "consumer");
    host = await createNodeRuntimeHost({
      applicationId: "capability-app",
      dataDirectory: mainDataDirectory,
      mode: "single-main",
      nodeId: "capability-main-node",
      runtimeId: "capability-main-runtime",
      worker: {
        credential: "capability-worker-secret",
        host: "127.0.0.1",
        port: 0,
        workerId: "capability-worker",
      },
    });
    await host.runtime.start();
    const workerUrl = await host.startWorkerListener();
    assert.notEqual(workerUrl, undefined);
    const workerReady = Promise.withResolvers();
    workerRunning = runWorkerProcess(
      parseCommand([
        "worker",
        "start",
        "--connect",
        workerUrl,
        "--credential",
        "capability-worker-secret",
        "--worker-id",
        "capability-worker",
        "--data-dir",
        workerDataDirectory,
        "--prepare",
        provider.artifactPath,
        "--prepare",
        consumer.artifactPath,
      ]),
      {
        signal: controller.signal,
        onReady: () => workerReady.resolve(),
      },
    );
    await Promise.race([
      workerReady.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("remote Worker readiness timed out")), deadlineMs),
      ),
    ]);
    for (const plugin of [provider, consumer]) {
      await host.artifactIngress.putPath(plugin.artifactPath);
      await host.runtime.operations.installPlugin({ digest: plugin.digest });
    }
    await deploy(host.runtime, provider, "remote", false);
    await deploy(host.runtime, consumer, "remote", true);

    const input = { value: "remote-topology" };
    const accepted = await host.runtime.operations.runTask({
      applicationId: "capability-app",
      pluginId: consumer.pluginId,
      componentId: consumer.componentId,
      input,
      deadline: new Date(Date.now() + deadlineMs).toISOString(),
      orphanPolicy: "finish-and-persist",
      operationId: "capability-remote-topology",
    });
    const completed = await host.runtime.operations.waitTask(accepted.taskId);
    assert.equal(
      completed.result?.status,
      "succeeded",
      JSON.stringify(completed.result?.diagnostic),
    );
    const snapshot = await host.runtime.operations.snapshot({});
    const providerInstance = snapshot.instances.items
      .map((item) => item.value)
      .find(
        (instance) =>
          instance.pluginId === provider.pluginId &&
          instance.componentId === provider.componentId &&
          instance.lifecycle === "ready",
      );
    assert.ok(providerInstance);
    assert.deepEqual(completed.result?.output, {
      activation: providerInstance.instanceId,
      componentId: provider.componentId,
      executor: "remote",
      input,
      method: "echo",
    });
  } finally {
    await host?.runtime.stop().catch(() => undefined);
    controller.abort();
    await workerRunning?.catch(() => undefined);
    await makeTreeOwnerWritable(mainDataDirectory);
    await makeTreeOwnerWritable(workerDataDirectory);
    await rm(workspace, { force: true, recursive: true });
    await rm(mainDataDirectory, { force: true, recursive: true });
    await rm(workerDataDirectory, { force: true, recursive: true });
  }
});
