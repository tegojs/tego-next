import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticCode } from "@tegojs/contracts";
import {
  PROCESS_OUTBOUND_MAX_QUEUED_BYTES,
  PROCESS_OUTBOUND_MAX_QUEUED_FRAMES,
  ProcessOutboundWriter,
} from "../src/process/outbound-writer.js";
import { encodeProcessFrame } from "../src/process/framing.js";

function blockedWriter() {
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const writer = new ProcessOutboundWriter({
    encode: (value: Record<string, unknown>) =>
      encodeProcessFrame(value, "EXECUTOR_OUTPUT_LIMIT_EXCEEDED"),
    async write() {
      writes += 1;
      await release.promise;
    },
  });
  return { release, writer, writes: () => writes };
}

test("outbound writer bounds frame count under stdout backpressure", async () => {
  const blocked = blockedWriter();
  const pending = Array.from({ length: PROCESS_OUTBOUND_MAX_QUEUED_FRAMES }, (_, index) =>
    blocked.writer.send({ kind: "event", index }, "required"),
  );
  await Promise.resolve();
  assert.equal(blocked.writer.pendingCount, PROCESS_OUTBOUND_MAX_QUEUED_FRAMES);
  assert.ok(blocked.writer.pendingBytes <= PROCESS_OUTBOUND_MAX_QUEUED_BYTES);
  await assert.rejects(
    blocked.writer.send({ kind: "response", overflow: true }, "required"),
    (error: unknown) => diagnosticCode(error) === "EXECUTOR_OUTPUT_QUEUE_CAPACITY_EXCEEDED",
  );
  await blocked.writer.send({ kind: "diagnostic", overflow: true }, "diagnostic");
  assert.equal(blocked.writer.droppedDiagnostics, 1);
  assert.equal(blocked.writer.pendingCount, PROCESS_OUTBOUND_MAX_QUEUED_FRAMES);

  blocked.release.resolve();
  await Promise.all(pending);
  await blocked.writer.flush();
  assert.equal(blocked.writer.pendingCount, 0);
  assert.equal(blocked.writer.pendingBytes, 0);
  assert.equal(blocked.writes(), PROCESS_OUTBOUND_MAX_QUEUED_FRAMES);
});

test("outbound writer bounds retained bytes and encodes only after dequeue", async () => {
  const blocked = blockedWriter();
  const payload = "x".repeat(Math.floor(PROCESS_OUTBOUND_MAX_QUEUED_BYTES / 3));
  const first = blocked.writer.send({ kind: "event", payload }, "required");
  const second = blocked.writer.send({ kind: "event", payload }, "required");
  await Promise.resolve();
  assert.equal(blocked.writes(), 1);
  assert.ok(blocked.writer.pendingBytes <= PROCESS_OUTBOUND_MAX_QUEUED_BYTES);
  await assert.rejects(
    blocked.writer.send({ kind: "event", payload }, "required"),
    (error: unknown) => diagnosticCode(error) === "EXECUTOR_OUTPUT_QUEUE_CAPACITY_EXCEEDED",
  );

  blocked.release.resolve();
  await Promise.all([first, second]);
  await blocked.writer.flush();
  assert.equal(blocked.writer.pendingBytes, 0);
});
