# Windows Control Broker Design

## Status

Approved on 2026-08-14 for the Phase 1 `2.0.0-alpha.1` release closure.

This design replaces the post-listen Windows named-pipe ACL helper. Real Windows CI proved that a
client handle cannot obtain the security rights required to inspect or update the server object's
descriptor, while Node.js 26 does not expose the server handle through a supported public API.
The broker implementation passed the authoritative packed-consumer Windows gate in
[run 31837308587](https://github.com/tegojs/tego-next/actions/runs/31837308587), including
[Windows job 94886355643](https://github.com/tegojs/tego-next/actions/runs/31837308587/job/94886355643).
Final release evidence and publication remain separate later gates.

## Scope

- Unix control endpoints remain owner-private `0600` Unix-domain sockets implemented with
  `node:net`.
- Windows uses a dedicated broker process that owns the public named pipe from creation through
  shutdown.
- The alpha supports `win32-x64` only. Other Windows architectures fail before endpoint creation
  with the stable unsafe-endpoint diagnostic.
- The broker is delivered as auditable PowerShell plus embedded C# source inside `@tego/cli`.
  It does not add a tenth npm package or a checked-in opaque executable.
- This does not replace the separately accepted general Windows test-process cleanup strategy.

## Rejected Approaches

### Mutating the pipe through a client handle

Real Windows probes showed that read/write client handles connect normally, but client handles
requesting `READ_CONTROL`, `WRITE_DAC`, or both do not succeed. Windows pipe security APIs require
a suitable handle, so changing access masks cannot make this approach reliable.

### Accessing Node private state

Using `server._handle`, undocumented libuv fields, or Windows file-descriptor adoption would bind
the security boundary to unsupported implementation details. The release contract continues to
forbid these paths.

### Pre-creating and handing off the same pipe name

An independently created first instance conflicts with libuv's first-instance behavior. Closing
one owner before the other binds also introduces a name-capture and default-ACL window. This does
not meet fail-closed startup.

### Prebuilt executable in the alpha package

A prebuilt executable would require either an opaque binary in Git or a new platform package and
cross-workflow artifact publication chain. The source-hosted broker keeps the existing nine-package
release topology and makes the complete privileged implementation reviewable.

## Architecture

On Windows, `startControlServer` starts the packaged broker with an absolute script path, fixed
arguments, `shell: false`, inherited anonymous stdin/stdout pipes, and a bounded startup deadline.
It does not call `net.createServer` for the public endpoint.

The PowerShell entry point compiles a fixed embedded C# program in memory and enters a long-lived
broker loop. The C# code:

1. rejects any process architecture other than x64;
2. resolves the current Windows user SID;
3. constructs a security descriptor whose owner is that SID and whose protected DACL has exactly
   one explicit full-access allow ACE for that SID, LocalSystem, and Administrators;
4. creates every named-pipe instance with that descriptor passed to `CreateNamedPipeW`;
5. reads the descriptor back from its server handle and applies the same strict validation used by
   the TypeScript policy layer; and
6. reports readiness only after descriptor validation and the first accept operation are armed.

The public pipe continues to carry the existing control request protocol. The broker forwards raw
connection bytes to Node; it does not parse or authorize application operations. Node converts
broker connection frames into an internal Duplex-compatible connection and reuses the existing
request parser, response writer, limits, timeouts, and dispatcher.

## Broker Protocol

The parent/broker channel is a versioned binary protocol over inherited anonymous pipes. It has a
fixed-width header containing magic, protocol version, frame type, unsigned 64-bit connection ID,
and payload length.

Broker-to-parent frames are `READY`, `OPEN`, `DATA`, `EOF`, `CLOSE`, and `FATAL`. Parent-to-broker
frames are `DATA`, `CLOSE`, `PAUSE`, `RESUME`, and `CLOSE_ALL`. A successful graceful shutdown ends
with a `CLOSE_ALL_ACK` frame.

Connection IDs are monotonically allocated and never reused during one broker process. The
implementation rejects unknown frame types, wrong versions, invalid lengths, duplicate `OPEN`,
data before `OPEN`, data after closure, duplicate terminal frames, truncated frames, and connection
ID reuse. Any parent/broker protocol violation tears down the complete control endpoint.

The protocol has explicit maximums for frame payload, per-connection queued bytes, total queued
bytes, and concurrent connections. Crossing a limit closes the offending connection or, when
protocol synchronization cannot be proven, fails the endpoint. `PAUSE` and `RESUME` propagate
backpressure in both directions so neither process can accumulate unbounded data.

## Lifecycle and Failure Handling

Node is the only lifecycle owner. The broker receives no endpoint or SID through environment
variables and performs no executable lookup. Startup, graceful shutdown, forced termination, and
final stream settlement have absolute deadlines.

The broker opens a stable synchronization handle to the exact parent process. A watchdog waits on
that handle and terminates the broker after closing all public pipe instances if the parent exits.
This avoids PID reuse and does not depend on assigning a GitHub-hosted process to a nested Job
Object.

Normal close first stops creating instances and rejects new connections, sends terminal frames for
active connections, waits for `CLOSE_ALL_ACK`, and then waits for the broker process and stdio to
finish. If any phase misses its deadline, Node terminates and then kills the exact child process and
still waits for final stream settlement. Cleanup failures are appended after the primary failure.

Broker exit, malformed output, descriptor mismatch, parent-channel closure, compile failure,
PowerShell absence, timeout, or unsupported architecture all produce
`PROTOCOL_CONTROL_ENDPOINT_UNSAFE`. There is no fallback to an unhardened Node named pipe.

stdout is reserved for framed binary traffic. stderr may contain only fixed enumerated stage codes;
it must not contain the endpoint, SID, request bytes, native exception text, or arbitrary Windows
messages. The public diagnostic remains stable and redacted.

## Packaging and Supply Chain

The PowerShell entry point and embedded C# source are copied beside the compiled CLI control
module. The package allowlist includes only those fixed source assets in addition to the existing
runtime files. Package contracts require byte-identical source/build copies and verify their
expected hashes, installed paths, and clean-consumer availability.

The launcher uses the packaged absolute path and the Windows-provided `powershell.exe` with fixed
non-interactive arguments. It does not write execution-policy, profile, npm, registry, or credential
configuration. Missing or incompatible PowerShell fails closed.

The nine public packages remain `2.0.0-alpha.1`; no platform package is added. The broker source is
part of `@tego/cli` and therefore covered by the tarball SHA-512 integrity, deterministic package
verification, resumable alpha publisher, and registry verification.

## Testing and Acceptance

Platform-independent tests model framing, connection state, backpressure, buffer limits, lifecycle
timeouts, malformed data, crash handling, and redacted diagnostics. Package tests reject missing,
altered, misplaced, or extra broker assets and continue to reject private `_handle` usage.

The required `windows-control` job on `windows-2025` builds and installs the packed CLI, then proves:

- the current user owns the pipe;
- the DACL is protected and contains exactly the current user, LocalSystem, and Administrators with
  full access;
- unexpected, inherited, broad, deny, duplicate, reordered, or underprivileged ACEs fail startup;
- a real current-user status request succeeds through the broker;
- malformed frames, buffer pressure, broker crash, and parent crash are bounded and leak-free;
- close makes reconnection fail;
- twenty start/request/close rounds leave no broker process or pipe endpoint; and
- a clean tarball consumer finds and launches the packaged broker sources.

CI must fail rather than skip when the platform, PowerShell, ACL inspection, process cleanup, or
broker contract is unavailable. The quality, PostgreSQL integration, system E2E, and real Windows
jobs must pass on the exact source/evidence chain before npm publication, Git tagging, GitHub
prerelease creation, spec synchronization, or archive.

## Deferred Work

A signed precompiled or NativeAOT broker may replace the source-hosted implementation after alpha
without changing the parent/broker protocol. Windows ARM64 support requires its own build,
packaging, and real-machine CI evidence. Neither item is part of `2.0.0-alpha.1`.
