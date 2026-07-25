import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ControlClientOptions } from "../src/control/client.js";
import type { ControlResponse } from "../src/control/protocol.js";
import { runCli } from "../src/run-cli.js";

function capture() {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  let output = "";
  stream.on("data", (chunk: string) => {
    output += chunk;
  });
  return { read: () => output, stream };
}

function response(result: Exclude<ControlResponse["result"], undefined>): ControlResponse {
  return {
    protocolVersion: "1.0",
    requestId: "request-plugin-command-test",
    ok: true,
    result,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("@spec:runtime-operations/plugin-development-operations/validate-before-pack", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-plugin-command-"));
  const pluginDirectory = join(directory, "invalid-plugin");
  const outputArtifact = join(directory, "invalid-plugin.tego");
  const stdout = capture();
  const stderr = capture();
  try {
    await mkdir(pluginDirectory);
    await writeFile(join(pluginDirectory, "manifest.json"), "{}");

    const exitCode = await runCli({
      argv: ["plugin", "pack", pluginDirectory, "--output", outputArtifact, "--json"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(exitCode, 1);
    assert.equal(await exists(outputArtifact), false);
    assert.equal(stdout.read(), "");
    assert.equal(JSON.parse(stderr.read()).diagnostic.source.kind, "artifact");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/plugin-development-operations/install-sends-canonical-path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-plugin-install-command-"));
  const artifactPath = join(directory, "plugin.tego");
  const stdout = capture();
  const stderr = capture();
  const requests: ControlClientOptions[] = [];
  try {
    await writeFile(artifactPath, "artifact-placeholder");
    const exitCode = await runCli({
      argv: [
        "plugin",
        "install",
        artifactPath,
        "--endpoint",
        "control.sock",
        "--json",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
      requestControl: async (request) => {
        requests.push(request);
        return response({
          digest: `sha256:${"a".repeat(64)}`,
          installedAt: "2026-07-25T00:00:00.000Z",
          manifest: {},
          pluginId: "org.example.echo",
          version: "1.0.0",
        });
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), "");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.operation, "plugin.install-path");
    assert.deepEqual(requests[0]?.input, { artifactPath: resolve(artifactPath) });
    assert.equal(isAbsolute((requests[0]?.input as { artifactPath: string }).artifactPath), true);
    assert.equal(JSON.parse(stdout.read()).pluginId, "org.example.echo");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/plugin-development-operations/deploy-and-status-use-canonical-input", async () => {
  const stdout = capture();
  const stderr = capture();
  const requests: ControlClientOptions[] = [];
  const digest = `sha256:${"b".repeat(64)}`;
  const requestControl = async (request: ControlClientOptions) => {
    requests.push(request);
    return response(request.input);
  };

  assert.equal(
    await runCli({
      argv: [
        "plugin",
        "deploy",
        "org.example.echo",
        "--digest",
        digest,
        "--application-id",
        "application-test",
        "--configuration",
        '{"enabled":true}',
        "--essential",
        "--json",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
      requestControl,
    }),
    0,
  );
  assert.equal(
    await runCli({
      argv: [
        "plugin",
        "status",
        "org.example.echo",
        "--application-id",
        "application-test",
        "--json",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
      requestControl,
    }),
    0,
  );

  assert.equal(stderr.read(), "");
  assert.deepEqual(
    requests.map(({ operation, input }) => ({ input, operation })),
    [
      {
        operation: "plugin.deploy",
        input: {
          applicationId: "application-test",
          pluginId: "org.example.echo",
          artifactDigest: digest,
          essential: true,
          configuration: { enabled: true },
          permissionGrants: [],
          capabilityBindings: {},
        },
      },
      {
        operation: "plugin.status",
        input: {
          applicationId: "application-test",
          pluginId: "org.example.echo",
        },
      },
    ],
  );
});
