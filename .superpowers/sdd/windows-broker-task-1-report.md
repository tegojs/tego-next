# Windows Broker Task 1 Report

## Scope

Implemented the internal parent/broker binary protocol only. The work adds no exports to
`packages/cli/src/index.ts` and does not touch the broker, Windows-native implementation, release
assets, or the unrelated Task 8 changes already present in this worktree.

## Delivered

- `packages/cli/src/control/windows-broker-protocol.ts`
  - Version 1, `TGBP`, fixed 24-byte big-endian header.
  - Validates magic, version, numeric type, reserved bytes, 64 KiB payload bound, connection-ID
    class, and truncated input with the stable fail-closed error
    `PROTOCOL_CONTROL_ENDPOINT_UNSAFE`.
  - Incremental decoder supports split and coalesced frames, and copies returned payloads.
  - State machine enforces monotonic non-reused IDs, one `OPEN`, data lifetime, one `EOF`, one
    `CLOSE`, `PAUSE`/`RESUME`, `READY`, `FATAL`, and `CLOSE_ALL`/ack transitions.
  - Data is capped per connection and in total; `drain(connectionId, bytes)` returns consumed
    capacity to both bounds. `CLOSE_ALL` rejects new data while allowing the active connection
    terminal frame needed before its acknowledgement.
- `packages/cli/test/windows-broker-protocol.test.ts`
  - 13 focused `node:test` cases covering codec framing, malformed input, fail-closed behavior,
    unsigned 64-bit IDs, state transitions, and pressure limits.

## Intentional Small Interface Addition

`WindowsBrokerConnectionState` has an optional structural constructor argument:

```ts
new WindowsBrokerConnectionState({ maxConnectionBytes?, maxTotalBytes? })
```

It is deliberately non-exported. The only added operation is `drain(connectionId, bytes)`, which
lets Task 3 return capacity after a virtual stream consumes queued data; there is no observation
API. It permits bounded, small-limit pressure tests while preserving the required
`accept(frame): void` operation. Defaults for both bounds are
`WINDOWS_BROKER_MAX_CONNECTION_BYTES` (256 KiB).

## TDD Evidence

Observed RED before each implementation slice:

1. Codec tests: `npm run build --workspace @tego/cli` failed with TS2307 because the new module
   did not exist.
2. State/pressure tests: the same build failed with TS2305 because
   `WindowsBrokerConnectionState` was not exported.
3. Global lifecycle mutation: focused test failed because duplicate `READY` was accepted.
4. Reserved-byte/malformed-value mutation: focused test failed because a nonzero reserved byte was
   accepted.
5. Shutdown mutation: focused test failed because `DATA` after `CLOSE_ALL` was accepted.
6. Queue-release test: the build failed with TS2339 because `drain` did not exist.

Each slice was then minimally implemented and rerun green.

## Final Verification

Executed with Node `v26.5.0` and npm `11.13.0`:

```text
npm run build --workspace @tego/cli
node --test packages/cli/dist/test/windows-broker-protocol.test.js
# 14 pass, 0 fail, 0 skipped

npm run typecheck --workspace @tego/cli
npx biome check packages/cli/src/control/windows-broker-protocol.ts packages/cli/test/windows-broker-protocol.test.ts
# both exit 0
```

The staged diff check for this task's three files passes. A whole-worktree `git diff --check`
continues to report the pre-existing Task 8 file `.superpowers/sdd/task-8-brief.md:69` for a new
blank line at EOF; this task neither changed nor stages that file.

## Direction-Aware Review Follow-up

Review required one aggregate connection state to distinguish broker-to-parent from
parent-to-broker frames. `accept` now requires the direction as its second argument, and `drain`
requires it between the connection ID and byte count. The state tracks queue bytes and EOF for
each direction, while maintaining a single bounded total. `PAUSE` in one direction blocks `DATA`
in the opposite direction until the matching same-direction `RESUME`.

`OPEN` and `READY` belong only to broker-to-parent, and `OPEN` requires `READY`. `CLOSE_ALL`
belongs only to parent-to-broker; its broker-to-parent acknowledgement is accepted only after all
opened connections have closed. `CLOSE` atomically discards both directional queues, and a
subsequent drain fails. `FATAL` is broker-to-parent only, may precede `READY`, and permanently
fences the protocol; acknowledgement likewise fences every later frame.

The payload-copy test now supplies a non-`Buffer` `Uint8Array` view, mutates its backing storage
after `push`, and verifies that decoded payloads remain unchanged.

### Review TDD Evidence

The direction-aware mutation test suite was written first. The build then failed with TS2554
because the former `accept(frame)` and `drain(connectionId, bytes)` signatures lacked direction.
After the minimal state refactor, the focused suite passed 12/12. Final CLI build/typecheck and
Biome checks also passed.

## Second Review Follow-up

`maxConnectionBytes` now applies to the aggregate of the two directional queues for one
connection, while `maxTotalBytes` remains process-wide. A mutation with a three-byte connection
limit and two bytes in each direction proves that the second direction cannot bypass this bound.

The protocol now has an explicit direction allowlist: broker-to-parent owns
`READY`, `OPEN`, `DATA`, `EOF`, `CLOSE`, `FATAL`, and `CLOSE_ALL_ACK`; parent-to-broker owns
`DATA`, `CLOSE`, `PAUSE`, `RESUME`, and `CLOSE_ALL`. Once `CLOSE_ALL` is accepted, only
broker-to-parent `EOF`, `CLOSE`, `FATAL`, and `CLOSE_ALL_ACK` may arrive through termination.
Mutation tests reject inverted EOF/backpressure frames and all prohibited shutdown controls.

The decoder ownership test no longer builds a combined `Buffer` first. It supplies an offset,
non-`Buffer` `Uint8Array` view, mutates its backing storage after decoding, and verifies each
returned payload has an independent, payload-sized backing store with byte offset zero.

### Second Review TDD Evidence

The new aggregate-limit, direction-allowlist, shutdown, and payload-ownership tests were added
before the fix. The focused run observed three expected RED failures: inverted frames were
accepted, queues in opposite directions bypassed `maxConnectionBytes`, and parent shutdown
controls were accepted after `CLOSE_ALL`. The first GREEN attempt exposed a queue-accounting bug
where an aggregate value was written into a directional counter; the existing matching-direction
`drain` mutation caught it. The minimal correction keeps aggregate bytes only for validation and
writes the directional value back to its matching queue. Final verification: focused 14/14,
CLI build/typecheck, and Biome all pass.

## Directional CLOSE convergence evolution

Task 3 root review exposed a legal cross-process race which the original "one terminal frame"
wording did not model: the broker can observe a client disconnect and emit `CLOSE` while the
parent's Duplex finalizer already has its own `CLOSE` queued. Treating the first frame as removing
all connection state made the opposite-direction frame look like a duplicate and poisoned the
otherwise healthy broker endpoint.

The version-1 wire format and direction allowlists are unchanged. The state-machine contract now
defines at most one `CLOSE` in each direction:

- the first `CLOSE` from either direction makes the connection data-terminal and releases both
  directional queues exactly once;
- `DATA`, `EOF`, `PAUSE`, `RESUME`, and `drain` are invalid after that first close;
- exactly one later `CLOSE` from the opposite direction is accepted as convergence;
- a same-direction duplicate or any frame for a never-opened ID remains a protocol error; and
- `CLOSE_ALL_ACK` requires at least one observed `CLOSE` for every opened connection, not both
  directional closes.

The revised focused test was observed RED when the opposite parent-to-broker close reached the old
`closed` boolean, then GREEN after replacing it with per-direction `closeSeen` state. The complete
Task 1 protocol suite passes 14/14.
