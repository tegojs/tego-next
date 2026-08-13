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

## Review Fixes

Follow-up review identified five storage/lifecycle boundaries. Each was reproduced with a failing
test before implementation:

- a directory fsync failure after rename left a visible target that a retry treated as already
  durable;
- `close()` waited indefinitely for a source suspended in `AsyncIterator.next()`;
- the exported quota API could commit a smaller same-digest reservation, admit another digest,
  then overwrite the first committed size past the namespace limit;
- canonical stable files with unsafe metadata sizes were silently excluded from startup usage;
- sequential write cleanup stopped at the first cleanup failure and could leak later resources.

The fixes now keep renamed-but-not-directory-durable bytes in pending occupied capacity and require
retry to sync both directories before promotion; abort active ingress on close and reject any
post-close publication; atomically re-admit or reject inconsistent same-digest commits while keeping
commit/release idempotent; fail closed on unsafe canonical sizes; and aggregate the primary error
with every cleanup failure after attempting reservation, handle, temporary-file, and empty-directory
cleanup.

Follow-up review also covered two second-order boundaries: synchronous `iterator.return()` throws
are now contained so they cannot replace the authoritative write/close diagnostic, and direct quota
commits treat pending-durability bytes as occupied authoritative size rather than shrinking them.

Focused review-fix suite result after implementation:

```text
tests 41
pass 41
fail 0
```

Local integration remained green with `134/136` passing and the same two PostgreSQL-only skips.
