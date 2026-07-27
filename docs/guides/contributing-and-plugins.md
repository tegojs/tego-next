# Contributing and plugin authoring

This guide covers the verified repository workflow and the CLI surface that
exists in phase one. Architecture and deployment details live in
[Runtime kernel architecture](../architecture/runtime-kernel.md) and
[Deployment topologies](../operations/deployment-topologies.md).

## Exact toolchain setup

Use exactly Node.js 26.5.0 and npm 11.13.0. The Node version is pinned in
`.node-version`; the npm version is pinned in `package.json`.

After installing Node.js 26.5.0 with your version manager, install and verify
the pinned npm:

```sh
npm install --global npm@11.13.0
node --version
npm --version
```

The expected output is `v26.5.0` and `11.13.0`. Then install the exact lockfile
graph and build the workspace:

```sh
npm ci
npm run build
```

The packages are not published. In this checkout, invoke the built CLI as:

```sh
node packages/cli/dist/src/bin.js --help
```

## OpenSpec-linked red-green-refactor

Every behavior change starts from the approved OpenSpec change at
`openspec/changes/runtime-kernel-phase-1/`.

1. Add or update one requirement scenario in the relevant
   `specs/<capability>/spec.md` and add its implementation item to `tasks.md`.
2. Write the smallest automated test for that scenario. Name it with the stable
   trace marker `@spec:<capability>/<requirement>/<scenario>`.
3. Run the focused test and prove RED for the expected missing behavior. Fix
   test errors until it fails for that reason.
4. Commit the verified failing test with a Conventional Commit such as
   `test(runtime): specify recovery ordering`.
5. Implement the smallest change that makes the focused test GREEN.
6. REFACTOR only after GREEN, rerunning the focused test after each cleanup.
7. Run the applicable package tests and repository verification. Mark the
   OpenSpec task complete only after the implementation and evidence pass.

Do not change a test merely to make an implementation pass. Do not add an
unlinked behavior that has no OpenSpec scenario.

Validate the change structure strictly:

```sh
npm run openspec:validate
```

## Verification commands

Use focused tests during RED/GREEN. For example:

```sh
node --test tests/architecture/documentation.test.mjs
npm run test:unit --workspace=@tegojs/runtime
```

Before handoff, run all local-capable gates:

```sh
npm run verify
git diff --check
```

`npm run verify` runs format, lint, build, typecheck, unit and architecture
tests, local integration tests, and the single-Main process smoke test.

Release verification additionally requires a clean tree, the exact toolchain,
PostgreSQL 16, and `TEGO_POSTGRES_URL`:

```sh
TEGO_POSTGRES_URL=postgresql://tego_test:tego_test@127.0.0.1:55432/tego_next_test \
  npm run verify:release
```

GitHub Actions remains the authoritative phase-one acceptance environment for
PostgreSQL integration and multi-Main system behavior.

## Author a plugin

The repository example is `examples/echo-plugin`. A phase-one plugin project
contains `package.json`, `tsconfig.json`, `manifest.json`, and TypeScript
component sources. The packer runs the project's TypeScript build, audits the
emitted modules, and writes a deterministic `.tego` archive.

The checked-in echo manifest currently demonstrates a future contract range.
For a plugin installed into this phase-one runtime, use a contract range that
includes the runtime's current `0.0.0` contract version.

### Component

Use `defineComponent`; no base class or decorator is required:

```ts
import { defineComponent } from "@tegojs/plugin-sdk";

export default defineComponent({
  kind: "task",
  async run(_context, input) {
    return input;
  },
});
```

Task input and output must be finite, acyclic JSON values. The component
context exposes identity, configuration, logs, events, capabilities, lifecycle
and runtime information, cancellation, disposables, attachments, and
permission-gated secrets.

### Manifest

This minimal manifest supports the current runtime contract and local process
execution:

```json
{
  "schemaVersion": "1.0",
  "pluginId": "org.example.echo",
  "version": "1.0.0",
  "contractRange": ">=0.0.0 <1.0.0",
  "nodeRange": ">=26.0.0 <27.0.0",
  "moduleFormat": "esm",
  "components": [
    {
      "componentId": "echo",
      "kind": "task",
      "entrypoint": "components/component.js",
      "executors": ["process"]
    }
  ],
  "permissions": [
    {
      "kind": "executor",
      "executors": ["process"]
    }
  ],
  "capabilities": {
    "provides": [],
    "requires": []
  }
}
```

The packer reads and validates the manifest before importing component code.
Built output must be JavaScript ESM. Static relative imports,
`@tegojs/plugin-sdk`, and Node builtins are supported; dynamic imports,
CommonJS, and third-party bare imports are rejected.

### Validate and package

After `npm run build`, validate a plugin directory without keeping an artifact:

```sh
node packages/cli/dist/src/bin.js plugin validate ./path/to/plugin --json
```

Create and inspect the deterministic artifact:

```sh
node packages/cli/dist/src/bin.js plugin pack ./path/to/plugin \
  --output /tmp/example.tego --json
node packages/cli/dist/src/bin.js plugin inspect /tmp/example.tego --json
```

`plugin pack` runs the plugin build by default. Use `--no-build` only when a
complete `build/` directory already exists.

### Sign during packaging

Signing is an option of `plugin pack`, not a separate command. Pass an Ed25519
private key, portable key ID, and optional signature output:

```sh
node packages/cli/dist/src/bin.js plugin pack ./path/to/plugin \
  --output /tmp/example.tego \
  --key-id release-key-1 \
  --private-key ./private-ed25519.pem \
  --signature-output /tmp/example.tego.sig \
  --json
```

The sidecar contains an Ed25519 signature envelope over the final artifact
digest. Keep the private key outside the repository. The current local install
command does not accept the signature sidecar or configure trust keys; a host
that requires signatures must compose `ArtifactService` with trusted public
keys and pass the envelope through the runtime operation API.

### Install and deploy

Start an embedded runtime as described in the
[single-Main guide](../operations/deployment-topologies.md), then install the
artifact through its private control endpoint:

```sh
node packages/cli/dist/src/bin.js plugin install /tmp/example.tego \
  --endpoint .tego/main/control.sock --json
```

Copy the returned `digest` and deploy it with a permission grant that is a
subset of the manifest request:

```sh
node packages/cli/dist/src/bin.js plugin deploy org.example.echo \
  --digest sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --permissions '[{"kind":"executor","executors":["process"]}]' \
  --endpoint .tego/main/control.sock --json
```

Poll the desired and observed deployment state until the observation is
`ready`:

```sh
node packages/cli/dist/src/bin.js plugin status org.example.echo \
  --endpoint .tego/main/control.sock --json
```

Deploying a new digest writes a new desired generation. It does not overwrite
the immutable installation.

### Run and inspect a task

Run waits for a terminal result unless `--no-wait` is present:

```sh
node packages/cli/dist/src/bin.js task run org.example.echo/echo \
  --input '{"message":"hello"}' \
  --operation-id example-echo-1 \
  --endpoint .tego/main/control.sock --json
```

For asynchronous operation, add `--no-wait`, copy the returned `taskId`, and
use the record commands:

```sh
node packages/cli/dist/src/bin.js task status REPLACE_WITH_TASK_ID \
  --endpoint .tego/main/control.sock --json
node packages/cli/dist/src/bin.js task wait REPLACE_WITH_TASK_ID \
  --timeout-ms 15000 --endpoint .tego/main/control.sock --json
node packages/cli/dist/src/bin.js task cancel REPLACE_WITH_TASK_ID \
  --endpoint .tego/main/control.sock --json
```

Treat `indeterminate` as a distinct terminal result with no output. Do not
automatically retry it.

## Current CLI limitations

### Exact command inventory

The current parser accepts exactly these command names:

- `runtime start`
- `runtime status`
- `runtime snapshot`
- `runtime stop`
- `plugin validate`
- `plugin pack`
- `plugin inspect`
- `plugin install`
- `plugin deploy`
- `plugin status`
- `task run`
- `task status`
- `task wait`
- `task cancel`
- `worker start`

It does not yet expose trust-key configuration, signature-envelope installation,
deployment disable/rollback controls, or Main-side Worker listener and
connection configuration. The Worker command can connect to an already
configured Main listener or listen for a Main that is configured through the
public library API:

```sh
TEGO_WORKER_CREDENTIAL=replace-me \
  node packages/cli/dist/src/bin.js worker start \
  --connect ws://127.0.0.1:9000 \
  --worker-id worker-1 \
  --prepare /tmp/example.tego \
  --data-dir .tego/worker-1 --json
```

Packages are unpublished and APIs are evolving. Production release remains
blocked until Node.js 26 enters LTS.
