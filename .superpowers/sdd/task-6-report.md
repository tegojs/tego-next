# Task 6 Report: Secure Plugin Artifacts

## Outcome

Task 6 implements a usable plugin artifact pipeline across `@tegojs/runtime`,
`@tegojs/cli`, and `@tegojs/testkit`.

The delivered vertical slice:

- compiles plugins with the exact workspace TypeScript 7 compiler through a
  shell-free child process;
- packages declared JavaScript ESM into deterministic POSIX ustar `.tego`
  archives;
- computes SHA-256 over the final archive bytes;
- signs raw SHA-256 digest bytes with Ed25519;
- performs bounded, data-only runtime preflight without extracting, importing,
  or evaluating component code;
- validates schema, Node, Tego contract, module format, platform, and
  architecture compatibility;
- verifies optional or required signatures against explicit trust keys;
- registers an immutable `PluginInstallation` transactionally.

## TDD Ledger

| Cycle | RED | GREEN |
| --- | --- | --- |
| Secure archive and CLI contract | `16201b9` | `6b0d15c` |
| Immutable installation | `4e2fed6` | `bb82fd6` |
| Reusable plugin fixtures | `8c41114` | `bdbb621` |
| Cross-platform path ambiguity | `e2c6e5e` | `a16fad6` |
| Installation triple identity | `c3d3185` | `63ccdd7` |
| Partial compatibility ranges | `001ba12` | `8cf0cc9` |

Every RED was observed failing for the intended missing behavior before its
implementation was written.

## Public API

`@tegojs/runtime` now exports:

- `ArtifactService.validate`
- `ArtifactService.install`
- `ArtifactSignatureEnvelope`
- `ArtifactTrustConfiguration`
- `ArtifactCompatibility`
- deterministic archive codec helpers used by the CLI

`@tegojs/cli` now exports:

- `buildPlugin`
- `packPlugin`
- `signArtifact`

`@tegojs/testkit` now exports:

- `createPluginManifestFixture`
- `artifactDigest`
- `artifactBytesSource`

All returned metadata and signature envelopes are JSON-safe. Private keys are
command inputs and are never persisted in artifact metadata.

## Security Boundaries

The runtime preflight:

- streams through a bounded reader with archive, entry-size, and entry-count
  limits;
- captures only `manifest.json` and `metadata/files.json`;
- hashes all archive entries while streaming;
- rejects malformed/truncated headers, checksum mismatches, non-zero padding,
  data after the tar terminator, and unsupported tar variants;
- rejects PAX/GNU overrides, links, directories, devices, and FIFOs;
- rejects absolute, drive, UNC, backslash, traversal, repeated-separator,
  non-NFC, control-character, Windows device, trailing-dot/space, colon, and
  alternate-stream paths;
- rejects duplicate entries, undeclared files, missing files, file digest/size
  mismatches, missing SBOM metadata, and missing/unsafe entrypoints;
- parses the manifest as data and never imports or extracts executable files.

The echo fixture contains an observable top-level side-effect trap. Invalid
manifest validation proves that the component is not evaluated.

Signatures use:

```text
Ed25519.sign(raw 32-byte SHA-256 digest)
```

The envelope carries the algorithm, key ID, digest, and canonical base64
signature. Required signatures, unknown keys, digest disagreement, malformed
signatures, and tampering are rejected before installation.

## Installation Model

One `StateStore` transaction writes:

1. a version index at `(pluginId, version)`;
2. an immutable installation at `(pluginId, version, digest)`.

The version index prevents a second digest from replacing an already-installed
plugin version. Reinstalling the same digest is idempotent. A concurrent
conditional-write race is resolved by rereading durable state and applying the
same conflict rule.

## Verification Evidence

Executed with Node.js `26.5.0`:

- focused build for contracts, testkit, runtime, local drivers, and CLI: PASS;
- combined contracts/runtime/CLI/testkit/local-driver suite: 134/134 PASS;
- runtime focused suite: 54/54 PASS;
- CLI focused suite: 3/3 PASS;
- testkit focused suite: 3/3 PASS;
- architecture suite: 18/18 PASS;
- targeted typecheck for all implemented workspaces: PASS;
- Biome format: PASS;
- Biome lint: PASS;
- `git diff --check`: PASS;
- SQLite restart smoke: packed an echo plugin, stored it through
  `FilesystemArtifactStore`, installed it through `ArtifactService`, reopened
  `SqliteStateStore`, and verified the immutable installation survived.

The repository-wide `npm run typecheck` still reaches four future placeholder
workspaces that have no `tsconfig.json`:

- `@tegojs/drivers-postgres`
- `@tegojs/executor-node`
- `@tegojs/plugin-sdk`
- `@tegojs/transport-websocket`

The implemented Task 6 workspaces all typecheck. The placeholder workspace gap
predates Task 6 and is assigned to later plan tasks.

## Deliberate Limits

- The archive reader accepts the auditable regular-file POSIX ustar subset and
  rejects extension records rather than interpreting them.
- Compatibility ranges support exact, partial, wildcard, comparison, caret,
  tilde, whitespace intersection, and `||` alternatives. They intentionally do
  not claim complete npm-semver grammar.
- Runtime validation buffers only the bounded manifest and files metadata.
  The local `ArtifactStore` remains the authority for verifying the full
  content-addressed archive digest before bytes are exposed.

## Formal Review Remediation

The formal and security review returned `REQUEST CHANGES`. The findings were
reproduced with failing tests before implementation changes:

| Review cycle | RED | GREEN |
| --- | --- | --- |
| Runtime identity, range, collision, and archive limits | `65665d4` | `b30ad44` |
| Bounded local artifact verification | `246b649` | `6b90f2c` |
| Build and pack confinement | `183d643` | `e027eff` |
| Mixed invalid ranges and fake Node built-ins | `cf1cbfb` | `a6bc3e2` |
| Symlinked build-configuration ancestors | `fad0d78` | `d644ee4` |

The remediation closes all seven requested findings:

- build and pack paths are canonicalized, confined below the real plugin root,
  checked for symlink ancestors, and read with no-follow descriptor checks plus
  post-read identity verification;
- build output is emitted into a private temporary directory below the plugin
  root and removed on success and failure;
- unsupported comparators invalidate the complete compatibility expression,
  including otherwise-satisfiable `||` alternatives;
- artifact verification uses a reusable 64 KiB buffer and yields bounded chunks
  only after the complete file digest is verified;
- archive and metadata paths reject case-folding, Unicode-normalization, and
  portable Windows-device collisions, including COM/LPT superscript forms;
- `ArtifactService` independently hashes the complete stream and compares the
  observed digest with the requested content address;
- packaging rejects bare third-party imports and fake `node:` built-ins, records
  audited built-in runtime imports in the SBOM, and enforces entry count,
  per-entry size, and total archive-size limits before concatenation.

Ed25519 signatures now also require canonical base64 with the exact encoded
length. The earlier statement that the local `ArtifactStore` is the sole
authority for complete-stream digest verification is superseded: both the
filesystem store and `ArtifactService` now verify the content address at their
respective trust boundaries.

Final review verification, executed with Node.js `26.5.0`:

- combined contracts, testkit, runtime, local-driver, and CLI matrix: 166/166
  PASS;
- runtime artifact and bootstrap suite: 72/72 PASS;
- CLI plugin-pack suite: 16/16 PASS;
- 8 MiB verification probe: maximum read and yielded chunk size remained at or
  below 64 KiB;
- targeted typecheck for all implemented workspaces: PASS;
- architecture suite: 18/18 PASS;
- Biome format and lint: PASS;
- `git diff --check`: PASS;
- SQLite restart smoke: a freshly built echo plugin was packed, persisted
  through `FilesystemArtifactStore`, installed through `ArtifactService`, then
  recovered by immutable `(pluginId, version, digest)` identity after reopening
  `SqliteStateStore`.
