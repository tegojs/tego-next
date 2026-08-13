import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packWorkspaceSet } from "./package-contract.mjs";
import { resolveNpmCli } from "./run-ci-test.mjs";
import {
  parseRecordedReleaseEvidence,
  validateRecordedReleaseEvidence,
  validateReleaseEvidenceTarget,
} from "./verify-release.mjs";

export const ALPHA_VERSION = "2.0.0-alpha.1";
export const NPM_REGISTRY = "https://registry.npmjs.org/";

const EXPECTED_NODE_VERSION = "v26.5.0";
const EXPECTED_NPM_VERSION = "11.13.0";
const RELEASE_TAG = `v${ALPHA_VERSION}`;
const RELEASE_MANIFEST = "release-manifest.json";
const RELEASE_NAMES = Object.freeze([
  "@tego/cli",
  "@tego/contracts",
  "@tego/drivers-local",
  "@tego/drivers-postgres",
  "@tego/executor-node",
  "@tego/plugin-sdk",
  "@tego/runtime",
  "@tego/testkit",
  "@tego/transport-websocket",
]);
const INTERNAL_DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = resolveNpmCli();
const preflightReceipts = new WeakMap();

function fail(message) {
  throw new Error(message);
}

function stringMap(value, label) {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const result = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string") fail(`${label}.${name} must be a string`);
    result[name] = version;
  }
  return result;
}

function dependenciesFor(manifest) {
  const result = {};
  for (const field of INTERNAL_DEPENDENCY_FIELDS) {
    for (const [name, version] of Object.entries(stringMap(manifest[field], field))) {
      if (!name.startsWith("@tego/")) continue;
      if (Object.hasOwn(result, name)) fail(`${manifest.name} declares ${name} more than once`);
      result[name] = version;
    }
  }
  return result;
}

function assertReleasePackage(expected) {
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    fail("release package must be an object");
  }
  if (typeof expected.name !== "string" || !expected.name.startsWith("@tego/")) {
    fail("release package has an invalid name");
  }
  if (expected.version !== ALPHA_VERSION) {
    fail(`${expected.name} must use ${ALPHA_VERSION}`);
  }
  for (const [name, version] of Object.entries(dependenciesFor(expected))) {
    if (version !== ALPHA_VERSION) {
      fail(`${expected.name} must pin internal dependency ${name} to ${ALPHA_VERSION}`);
    }
  }
}

function assertCompleteReleaseSet(packages) {
  const actual = packages.map(({ name }) => name).toSorted();
  const expected = RELEASE_NAMES.toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`release package set must be exactly: ${RELEASE_NAMES.join(", ")}`);
  }
}

export function releaseOrder(manifests) {
  if (!Array.isArray(manifests) || manifests.length === 0) fail("release manifests are required");
  const byName = new Map();
  for (const manifest of manifests) {
    assertReleasePackage(manifest);
    if (byName.has(manifest.name)) fail(`duplicate release package: ${manifest.name}`);
    byName.set(manifest.name, manifest);
  }

  const dependencies = new Map();
  const dependants = new Map([...byName.keys()].map((name) => [name, []]));
  for (const manifest of manifests) {
    const internal = Object.keys(dependenciesFor(manifest));
    for (const dependency of internal) {
      if (!byName.has(dependency)) {
        fail(`${manifest.name} has unknown internal dependency ${dependency}`);
      }
      dependants.get(dependency).push(manifest.name);
    }
    dependencies.set(manifest.name, new Set(internal));
  }

  const ready = [...byName.keys()]
    .filter((name) => dependencies.get(name).size === 0)
    .toSorted((left, right) => {
      if (left === "@tego/contracts") return -1;
      if (right === "@tego/contracts") return 1;
      if (left === "@tego/cli") return 1;
      if (right === "@tego/cli") return -1;
      return left.localeCompare(right);
    });
  const ordered = [];
  while (ready.length > 0) {
    const name = ready.shift();
    ordered.push(byName.get(name));
    for (const dependant of dependants.get(name).toSorted()) {
      const remaining = dependencies.get(dependant);
      remaining.delete(name);
      if (remaining.size === 0) {
        ready.push(dependant);
        ready.sort((left, right) => {
          if (left === "@tego/cli") return 1;
          if (right === "@tego/cli") return -1;
          return left.localeCompare(right);
        });
      }
    }
  }
  if (ordered.length !== manifests.length) fail("release dependency graph contains a cycle");
  if (byName.has("@tego/contracts") && ordered[0]?.name !== "@tego/contracts") {
    fail("release order must begin with @tego/contracts");
  }
  if (byName.has("@tego/cli") && ordered.at(-1)?.name !== "@tego/cli") {
    fail("release order must end with @tego/cli");
  }
  return ordered;
}

function tagsFor(actual) {
  return actual?.["dist-tags"] ?? actual?.distTags ?? {};
}

function assertNoLatest(name, tags) {
  if (Object.hasOwn(tags, "latest")) {
    fail(`${name} already has a latest dist-tag; the alpha release fails closed`);
  }
}

function assertExactInternalDependencies(expected, actual) {
  for (const field of INTERNAL_DEPENDENCY_FIELDS) {
    const expectedDependencies = Object.fromEntries(
      Object.entries(stringMap(expected[field], `${expected.name}.${field}`)).filter(([name]) =>
        name.startsWith("@tego/"),
      ),
    );
    const actualDependencies = Object.fromEntries(
      Object.entries(stringMap(actual[field], `${actual.name}.${field}`)).filter(([name]) =>
        name.startsWith("@tego/"),
      ),
    );
    const expectedEntries = Object.entries(expectedDependencies).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    const actualEntries = Object.entries(actualDependencies).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
      fail(`${expected.name} registry internal dependencies do not match for ${field}`);
    }
  }
}

export function validateRegistryState(expected, actual) {
  assertReleasePackage(expected);
  if (actual === null || actual === undefined) return { action: "publish" };
  if (actual.name !== expected.name || actual.version !== expected.version) {
    fail(`${expected.name} registry identity does not match the release manifest`);
  }
  if ((actual.dist?.integrity ?? actual["dist.integrity"]) !== expected.integrity) {
    fail(`${expected.name} registry integrity does not match the local tarball`);
  }
  const tags = stringMap(tagsFor(actual), `${expected.name} dist-tags`);
  assertNoLatest(expected.name, tags);
  if (tags.alpha !== ALPHA_VERSION) {
    fail(`${expected.name} existing version does not have alpha -> ${ALPHA_VERSION}`);
  }
  assertExactInternalDependencies(expected, actual);
  return { action: "skip" };
}

function commandResult(result, label) {
  if (typeof result !== "object" || result === null) fail(`${label} returned no result`);
  return {
    exitCode: result.exitCode,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

async function run(adapters, command, args) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    fail(`unsafe non-array arguments for ${command}`);
  }
  if (typeof adapters.run !== "function") fail(`command adapter is required for ${command}`);
  return commandResult(await adapters.run(command, args), `${command} ${args.join(" ")}`);
}

function requireSuccess(result, message) {
  if (result.exitCode !== 0) fail(`${message}: ${result.stderr.trim() || "command failed"}`);
  return result.stdout.trim();
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(
      `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRegistryNotFound(result) {
  return (
    result.exitCode !== 0 && /(?:E404|404 Not Found)/iu.test(`${result.stdout}\n${result.stderr}`)
  );
}

async function queryRegistryState(adapters, expected) {
  if (typeof adapters.registryState === "function") {
    return await adapters.registryState(expected.name, expected.version);
  }
  const result = await run(adapters, "npm", [
    "view",
    `${expected.name}@${expected.version}`,
    "name",
    "version",
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "dist.integrity",
    "dist-tags",
    "--json",
    "--registry",
    NPM_REGISTRY,
  ]);
  if (isRegistryNotFound(result)) return null;
  return parseJson(requireSuccess(result, `could not inspect ${expected.name}`), expected.name);
}

async function queryRegistryTags(adapters, expected, actual) {
  if (typeof adapters.registryTags === "function") {
    return stringMap(await adapters.registryTags(expected.name), `${expected.name} dist-tags`);
  }
  if (typeof adapters.registryState === "function") {
    return stringMap(tagsFor(actual), `${expected.name} dist-tags`);
  }
  const result = await run(adapters, "npm", [
    "view",
    expected.name,
    "dist-tags",
    "--json",
    "--registry",
    NPM_REGISTRY,
  ]);
  if (isRegistryNotFound(result)) return {};
  return stringMap(
    parseJson(
      requireSuccess(result, `could not inspect ${expected.name} dist-tags`),
      expected.name,
    ),
    `${expected.name} dist-tags`,
  );
}

async function registryDecision(adapters, expected) {
  const actual = await queryRegistryState(adapters, expected);
  const tags = await queryRegistryTags(adapters, expected, actual);
  assertNoLatest(expected.name, tags);
  return validateRegistryState(expected, actual === null ? null : { ...actual, "dist-tags": tags });
}

function validateScopeAccess(output) {
  const permissions = parseJson(output, "npm access");
  if (
    typeof permissions !== "object" ||
    permissions === null ||
    Array.isArray(permissions) ||
    !Object.values(permissions).includes("read-write")
  ) {
    fail("authenticated npm identity does not have publish access to @tego");
  }
}

function validateEvidence(evidence) {
  const errors = validateRecordedReleaseEvidence(evidence);
  if (errors.length > 0) fail(`release evidence is not green for HEAD: ${errors.join("; ")}`);
}

function releaseFingerprint(packages, targetSha) {
  return JSON.stringify({
    targetSha,
    packages: releaseOrder(packages).map((expected) => ({
      name: expected.name,
      version: expected.version,
      integrity: expected.integrity,
      tarball: expected.tarball,
      internalDependencies: dependenciesFor(expected),
    })),
  });
}

function adapterSession(adapters) {
  return {
    publish: adapters.publish,
    registryState: adapters.registryState,
    registryTags: adapters.registryTags,
    run: adapters.run,
    snapshotCheckpoint: adapters.snapshotCheckpoint,
  };
}

function sameAdapterSession(actual, expected) {
  return Object.keys(expected).every((field) => actual[field] === expected[field]);
}

async function validateTagAndReleaseState(adapters, head) {
  const localTag = await run(adapters, "git", [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/tags/${RELEASE_TAG}`,
  ]);
  if (localTag.exitCode === 0) {
    const localTarget = requireSuccess(
      await run(adapters, "git", ["rev-list", "-n", "1", RELEASE_TAG]),
      `could not resolve local ${RELEASE_TAG}`,
    );
    if (localTarget !== head) fail(`${RELEASE_TAG} conflicts with the release HEAD`);
  } else if (localTag.exitCode !== 1) {
    fail(`could not inspect local ${RELEASE_TAG}`);
  }

  const remoteTag = await run(adapters, "git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${RELEASE_TAG}`,
    `refs/tags/${RELEASE_TAG}^{}`,
  ]);
  const remoteOutput = requireSuccess(remoteTag, `could not inspect remote ${RELEASE_TAG}`);
  if (remoteOutput !== "") {
    const targets = remoteOutput
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .filter(([, ref]) => ref?.endsWith("^{}"))
      .map(([sha]) => sha);
    const resolved = targets.at(-1) ?? remoteOutput.split(/\s+/u)[0];
    if (resolved !== head) fail(`remote ${RELEASE_TAG} conflicts with the release HEAD`);
  }

  const githubRelease = await run(adapters, "gh", [
    "release",
    "view",
    RELEASE_TAG,
    "--repo",
    "tegojs/tego-next",
    "--json",
    "tagName,targetCommitish,isPrerelease",
  ]);
  if (githubRelease.exitCode === 0) {
    const release = parseJson(githubRelease.stdout, "GitHub release");
    if (
      release.tagName !== RELEASE_TAG ||
      release.isPrerelease !== true ||
      ![head, RELEASE_TAG].includes(release.targetCommitish)
    ) {
      fail(`GitHub release ${RELEASE_TAG} conflicts with the release HEAD`);
    }
  } else if (!/(?:404|release not found)/iu.test(githubRelease.stderr)) {
    fail(`could not inspect GitHub release ${RELEASE_TAG}: ${githubRelease.stderr.trim()}`);
  }
}

export async function preflightRelease(adapters) {
  if (adapters.registry !== NPM_REGISTRY) fail("release requires the official npm registry");
  if (adapters.nodeVersion !== EXPECTED_NODE_VERSION) {
    fail(`release requires Node.js ${EXPECTED_NODE_VERSION.slice(1)}`);
  }
  const packages = releaseOrder(adapters.packages);
  assertCompleteReleaseSet(packages);

  const npmVersion = requireSuccess(await run(adapters, "npm", ["--version"]), "npm failed");
  if (npmVersion !== EXPECTED_NPM_VERSION) fail(`release requires npm ${EXPECTED_NPM_VERSION}`);
  const gitStatus = requireSuccess(
    await run(adapters, "git", ["status", "--porcelain=v1"]),
    "could not inspect Git status",
  );
  if (gitStatus !== "") fail("release requires a clean Git worktree");
  const head = requireSuccess(
    await run(adapters, "git", ["rev-parse", "HEAD"]),
    "could not resolve Git HEAD",
  );
  if (!/^[0-9a-f]{40}$/u.test(head)) fail("Git HEAD must be a full commit SHA");
  validateEvidence(adapters.releaseEvidence);
  const targetSha = adapters.releaseEvidence.targetSha;
  if (typeof adapters.validateEvidenceTarget === "function") {
    await adapters.validateEvidenceTarget(adapters.releaseEvidence, head);
  } else if (targetSha !== head) {
    fail("release evidence target SHA differs from HEAD without ancestry validation");
  }

  const identity = requireSuccess(
    await run(adapters, "npm", ["whoami", "--registry", NPM_REGISTRY]),
    "could not establish npm identity",
  );
  if (identity === "") fail("could not establish npm identity");
  const scopeAccess = requireSuccess(
    await run(adapters, "npm", [
      "access",
      "list",
      "packages",
      "@tego",
      "--json",
      "--registry",
      NPM_REGISTRY,
    ]),
    "could not inspect @tego scope access",
  );
  validateScopeAccess(scopeAccess);

  const decisions = [];
  const registryFailures = [];
  for (const expected of packages) {
    try {
      decisions.push({ name: expected.name, ...(await registryDecision(adapters, expected)) });
    } catch (error) {
      registryFailures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (registryFailures.length > 0) {
    fail(`registry preflight failed:\n${registryFailures.join("\n")}`);
  }
  await validateTagAndReleaseState(adapters, head);
  const receipt = Object.freeze({});
  preflightReceipts.set(receipt, {
    adapters,
    fingerprint: releaseFingerprint(packages, targetSha),
    session: adapterSession(adapters),
    targetSha,
  });
  return { targetSha, identity, packages: decisions, receipt };
}

export async function publishAlpha(adapters) {
  const receiptState = preflightReceipts.get(adapters.preflightReceipt);
  preflightReceipts.delete(adapters.preflightReceipt);
  const packages = releaseOrder(adapters.packages);
  assertCompleteReleaseSet(packages);
  if (
    receiptState === undefined ||
    receiptState.adapters !== adapters ||
    !sameAdapterSession(adapters, receiptState.session) ||
    receiptState.fingerprint !== releaseFingerprint(packages, receiptState.targetSha)
  ) {
    fail("npm publication requires an unforgeable preflight receipt from the same invocation");
  }
  const published = [];
  const skipped = [];
  for (const expected of packages) {
    const decision = await registryDecision(adapters, expected);
    if (decision.action === "skip") {
      skipped.push(expected.name);
      continue;
    }
    if (typeof expected.tarball !== "string" || expected.tarball === "") {
      fail(`${expected.name} has no packed tarball`);
    }
    const snapshotDirectory = await createPrivateDirectory("tego-alpha-publish-");
    let primaryError;
    try {
      const snapshot = await createPublishSnapshot(
        expected,
        snapshotDirectory,
        adapters.snapshotCheckpoint,
      );
      const args = [
        "publish",
        snapshot,
        "--registry",
        NPM_REGISTRY,
        "--access",
        "public",
        "--tag",
        "alpha",
      ];
      const result =
        typeof adapters.publish === "function"
          ? commandResult(await adapters.publish(expected, "npm", args), `${expected.name} publish`)
          : await run(adapters, "npm", args);
      requireSuccess(result, `could not publish ${expected.name}`);
      published.push(expected.name);
    } catch (error) {
      primaryError = error;
    }
    let cleanupError;
    try {
      await rm(snapshotDirectory, { force: true, recursive: true });
    } catch (error) {
      cleanupError = error;
    }
    if (primaryError !== undefined) {
      if (primaryError instanceof Error && cleanupError !== undefined) {
        primaryError.cleanupError = cleanupError;
      }
      throw primaryError;
    }
    if (cleanupError !== undefined) throw cleanupError;
  }
  return { published, skipped };
}

export async function verifyRegistryRelease(adapters) {
  const packages = releaseOrder(adapters.packages);
  assertCompleteReleaseSet(packages);
  const verified = [];
  const failures = [];
  for (const expected of packages) {
    try {
      const decision = await registryDecision(adapters, expected);
      if (decision.action !== "skip") fail(`${expected.name}@${ALPHA_VERSION} is missing from npm`);
      verified.push(expected.name);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) fail(`registry release verification failed:\n${failures.join("\n")}`);
  return { packages: verified };
}

function safeArtifactDirectory(directory) {
  const absolute = resolve(directory);
  if (absolute === resolve("/") || absolute === resolve(root)) {
    fail("artifact directory must not be the filesystem or repository root");
  }
  return absolute;
}

function permissionBits(stats) {
  return Number(stats.mode) & 0o777;
}

async function secureArtifactDirectory(directory) {
  const absolute = safeArtifactDirectory(directory);
  await mkdir(absolute, { mode: 0o700, recursive: true });
  let handle;
  try {
    handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isDirectory()) fail("artifact directory must be a real directory, not a symlink");
    await handle.chmod(0o700);
    const after = await handle.stat({ bigint: true });
    if (!after.isDirectory() || permissionBits(after) !== 0o700) {
      fail("artifact directory must be an owner-only real directory");
    }
    await verifyPathStillNamesDirectory(absolute, after);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("artifact directory")) throw error;
    fail("artifact directory must be an owner-only real directory, not a symlink");
  } finally {
    await handle?.close().catch(() => {});
  }
  return absolute;
}

async function createPrivateDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await secureArtifactDirectory(directory);
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

function relativeTarball(artifactDirectory, tarball) {
  const path = relative(artifactDirectory, resolve(tarball));
  if (path === "" || path.startsWith("..") || isAbsolute(path) || path !== basename(path)) {
    fail(`packed tarball must be directly beneath the artifact directory: ${tarball}`);
  }
  return path;
}

function sameFileIdentityAndState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function verifyPathStillNamesDirectory(path, initial) {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch {
    fail("artifact directory changed while it was being secured");
  }
  if (
    !current.isDirectory() ||
    current.dev !== initial.dev ||
    current.ino !== initial.ino ||
    permissionBits(current) !== 0o700
  ) {
    fail("artifact directory changed or became a symlink while it was being secured");
  }
}

async function openRegular(path, label, flags = constants.O_RDONLY) {
  let handle;
  try {
    handle = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) fail(`${label} must be a regular file, not a symlink`);
    return { handle, stats };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    fail(`${label} must be a readable regular file, not a symlink`);
  }
}

async function hashHandle(handle, stats, label) {
  if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} is too large to verify safely`);
  const hash = createHash("sha512");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < Number(stats.size)) {
    const length = Math.min(buffer.length, Number(stats.size) - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) fail(`${label} changed while it was being read`);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return `sha512-${hash.digest("base64")}`;
}

async function verifyPathStillNamesFile(path, initial, label) {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch {
    fail(`${label} changed while it was being verified`);
  }
  if (!current.isFile() || !sameFileIdentityAndState(initial, current)) {
    fail(`${label} changed or became a symlink while it was being verified`);
  }
}

async function sha512RegularFile(path, label) {
  const { handle, stats: before } = await openRegular(path, label);
  try {
    const integrity = await hashHandle(handle, before, label);
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentityAndState(before, after)) {
      fail(`${label} changed while it was being verified`);
    }
    await verifyPathStillNamesFile(path, before, label);
    return integrity;
  } finally {
    await handle.close();
  }
}

async function copyHandle(source, destination, size, label) {
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} is too large to snapshot safely`);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < Number(size)) {
    const length = Math.min(buffer.length, Number(size) - position);
    const { bytesRead } = await source.read(buffer, 0, length, position);
    if (bytesRead === 0) fail(`${label} changed while its snapshot was created`);
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(
        buffer,
        written,
        bytesRead - written,
        position + written,
      );
      if (result.bytesWritten === 0) fail(`${label} snapshot could not be written completely`);
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
}

async function createPublishSnapshot(expected, directory, checkpoint) {
  const label = `${expected.name} tarball`;
  const { handle: source, stats: before } = await openRegular(expected.tarball, label);
  const snapshot = join(directory, `${expected.name.slice("@tego/".length)}.tgz`);
  let destination;
  try {
    destination = await open(
      snapshot,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const destinationStats = await destination.stat({ bigint: true });
    if (!destinationStats.isFile()) fail(`${label} snapshot is not a regular file`);
    await copyHandle(source, destination, before.size, label);
    await destination.sync();
    if (typeof checkpoint === "function") await checkpoint(expected);
    const after = await source.stat({ bigint: true });
    if (!sameFileIdentityAndState(before, after)) {
      fail(`${label} changed while its snapshot was created`);
    }
    await verifyPathStillNamesFile(expected.tarball, before, label);
    await destination.chmod(0o400);
  } finally {
    await destination?.close().catch(() => {});
    await source.close();
  }
  const snapshotStats = await lstat(snapshot);
  if (
    !snapshotStats.isFile() ||
    snapshotStats.isSymbolicLink() ||
    permissionBits(snapshotStats) !== 0o400
  ) {
    fail(`${label} snapshot is not an immutable regular file`);
  }
  const integrity = await sha512RegularFile(snapshot, `${label} snapshot`);
  if (integrity !== expected.integrity) {
    fail(`${label} snapshot integrity does not match the release manifest`);
  }
  return snapshot;
}

async function writePrivateManifest(path, contents) {
  let handle;
  try {
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    }
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail("release manifest must be a regular file, not a symlink");
    await handle.chmod(0o600);
    await handle.truncate(0);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || permissionBits(after) !== 0o600) {
      fail("release manifest must be an owner-only regular file");
    }
    await verifyPathStillNamesFile(path, after, "release manifest");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("release manifest")) throw error;
    fail("release manifest must be a writable regular file, not a symlink");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readPrivateManifest(path) {
  const { handle, stats: before } = await openRegular(path, "release manifest");
  try {
    await handle.chmod(0o600);
    const contents = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      permissionBits(after) !== 0o600 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      fail("release manifest changed or is not owner-only");
    }
    await verifyPathStillNamesFile(path, after, "release manifest");
    return contents;
  } finally {
    await handle.close();
  }
}

export async function createReleaseManifest({ artifactDirectory, targetSha, packages }) {
  const absoluteArtifactDirectory = await secureArtifactDirectory(artifactDirectory);
  if (!/^[0-9a-f]{40}$/u.test(targetSha)) fail("release manifest requires a full target SHA");
  const ordered = releaseOrder(packages);
  assertCompleteReleaseSet(ordered);
  const records = [];
  for (const expected of ordered) {
    const tarball = relativeTarball(absoluteArtifactDirectory, expected.tarball);
    const integrity = await sha512RegularFile(
      join(absoluteArtifactDirectory, tarball),
      `${expected.name} tarball`,
    );
    if (expected.integrity !== undefined && expected.integrity !== integrity) {
      fail(`${expected.name} npm pack integrity does not match the tarball bytes`);
    }
    records.push({
      name: expected.name,
      version: expected.version,
      directory: expected.directory,
      tarball,
      integrity,
      ...Object.fromEntries(
        INTERNAL_DEPENDENCY_FIELDS.map((field) => [field, stringMap(expected[field], field)]),
      ),
    });
  }
  const manifest = {
    schemaVersion: 1,
    version: ALPHA_VERSION,
    registry: NPM_REGISTRY,
    targetSha,
    packages: records,
  };
  const manifestPath = join(absoluteArtifactDirectory, RELEASE_MANIFEST);
  await writePrivateManifest(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath };
}

export async function loadReleaseManifest(manifestPath) {
  const absoluteManifestPath = resolve(manifestPath);
  const artifactDirectory = await secureArtifactDirectory(dirname(absoluteManifestPath));
  const manifest = parseJson(await readPrivateManifest(absoluteManifestPath), RELEASE_MANIFEST);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== ALPHA_VERSION ||
    manifest.registry !== NPM_REGISTRY ||
    !/^[0-9a-f]{40}$/u.test(manifest.targetSha) ||
    !Array.isArray(manifest.packages)
  ) {
    fail("release manifest does not match the official npm registry and alpha release contract");
  }
  const packages = manifest.packages.map((record) => ({
    ...record,
    tarball: join(
      artifactDirectory,
      relativeTarball(artifactDirectory, join(artifactDirectory, record.tarball)),
    ),
  }));
  const ordered = releaseOrder(packages);
  assertCompleteReleaseSet(ordered);
  for (const expected of ordered) {
    const integrity = await sha512RegularFile(expected.tarball, `${expected.name} tarball`);
    if (integrity !== expected.integrity) {
      fail(`${expected.name} release manifest integrity does not match its tarball bytes`);
    }
  }
  return { ...manifest, packages: ordered };
}

async function packedManifest(tarball) {
  const { stdout } = await execute("tar", ["-xOf", tarball, "package/package.json"], {
    encoding: "utf8",
  });
  return parseJson(stdout, `${tarball} package.json`);
}

async function packRelease(artifactDirectory, targetSha) {
  const packed = await packWorkspaceSet(root, artifactDirectory);
  const packages = [];
  for (const workspace of packed) {
    const manifest = await packedManifest(workspace.tarball);
    packages.push({
      ...workspace,
      ...Object.fromEntries(
        INTERNAL_DEPENDENCY_FIELDS.map((field) => [field, stringMap(manifest[field], field)]),
      ),
    });
  }
  return createReleaseManifest({ artifactDirectory, targetSha, packages });
}

async function readReleaseEvidence() {
  const path = join(
    root,
    "openspec",
    "changes",
    "runtime-kernel-phase-1",
    "verification-report.md",
  );
  const contents = await readFile(path, "utf8").catch((error) => {
    fail(`release evidence is unavailable at ${path}: ${error.message}`);
  });
  return parseRecordedReleaseEvidence(contents);
}

function executableCommand(command, args) {
  if (command === "npm") return { command: process.execPath, args: [npmCli, ...args] };
  return { command, args };
}

async function defaultRun(command, args) {
  const executable = executableCommand(command, args);
  try {
    const result = await execute(executable.command, executable.args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : null,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : error.message,
    };
  }
}

export function parseReleaseArguments(arguments_) {
  const modes = new Set(["--preflight", "--pack", "--publish", "--verify-registry"]);
  const selected = arguments_.filter((argument) => modes.has(argument));
  if (selected.length !== 1) {
    fail("choose exactly one of --preflight, --pack, --publish, or --verify-registry");
  }
  let artifactDirectory;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (modes.has(argument)) continue;
    if (argument === "--artifact-directory") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) fail("--artifact-directory needs a path");
      artifactDirectory = safeArtifactDirectory(value);
      index += 1;
      continue;
    }
    fail(`unsupported release argument: ${argument}`);
  }
  return { mode: selected[0], artifactDirectory };
}

async function main() {
  const { mode, artifactDirectory: suppliedDirectory } = parseReleaseArguments(
    process.argv.slice(2),
  );
  const artifactDirectory =
    suppliedDirectory ?? (await mkdtemp(join(tmpdir(), "tego-alpha-release-")));
  const adapters = {
    registry: NPM_REGISTRY,
    nodeVersion: process.version,
    run: defaultRun,
  };
  const headSha = requireSuccess(
    await run(adapters, "git", ["rev-parse", "HEAD"]),
    "could not resolve Git HEAD",
  );
  const releaseEvidence = mode === "--pack" ? undefined : await readReleaseEvidence();
  const targetSha = releaseEvidence?.targetSha ?? headSha;
  const { manifestPath } = await packRelease(artifactDirectory, targetSha);
  const { packages } = await loadReleaseManifest(manifestPath);

  if (mode === "--pack") {
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "pack", manifestPath })}\n`);
    return;
  }
  if (mode === "--preflight") {
    const result = await preflightRelease({
      ...adapters,
      packages,
      releaseEvidence,
      validateEvidenceTarget: async (evidence, head) =>
        validateReleaseEvidenceTarget({ evidence, headSha: head, run: defaultRun }),
    });
    const { receipt: _receipt, ...summary } = result;
    process.stdout.write(
      `${JSON.stringify({ ok: true, mode: "preflight", manifestPath, ...summary })}\n`,
    );
    return;
  }
  if (mode === "--publish") {
    adapters.packages = packages;
    adapters.releaseEvidence = releaseEvidence;
    adapters.validateEvidenceTarget = async (evidence, head) =>
      validateReleaseEvidenceTarget({ evidence, headSha: head, run: defaultRun });
    const preflight = await preflightRelease(adapters);
    adapters.preflightReceipt = preflight.receipt;
    const publication = await publishAlpha(adapters);
    const verification = await verifyRegistryRelease({ ...adapters, packages });
    const { receipt: _receipt, ...preflightSummary } = preflight;
    process.stdout.write(
      `${JSON.stringify({ ok: true, mode: "publish", manifestPath, preflight: preflightSummary, publication, verification })}\n`,
    );
    return;
  }
  const verification = await verifyRegistryRelease({ ...adapters, packages });
  process.stdout.write(
    `${JSON.stringify({ ok: true, mode: "verify-registry", manifestPath, verification })}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
