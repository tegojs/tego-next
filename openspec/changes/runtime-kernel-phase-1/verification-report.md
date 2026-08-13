# Phase 1 Alpha Release Verification

## Status

- Release target: `db2fd2dedc3ff025ebd8296f9c0890e1b419344c`
- Local verification: passed on 2026-08-14 (Asia/Shanghai)
- Authoritative GitHub Actions: pending for the first evidence commit
- npm publication, Git tag, GitHub prerelease, spec sync, and OpenSpec archive: pending

The release target is the exact implementation commit tested and packed locally. The commits after
that target may modify only this report and `.comet.yaml`; they do not change the package bytes.

## Toolchain and Database

| Item | Verified value |
| --- | --- |
| Node.js | `v26.5.0` |
| npm | `11.13.0` |
| Volta | `2.0.2` |
| PostgreSQL | `16.14 (Homebrew)` |
| PostgreSQL architecture | Apple Silicon / 64-bit |
| Verification window | 2026-08-14 01:57:46–02:03:04 +08:00 |

Docker was not used because its local storage was full. Verification instead created a validated
`/tmp/tego-task10-pg16.*` PostgreSQL 16 cluster, bound it to loopback on a non-default ephemeral
port, and left the existing PostgreSQL service on port 5432 untouched. The disposable cluster is
stopped and its validated temporary root is removed after evidence recording. All random PostgreSQL
test namespaces live only in that disposable cluster.

## Full Release Gate

Executed against the release target with a clean tracked worktree:

```sh
TEGO_POSTGRES_URL='postgresql://127.0.0.1:<ephemeral-port>/postgres' npm run verify:release
```

Result: PASS, all 12 release stages exited 0.

| Stage | Result | Fresh evidence |
| --- | --- | --- |
| clean lockfile install | PASS | `npm ci`, 104 packages installed |
| format | PASS | Biome checked 256 files |
| lint | PASS | Biome checked 256 files |
| build | PASS | all nine public packages plus echo plugin |
| typecheck | PASS | all nine public packages plus echo plugin |
| unit and architecture tests | PASS | architecture suite 344/344; all workspace unit suites green |
| integration tests | PASS | local integration 162/162; PostgreSQL driver integration 89/89 |
| public package contracts | PASS | nine tarballs and clean consumer |
| deterministic plugin package | PASS | two artifact SHA-256 values both `614657423c310cb65abd1f2c7863b2509a6896a5e1caa612a433ff0513928709` |
| single-Main smoke | PASS | 1/1 real process flow |
| multi-Main takeover | PASS | 1/1 PostgreSQL failover flow |
| strict OpenSpec validation | PASS | `runtime-kernel-phase-1` valid |

An initial full run exposed four pre-existing files that were not formatted by the pinned Biome
2.5.5. The mechanical-only correction is commit
`db2fd2dedc3ff025ebd8296f9c0890e1b419344c`; format, lint, affected build, and the 39/39 focused
workspace-boundary tests passed before the full gate above was rerun from the beginning.

## Focused Stress Gate

Each loop used the compiled release-target code and stopped on the first non-zero exit.

1. Readiness failure process-tree cleanup, 20/20 rounds:

   ```sh
   node --test --test-name-pattern='teardown kills a spawned grandchild when readiness fails|throwing readiness predicate cleans the whole process tree' tests/integration/process-harness.test.mjs
   ```

   Every round passed 3/3 selected tests. Direct children and real grandchildren were asserted
   dead, cleanup artifacts were finalized, and temporary workspaces were removed.

2. Concurrent filesystem and PostgreSQL artifact quota admission, 20/20 rounds:

   ```sh
   node --test --test-name-pattern='prevents concurrent writes from overcommitting namespace reservations' packages/drivers-local/dist/test/local-drivers.test.js
   TEGO_POSTGRES_URL='postgresql://127.0.0.1:<ephemeral-port>/postgres' \
     node --test --test-name-pattern='two PostgreSQL ArtifactStore pools cannot overcommit an existing namespace usage row|two PostgreSQL ArtifactStore pools serialize concurrent first use of a namespace' packages/drivers-postgres/dist/test/postgres-drivers.test.js
   ```

   Every round passed one filesystem and two PostgreSQL races: 60/60 focused scenarios, with one
   durable PostgreSQL winner per race and no quota overcommit.

3. Foreground SIGTERM shutdown, 20/20 rounds:

   ```sh
   node --test --test-name-pattern='foreground-sigterm-cleans-endpoint' packages/cli/dist/test/runtime-process.test.js
   ```

   Every round passed 1/1; the runtime exited 0 and the control endpoint was absent afterward.

The loop logs were local transient evidence and are not committed:

| Stress log | Lines | SHA-256 |
| --- | ---: | --- |
| readiness cleanup | 240 | `010c5af50d04b7fb3c8fc94a0479e6378ac6586e0b6efa8578d573a718f05522` |
| quota admission | 420 | `6b118f662c2d0e2fbf436c4ff636b127be23fa9e8ac5eb435bec17bd3a1bca07` |
| foreground shutdown | 180 | `04beac1e577137ff5667fe840c25c7cb3bf7ae5deddca33a43fc4001330526f7` |

A post-stress process scan found no process created during this verification. It did find two
readiness-fixture process groups started four to five hours before Task 10. Their exact command,
start time, and process-group identities were checked before they were terminated; all four parent
and grandchild PIDs were then proven absent. Historical harness diagnostic directories are retained
by tests that intentionally preserve process logs; they were not live workspaces, sockets, or
processes and are outside the release artifacts.

## Authoritative CI

Pending. The first evidence commit will be pushed and dispatched through the repository's exact
`CI` workflow. These jobs must all succeed on that exact commit before this section is finalized:

- `quality`
- `windows-control` on `windows-2025`, with a real non-skipped named-pipe ACL test
- `integration` with PostgreSQL 16.14
- `system-e2e` with the real single-Main and multi-Main flows

The follow-up CI evidence commit is also required to pass its applicable exact-SHA gates.

## Machine-readable Release Evidence

This block intentionally remains pending until authoritative CI completes. Task 11 preflight must
continue to fail closed until `authoritativeCi.status` is `passed` and all source SHAs are filled.

```release-evidence
{
  "schemaVersion": 1,
  "targetSha": "db2fd2dedc3ff025ebd8296f9c0890e1b419344c",
  "localVerification": {
    "status": "passed",
    "sourceSha": "db2fd2dedc3ff025ebd8296f9c0890e1b419344c"
  },
  "authoritativeCi": {
    "status": "pending",
    "sourceSha": null,
    "url": null
  }
}
```
