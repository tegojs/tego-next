# Task 4 Report: Atomic Filesystem Artifact Quotas

## Status

Implemented and verified for one `FilesystemArtifactStore` instance. The store now requires an
explicit namespace, parses finite default or injected limits, restores committed usage from
canonical stable `.tego` files at startup, and serializes committed-plus-reserved quota decisions.

The approved Task 3 conformance suite requires capacity to be reserved before a paused source
completes. Therefore Task 4 uses incremental serialized reservations while chunks arrive rather
than the brief's illustrative post-digest reservation pseudocode. Each candidate is still fully
streamed, bounded by `maxArtifactBytes`, and digest-validated before publication. Same-digest
reservations share their charged maximum without skipping validation for any caller.

No cross-process filesystem coordination was added. Atomicity is intentionally scoped to one store
instance, plus restart reconstruction from the filesystem.

## RED Evidence

After binding `defineArtifactStoreSuite` to the real filesystem driver and adding restart, malformed
path, fail-closed startup, same-digest race, close, reservation, and temporary-file cleanup tests:

```text
npm run build --workspace @tego/drivers-local
```

failed with the expected missing construction contract:

```text
Object literal may only specify known properties, and 'namespace' does not exist in type
'FilesystemArtifactStoreOptions'.
Object literal may only specify known properties, and 'namespace' does not exist in type
'CreateLocalDriversOptions'.
```

## GREEN Evidence

Focused verification:

```text
npm run build --workspace @tego/drivers-local
node --test packages/drivers-local/dist/test/local-drivers.test.js
node --test packages/drivers-local/dist/test/development-secret-provider.test.js
npm run typecheck --workspace @tego/drivers-local
```

Result: exit 0; local driver artifact suite `34/34` passed, development secret/provider factory
suite `3/3` passed, and typecheck passed.

CLI call-site verification:

```text
npm run build --workspace @tego/cli
npm run typecheck --workspace @tego/cli
```

Result: exit 0 for both commands.

Local integration verification:

```text
npm run test:integration:local
```

Result: exit 0; `134/136` passed and the two PostgreSQL-only scenarios were skipped because
`TEGO_POSTGRES_URL` was not configured.

Formatting/lint verification for every touched source and test file:

```text
npx biome check <touched files>
```

Result: exit 0 with no fixes required after formatting.

Independent concurrency/storage review found no actionable Critical, Important, or Minor issues.

## Coverage Added

- real public quota conformance suite with tiny limits;
- incremental per-artifact byte enforcement with stable
  `ARTIFACT_SIZE_LIMIT_EXCEEDED` diagnostics;
- committed-plus-reserved namespace admission with stable
  `ARTIFACT_NAMESPACE_QUOTA_EXCEEDED` diagnostics;
- simultaneous distinct digest overcommit prevention;
- simultaneous same-digest shared charging while validating every supplied source;
- restart accounting of only canonical stable artifact paths;
- safe ignoring of temporary and malformed unexpected paths;
- fail-closed startup for pre-existing over-limit committed files;
- digest failure and close cleanup of reservations and temporary files;
- required namespace propagation through local driver and CLI call sites.
