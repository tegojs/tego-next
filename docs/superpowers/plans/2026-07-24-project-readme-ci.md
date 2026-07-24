# Project README and Continuous Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add contributor documentation, locally and remotely enforced Conventional Commits, and GitHub Actions quality and PostgreSQL integration gates.

**Architecture:** Repository-level Node tests define the expected tooling contract before configuration is added. Husky and commitlint share one root configuration, while GitHub Actions separates deterministic quality checks from PostgreSQL integration checks and uses a small tested script to normalize commit ranges.

**Tech Stack:** Node.js 26.5.0, npm 11.13.0, Husky 9.1.7, commitlint 21.2.x, Biome 2.5.5, TypeScript 7.0.2, GitHub Actions, PostgreSQL 16.14.

## Global Constraints

- Use Node.js `26.5.0` from `.node-version` and npm `11.13.0`.
- Use exact dependency versions: `husky@9.1.7`, `@commitlint/cli@21.2.1`, and `@commitlint/config-conventional@21.2.0`.
- Continue using npm workspaces and the checked-in `package-lock.json`.
- Run GitHub checks on pull requests targeting `main`, pushes to `main`, and manual dispatch.
- Use PostgreSQL `16.14-alpine` for disposable CI integration tests.
- Do not publish npm packages, create GitHub Releases, deploy services, or change repository branch protection.
- Do not claim API stability, production readiness, or Node.js compatibility outside the declared `>=26.5.0 <27` range.

---

## File Structure

- `README.md`: contributor-facing project scope, architecture, package map, development commands, PostgreSQL setup, and commit rules.
- `commitlint.config.mjs`: the single Conventional Commits rule source used locally and in CI.
- `.husky/commit-msg`: local Git `commit-msg` hook invoking the root commitlint installation.
- `scripts/commitlint-ci.mjs`: maps CI environment ranges to commitlint CLI arguments and executes commitlint.
- `.github/workflows/ci.yml`: GitHub quality and PostgreSQL integration gates.
- `tests/architecture/project-tooling.test.mjs`: executable contract tests for package scripts, commitlint configuration, and the Husky hook.
- `tests/architecture/project-ci.test.mjs`: tests commit range selection and stable workflow requirements.
- `tests/architecture/readme.test.mjs`: verifies that the README exposes required project and developer entry points.
- `package.json`: exact tooling dependencies and repository scripts.
- `package-lock.json`: resolved dependency graph for reproducible `npm ci`.

---

### Task 1: Conventional Commit Policy and Local Hook

**Files:**
- Create: `tests/architecture/project-tooling.test.mjs`
- Create: `commitlint.config.mjs`
- Create: `.husky/commit-msg`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: root npm workspace and Node's built-in test runner.
- Produces: `npm run commitlint`, `npm run prepare`, a conventional commitlint configuration, and a local `commit-msg` hook.

- [ ] **Step 1: Write the failing tooling contract test**

Create `tests/architecture/project-tooling.test.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const commitlintBinary = join(root, "node_modules", ".bin", "commitlint");
const hook = join(root, ".husky", "commit-msg");

test("root tooling declares the conventional commit toolchain", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  assert.equal(packageJson.scripts.prepare, "husky");
  assert.equal(packageJson.scripts.commitlint, "commitlint");
  assert.equal(packageJson.devDependencies.husky, "9.1.7");
  assert.equal(packageJson.devDependencies["@commitlint/cli"], "21.2.1");
  assert.equal(
    packageJson.devDependencies["@commitlint/config-conventional"],
    "21.2.0",
  );

  const configPath = join(root, "commitlint.config.mjs");
  assert.equal(existsSync(configPath), true, "commitlint.config.mjs must exist");
  const config = (await import(pathToFileURL(configPath).href)).default;
  assert.deepEqual(config.extends, ["@commitlint/config-conventional"]);
});

test("commitlint accepts conventional messages and rejects free-form messages", () => {
  assert.equal(existsSync(commitlintBinary), true, "commitlint must be installed");

  const valid = spawnSync(commitlintBinary, [], {
    cwd: root,
    encoding: "utf8",
    input: "feat(runtime): add lifecycle\n",
  });
  const invalid = spawnSync(commitlintBinary, [], {
    cwd: root,
    encoding: "utf8",
    input: "added lifecycle support\n",
  });

  assert.equal(valid.status, 0, valid.stderr);
  assert.notEqual(invalid.status, 0);
});

test("the Husky commit-msg hook enforces the same rules", async () => {
  assert.equal(existsSync(hook), true, ".husky/commit-msg must exist");
  const directory = await mkdtemp(join(tmpdir(), "tego-commitlint-"));

  try {
    const validPath = join(directory, "valid");
    const invalidPath = join(directory, "invalid");
    await writeFile(validPath, "fix(worker): contain disconnect\n");
    await writeFile(invalidPath, "contain worker disconnect\n");

    const valid = spawnSync("sh", [hook, validPath], {
      cwd: root,
      encoding: "utf8",
    });
    const invalid = spawnSync("sh", [hook, invalidPath], {
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    assert.notEqual(invalid.status, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run the test and verify the expected red state**

Run:

```sh
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH \
  node --test tests/architecture/project-tooling.test.mjs
```

Expected: FAIL because `scripts.prepare`, `scripts.commitlint`, the declared
dependencies, and `.husky/commit-msg` do not exist.

- [ ] **Step 3: Add the exact dependencies and scripts**

Update the root `package.json` scripts:

```json
{
  "scripts": {
    "prepare": "husky",
    "commitlint": "commitlint"
  }
}
```

Preserve all existing scripts and add these root dev dependencies:

```json
{
  "devDependencies": {
    "@commitlint/cli": "21.2.1",
    "@commitlint/config-conventional": "21.2.0",
    "husky": "9.1.7"
  }
}
```

Run:

```sh
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH npm install --ignore-scripts
```

Expected: `package-lock.json` records the exact direct dependency versions.

- [ ] **Step 4: Add the shared commitlint configuration and Husky hook**

Create `commitlint.config.mjs`:

```js
export default {
  extends: ["@commitlint/config-conventional"],
};
```

Create `.husky/commit-msg`:

```sh
npm exec --no -- commitlint --edit "$1"
```

Run:

```sh
chmod +x .husky/commit-msg
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH npm run prepare
```

Expected: Husky installs the repository Git hooks without changing tracked
source files other than the intended `.husky/commit-msg`.

- [ ] **Step 5: Run the tooling test and verify green**

Run:

```sh
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH \
  node --test tests/architecture/project-tooling.test.mjs
```

Expected: 3 tests pass, including acceptance and rejection through the actual
hook.

- [ ] **Step 6: Commit the local policy**

```sh
git add package.json package-lock.json commitlint.config.mjs .husky/commit-msg \
  tests/architecture/project-tooling.test.mjs
git commit -m "build: enforce conventional commits"
```

Expected: the commit succeeds through the new `commit-msg` hook.

---

### Task 2: Tested GitHub Quality and PostgreSQL Gates

**Files:**
- Create: `tests/architecture/project-ci.test.mjs`
- Create: `scripts/commitlint-ci.mjs`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: `npm run commitlint`, `.node-version`, root quality and integration scripts, and `TEGO_POSTGRES_URL`.
- Produces: `commitlintArguments(environment): string[]`, `runCommitlint(environment): number`, `npm run commitlint:ci`, GitHub `quality`, and GitHub `postgres-integration` jobs.

- [ ] **Step 1: Write the failing CI contract test**

Create `tests/architecture/project-ci.test.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scriptUrl = new URL("../../scripts/commitlint-ci.mjs", import.meta.url);
const workflowUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);

test("commitlint CI selects explicit ranges and safe fallbacks", async () => {
  assert.equal(existsSync(scriptUrl), true, "commitlint CI script must exist");
  const { commitlintArguments } = await import(scriptUrl.href);

  assert.deepEqual(
    commitlintArguments({
      COMMITLINT_FROM: "a".repeat(40),
      COMMITLINT_TO: "b".repeat(40),
    }),
    ["--from", "a".repeat(40), "--to", "b".repeat(40), "--verbose"],
  );
  assert.deepEqual(
    commitlintArguments({
      COMMITLINT_FROM: "0".repeat(40),
      COMMITLINT_TO: "b".repeat(40),
    }),
    ["--last", "--verbose"],
  );
  assert.deepEqual(commitlintArguments({}), ["--last", "--verbose"]);
});

test("GitHub CI declares quality and PostgreSQL integration gates", async () => {
  assert.equal(existsSync(workflowUrl), true, "CI workflow must exist");
  const workflow = await readFile(workflowUrl, "utf8");

  for (const marker of [
    "pull_request:",
    "push:",
    "workflow_dispatch:",
    "contents: read",
    "quality:",
    "postgres-integration:",
    "actions/checkout@v6",
    "actions/setup-node@v6",
    "node-version-file: .node-version",
    "npm run commitlint:ci",
    "npm run format:check",
    "npm run lint",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "postgres:16.14-alpine",
    "TEGO_POSTGRES_URL:",
    "npm run test:integration",
  ]) {
    assert.match(workflow, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
});
```

- [ ] **Step 2: Run the CI test and verify the expected red state**

Run:

```sh
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH \
  node --test tests/architecture/project-ci.test.mjs
```

Expected: 2 tests fail with the explicit missing script and missing workflow
messages.

- [ ] **Step 3: Implement the tested commit range adapter**

Create `scripts/commitlint-ci.mjs`:

```js
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const zeroObjectId = /^0{40}$/u;

export function commitlintArguments(environment = process.env) {
  const from = environment.COMMITLINT_FROM?.trim();
  const to = environment.COMMITLINT_TO?.trim() || "HEAD";

  if (from && !zeroObjectId.test(from)) {
    return ["--from", from, "--to", to, "--verbose"];
  }

  return ["--last", "--verbose"];
}

export function runCommitlint(environment = process.env) {
  const result = spawnSync("commitlint", commitlintArguments(environment), {
    env: environment,
    stdio: "inherit",
  });

  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runCommitlint();
}
```

Add to the root `package.json`:

```json
{
  "scripts": {
    "commitlint:ci": "node scripts/commitlint-ci.mjs"
  }
}
```

- [ ] **Step 4: Add the GitHub Actions workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    name: Quality
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - name: Set up Node.js
        uses: actions/setup-node@v6
        with:
          node-version-file: .node-version
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Validate commit messages
        run: npm run commitlint:ci
        env:
          COMMITLINT_FROM: ${{ github.event.pull_request.base.sha || github.event.before }}
          COMMITLINT_TO: ${{ github.event.pull_request.head.sha || github.sha }}
      - name: Check formatting
        run: npm run format:check
      - name: Lint
        run: npm run lint
      - name: Typecheck
        run: npm run typecheck
      - name: Run unit and architecture tests
        run: npm test
      - name: Build
        run: npm run build

  postgres-integration:
    name: PostgreSQL integration
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16.14-alpine
        env:
          POSTGRES_DB: tego_next_test
          POSTGRES_PASSWORD: tego_test
          POSTGRES_USER: tego_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U tego_test -d tego_next_test"
          --health-interval 1s
          --health-timeout 3s
          --health-retries 30
    steps:
      - name: Check out repository
        uses: actions/checkout@v6
      - name: Set up Node.js
        uses: actions/setup-node@v6
        with:
          node-version-file: .node-version
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Run integration tests
        run: npm run test:integration
        env:
          TEGO_POSTGRES_URL: postgresql://tego_test:tego_test@127.0.0.1:5432/tego_next_test
```

- [ ] **Step 5: Run the CI contract test and verify green**

Run:

```sh
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH \
  node --test tests/architecture/project-ci.test.mjs
```

Expected: 2 tests pass.

- [ ] **Step 6: Exercise the commit range adapter against repository history**

Run:

```sh
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH \
  COMMITLINT_FROM="$(git rev-parse HEAD~1)" \
  COMMITLINT_TO="$(git rev-parse HEAD)" \
  npm run commitlint:ci
```

Expected: commitlint prints the conventional `build:` commit and exits 0.

- [ ] **Step 7: Commit the CI gates**

```sh
git add package.json scripts/commitlint-ci.mjs .github/workflows/ci.yml \
  tests/architecture/project-ci.test.mjs
git commit -m "ci: add project verification gates"
```

Expected: the commit succeeds through commitlint.

---

### Task 3: Contributor README

**Files:**
- Create: `tests/architecture/readme.test.mjs`
- Create: `README.md`

**Interfaces:**
- Consumes: actual workspace package names, root npm scripts, `compose.yaml`, and `examples/echo-plugin`.
- Produces: the root contributor entry point with commands that can be copied and executed.

- [ ] **Step 1: Write the failing README contract test**

Create `tests/architecture/readme.test.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readmeUrl = new URL("../../README.md", import.meta.url);

test("README documents project scope and executable contributor paths", async () => {
  assert.equal(existsSync(readmeUrl), true, "README.md must exist");
  const readme = await readFile(readmeUrl, "utf8");

  for (const marker of [
    "# Tego Next",
    "Node.js 26.5.0",
    "npm ci",
    "npm run build",
    "npm run typecheck",
    "npm test",
    "docker compose up -d postgres",
    "TEGO_POSTGRES_URL",
    "npm run test:integration",
    "@tegojs/runtime",
    "@tegojs/plugin-sdk",
    "@tegojs/drivers-local",
    "@tegojs/drivers-postgres",
    "@tegojs/executor-node",
    "@tegojs/transport-websocket",
    "examples/echo-plugin",
    "Conventional Commits",
  ]) {
    assert.match(readme, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
});
```

- [ ] **Step 2: Run the README test and verify the expected red state**

Run:

```sh
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH \
  node --test tests/architecture/readme.test.mjs
```

Expected: FAIL with `README.md must exist`.

- [ ] **Step 3: Write the README**

Create `README.md` with these sections and concrete content:

```markdown
# Tego Next

Tego Next is the backend runtime kernel for applications, plugins, clustered
main nodes, and distributed workers. This repository currently implements the
first layer of the planned three-layer architecture.

> Development status: the APIs and package boundaries are still evolving.
> Packages are not published and no compatibility layer is provided yet.

## Architecture

1. Runtime kernel — applications, plugins, cluster coordination, workers, and
   execution placement.
2. Core capabilities — HTTP, security, data sources, caching, and resources.
3. Business capabilities — reusable product and domain modules.

Only the runtime-kernel layer is implemented here.

## Implemented capabilities

- plugin manifests, artifacts, packaging, signing, and lifecycle reconciliation;
- capability resolution and permission gates;
- local memory, SQLite, filesystem, process, and development-secret drivers;
- PostgreSQL state, coordination, and artifact drivers;
- thread, process, and remote worker executors;
- authenticated WebSocket worker transport and reconnect handling;
- reusable driver and executor conformance suites.

## Workspace

| Package | Responsibility |
| --- | --- |
| `@tegojs/contracts` | Stable first-layer contracts and schemas |
| `@tegojs/runtime` | Runtime creation, lifecycle, reconciliation, and recovery |
| `@tegojs/plugin-sdk` | TypeScript plugin component authoring API |
| `@tegojs/drivers-local` | Embedded and single-main local drivers |
| `@tegojs/drivers-postgres` | Cluster-capable PostgreSQL drivers |
| `@tegojs/executor-node` | Thread and process executors for Node.js |
| `@tegojs/transport-websocket` | Main/worker WebSocket transport |
| `@tegojs/testkit` | Driver, worker, and executor conformance tests |
| `@tegojs/cli` | Plugin packaging and signing commands |

The runnable example is in `examples/echo-plugin`.

## Requirements

- Node.js 26.5.0
- npm 11.13.0
- Docker or a local PostgreSQL 16 server for PostgreSQL integration tests

## Development

```sh
npm ci
npm run build
npm run typecheck
npm test
```

Run formatting and lint checks:

```sh
npm run format:check
npm run lint
```

## PostgreSQL integration tests

Start the disposable PostgreSQL service:

```sh
docker compose up -d postgres
```

Run all integration tests against it:

```sh
TEGO_POSTGRES_URL=postgresql://tego_test:tego_test@127.0.0.1:55432/tego_next_test \
  npm run test:integration
```

Stop and delete the disposable database:

```sh
docker compose down -v
```

## Plugin development

`examples/echo-plugin` contains a minimal TypeScript component and manifest.
Plugin code uses `@tegojs/plugin-sdk`; packaging and signing are provided by
`@tegojs/cli`.

## Contributing

Commits follow Conventional Commits:

```text
<type>(optional-scope): <description>
```

Examples:

```text
feat(runtime): add component readiness
fix(worker): contain reconnect failure
test(postgres): cover lease expiry
docs: clarify plugin lifecycle
```

Husky validates messages locally. GitHub validates the entire pull-request
commit range, so bypassing the local hook does not bypass the repository gate.
```

- [ ] **Step 4: Run the README test and verify green**

Run:

```sh
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH \
  node --test tests/architecture/readme.test.mjs
```

Expected: 1 test passes.

- [ ] **Step 5: Commit the documentation**

```sh
git add README.md tests/architecture/readme.test.mjs
git commit -m "docs: add contributor readme"
```

Expected: the commit succeeds through commitlint.

---

### Task 4: Full Local and GitHub Verification

**Files:**
- Modify only files required to resolve failures introduced by Tasks 1-3.

**Interfaces:**
- Consumes: every deliverable from Tasks 1-3.
- Produces: fresh local evidence and an actual GitHub Actions result for the feature branch.

- [ ] **Step 1: Run static and unit verification**

Run:

```sh
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH npm run format:check
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH npm run lint
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH npm run typecheck
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH npm test
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH npm run build
```

Expected: every command exits 0; all new architecture tests are included by
the existing root `npm test` glob.

- [ ] **Step 2: Run PostgreSQL integration verification**

Use the existing local database:

```sh
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH \
  TEGO_POSTGRES_URL=postgresql://tego_dev:tego_dev@127.0.0.1:5432/tego_next_test \
  npm run test:integration
```

Expected: root integration tests and all PostgreSQL driver integration tests
exit 0.

- [ ] **Step 3: Verify clean installation behavior**

Run:

```sh
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH npm ci
PATH=/Users/seal/.volta/tools/image/node/26.5.0/bin:$PATH npm test
```

Expected: `prepare` installs Husky successfully and the test suite remains
green using only the committed manifest and lockfile.

- [ ] **Step 4: Inspect the final change set**

Run:

```sh
git diff --check main...HEAD
git status --short --branch
git log --oneline main..HEAD
```

Expected: no whitespace errors, only planned files changed, and all feature
commits use Conventional Commits.

- [ ] **Step 5: Push the branch and verify GitHub Actions through a draft pull request**

Run:

```sh
git push -u origin codex/project-readme-ci
gh pr create \
  --draft \
  --base main \
  --head codex/project-readme-ci \
  --title "build: add project contribution gates" \
  --body "Adds the contributor README, Conventional Commit enforcement, and GitHub quality and PostgreSQL integration gates."
```

The pull request triggers the workflow without weakening the intended
`pull_request`, `main` push, and manual-dispatch boundaries. Watch its checks:

```sh
gh pr checks codex/project-readme-ci --watch --fail-fast
```

Expected: `Quality` and `PostgreSQL integration` both complete successfully.
