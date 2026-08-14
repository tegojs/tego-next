# Windows control broker Task 3 report

## Status

`DONE_WITH_CONCERNS`

Windows x64 control startup now selects the packaged broker before any Node `net.Server` is
created. The broker adapter exposes virtual Duplex control connections, validates the broker's
read-back security descriptor before readiness, enforces protocol queue/backpressure limits, and
settles the child and its streams on startup and shutdown paths. The Unix socket path retains its
existing listener, permission, identity, dispatch, and cleanup behavior.

The remaining concern is an evidence boundary rather than a known local failure: this macOS host
cannot compile the C# through Windows PowerShell 5.1 or execute the Win32 named-pipe path. Task 4's
real-Windows gate must establish those facts.

## TDD evidence

The transport-neutral `ControlConnection` extraction was made under the existing control tests.
The pre-Windows-behavior run remained green at 45/45.

The first adapter/source run was intentionally RED:

```text
CLI build: failed because windows-broker.ts and windows-broker-security.ts did not exist
Windows broker C# source contract: tests 7; pass 5; fail 2
```

The two C# failures specifically showed that the first server-handle descriptor was not encoded
and that `READY` still carried an empty payload. Fake-child adapter tests were written with real
PassThrough stdin/stdout/stderr streams before the adapter implementation.

During self-review, a new close-settlement test proved RED when a child acknowledged `CLOSE_ALL`
but then exited nonzero: the close promise incorrectly resolved. The adapter now preserves that
terminal failure, and the focused test passes.

Final focused results:

```text
control + broker adapter: tests 35; pass 35; fail 0
Windows broker source contract: tests 7; pass 7; fail 0
source + clean-consumer package contracts: tests 25; pass 25; fail 0
```

## READY descriptor contract

The C# broker performs a fresh `GetKernelObjectSecurity` readback on the first server handle,
re-parses a `RawSecurityDescriptor`, and reuses the strict descriptor validator before encoding a
canonical binary `TGSD` version 1 payload. The format is independent of PowerShell JSON support:

- 12-byte big-endian header: four-byte `TGSD` magic, version, protected-DACL flag, owner SID byte
  length, and ACE count;
- canonical printable ASCII owner SID;
- ordered ACE entries containing allow/non-inherited/non-callback flags, the full pipe-control
  mask, and a canonical SID;
- exact payload length with zero reserved fields and no trailing data.

TypeScript decodes the payload strictly and requires the exact distinct ordered SID sequence of
owner, LocalSystem, and Administrators. It rejects wrong magic/version, unprotected DACLs,
malformed SIDs, missing/duplicate/reordered/unexpected ACEs, inherited or callback ACEs, wrong
masks, nonzero reserved fields, and trailing bytes. The protocol maximum frame size is unchanged.

## Implementation

- `server.ts` now dispatches through a transport-neutral `ControlConnection`. Unix still creates
  its paused `net.Server`, verifies the owner-private directory and exact owner-owned mode-0600
  socket, and uses the same request framing and drain rules.
- Windows selection occurs before Unix endpoint inspection or listener creation. Windows x64
  starts only the broker; unsupported architectures and broker construction/startup failures fail
  with `PROTOCOL_CONTROL_ENDPOINT_UNSAFE`. Tests inject a broker factory on macOS instead of
  spoofing `process.platform` or spawning real PowerShell.
- Pending virtual connections remain undispatched until `broker.start()` resolves after a valid
  `READY`. Failure destroys pending connections and awaits broker rollback; no Node named pipe,
  fallback, `NODE_PENDING_PIPE_INSTANCES`, or private `_handle` adoption remains.
- The adapter resolves the packaged `.ps1` and `.cs` beside `import.meta.url`, checks both assets,
  and invokes `powershell.exe` with fixed absolute arguments, `shell: false`, hidden window, and
  piped stdio.
- A Task 1 `WindowsBrokerConnectionState` validates every inbound and outbound frame and enforces
  per-connection/global queued-byte limits. `OPEN`, `DATA`, `EOF`, and `CLOSE` become Duplex
  connections; response writes become `DATA` and terminal `CLOSE` frames. Readable backpressure
  generates direction-correct `PAUSE`/`RESUME` frames.
- Startup abort/timeout, malformed/truncated stdout, invalid `READY`, `FATAL`, child errors/exits,
  and non-allowlisted or oversized stderr fail closed. Diagnostics expose only fixed stage codes.
- Close sends `CLOSE_ALL`, waits a bounded interval for ACK and child/stdio settlement, then
  escalates through terminate and kill. Cleanup aggregation keeps the primary protocol error first.
- The obsolete post-listen TypeScript security adapter, PowerShell helper, admission-barrier
  constants/logic/tests, emitted asset, and package requirement were removed. Active security,
  release, and delta-spec wording now documents broker creation/readback and READY validation.

## Packaging and verification

- `npm run test:unit --workspace @tego/cli`: 191/191 passed;
- `npm run build --workspace @tego/cli`: passed;
- `npm run typecheck --workspace @tego/cli`: passed;
- `node --test tests/architecture/*.test.mjs`: 352/352 passed;
- clean-consumer package verification passed for the exact nine public packages and includes only
  the broker `.ps1`/`.cs` assets for Windows control;
- repository broker `.ps1` and `.cs` sources match the emitted CLI copies byte-for-byte;
- full-repository Biome lint and format checks passed (261 files);
- Task 3 scoped `git diff --check` passed.

The whole-worktree diff still contains pre-existing, out-of-scope edits to
`.superpowers/sdd/task-8-brief.md` and `.superpowers/sdd/task-8-report.md`. They were neither modified
for Task 3 nor staged.

## Remaining concern

Do not interpret static source contracts or macOS fake-child tests as evidence that Windows
PowerShell 5.1 compiles the updated C#, that `GetKernelObjectSecurity` returns the expected live
descriptor on Windows, or that real Win32 process/pipe cleanup is leak-free. Task 4 must run the
packaged broker and control gate on the authoritative Windows worker.

## Root-review remediation

Root review rejected the first Task 3 commit for four lifecycle/security gaps. This section
supersedes the affected completion claims above while preserving the real-Windows evidence
boundary.

### Directional close convergence

Task 1 now records `CLOSE` independently for broker-to-parent and parent-to-broker directions. The
first close releases both queues once and fences later data/EOF/backpressure; one opposite close is
accepted, while same-direction duplicates remain invalid. The C# broker keeps a fixed recent-64-ID
tombstone window after disposing a connection. It consumes one queued parent close after its own
close, rejects never-opened IDs and duplicate parent closes, and clears both tombstone structures
during shutdown.

A fake-child race test queues response `DATA`, delivers broker `CLOSE` first, observes the later
parent `CLOSE`, then opens and serves a second connection without a broker error. Source mutations
require the C# input loop to route `CLOSE` before active lookup, retain directional tombstones,
bound both the dictionary and FIFO by `MaxConnections`, and clear them at shutdown.

### Child and stdio settlement

`exitCode` and `signalCode` now suppress only redundant terminate/kill signals. They never bypass a
bounded wait for the child `close` event, which is Node's post-stdio settlement event. The fake child
can publish exit state separately from ending stdin/stdout/stderr and emitting close; startup
rollback and terminal broker close both remain pending until that explicit settlement. A missing
close becomes an ordered cleanup timeout error.

### Exact SID parsing

The READY decoder now accepts only uppercase canonical `S-1-...` text, revision exactly 1, a
canonical decimal identifier authority no greater than `2^48-1`, and 1 through 15 canonical decimal
subauthorities no greater than `2^32-1`. Tests cover both maximum legal bounds and reject lowercase,
wrong/zero-padded revision or authority, authority/subauthority overflow, missing subauthorities,
zero-padded subauthorities, and sixteen subauthorities. Exact LocalSystem/Administrators identity,
ACE order, and full-control mask validation remain unchanged.

### Close error ordering

Windows server close now always observes broker cleanup before deciding its result. If broker close
fails after an error was already stored by the broker observer or `onServerError`, the thrown
`AggregateError` orders the broker close failure first and the stored listener error second. The
observer error cannot mask cleanup failure.

Each item began with a focused failing test for the reported behavior. The remaining platform
concern is unchanged.

Fresh post-remediation verification:

```text
focused control + Task 1 protocol + broker adapter: 52/52 passed
focused C# source/mutation contract: 7/7 passed
all CLI unit tests: 194/194 passed
all architecture/package tests: 352/352 passed
CLI build and typecheck: passed
repository Biome lint and format: 261 files passed
repository source versus emitted broker .ps1/.cs: byte-for-byte equal
```

## Final close-handshake redesign

The final review rejected the bounded recent-ID FIFO described in the first remediation: eviction
could make a still-queued acknowledgement for the earliest broker-first close look like an unknown
ID. This section supersedes that FIFO/tombstone design.

Task 1 deletes connection state immediately after both directional closes and relies on the
monotonic `lastConnectionId` to reject reuse and old traffic. A 10,000-connection regression proves
the active map returns to zero. `CLOSE_ALL` still needs only one observed close for each remaining
active entry, so its scan is bounded by live adapter admission rather than lifetime churn.

The virtual Duplex now memoizes its parent close operation. A broker-first close queues the parent
close acknowledgement before destroying the virtual connection; `_final` and `_destroy` share the
same promise, so either race order emits at most one parent close. The deterministic fake-child test
queues response data, delivers broker close first, observes exactly one later parent close, and then
serves another connection on the same healthy endpoint.

The C# broker replaces the recent-close dictionary/FIFO with an unresolved-only
`PendingCloseTracker`:

- a parent-first close removes the active pipe and promptly writes the broker close
  acknowledgement, completing convergence without retained history;
- a broker-first close replaces its active slot with one pending close carrying an absolute UTC
  deadline no later than `ShutdownTimeoutMilliseconds` (2 seconds), then writes broker close;
- parent acknowledgement validates the directional state, removes the pending entry, reschedules
  the single deadline timer, and releases admission capacity;
- active connections plus unresolved broker-first closes can never exceed `MaxConnections` (64),
  so a full pending set prevents creation/acceptance of a 65th connection without evicting any ID;
- the timer callback never blocks the parent input loop; expiry emits the fixed protocol failure and
  fails closed, while shutdown clears pending state, disarms the timer, and boundedly waits for any
  callback during disposal; and
- fully converged, duplicate, or never-opened parent close IDs remain fatal protocol input.

Both the JavaScript admission model and the C# `SelfTest` hold the earliest close unresolved while
filling all 64 slots, reject further admission, acknowledge the earliest ID, and churn through
10,000 IDs while retaining exactly 64 unresolved entries. Source mutation contracts prohibit
`RecentClosed`, `Queue<ulong>`, or FIFO-cap code and require the timer deadline, capacity sum,
acknowledgement removal, shutdown clearing, and callback settlement.

### Final redesign TDD and verification

The Task 1 test first failed with an undefined active count and retained state. The adapter test was
changed before implementation so broker close arrived without a preceding `end`; it could not
observe the required parent acknowledgement. The C# source contract then failed on the missing
pending tracker and retained FIFO code. Each focused suite passed after its corresponding minimal
implementation.

Fresh verification on Node v26.5.0:

```text
focused Task 1 protocol + adapter: 26/26 passed
focused C# source/model/mutation contract: 8/8 passed
all CLI unit tests: 195/195 passed
all architecture and package tests: 353/353 passed
CLI build and typecheck: passed
repository source versus emitted broker .ps1/.cs: byte-for-byte equal
```

The platform evidence boundary remains unchanged: this macOS run does not claim PowerShell 5.1
compilation or live Win32 pipe behavior. Task 4 remains authoritative for those checks.

## Final adapter disposition and admission follow-up

The adapter now consumes Task 1's typed close disposition. A broker-first close still requires a
live Duplex, queues the memoized parent close, and terminates the stream. A converging broker close
is also valid when the parent-first Duplex has already emitted its close frame and been removed from
the live map; the adapter accepts that late acknowledgement without treating the endpoint as
unsafe. If the Duplex still exists during that race, the same memoized termination path settles it.

`OPEN` admission now checks `WindowsBrokerConnectionState.activeConnectionCount` before accepting
the frame, rather than checking only the live Duplex map. This count includes both live streams and
parent-first streams awaiting reciprocal broker close, and decreases only when the two directions
converge. Consequently, removing 64 parent-first Duplexes cannot expose an accidental 65th slot.

The parent-first test was written first and reproduced the endpoint fault when a late broker close
found no live Duplex. A second deterministic test opens and parent-closes 64 streams with all broker
acknowledgements delayed: an attempted 65th open fails closed even though the live map is empty. On
a fresh healthy endpoint with the same saturated state, acknowledging the earliest close releases
one protocol slot and permits connection 65. The existing broker-first race remains covered.

Fresh follow-up verification: focused control/protocol/adapter 55/55, focused C# source contract
8/8, all CLI unit tests 197/197, and all architecture/package tests 353/353 passed. CLI build,
typecheck, scoped Biome, scoped diff-check, and repository-source versus emitted C# comparison also
passed. The Task 4 Windows evidence boundary remains unchanged.
