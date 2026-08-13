# Task 5 Report: Transactional PostgreSQL Artifact Quotas

## Status

Implemented and verified against an isolated PostgreSQL 16.14 cluster. PostgreSQL artifact stores
now accept contract limits, enforce cumulative namespace quota with a durable usage row, serialize
independent pools with a row lock, and commit artifact bytes plus accounting atomically.

## Delivered behavior

- PostgreSQL migration version 5 creates
  `tego_artifact_namespace_usage(driver_namespace PRIMARY KEY, committed_bytes BIGINT NOT NULL)`
  with a non-negative check and backfills exact `octet_length(content)` totals without double
  counting. Migration rows now carry SHA-256 checksums; the existing four legacy versions are
  upgraded from trusted fixed checksums and later drift is rejected.
- `PostgresArtifactStore` parses the Task 3 storage limits. It bounds ingress by the configured
  per-artifact limit, hashes and validates every supplied source (including duplicate digests), and
  uses BigInt for durable quota values.
- A transaction inserts-or-observes the namespace usage row, locks it with `FOR UPDATE`, checks the
  digest, admits capacity, inserts immutable bytes, increments usage, and commits. Rollback covers
  digest, query, trigger, connection, and close failures before the commit linearization point.
- Two store instances backed by independent pools cannot overcommit either an existing usage row or
  an initially absent row. Namespace usage is isolated.
- Close destroys tracked preflight and pre-commit clients, while an already-committing transaction
  is allowed to settle so a durable commit is never reported as closed.
- `createPostgresDrivers()` exposes `artifactLimits` and forwards them to the artifact store.

## TDD evidence

### RED

After binding the Task 3 public suite and writing migration, restart, duplicate, two-pool, rollback,
namespace-isolation, and close tests, the required build failed before implementation:

```text
TS2353: 'limits' does not exist in type 'PostgresConnectionOptions'
```

The first real PostgreSQL run then exposed the missing durable behavior and synchronization. Two
review regressions were separately observed red:

```text
closing a store cancels a put blocked during its preflight artifact status query
Error: Artifact store close did not cancel its preflight query
```

and:

```text
closing a store lets an already-committing artifact transaction settle successfully
DiagnosticError: PostgreSQL artifact store is closed
```

### GREEN

An isolated Homebrew cluster was created without touching the existing port 5432 service or Docker:

```sh
pg_tmp=$(mktemp -d /tmp/tego-task5-pg.XXXXXX)
/opt/homebrew/opt/postgresql@16/bin/initdb -D "$pg_tmp/data" --auth=trust --no-locale
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D "$pg_tmp/data" \
  -l "$pg_tmp/postgres.log" -o "-h 127.0.0.1 -p 55432" -w start
/opt/homebrew/opt/postgresql@16/bin/createuser -h 127.0.0.1 -p 55432 tego_test
/opt/homebrew/opt/postgresql@16/bin/createdb -h 127.0.0.1 -p 55432 \
  -O tego_test tego_next_test
export TEGO_POSTGRES_URL=postgresql://tego_test@127.0.0.1:55432/tego_next_test
```

Database version:

```text
PostgreSQL 16.14 (Homebrew) on aarch64-apple-darwin25.4.0
```

Fresh final verification:

```sh
TEGO_POSTGRES_URL="$TEGO_POSTGRES_URL" npm run test:integration \
  --workspace @tego/drivers-postgres
npm run typecheck --workspace @tego/drivers-postgres
npx biome check packages/drivers-postgres/src/migrations.ts \
  packages/drivers-postgres/src/postgres-artifact-store.ts \
  packages/drivers-postgres/src/create-postgres-drivers.ts \
  packages/drivers-postgres/test/postgres-drivers.test.ts \
  packages/drivers-postgres/test/artifact-boundaries.test.ts
git diff --check
```

Result: integration **79/79 passed**; build, typecheck, Biome, and diff-check passed. The database
reported schema version 5 with five valid 64-hex migration checksums and no negative usage rows.

## Self-review

An independent read-only review initially found two Important close races: an untracked preflight
query and ambiguous close during in-flight COMMIT. Both received focused failing PostgreSQL tests,
were fixed with tracked clients and an explicit commit linearization set, and passed re-review.
Final verdict: **Ready — yes**, with no Critical, Important, or Minor findings.

## Concerns

None. The test cluster is disposable and is stopped with `pg_ctl -m fast` before removing only its
validated `/tmp/tego-task5-pg.*` root.
