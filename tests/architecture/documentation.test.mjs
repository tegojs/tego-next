import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const documents = {
  architecture: "docs/architecture/runtime-kernel.md",
  contributor: "docs/guides/contributing-and-plugins.md",
  operations: "docs/operations/deployment-topologies.md",
  security: "docs/security/threat-model.md",
};

async function read(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

test("@spec:runtime-operations/layer-one-dependency-boundary/architecture-documentation", async () => {
  const architecture = await read(documents.architecture);
  for (const heading of [
    "## Scope and forbidden APIs",
    "## Package graph and dependency direction",
    "## Runtime topology",
    "## State machines",
    "### Deployment state",
    "### Runtime lifecycle",
    "### Component lifecycle",
    "### Task lifecycle",
    "### Worker session and remote attempt lifecycle",
    "## Persistence, revisions, and fencing",
    "## Worker protocol compatibility and recovery",
    "## Failure, indeterminate, and recovery semantics",
  ]) {
    assert.match(architecture, new RegExp(`^${heading}$`, "mu"));
  }
  for (const marker of [
    "Tego 1.x",
    "HTTP routing",
    "authentication",
    "ACL",
    "cache",
    "workflow",
    "datasource",
    "unknown",
    "indeterminate",
    "finish-and-buffer",
    "finish-and-persist",
    "PROTOCOL_VERSION_UNSUPPORTED",
  ]) {
    assert.match(architecture, new RegExp(marker, "u"));
  }
});

test("@spec:runtime-operations/layer-one-dependency-boundary/package-graph-documentation", async () => {
  const architecture = await read(documents.architecture);
  for (const packageName of [
    "@tegojs/contracts",
    "@tegojs/runtime",
    "@tegojs/drivers-local",
    "@tegojs/drivers-postgres",
    "@tegojs/executor-node",
    "@tegojs/transport-websocket",
    "@tegojs/plugin-sdk",
    "@tegojs/testkit",
    "@tegojs/cli",
  ]) {
    assert.match(architecture, new RegExp(packageName.replaceAll("/", "\\/"), "u"));
  }
});

test("@spec:runtime-operations/reproducible-development-environment/contributor-documentation", async () => {
  const contributor = await read(documents.contributor);
  for (const heading of [
    "## Exact toolchain setup",
    "## OpenSpec-linked red-green-refactor",
    "## Verification commands",
    "## Author a plugin",
    "### Component",
    "### Manifest",
    "### Validate and package",
    "### Sign during packaging",
    "### Install and deploy",
    "### Run and inspect a task",
    "## Current CLI limitations",
  ]) {
    assert.match(contributor, new RegExp(`^${heading}$`, "mu"));
  }
  for (const marker of [
    "Node.js 26.5.0",
    "npm 11.13.0",
    "npm ci",
    "npm run openspec:validate",
    "npm run verify",
    "npm run verify:release",
    "@spec:",
    "RED",
    "GREEN",
    "REFACTOR",
  ]) {
    assert.match(contributor, new RegExp(marker, "u"));
  }
});

test("@spec:runtime-operations/plugin-development-operations/current-cli-workflow", async () => {
  const source = Object.values(documents).map((path) => read(path));
  const documentation = (await Promise.all(source)).join("\n");
  for (const command of [
    "runtime start",
    "runtime snapshot",
    "runtime status",
    "runtime stop",
    "plugin validate",
    "plugin pack",
    "plugin inspect",
    "plugin install",
    "plugin deploy",
    "plugin status",
    "task run",
    "task status",
    "task wait",
    "task cancel",
    "worker start",
  ]) {
    assert.match(documentation, new RegExp(command, "u"));
  }
});

test("@spec:runtime-bootstrap/durable-restart-recovery/deployment-documentation", async () => {
  const operations = await read(documents.operations);
  for (const heading of [
    "## Current support boundary",
    "## Embedded single-Main",
    "### Topology and local storage",
    "### Start, inspect, and stop",
    "### Artifact and deployment lifecycle",
    "## Multi-Main with PostgreSQL",
    "### Topology and shared state",
    "### Start two Mains",
    "### Leader and follower operations",
    "### Worker connectivity",
    "### Takeover and recovery",
    "## Production gate and deferred deployment capabilities",
  ]) {
    assert.match(operations, new RegExp(`^${heading}$`, "mu"));
  }
  for (const marker of [
    "state.sqlite",
    "single-main",
    "multi-main",
    "--postgres-url",
    "follower",
    "fencing epoch",
    "production release remains blocked until Node.js 26 enters LTS",
  ]) {
    assert.match(operations, new RegExp(marker, "iu"));
  }
});

test("@spec:plugin-deployment/pre-execution-deployment-gate/threat-model-documentation", async () => {
  const security = await read(documents.security);
  for (const heading of [
    "## Security posture and trust boundaries",
    "## Permission model and limits",
    "## Thread, process, and remote isolation",
    "## Secrets",
    "## Network exposure",
    "## Deferred security capabilities",
  ]) {
    assert.match(security, new RegExp(`^${heading}$`, "mu"));
  }
  for (const marker of [
    "not a security boundary",
    "not an operating-system sandbox",
    "bootstrap credential",
    "development-only",
    "capability",
    "executor",
    "filesystem",
    "network",
    "secret",
    "environment",
    "Worker",
  ]) {
    assert.match(security, new RegExp(marker, "iu"));
  }
});

test("documentation navigation and local links resolve", async () => {
  const readme = await read("README.md");
  for (const path of Object.values(documents)) {
    assert.match(readme, new RegExp(`\\(${path.replaceAll("/", "\\/")}\\)`, "u"));
  }

  for (const path of Object.values(documents)) {
    const source = await read(path);
    const links = [...source.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu)];
    assert.ok(links.length > 0, `${path} must link to another maintained document`);
    for (const link of links) {
      const target = resolve(dirname(resolve(root, path)), link[1]);
      await assert.doesNotReject(readFile(target));
    }
  }
});

test("documentation does not advertise absent commands, flags, or production readiness", async () => {
  const documentation = (
    await Promise.all(["README.md", ...Object.values(documents)].map((path) => read(path)))
  ).join("\n");
  for (const falseClaim of [
    /\btego plugin sign\b/iu,
    /\btego plugin uninstall\b/iu,
    /\btego runtime recover\b/iu,
    /\btego worker status\b/iu,
    /--worker-(?:port|url)\b/iu,
    /\bNode(?:\.js)? 26 is LTS\b/iu,
    /\bcurrently production[- ]ready\b/iu,
  ]) {
    assert.doesNotMatch(documentation, falseClaim);
  }
});
