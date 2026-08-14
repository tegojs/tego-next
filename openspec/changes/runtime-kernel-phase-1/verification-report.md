# Phase 1 Alpha Release Verification

## Status

- Release target: `2be6a7ad7d470fe77fdf2cee6ba8269ef517cbe3`
- Local verification: passed on 2026-08-15 (Asia/Shanghai)
- Reviewed Windows broker gate: passed on source `ae83ef4c303842a7f4567fbdd4b3ebb19435329b`
- Fresh authoritative GitHub Actions for the Task 5 evidence commit: pending
- npm publication, Git tag, GitHub prerelease, spec sync, and OpenSpec archive: pending Task 11

The release target is the exact documentation/specification source tested locally. Commits after
that target may modify only this report and `.comet.yaml`; they do not change package bytes, tests,
specification requirements, or release documentation.

## Reviewed Windows Broker Evidence

The final Task 4 implementation source is `ae83ef4c303842a7f4567fbdd4b3ebb19435329b`.
Its authoritative [run 31837308587](https://github.com/tegojs/tego-next/actions/runs/31837308587)
completed with all four jobs successful. Canonical sorted run metadata SHA-256:
`8f24c7ba7376ce3a31d57226559ce656570e44c003abc7f24eaafa86918a3337`.

| Job | Result | Frozen log SHA-256 |
| --- | --- | --- |
| [Quality / 94886355756](https://github.com/tegojs/tego-next/actions/runs/31837308587/job/94886355756) | PASS | `98ae0dac6b5b09c82a9ec6fe9ccd645934e8ae41eb45821ea5f6570383a538f0` |
| [Windows control-pipe security / 94886355643](https://github.com/tegojs/tego-next/actions/runs/31837308587/job/94886355643) | PASS; exactly one `TEGO_WINDOWS_CONTROL_GATE_OK` | `ab5776ad05551f546382ef9530901633dc9de4669126317be96f5cbac526bad0` |
| [PostgreSQL integration / 94886355721](https://github.com/tegojs/tego-next/actions/runs/31837308587/job/94886355721) | PASS | `bbf8cc52e7b33bddef248e1f87f90306e0921998453534f8921384c588e19780` |
| [Main and Worker process E2E / 94886355706](https://github.com/tegojs/tego-next/actions/runs/31837308587/job/94886355706) | PASS | `5b210e8337efeba515a73c604ad0a336c153e3634a87b9a8cb35f1b8291430f0` |

This proves the packed `@tego/cli` `win32-x64` broker implementation. It does not substitute for
the fresh Task 5 exact-SHA release chain below.

## Documentation Contract Cycle

The broker documentation contract was added before the document/specification edits. The RED run
used the pinned toolchain:

```sh
/Users/seal/.volta/bin/volta run --node 26.5.0 --npm 11.13.0 \
  node --test tests/architecture/documentation.test.mjs
```

RED: 41/42 passed and the new test failed because authoritative run `31837308587` was absent.
After updating the approved design status, operator/security/release/review documents, both active
delta specs, and the OpenSpec task ledger, the identical command passed 42/42. The contract rejects
post-listen ACL mutation and admission-barrier claims and requires broker ownership, `win32-x64`
scope, PowerShell/C# source delivery, stable parent-handle cleanup, no fallback, immutable real
Windows evidence, and deferred ARM64/precompiled work.

## Toolchain and Disposable Database

| Item | Verified value |
| --- | --- |
| Node.js | `v26.5.0` via Volta |
| npm | `11.13.0` via Volta |
| Volta | `2.0.2` |
| PostgreSQL | `16.14 (Homebrew)` |
| PostgreSQL executable | Mach-O 64-bit `arm64` |
| PostgreSQL endpoint | loopback `127.0.0.1:55951`, validated free before startup |
| Source checkout | disposable detached clean worktree at the exact release target |
| Verification window | 2026-08-15 04:42:47–04:47:12 +08:00 |

The run initialized a new `/tmp/tego-task5-pg16.*` cluster with trust authentication and bound only
the non-default port above. It did not connect to, stop, configure, or delete the existing
PostgreSQL service on port 5432 and did not use Docker. The trap stopped PostgreSQL, removed the
validated temporary cluster, and removed the detached worktree after success. The two pre-existing
Task 8 scratch modifications in the main worktree were never staged or changed.

A dependency-empty checkout needs the repository dependencies before `verify-release.mjs` can
import `js-yaml`. The first disposable setup attempt therefore stopped before any release stage at
04:41:42 +08:00, cleaned PostgreSQL port 55820 and its worktree, and retained a 23-line diagnostic
log with SHA-256 `4a88024cecbd91bb189e35513e0a67561693b546f00775a13413b0b51074cecb`.
The authoritative local run added this explicit pinned bootstrap and then restarted the complete
release command, whose first stage independently ran `npm ci` again:

```sh
/Users/seal/.volta/bin/volta run --node 26.5.0 --npm 11.13.0 npm ci
```

## Full Local Release Gate

Executed from the clean detached target checkout:

```sh
TEGO_POSTGRES_URL='postgresql://postgres@127.0.0.1:55951/postgres' \
  /Users/seal/.volta/bin/volta run --node 26.5.0 --npm 11.13.0 \
  npm run verify:release
```

Result: PASS. All 12 release stages exited 0 and reported bounded, terminated process trees.

| Stage | Fresh result |
| --- | --- |
| clean lockfile install | PASS; 104 packages installed |
| format | PASS; Biome checked 262 files |
| lint | PASS; Biome checked 262 files |
| build | PASS; all nine public workspaces plus echo plugin |
| typecheck | PASS; all nine public workspaces plus echo plugin |
| unit and architecture tests | PASS; 1,013 workspace unit tests and 561/561 architecture tests |
| integration tests | PASS; local 162/162 and PostgreSQL 89/89 |
| public package contracts | PASS; exactly nine tarballs and clean consumer |
| deterministic plugin package | PASS; artifact `614657423c310cb65abd1f2c7863b2509a6896a5e1caa612a433ff0513928709` |
| single-Main smoke | PASS; 1/1 real-process flow |
| multi-Main takeover | PASS; 1/1 PostgreSQL failover flow |
| strict OpenSpec validation | PASS; `runtime-kernel-phase-1` valid |

## Focused Twenty-Round Stress Gates

Each loop used the compiled release-target code and stopped on the first non-zero result.

1. Readiness failure process-tree cleanup, 20/20 rounds and 60/60 selected assertions:

   ```sh
   node --test \
     --test-name-pattern='teardown kills a spawned grandchild when readiness fails|throwing readiness predicate cleans the whole process tree' \
     tests/integration/process-harness.test.mjs
   ```

2. Concurrent filesystem and PostgreSQL artifact quota admission, 20/20 rounds and 60/60 races:

   ```sh
   node --test \
     --test-name-pattern='prevents concurrent writes from overcommitting namespace reservations' \
     packages/drivers-local/dist/test/local-drivers.test.js

   TEGO_POSTGRES_URL='postgresql://postgres@127.0.0.1:55951/postgres' \
     node --test \
     --test-name-pattern='two PostgreSQL ArtifactStore pools cannot overcommit an existing namespace usage row|two PostgreSQL ArtifactStore pools serialize concurrent first use of a namespace' \
     packages/drivers-postgres/dist/test/postgres-drivers.test.js
   ```

3. Foreground SIGTERM shutdown, 20/20 rounds:

   ```sh
   node --test \
     --test-name-pattern='foreground-sigterm-cleans-endpoint' \
     packages/cli/dist/test/runtime-process.test.js
   ```

Standalone package determinism and strict OpenSpec validation were then repeated:

```sh
node scripts/verify-release.mjs --deterministic-package
npm run openspec:validate
```

Both passed. The standalone package run reproduced artifact SHA-256
`614657423c310cb65abd1f2c7863b2509a6896a5e1caa612a433ff0513928709` and manifest SHA-256
`23bac02a030305e6e84f3a0f1ade33163cfafc1aa0ad4f295ff1cda38a41843b`.

## Frozen Local Logs

The transient logs are retained outside the repository at `/tmp/tego-task5-evidence.MQAr8H`.

| Log | Lines | SHA-256 |
| --- | ---: | --- |
| bootstrap `npm ci` | 9 | `62794096148ab4e90c1512a7a2de0c3cf31f5939bf2772cc5c92c80ef463e603` |
| full release verification | 2,270 | `59ef372b4032bc3ba694d07061c4284155a965ec226f40483cd75eed50cf045b` |
| readiness stress | 260 | `e357797634e68dc47b6b83415b626090b57730e794bd24e2f9bd420683190e1d` |
| quota stress | 440 | `4094f82fa715c7e15bf13c43fe10952c579874e18c747aadbf76de6a34f80348` |
| SIGTERM stress | 200 | `095fed32ad7651ae02f61a1a0a89fb56fc0ae0dc9e22ffa670d6622472f25d87` |
| standalone determinism | 7 | `4b31aa0a66c49b072ecaef2f1bd7a710122bc4edf9b36eb4d1a014a163153453` |
| standalone strict OpenSpec | 7 | `64fd6b5e675fd0a5f7ecdb5e3078ff352635950ae64f48329f715b3bd20e5ba5` |

## Fresh Authoritative CI

Pending. This local-evidence commit will be the first allowlisted commit after the release target.
It must pass the exact `CI` workflow with all four required jobs:

- `quality`
- `windows-control` on `windows-2025`, with the packed broker gate and one success marker
- `integration` with PostgreSQL 16.14
- `system-e2e` with real single-Main and multi-Main flows

After those jobs pass, one final allowlisted follow-up will record immutable run/job URLs and
metadata/log hashes. That follow-up must then pass its exact-SHA documentation/quality gate.

## Machine-readable Release Evidence

Task 11 preflight must continue to fail closed until fresh authoritative CI is passed.

```release-evidence
{
  "schemaVersion": 1,
  "targetSha": "2be6a7ad7d470fe77fdf2cee6ba8269ef517cbe3",
  "localVerification": {
    "status": "passed",
    "sourceSha": "2be6a7ad7d470fe77fdf2cee6ba8269ef517cbe3"
  },
  "authoritativeCi": {
    "status": "pending",
    "sourceSha": null,
    "url": null
  }
}
```

No npm package was published, no dist-tag was changed, no Git tag or GitHub release was created,
and no OpenSpec sync or archive was performed.
