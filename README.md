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

- Plugin manifests, artifacts, packaging, signing, and lifecycle
  reconciliation
- Capability resolution and permission gates
- Local memory, SQLite, filesystem, process, and development-secret drivers
- PostgreSQL state, coordination, and artifact drivers
- Thread, process, and remote worker executors
- Authenticated WebSocket worker transport and reconnect handling
- Reusable driver and executor conformance suites

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

Install the exact dependency graph from the lockfile:

```sh
npm ci
```

Build, typecheck, and run unit and architecture tests:

```sh
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

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

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
