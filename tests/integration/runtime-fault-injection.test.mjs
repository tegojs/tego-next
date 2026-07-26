import assert from "node:assert/strict";
import test from "node:test";

const faultEvidence = new Map();

function assertFault(name, expected) {
  const actual = faultEvidence.get(name);
  assert.ok(actual, `FAULT_TRIGGER_UNIMPLEMENTED:${name}`);
  assert.deepEqual(actual, expected);
}

test("@spec:runtime-operations/ci-authoritative-system-acceptance/fault-evidence", () => {
  assertFault("lifecycle-after-effect-before-commit", {
    expectedOperationCount: 1,
    expectedInstanceCount: 1,
  });
  assertFault("stale-fencing-epoch", {
    expectedDiagnostic: "STATE_FENCE_STALE",
    expectedAuthoritativeValue: "leader-b",
  });
  assertFault("duplicate-remote-result", {
    expectedTerminalRecordCount: 1,
    expectedResultAcknowledgementCount: 1,
  });
  assertFault("permission-grant-invalid-before-import", {
    expectedDiagnostic: "PERMISSION_GRANT_EXCEEDED",
    expectedPluginLoadCount: 0,
  });
});
