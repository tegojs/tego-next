import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ALPHA_VERSION,
  createReleaseManifest,
  loadReleaseManifest,
  NPM_REGISTRY,
  parseReleaseArguments,
  preflightRelease,
  publishAlpha,
  releaseOrder,
  validateRegistryState,
  verifyRegistryRelease,
} from "../../scripts/publish-alpha.mjs";

function packageRecord(name, dependencies = {}) {
  return {
    name,
    version: ALPHA_VERSION,
    integrity: `sha512-${Buffer.from(name).toString("base64")}`,
    tarball: `/tmp/${name.slice(6)}-${ALPHA_VERSION}.tgz`,
    dependencies,
    devDependencies: {},
    optionalDependencies: {},
    peerDependencies: {},
  };
}

function releasePackages() {
  const contracts = packageRecord("@tego/contracts");
  const testkit = packageRecord("@tego/testkit", { "@tego/contracts": ALPHA_VERSION });
  const pluginSdk = packageRecord("@tego/plugin-sdk", { "@tego/contracts": ALPHA_VERSION });
  const local = packageRecord("@tego/drivers-local", { "@tego/contracts": ALPHA_VERSION });
  local.devDependencies = { "@tego/testkit": ALPHA_VERSION };
  const postgres = packageRecord("@tego/drivers-postgres", {
    "@tego/contracts": ALPHA_VERSION,
  });
  postgres.devDependencies = { "@tego/testkit": ALPHA_VERSION };
  const executor = packageRecord("@tego/executor-node", {
    "@tego/contracts": ALPHA_VERSION,
    "@tego/plugin-sdk": ALPHA_VERSION,
  });
  executor.devDependencies = { "@tego/testkit": ALPHA_VERSION };
  const runtime = packageRecord("@tego/runtime", { "@tego/contracts": ALPHA_VERSION });
  runtime.devDependencies = { "@tego/testkit": ALPHA_VERSION };
  const websocket = packageRecord("@tego/transport-websocket", {
    "@tego/contracts": ALPHA_VERSION,
  });
  websocket.devDependencies = { "@tego/testkit": ALPHA_VERSION };
  const cli = packageRecord("@tego/cli", {
    "@tego/contracts": ALPHA_VERSION,
    "@tego/drivers-local": ALPHA_VERSION,
    "@tego/drivers-postgres": ALPHA_VERSION,
    "@tego/executor-node": ALPHA_VERSION,
    "@tego/plugin-sdk": ALPHA_VERSION,
    "@tego/runtime": ALPHA_VERSION,
    "@tego/transport-websocket": ALPHA_VERSION,
  });
  return [cli, contracts, local, postgres, executor, pluginSdk, runtime, testkit, websocket];
}

async function releasePackagesOnDisk(directory) {
  const packages = releasePackages();
  for (const expected of packages) {
    const contents = `publish tarball bytes: ${expected.name}`;
    expected.tarball = join(directory, `${expected.name.slice("@tego/".length)}.tgz`);
    await writeFile(expected.tarball, contents, { mode: 0o600 });
    expected.integrity = `sha512-${createHash("sha512").update(contents).digest("base64")}`;
  }
  return packages;
}

function registryRecord(expected) {
  return {
    name: expected.name,
    version: expected.version,
    dependencies: expected.dependencies,
    devDependencies: expected.devDependencies,
    optionalDependencies: expected.optionalDependencies,
    peerDependencies: expected.peerDependencies,
    dist: { integrity: expected.integrity },
    "dist-tags": { alpha: ALPHA_VERSION },
  };
}

function preflightAdapters(overrides = {}) {
  const calls = [];
  const head = "1234567890abcdef1234567890abcdef12345678";
  const adapters = {
    registry: NPM_REGISTRY,
    nodeVersion: "v26.5.0",
    packages: releasePackages(),
    releaseEvidence: {
      schemaVersion: 1,
      targetSha: head,
      localVerification: { status: "passed", sourceSha: head },
      authoritativeCi: {
        sourceSha: head,
        status: "passed",
        url: "https://github.com/tegojs/tego-next/actions/runs/123",
      },
    },
    async registryState() {
      return null;
    },
    async registryTags() {
      return {};
    },
    async run(command, args) {
      calls.push({ command, args });
      const key = `${command} ${args.join(" ")}`;
      if (args[0] === "--version") return { exitCode: 0, stdout: "11.13.0\n", stderr: "" };
      if (key === "git status --porcelain=v1") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "git rev-parse HEAD") return { exitCode: 0, stdout: `${head}\n`, stderr: "" };
      if (args[0] === "whoami") return { exitCode: 0, stdout: "tego-release\n", stderr: "" };
      if (args.slice(0, 4).join(" ") === "access list packages @tego") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ "@tego/core": "read-write" }),
          stderr: "",
        };
      }
      if (key === "git show-ref --verify --quiet refs/tags/v2.0.0-alpha.1") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "ls-remote") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "gh" && args[0] === "release" && args[1] === "view") {
        return { exitCode: 1, stdout: "", stderr: "release not found" };
      }
      throw new Error(`unexpected command: ${key}`);
    },
    ...overrides,
  };
  return { adapters, calls };
}

test("release topology starts with contracts and publishes CLI last", () => {
  const ordered = releaseOrder(releasePackages());
  assert.equal(ordered.length, 9);
  assert.equal(ordered[0].name, "@tego/contracts");
  assert.equal(ordered.at(-1).name, "@tego/cli");
  const positions = new Map(ordered.map(({ name }, index) => [name, index]));
  for (const manifest of ordered) {
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })) {
      if (positions.has(dependency)) {
        assert.ok(positions.get(dependency) < positions.get(manifest.name));
      }
    }
  }
});

test("release CLI accepts exactly one explicit mode and an optional artifact directory", () => {
  for (const mode of ["--preflight", "--pack", "--publish", "--verify-registry"]) {
    assert.equal(parseReleaseArguments([mode]).mode, mode);
  }
  assert.deepEqual(parseReleaseArguments(["--pack", "--artifact-directory", "/tmp/release"]), {
    mode: "--pack",
    artifactDirectory: "/tmp/release",
  });
  assert.throws(() => parseReleaseArguments([]), /exactly one/u);
  assert.throws(() => parseReleaseArguments(["--pack", "--publish"]), /exactly one/u);
  assert.throws(() => parseReleaseArguments(["--pack", "--registry", "mirror"]), /unsupported/u);
});

test("release topology rejects unknown dependencies, duplicates, and cycles", () => {
  const unknown = releasePackages();
  unknown[0].dependencies["@tego/missing"] = ALPHA_VERSION;
  assert.throws(() => releaseOrder(unknown), /unknown internal dependency/u);

  const duplicate = releasePackages();
  duplicate.push(structuredClone(duplicate[0]));
  assert.throws(() => releaseOrder(duplicate), /duplicate/u);

  const cycle = releasePackages();
  cycle.find(({ name }) => name === "@tego/contracts").dependencies = {
    "@tego/runtime": ALPHA_VERSION,
  };
  assert.throws(() => releaseOrder(cycle), /cycle/u);
});

for (const scenario of [
  {
    name: "wrong Node.js",
    override: { nodeVersion: "v26.4.0" },
    pattern: /Node\.js.*26\.5\.0/u,
  },
  {
    name: "wrong npm",
    override: {
      async run(command, args) {
        if (args[0] === "--version") return { exitCode: 0, stdout: "11.12.0\n", stderr: "" };
        return preflightAdapters().adapters.run(command, args);
      },
    },
    pattern: /npm.*11\.13\.0/u,
  },
  {
    name: "dirty Git",
    override: {
      async run(command, args) {
        if (command === "git" && args[0] === "status") {
          return { exitCode: 0, stdout: " M package.json\n", stderr: "" };
        }
        return preflightAdapters().adapters.run(command, args);
      },
    },
    pattern: /clean Git worktree/u,
  },
  {
    name: "mirror registry",
    override: { registry: "https://registry.example.test/" },
    pattern: /official npm registry/u,
  },
  {
    name: "missing npm identity",
    override: {
      async run(command, args) {
        if (args[0] === "whoami") return { exitCode: 1, stdout: "", stderr: "ENEEDAUTH" };
        return preflightAdapters().adapters.run(command, args);
      },
    },
    pattern: /npm identity/u,
  },
  {
    name: "missing scope permission",
    override: {
      async run(command, args) {
        if (args[0] === "access") return { exitCode: 0, stdout: "{}", stderr: "" };
        return preflightAdapters().adapters.run(command, args);
      },
    },
    pattern: /publish access.*@tego/u,
  },
  {
    name: "failed release evidence",
    override: {
      releaseEvidence: {
        schemaVersion: 1,
        targetSha: "1234567890abcdef1234567890abcdef12345678",
        localVerification: {
          status: "failed",
          sourceSha: "1234567890abcdef1234567890abcdef12345678",
        },
        authoritativeCi: {
          status: "failed",
          sourceSha: "1234567890abcdef1234567890abcdef12345678",
        },
      },
    },
    pattern: /release evidence/u,
  },
]) {
  test(`preflight fails closed for ${scenario.name}`, async () => {
    const { adapters } = preflightAdapters(scenario.override);
    await assert.rejects(preflightRelease(adapters), scenario.pattern);
  });
}

test("preflight rejects a registry collision before any upload", async () => {
  const packages = releasePackages();
  const expected = packages.find(({ name }) => name === "@tego/runtime");
  let uploads = 0;
  const { adapters } = preflightAdapters({
    packages,
    async registryState(name) {
      if (name !== expected.name) return null;
      const actual = registryRecord(expected);
      actual.dist.integrity = "sha512-different";
      return actual;
    },
    async publish() {
      uploads += 1;
    },
  });
  await assert.rejects(preflightRelease(adapters), /integrity/u);
  assert.equal(uploads, 0);
});

test("preflight collects every registry decision before failing", async () => {
  const packages = releasePackages();
  const queried = [];
  const { adapters } = preflightAdapters({
    packages,
    async registryState(name) {
      queried.push(name);
      if (name !== "@tego/runtime") return null;
      const expected = packages.find((releasePackage) => releasePackage.name === name);
      return { ...registryRecord(expected), "dist.integrity": "sha512-wrong", dist: undefined };
    },
  });
  await assert.rejects(preflightRelease(adapters), /registry preflight failed.*@tego\/runtime/su);
  assert.deepEqual(new Set(queried), new Set(packages.map(({ name }) => name)));
});

test("preflight accepts matching resumable packages but rejects any latest tag", async () => {
  const packages = releasePackages();
  const expected = packages.find(({ name }) => name === "@tego/contracts");
  const matching = registryRecord(expected);
  const { adapters } = preflightAdapters({
    packages,
    async registryState(name) {
      return name === expected.name ? matching : null;
    },
    async registryTags(name) {
      return name === expected.name ? matching["dist-tags"] : {};
    },
  });
  await preflightRelease(adapters);

  matching["dist-tags"].latest = "1.0.0";
  await assert.rejects(preflightRelease(adapters), /latest/u);
});

test("registry state only resumes an exact integrity and alpha tag match", () => {
  const expected = releasePackages()[0];
  assert.deepEqual(validateRegistryState(expected, null), { action: "publish" });
  assert.deepEqual(validateRegistryState(expected, registryRecord(expected)), { action: "skip" });

  const wrongIntegrity = registryRecord(expected);
  wrongIntegrity.dist.integrity = "sha512-wrong";
  assert.throws(() => validateRegistryState(expected, wrongIntegrity), /integrity/u);

  const wrongAlpha = registryRecord(expected);
  wrongAlpha["dist-tags"].alpha = "2.0.0-alpha.0";
  assert.throws(() => validateRegistryState(expected, wrongAlpha), /alpha/u);

  const latest = registryRecord(expected);
  latest["dist-tags"].latest = ALPHA_VERSION;
  assert.throws(() => validateRegistryState(expected, latest), /latest/u);
});

test("registry state accepts npm view's flattened integrity field and dependency key order", () => {
  const expected = releasePackages().find(({ name }) => name === "@tego/cli");
  const actual = registryRecord(expected);
  actual["dist.integrity"] = actual.dist.integrity;
  delete actual.dist;
  actual.dependencies = Object.fromEntries(Object.entries(actual.dependencies).toReversed());
  assert.deepEqual(validateRegistryState(expected, actual), { action: "skip" });
});

test("publisher uses explicit safe npm flags, skips exact matches, and never invokes git or gh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-publish-snapshot-test-"));
  const packages = await releasePackagesOnDisk(directory);
  const existing = packages.find(({ name }) => name === "@tego/contracts");
  const state = new Map([[existing.name, registryRecord(existing)]]);
  const commandCalls = [];
  const published = [];

  const { adapters } = preflightAdapters({
    packages,
    async registryState(name) {
      return state.get(name) ?? null;
    },
    async registryTags(name) {
      return state.get(name)?.["dist-tags"] ?? {};
    },
    async publish(expected, command, args) {
      published.push(expected.name);
      commandCalls.push({ command, args });
      const source = packages.find(({ name }) => name === expected.name).tarball;
      assert.notEqual(args[1], source);
      assert.equal(await readFile(args[1], "utf8"), `publish tarball bytes: ${expected.name}`);
      const snapshot = await lstat(args[1]);
      assert.equal(snapshot.isFile(), true);
      assert.equal(snapshot.mode & 0o777, 0o400);
      assert.equal((await lstat(dirname(args[1]))).mode & 0o777, 0o700);
      state.set(expected.name, registryRecord(expected));
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  try {
    const preflight = await preflightRelease(adapters);
    adapters.preflightReceipt = preflight.receipt;
    const result = await publishAlpha(adapters);

    assert.deepEqual(result.skipped, ["@tego/contracts"]);
    assert.equal(result.published.length, 8);
    assert.deepEqual(new Set(result.published), new Set(published));
    for (const { command, args } of commandCalls) {
      assert.notEqual(command, "git");
      assert.notEqual(command, "gh");
      assert.equal(args[0], "publish");
      assert.deepEqual(args.slice(2), [
        "--registry",
        NPM_REGISTRY,
        "--access",
        "public",
        "--tag",
        "alpha",
      ]);
      await assert.rejects(lstat(args[1]), /ENOENT/u);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("publisher rejects symlinks, non-regular tarballs, and path replacement without uploading", async () => {
  for (const attack of ["symlink", "non-regular", "replace-after-copy"]) {
    const directory = await mkdtemp(join(tmpdir(), `tego-publish-${attack}-`));
    try {
      const packages = await releasePackagesOnDisk(directory);
      const attacked = packages.find(({ name }) => name === "@tego/contracts");
      let uploads = 0;
      const overrides = {
        packages,
        async publish() {
          uploads += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };
      if (attack === "replace-after-copy") {
        overrides.snapshotCheckpoint = async (expected) => {
          if (expected.name !== attacked.name) return;
          await rename(attacked.tarball, `${attacked.tarball}.original`);
          await writeFile(attacked.tarball, "replacement bytes", { mode: 0o600 });
        };
      }
      const { adapters } = preflightAdapters(overrides);
      const preflight = await preflightRelease(adapters);
      adapters.preflightReceipt = preflight.receipt;
      if (attack === "symlink") {
        await rename(attacked.tarball, `${attacked.tarball}.target`);
        await symlink(`${attacked.tarball}.target`, attacked.tarball);
      }
      if (attack === "non-regular") {
        await rm(attacked.tarball);
        await mkdir(attacked.tarball);
      }
      await assert.rejects(publishAlpha(adapters), /tarball.*(?:regular|changed|symlink)/u);
      assert.equal(uploads, 0, attack);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
});

test("publisher fails before registry access when a preflight result is missing", async () => {
  let registryQueries = 0;
  await assert.rejects(
    publishAlpha({
      packages: releasePackages(),
      async registryState() {
        registryQueries += 1;
        return null;
      },
    }),
    /preflight receipt/u,
  );
  assert.equal(registryQueries, 0);
});

test("publisher rejects forged, cross-session, cross-manifest, and consumed preflight receipts", async () => {
  for (const kind of ["forged", "cross-session", "mutated-session", "cross-manifest", "consumed"]) {
    const packages = releasePackages();
    let publishCalls = 0;
    let registryQueries = 0;
    const { adapters } = preflightAdapters({
      packages,
      async registryState() {
        registryQueries += 1;
        return null;
      },
      async publish() {
        publishCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const preflight = await preflightRelease(adapters);
    adapters.preflightReceipt = preflight.receipt;

    if (kind === "forged") adapters.preflightReceipt = { ok: true };
    if (kind === "cross-session") {
      await assert.rejects(
        publishAlpha({ ...adapters, preflightReceipt: preflight.receipt }),
        /preflight receipt/u,
      );
    } else if (kind === "mutated-session") {
      adapters.registryState = async () => null;
      await assert.rejects(publishAlpha(adapters), /preflight receipt/u);
    } else if (kind === "cross-manifest") {
      adapters.packages = structuredClone(packages);
      adapters.packages[0].integrity = "sha512-tampered";
      await assert.rejects(publishAlpha(adapters), /preflight receipt/u);
    } else if (kind === "consumed") {
      adapters.packages = [];
      await assert.rejects(publishAlpha(adapters), /release manifests/u);
      adapters.packages = packages;
      await assert.rejects(publishAlpha(adapters), /preflight receipt/u);
    } else {
      await assert.rejects(publishAlpha(adapters), /preflight receipt/u);
    }
    assert.equal(publishCalls, 0, `${kind}: no upload`);
    assert.equal(registryQueries, 9, `${kind}: only preflight registry inspection`);
  }
});

test("registry verification requires exact identities, dependencies, integrity, and tags", async () => {
  const packages = releasePackages();
  const state = new Map(packages.map((expected) => [expected.name, registryRecord(expected)]));
  const adapters = {
    packages,
    async registryState(name) {
      return state.get(name) ?? null;
    },
  };
  const result = await verifyRegistryRelease(adapters);
  assert.deepEqual(
    result.packages,
    releaseOrder(packages).map(({ name }) => name),
  );

  const runtime = state.get("@tego/runtime");
  runtime.dependencies = { "@tego/contracts": "^2.0.0-alpha.1" };
  await assert.rejects(verifyRegistryRelease(adapters), /internal dependencies/u);
});

test("registry verification checks every package before reporting a mismatch", async () => {
  const packages = releasePackages();
  const state = new Map(packages.map((expected) => [expected.name, registryRecord(expected)]));
  state.get("@tego/runtime").dependencies = { "@tego/contracts": "^2.0.0-alpha.1" };
  const queried = [];
  await assert.rejects(
    verifyRegistryRelease({
      packages,
      async registryState(name) {
        queried.push(name);
        return state.get(name);
      },
      async registryTags(name) {
        return state.get(name)["dist-tags"];
      },
    }),
    /registry release verification failed.*@tego\/runtime/su,
  );
  assert.deepEqual(new Set(queried), new Set(packages.map(({ name }) => name)));
});

test("release manifest records Git SHA and computed SHA-512 without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-release-manifest-test-"));
  const packages = releasePackages().map((expected) => ({
    ...expected,
    integrity: undefined,
    directory: expected.name.slice("@tego/".length),
    tarball: join(directory, `${expected.name.slice("@tego/".length)}.tgz`),
  }));
  await Promise.all(
    packages.map(({ name, tarball }) => writeFile(tarball, `tarball bytes: ${name}`)),
  );

  try {
    const result = await createReleaseManifest({
      artifactDirectory: directory,
      targetSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      packages,
    });
    const persisted = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(persisted.targetSha, "abcdefabcdefabcdefabcdefabcdefabcdefabcd");
    assert.equal(Object.hasOwn(persisted, "gitSha"), false);
    assert.equal(persisted.packages.length, 9);
    for (const releasePackage of persisted.packages) {
      assert.match(releasePackage.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
      assert.equal(releasePackage.tarball, `${releasePackage.directory}.tgz`);
    }
    assert.doesNotMatch(JSON.stringify(persisted), /token|password|_auth/iu);
    assert.equal((await lstat(result.manifestPath)).mode & 0o777, 0o600);

    await chmod(result.manifestPath, 0o644);
    await loadReleaseManifest(result.manifestPath);
    assert.equal((await lstat(result.manifestPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(directory)).mode & 0o077, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("manifest and artifact loading rejects symlinks and non-regular tarballs", async () => {
  for (const attack of [
    "symlink-artifact-directory",
    "symlink-tarball",
    "non-regular-tarball",
    "symlink-manifest",
  ]) {
    const parent = await mkdtemp(join(tmpdir(), `tego-manifest-${attack}-`));
    const directory = join(parent, "artifacts");
    const realDirectory =
      attack === "symlink-artifact-directory" ? join(parent, "real-artifacts") : directory;
    await mkdir(realDirectory, { mode: 0o755 });
    if (attack === "symlink-artifact-directory") await symlink(realDirectory, directory);
    try {
      const packages = (await releasePackagesOnDisk(directory)).map((expected) => ({
        ...expected,
        directory: expected.name.slice("@tego/".length),
      }));
      const creation = createReleaseManifest({
        artifactDirectory: directory,
        targetSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        packages,
      });
      if (attack === "symlink-artifact-directory") {
        await assert.rejects(creation, /artifact directory.*symlink/u);
        continue;
      }
      const { manifestPath } = await creation;
      assert.equal((await lstat(directory)).mode & 0o077, 0);
      if (attack === "symlink-manifest") {
        await rename(manifestPath, `${manifestPath}.target`);
        await symlink(`${manifestPath}.target`, manifestPath);
      } else {
        const attacked = packages.find(({ name }) => name === "@tego/contracts");
        if (attack === "symlink-tarball") {
          await rename(attacked.tarball, `${attacked.tarball}.target`);
          await symlink(`${attacked.tarball}.target`, attacked.tarball);
        } else {
          await rm(attacked.tarball);
          await mkdir(attacked.tarball);
        }
      }
      await assert.rejects(
        loadReleaseManifest(manifestPath),
        /(?:manifest|tarball).*(?:regular|symlink)/u,
      );
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  }
});

test("release manifest reload rejects a changed tarball and wrong registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tego-release-manifest-reload-"));
  const packages = releasePackages().map((expected) => ({
    ...expected,
    integrity: undefined,
    directory: expected.name.slice("@tego/".length),
    tarball: join(directory, `${expected.name.slice("@tego/".length)}.tgz`),
  }));
  await Promise.all(
    packages.map(({ name, tarball }) => writeFile(tarball, `tarball bytes: ${name}`)),
  );

  try {
    const { manifestPath } = await createReleaseManifest({
      artifactDirectory: directory,
      targetSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      packages,
    });
    const loaded = await loadReleaseManifest(manifestPath);
    assert.equal(loaded.packages.length, 9);

    await writeFile(packages[0].tarball, "changed tarball bytes");
    await assert.rejects(loadReleaseManifest(manifestPath), /integrity/u);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.registry = "https://registry.example.test/";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadReleaseManifest(manifestPath), /official npm registry/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("registry lookups always name the official registry and use array arguments", async () => {
  const packages = releasePackages();
  const calls = [];
  await verifyRegistryRelease({
    packages,
    async run(command, args) {
      calls.push({ command, args });
      const name = args[1].split("@").slice(0, 2).join("@");
      const expected = packages.find((releasePackage) => releasePackage.name === name);
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          args.includes("dist.integrity") ? registryRecord(expected) : { alpha: ALPHA_VERSION },
        ),
        stderr: "",
      };
    },
  });
  assert.equal(calls.length, 18);
  for (const call of calls) {
    assert.ok(call.args.includes("--registry"));
    assert.equal(call.args.at(-1), NPM_REGISTRY);
  }
});
