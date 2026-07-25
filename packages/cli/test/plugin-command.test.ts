import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { JsonValue } from "@tegojs/contracts";
import type { ControlClientOptions } from "../src/control/client.js";
import type { ControlResponse } from "../src/control/protocol.js";
import { parseCommand } from "../src/parse-command.js";
import { packPlugin } from "../src/plugin/pack-plugin.js";
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

function response(
  result: Exclude<ControlResponse["result"], undefined>,
  requestId = "request-plugin-command-test",
): ControlResponse {
  return {
    protocolVersion: "1.0",
    requestId,
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

async function createPackFixture() {
  const directory = await mkdtemp(join(tmpdir(), "tego-plugin-path-command-"));
  const pluginDirectory = join(directory, "plugin");
  await mkdir(join(pluginDirectory, "build"), { recursive: true });
  await writeFile(
    join(pluginDirectory, "manifest.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      pluginId: "org.example.path-test",
      version: "1.0.0",
      contractRange: "^1.0.0",
      nodeRange: ">=26.0.0",
      moduleFormat: "esm",
      components: [
        {
          componentId: "echo",
          kind: "task",
          entrypoint: "component.js",
          executors: ["thread"],
        },
      ],
      permissions: [],
      capabilities: { provides: [], requires: [] },
    }),
  );
  await writeFile(
    join(pluginDirectory, "build", "component.js"),
    "export default { async run(_context, input) { return input; } };\n",
  );
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyText = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const privateKeyPath = join(directory, "private.pem");
  await writeFile(privateKeyPath, privateKeyText);
  return { directory, pluginDirectory, privateKeyPath, privateKeyText };
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

test("@spec:runtime-operations/plugin-development-operations/pack-can-reuse-a-build", () => {
  const command = parseCommand(["plugin", "pack", ".", "--no-build"]);
  assert.equal(command.kind, "plugin.pack");
  assert.equal(command.build, false);
});

test("@spec:runtime-operations/plugin-development-operations/validate-and-inspect-locally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-plugin-inspect-command-"));
  const artifactPath = join(directory, "echo.tego");
  const validateStdout = capture();
  const inspectStdout = capture();
  const stderr = capture();
  try {
    const pluginDirectory = resolve("../..", "examples/echo-plugin");
    await packPlugin({ artifactPath, pluginDirectory });

    assert.equal(
      await runCli({
        argv: ["plugin", "validate", pluginDirectory, "--json"],
        stdout: validateStdout.stream,
        stderr: stderr.stream,
      }),
      0,
    );
    assert.equal(
      await runCli({
        argv: ["plugin", "inspect", artifactPath],
        stdout: inspectStdout.stream,
        stderr: stderr.stream,
      }),
      0,
    );

    assert.equal(stderr.read(), "");
    assert.equal(JSON.parse(validateStdout.read()).valid, true);
    const inspected = JSON.parse(inspectStdout.read());
    assert.equal(inspected.manifest.pluginId, "org.example.echo");
    assert.match(inspected.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(inspected.files.files.length > 0);
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
      argv: ["plugin", "install", artifactPath, "--endpoint", "control.sock", "--json"],
      stdout: stdout.stream,
      stderr: stderr.stream,
      requestControl: async (request) => {
        requests.push(request);
        return response(
          {
            digest: `sha256:${"a".repeat(64)}`,
            installedAt: "2026-07-25T00:00:00.000Z",
            manifest: {
              schemaVersion: "1.0",
              pluginId: "org.example.echo",
              version: "1.0.0",
              contractRange: "^1.0.0",
              nodeRange: ">=26.0.0",
              moduleFormat: "esm",
              components: [
                {
                  componentId: "echo",
                  kind: "task",
                  entrypoint: "component.js",
                  executors: ["thread"],
                },
              ],
              permissions: [],
              capabilities: { provides: [], requires: [] },
            },
            pluginId: "org.example.echo",
            version: "1.0.0",
          },
          request.requestId,
        );
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), "");
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.operation, "plugin.install-path");
    assert.deepEqual(request.input, { artifactPath: await realpath(artifactPath) });
    assert.equal(isAbsolute((request.input as { artifactPath: string }).artifactPath), true);
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
    if (request.operation === "plugin.deploy") {
      return response(
        {
          ...(request.input as Record<string, JsonValue>),
          version: "1.0.0",
          generation: "1",
          state: "active",
        },
        request.requestId,
      );
    }
    return response(
      {
        identity: request.input,
        observation: { state: "running" },
      },
      request.requestId,
    );
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

test("@spec:runtime-operations/plugin-development-operations/reject-invalid-deploy-before-control", async () => {
  const stdout = capture();
  const stderr = capture();
  let requests = 0;
  const exitCode = await runCli({
    argv: ["plugin", "deploy", "org.example.echo", "--digest", "not-a-digest", "--json"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestControl: async () => {
      requests += 1;
      return response(null);
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(requests, 0);
  assert.equal(stdout.read(), "");
  assert.equal(JSON.parse(stderr.read()).diagnostic.code, "PROTOCOL_COMMAND_INVALID");
});

test("@spec:runtime-operations/plugin-development-operations/human-and-json-use-one-result", async () => {
  const jsonStdout = capture();
  const humanStdout = capture();
  const stderr = capture();
  const result = {
    identity: {
      applicationId: "application-default",
      pluginId: "org.example.echo",
    },
    observation: { state: "running" },
  };
  const requestControl = async (request: ControlClientOptions) =>
    response(result, request.requestId);

  assert.equal(
    await runCli({
      argv: ["plugin", "status", "org.example.echo", "--json"],
      stdout: jsonStdout.stream,
      stderr: stderr.stream,
      requestControl,
    }),
    0,
  );
  assert.equal(
    await runCli({
      argv: ["plugin", "status", "org.example.echo"],
      stdout: humanStdout.stream,
      stderr: stderr.stream,
      requestControl,
    }),
    0,
  );

  assert.equal(stderr.read(), "");
  assert.deepEqual(JSON.parse(humanStdout.read()), JSON.parse(jsonStdout.read()));
});

test("@spec:runtime-operations/plugin-development-operations/rejects-lexical-output-collisions-before-write", async () => {
  const fixture = await createPackFixture();
  const stderr = capture();
  const artifactPath = join(fixture.directory, "plugin.tego");
  try {
    const signatureCollision = await runCli({
      argv: [
        "plugin",
        "pack",
        fixture.pluginDirectory,
        "--no-build",
        "--output",
        artifactPath,
        "--private-key",
        fixture.privateKeyPath,
        "--key-id",
        "test-key",
        "--signature-output",
        artifactPath,
        "--json",
      ],
      stderr: stderr.stream,
    });
    assert.equal(signatureCollision, 1);
    assert.equal(await exists(artifactPath), false);
    assert.equal(await readFile(fixture.privateKeyPath, "utf8"), fixture.privateKeyText);

    const keyCollision = await runCli({
      argv: [
        "plugin",
        "pack",
        fixture.pluginDirectory,
        "--no-build",
        "--output",
        fixture.privateKeyPath,
        "--private-key",
        fixture.privateKeyPath,
        "--key-id",
        "test-key",
        "--json",
      ],
      stderr: stderr.stream,
    });
    assert.equal(keyCollision, 1);
    assert.equal(await readFile(fixture.privateKeyPath, "utf8"), fixture.privateKeyText);
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/plugin-development-operations/rejects-hardlink-output-collision-before-write", async () => {
  const fixture = await createPackFixture();
  const artifactPath = join(fixture.directory, "artifact-alias.tego");
  const stderr = capture();
  try {
    await link(fixture.privateKeyPath, artifactPath);
    const exitCode = await runCli({
      argv: [
        "plugin",
        "pack",
        fixture.pluginDirectory,
        "--no-build",
        "--output",
        artifactPath,
        "--private-key",
        fixture.privateKeyPath,
        "--key-id",
        "test-key",
        "--json",
      ],
      stderr: stderr.stream,
    });

    assert.equal(exitCode, 1);
    assert.equal(await readFile(fixture.privateKeyPath, "utf8"), fixture.privateKeyText);
    assert.equal(await readFile(artifactPath, "utf8"), fixture.privateKeyText);
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/plugin-development-operations/rejects-canonical-parent-alias-before-write", {
  skip: process.platform === "win32" ? "directory symlink contract runs on Unix" : false,
}, async () => {
  const fixture = await createPackFixture();
  const outputDirectory = join(fixture.directory, "output");
  const outputAlias = join(fixture.directory, "output-alias");
  const artifactPath = join(outputDirectory, "plugin.tego");
  const signaturePath = join(outputAlias, "plugin.tego");
  const stderr = capture();
  try {
    await mkdir(outputDirectory);
    await symlink(outputDirectory, outputAlias, "dir");
    const exitCode = await runCli({
      argv: [
        "plugin",
        "pack",
        fixture.pluginDirectory,
        "--no-build",
        "--output",
        artifactPath,
        "--private-key",
        fixture.privateKeyPath,
        "--key-id",
        "test-key",
        "--signature-output",
        signaturePath,
        "--json",
      ],
      stderr: stderr.stream,
    });

    assert.equal(exitCode, 1);
    assert.equal(await exists(artifactPath), false);
    assert.equal(await readFile(fixture.privateKeyPath, "utf8"), fixture.privateKeyText);
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/plugin-development-operations/rejects-dangling-symlink-output-alias-before-write", {
  skip: process.platform === "win32" ? "file symlink contract runs on Unix" : false,
}, async () => {
  const fixture = await createPackFixture();
  const artifactPath = join(fixture.directory, "plugin.tego");
  const signaturePath = join(fixture.directory, "signature-link");
  const stdout = capture();
  const stderr = capture();
  try {
    await symlink("plugin.tego", signaturePath, "file");
    const exitCode = await runCli({
      argv: [
        "plugin",
        "pack",
        fixture.pluginDirectory,
        "--no-build",
        "--output",
        artifactPath,
        "--private-key",
        fixture.privateKeyPath,
        "--key-id",
        "test-key",
        "--signature-output",
        signaturePath,
        "--json",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(exitCode, 1);
    assert.equal(stdout.read(), "");
    assert.equal(await exists(artifactPath), false);
    assert.equal(await readFile(fixture.privateKeyPath, "utf8"), fixture.privateKeyText);
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("@spec:runtime-operations/plugin-development-operations/rejects-mismatched-plugin-identities", async () => {
  const digest = `sha256:${"c".repeat(64)}`;
  for (const command of ["deploy", "status"] as const) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli({
      argv:
        command === "deploy"
          ? [
              "plugin",
              "deploy",
              "org.example.echo",
              "--digest",
              digest,
              "--application-id",
              "application-test",
              "--json",
            ]
          : [
              "plugin",
              "status",
              "org.example.echo",
              "--application-id",
              "application-test",
              "--json",
            ],
      stdout: stdout.stream,
      stderr: stderr.stream,
      requestControl: async (request) =>
        command === "deploy"
          ? response(
              {
                ...(request.input as Record<string, JsonValue>),
                applicationId: "application-other",
                version: "1.0.0",
                generation: "1",
                state: "active",
              },
              request.requestId,
            )
          : response(
              {
                identity: {
                  applicationId: "application-other",
                  pluginId: "org.example.echo",
                },
              },
              request.requestId,
            ),
    });

    assert.equal(exitCode, 1, command);
    assert.equal(stdout.read(), "");
    assert.equal(JSON.parse(stderr.read()).diagnostic.code, "PROTOCOL_CONTROL_REQUEST_MISMATCH");
  }
});

test("@spec:runtime-operations/plugin-development-operations/rejects-mismatched-plugin-artifact-and-desired-identity", async () => {
  const requestedDigest = `sha256:${"d".repeat(64)}`;
  const otherDigest = `sha256:${"e".repeat(64)}`;
  for (const command of ["deploy", "status"] as const) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli({
      argv:
        command === "deploy"
          ? [
              "plugin",
              "deploy",
              "org.example.echo",
              "--digest",
              requestedDigest,
              "--application-id",
              "application-test",
              "--json",
            ]
          : [
              "plugin",
              "status",
              "org.example.echo",
              "--application-id",
              "application-test",
              "--json",
            ],
      stdout: stdout.stream,
      stderr: stderr.stream,
      requestControl: async (request) =>
        command === "deploy"
          ? response(
              {
                ...(request.input as Record<string, JsonValue>),
                artifactDigest: otherDigest,
                version: "1.0.0",
                generation: "1",
                state: "active",
              },
              request.requestId,
            )
          : response(
              {
                identity: request.input,
                desired: {
                  applicationId: "application-other",
                  pluginId: "org.example.echo",
                  version: "1.0.0",
                  artifactDigest: requestedDigest,
                  generation: "1",
                  state: "active",
                  essential: false,
                  configuration: {},
                  permissionGrants: [],
                  capabilityBindings: {},
                },
              },
              request.requestId,
            ),
    });

    assert.equal(exitCode, 1, command);
    assert.equal(stdout.read(), "");
    assert.equal(JSON.parse(stderr.read()).diagnostic.code, "PROTOCOL_CONTROL_REQUEST_MISMATCH");
  }
});
