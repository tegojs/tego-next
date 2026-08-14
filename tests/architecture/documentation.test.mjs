import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const documents = {
  architecture: "docs/architecture/runtime-kernel.md",
  contributor: "docs/guides/contributing-and-plugins.md",
  operations: "docs/operations/deployment-topologies.md",
  release: "docs/releases/2.0.0-alpha.1.md",
  security: "docs/security/threat-model.md",
};

const releaseDocuments = [
  "README.md",
  ...Object.values(documents),
  "docs/reviews/phase-1-api-architecture-review.md",
  "docs/reviews/phase-1-security-concurrency-recovery-review.md",
  "openspec/changes/runtime-kernel-phase-1/.comet/handoff/design-context.md",
  "openspec/changes/runtime-kernel-phase-1/tasks.md",
];

const windowsBrokerDocuments = [
  "docs/superpowers/specs/2026-08-14-windows-control-broker-design.md",
  documents.security,
  documents.operations,
  documents.release,
  "docs/reviews/phase-1-security-concurrency-recovery-review.md",
  "openspec/changes/runtime-kernel-phase-1/specs/runtime-bootstrap/spec.md",
  "openspec/changes/runtime-kernel-phase-1/specs/runtime-operations/spec.md",
];

const deltaSpecsRoot = "openspec/changes/runtime-kernel-phase-1/specs";

async function activeDeltaSpecPaths() {
  const entries = await readdir(resolve(root, deltaSpecsRoot), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${deltaSpecsRoot}/${entry.name}/spec.md`)
    .toSorted();
}

const publicPackages = [
  "@tego/cli",
  "@tego/contracts",
  "@tego/drivers-local",
  "@tego/drivers-postgres",
  "@tego/executor-node",
  "@tego/plugin-sdk",
  "@tego/runtime",
  "@tego/testkit",
  "@tego/transport-websocket",
];

const postgresCleanupTables = [
  "tego_operation_history",
  "tego_operations",
  "tego_outbox",
  "tego_idempotency",
  "tego_state_changes",
  "tego_records",
  "tego_fences",
  "tego_state_revisions",
  "tego_coordination_changes",
  "tego_coordination_records",
  "tego_coordination_leases",
  "tego_coordination_epochs",
  "tego_coordination_revisions",
  "tego_artifacts",
  "tego_artifact_namespace_usage",
];

const documentedContracts = [
  {
    document: "architecture",
    required: [
      "terminal -> expired",
      "unknown remains a non-terminal reconciliation state and does not directly expire",
      "correlation ID is mandatory",
      "one-way messages and requests self-correlate",
      "responses correlate to the triggering request's message ID",
    ],
    forbidden: ["unknown -> expired", "optional correlation"],
  },
  {
    document: "security",
    required: [
      "no application-layer authentication",
      "relies on operating-system access to its endpoint",
      "owner-private parent directory",
      "mode 0600",
      "protected DACL",
      "current Windows user",
      "LocalSystem",
      "Administrators",
      "full pipe access",
    ],
  },
];

const followerIngressRequiredClauses = [
  /\blocal (?:control )?endpoint is trusted\b/iu,
  /\bfollower\b[^.]{0,120}\b(?:may\s+)?(?:admit|store)s?\b[^.]{0,120}\bcontent-addressed immutable(?: artifact)? bytes\b[^.]{0,120}\bbefore\b[^.]{0,120}\bsemantic installation\b[^.]{0,120}\bfence\b/iu,
  /\b(?:returns?|responds with)\s+`?COORDINATION_NOT_LEADER`?\b/iu,
  /\bleaving installations and deployments semantic state unchanged\b/iu,
  /\bauthorized local client\b[^.]{0,120}\bcan\b[^.]{0,40}\bconsume\b[^.]{0,80}\bartifact (?:storage|capacity)\b/iu,
  /\bstorage denial of service\b/iu,
];

const forbiddenFollowerIngressClaims = [
  {
    claim:
      /\bfollower\b[^.]{0,80}\b(?:rejects?|blocks?|refuses?)\b[^.]{0,100}\bimmutable(?: artifact)? bytes\b[^.]{0,80}\bbefore ingress\b/iu,
    description: "pre-ingress rejection",
  },
  {
    claim:
      /\bCOORDINATION_NOT_LEADER\b[^.]{0,100}\b(?:prevents?|blocks?|stops?)\b[^.]{0,100}\b(?:artifact storage|storage (?:consumption|denial of service))\b/iu,
    description: "not-leader storage prevention",
  },
  {
    claim:
      /\bauthorized local client\b[^.]{0,80}\b(?:cannot|may not|does not)\b[^.]{0,40}\bconsume\b[^.]{0,80}\bartifact (?:storage|capacity)\b/iu,
    description: "authorized-client storage prevention",
  },
];

const documentedCliCommands = [
  "runtime start",
  "runtime status",
  "runtime snapshot",
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
];

async function read(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

function normalizeWhitespace(source) {
  return source.replace(/\s+/gu, " ").trim();
}

function assertRequiredContractMarkers(source, required, document) {
  for (const marker of required) {
    assert.ok(source.includes(marker), `${document} must state: ${marker}`);
  }
}

function assertOrderedClauses(source, clauses, document) {
  let offset = 0;
  for (const clause of clauses) {
    const match = clause.exec(source.slice(offset));
    assert.ok(match, `${document} must state ordered affirmative clause: ${clause}`);
    offset += match.index + match[0].length;
  }
}

function assertFollowerIngressContract(source, document) {
  const normalized = normalizeWhitespace(source);
  for (const forbidden of forbiddenFollowerIngressClaims) {
    assert.ok(
      !forbidden.claim.test(normalized),
      `${document} must not claim ${forbidden.description}`,
    );
  }
  assertOrderedClauses(normalized, followerIngressRequiredClauses, document);
}

function assertWorkerThreadContract(source, document) {
  const normalized = normalizeWhitespace(source);
  assert.match(
    normalized,
    /\bWorker Thread\b[^.]{0,100}\bhas its own JavaScript thread and event loop\b/iu,
    `${document} must state that a Worker Thread has its own JavaScript event loop`,
  );
  assert.match(
    normalized,
    /\bshares the Main operating-system process, address space, privileges, and process-wide resources\b/iu,
    `${document} must state the resources shared with Main`,
  );
  assert.doesNotMatch(
    normalized,
    /(?:^|[.;]\s+|,\s+|\b(?:and|but)\s+)(?:(?:a|the) Worker Thread\s+|it\s+)?(?:runs?|executes?) on the Main JavaScript event loop\b/iu,
    `${document} must not state affirmative execution on the Main JavaScript event loop`,
  );
}

function section(source, heading) {
  const start = source.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `${heading} must exist`);
  const bodyStart = start + heading.length + 1;
  const nextHeading = source.indexOf("\n### ", bodyStart);
  return source.slice(bodyStart, nextHeading === -1 ? undefined : nextHeading);
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
});

test("@spec:runtime-operations/layer-one-dependency-boundary/package-graph-documentation", async () => {
  const architecture = await read(documents.architecture);
  for (const packageName of publicPackages) {
    assert.match(architecture, new RegExp(packageName.replaceAll("/", "\\/"), "u"));
  }
});

test("@spec:runtime-operations/public-alpha-channel/release-documentation", async () => {
  assert.equal(
    existsSync(resolve(root, "docs/releases/0.1.0-alpha.1.md")),
    false,
    "the superseded release-note filename must be removed",
  );
  const readme = await read("README.md");
  const release = await read(documents.release);
  for (const source of [readme, release]) {
    assert.match(source, /\b2\.0\.0-alpha\.1\b/u);
    assert.match(source, /npm install @tego\/runtime@alpha/u);
    assert.match(source, /alpha -> 2\.0\.0-alpha\.1/u);
    assert.match(source, /latest -> absent/u);
    for (const packageName of publicPackages) {
      assert.match(source, new RegExp(packageName.replaceAll("/", "\\/"), "u"));
    }
  }
});

test("@spec:plugin-artifacts/bounded-artifact-storage/documentation", async () => {
  const architecture = await read(documents.architecture);
  const operations = await read(documents.operations);
  const combined = `${architecture}\n${operations}`;
  for (const marker of [
    "256 MiB",
    "4 GiB",
    "maxArtifactBytes",
    "maxNamespaceBytes",
    "artifactLimits",
    "ARTIFACT_SIZE_LIMIT_EXCEEDED",
    "ARTIFACT_NAMESPACE_QUOTA_EXCEEDED",
    "one FilesystemArtifactStore instance",
    "same PostgreSQL namespace",
    "tego_artifact_namespace_usage",
  ]) {
    assert.match(combined, new RegExp(marker, "u"));
  }
});

test("@spec:runtime-operations/deterministic-cleanup/documentation", async () => {
  const operations = await read(documents.operations);
  for (const marker of [
    "^test_[a-z0-9]+_[a-z0-9_]+$",
    "driver_namespace = $1",
    "tego_artifact_namespace_usage",
    "tego_schema_migrations",
    "neighboring namespaces",
    "taskkill /T",
    "PID + CreationDate",
    "does not use a native Windows Job Object launcher",
  ]) {
    assert.ok(operations.includes(marker), `${documents.operations} must state: ${marker}`);
  }
  const order = /The fixed deletion order is:\n\n```text\n([^`]+)```/u.exec(operations);
  assert.ok(order, `${documents.operations} must enumerate the fixed deletion order`);
  assert.deepEqual(
    order[1]
      .trim()
      .split("\n")
      .map((line) => line.trim()),
    postgresCleanupTables,
  );
});

test("@spec:runtime-operations/resumable-alpha-release/documentation", async () => {
  const contributor = await read(documents.contributor);
  const release = await read(documents.release);
  const combined = `${contributor}\n${release}`;
  for (const marker of [
    "https://registry.npmjs.org/",
    "--preflight",
    "--pack",
    "--publish",
    "--verify-registry",
    "release-manifest.json",
    "SHA-512",
    "partial publication",
    "Task 11",
    "repacks the current source tree",
    "current invocation",
    "does not load a prior release-manifest.json",
    "same targetSha",
  ]) {
    assert.ok(combined.includes(marker), `release documentation must state: ${marker}`);
  }
  assert.doesNotMatch(
    combined,
    /(?:retain|reuse|using|against) the unchanged (?:private )?(?:artifact directory|release manifest)/iu,
  );
});

test("current release documents reject superseded or incomplete claims", async () => {
  const currentPaths = [...releaseDocuments, ...(await activeDeltaSpecPaths())];
  const documentation = (await Promise.all(currentPaths.map((path) => read(path)))).join("\n");
  for (const falseClaim of [
    /\b0\.1\.0-alpha\.1\b/u,
    /@tegojs\//u,
    /Windows named-pipe ACL hardening is not implemented/iu,
    /\bpackages are (?:not published|unpublished)\b/iu,
  ]) {
    assert.doesNotMatch(documentation, falseClaim);
  }
  assert.match(
    documentation,
    /real Windows[^.]{0,160}https:\/\/github\.com\/tegojs\/tego-next\/actions\/runs\/31837308587/iu,
  );
  assert.match(documentation, /Phase 2[^.]{0,80}Phase 3[^.]{0,80}(?:deferred|out of scope)/iu);
  assert.match(documentation, /Node\.js 26[^.]{0,120}LTS/iu);
  assert.match(documentation, /(?:npm|GitHub)[^.]{0,100}(?:not yet published|pending)/iu);
  assert.match(
    documentation,
    /OpenSpec[^.]{0,100}(?:not\s+yet\s+archived|archive\s+remains\s+pending)/iu,
  );
});

test("all active delta specs agree on the hardened Windows control boundary", async () => {
  const paths = await activeDeltaSpecPaths();
  const specs = await Promise.all(paths.map((path) => read(path)));
  for (const [index, spec] of specs.entries()) {
    assert.doesNotMatch(
      spec,
      /(?:no implemented ACL hardening|ACL hardening is not implemented)/iu,
      `${paths[index]} must not retain the superseded Windows boundary`,
    );
  }
  const bootstrap = await read(
    "openspec/changes/runtime-kernel-phase-1/specs/runtime-bootstrap/spec.md",
  );
  for (const marker of [
    "protected DACL",
    "current Windows user",
    "LocalSystem",
    "Administrators",
    "full pipe access",
    "before dispatch",
  ]) {
    assert.ok(bootstrap.includes(marker), `runtime-bootstrap delta must state: ${marker}`);
  }
});

test("reviewed documents describe only the proven Windows broker boundary", async () => {
  const sources = await Promise.all(windowsBrokerDocuments.map((path) => read(path)));
  const documentation = normalizeWhitespace(sources.join("\n"));
  const implementedDocumentation = normalizeWhitespace(sources.slice(1).join("\n"));

  for (const marker of [
    "dedicated broker process",
    "owns the public named pipe from creation through shutdown",
    "`win32-x64` only",
    "PowerShell plus embedded C# source",
    "stable synchronization handle to the exact parent process",
    "no fallback to an unhardened Node named pipe",
    "https://github.com/tegojs/tego-next/actions/runs/31837308587",
    "Windows ARM64 support",
    "precompiled",
    "deferred",
  ]) {
    assert.ok(documentation.includes(marker), `Windows broker documentation must state: ${marker}`);
  }

  for (const supersededClaim of [
    /post-listen[^.]{0,100}(?:ACL|DACL|descriptor) (?:application|hardening|mutation)/iu,
    /(?:admission barrier|pre-cutover sockets)/iu,
    /connections accepted before[^.]{0,100}(?:hardening|ACL|DACL|descriptor)/iu,
    /real Windows[^.]{0,100}(?:Task 10|not yet verified|still pending)/iu,
  ]) {
    assert.doesNotMatch(
      implementedDocumentation,
      supersededClaim,
      `implemented Windows documentation must reject ${supersededClaim}`,
    );
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

test("@spec:runtime-operations/documented-contracts/exact-operator-claims", async (t) => {
  for (const contract of documentedContracts) {
    const source = normalizeWhitespace(await read(documents[contract.document]));
    for (const required of contract.required) {
      await t.test(`${contract.document}: ${required}`, () => {
        assertRequiredContractMarkers(source, [required], documents[contract.document]);
      });
    }
    for (const forbidden of contract.forbidden ?? []) {
      await t.test(`${contract.document}: rejects ${forbidden}`, () => {
        assert.ok(
          !source.includes(forbidden),
          `${documents[contract.document]} must not state: ${forbidden}`,
        );
      });
    }
  }
});

for (const document of ["operations", "security"]) {
  test(`${document} documents ordered affirmative follower ingress semantics`, async () => {
    assertFollowerIngressContract(await read(documents[document]), documents[document]);
  });
}

const validFollowerIngressFixture = normalizeWhitespace(`
  The local control endpoint is trusted.
  A follower may admit content-addressed immutable artifact bytes before the
  semantic installation fence. The operation returns COORDINATION_NOT_LEADER,
  leaving installations and deployments semantic state unchanged.
  An authorized local client can consume artifact storage, creating a storage
  denial of service risk.
`);

for (const mutation of [
  {
    name: "pre-ingress byte rejection",
    source: validFollowerIngressFixture.replace(
      /A follower may admit[^.]+\./u,
      "A follower rejects immutable artifact bytes before ingress.",
    ),
    rejection: /must not claim pre-ingress rejection/u,
  },
  {
    name: "not-leader storage prevention",
    source: validFollowerIngressFixture.replace(
      "returns COORDINATION_NOT_LEADER,",
      "returns COORDINATION_NOT_LEADER and prevents artifact storage,",
    ),
    rejection: /must not claim not-leader storage prevention/u,
  },
  {
    name: "authorized-client storage prevention",
    source: validFollowerIngressFixture.replace(
      "An authorized local client can consume artifact storage",
      "An authorized local client cannot consume artifact storage",
    ),
    rejection: /must not claim authorized-client storage prevention/u,
  },
]) {
  test(`follower ingress contract rejects ${mutation.name}`, () => {
    assert.throws(
      () => assertFollowerIngressContract(mutation.source, "mutation fixture"),
      mutation.rejection,
    );
  });
}

test("architecture documents Worker Thread event-loop isolation", async () => {
  assertWorkerThreadContract(await read(documents.architecture), documents.architecture);
});

const validWorkerThreadFixture = normalizeWhitespace(`
  A Worker Thread has its own JavaScript thread and event loop. It shares the
  Main operating-system process, address space, privileges, and process-wide
  resources; it does not run on the Main JavaScript event loop.
`);

test("Worker Thread contract accepts negative Main event-loop wording", () => {
  assert.doesNotThrow(() =>
    assertWorkerThreadContract(validWorkerThreadFixture, "mutation fixture"),
  );
});

for (const verb of ["runs", "executes"]) {
  test(`Worker Thread contract rejects affirmative '${verb} on Main' wording`, () => {
    const mutation = validWorkerThreadFixture.replace("does not run", verb);
    assert.throws(
      () => assertWorkerThreadContract(mutation, "mutation fixture"),
      /must not state affirmative execution/u,
    );
  });
}

test("@spec:runtime-operations/plugin-development-operations/exact-cli-inventory", async () => {
  const contributor = await read(documents.contributor);
  const inventory = section(contributor, "### Exact command inventory");
  const commands = [...inventory.matchAll(/^- `([^`]+)`$/gmu)].map((match) => match[1]);
  assert.equal(
    commands.length,
    new Set(commands).size,
    "CLI inventory must not contain duplicates",
  );
  assert.deepEqual(commands.toSorted(), documentedCliCommands.toSorted());
});

test("@spec:runtime-operations/plugin-development-operations/executable-digest-example", async () => {
  const contributor = await read(documents.contributor);
  const installAndDeploy = section(contributor, "### Install and deploy");
  const digestArguments = [...installAndDeploy.matchAll(/--digest\s+(\S+)/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(digestArguments.length, 1);
  assert.match(digestArguments[0], /^sha256:[0-9a-f]{64}$/u);
  assert.doesNotMatch(installAndDeploy, /sha256:(?:sha256:|REPLACE_WITH_INSTALL_DIGEST)/u);
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
