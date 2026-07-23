import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticCode, parseComponentId, parsePluginId } from "@tegojs/contracts";
import {
  componentApplicationReady,
  transitionComponentLifecycle,
  type ComponentInstanceObservation,
  type ComponentLifecycleState,
} from "../src/index.js";

const observedAt = "2026-07-23T00:00:00.000Z";
const pluginId = parsePluginId("org.example.echo");
const componentId = parseComponentId("echo-service");

function transition(
  current: ComponentLifecycleState,
  next: ComponentLifecycleState,
): ComponentLifecycleState {
  return transitionComponentLifecycle({
    componentId,
    current,
    next,
    observedAt,
    pluginId,
  });
}

test("@spec:plugin-deployment/kernel-owned-component-lifecycle/legal-transition-sequence", () => {
  let current: ComponentLifecycleState = "created";
  for (const next of [
    "preparing",
    "starting",
    "ready",
    "degraded",
    "ready",
    "draining",
    "stopping",
    "stopped",
  ] satisfies readonly ComponentLifecycleState[]) {
    current = transition(current, next);
  }
  assert.equal(current, "stopped");
});

test("@spec:plugin-deployment/kernel-owned-component-lifecycle/illegal-transition-diagnostic", () => {
  assert.throws(
    () => transition("created", "ready"),
    (error: unknown) => {
      assert.equal(diagnosticCode(error), "LIFECYCLE_TRANSITION_INVALID");
      assert.deepEqual((error as { diagnostic?: { details?: unknown } }).diagnostic?.details, {
        componentId,
        current: "created",
        next: "ready",
        pluginId,
      });
      return true;
    },
  );
});

test("interrupted startup can drain and failed shutdown can retry stopping", () => {
  for (const state of ["created", "preparing", "starting"] satisfies ComponentLifecycleState[]) {
    assert.equal(transition(state, "draining"), "draining");
  }
  assert.equal(transition("failed", "stopping"), "stopping");
});

test("component failures are isolated from kernel liveness and only essential failures block readiness", () => {
  const failed = {
    lifecycle: "failed",
    observedGeneration: "1",
  } as ComponentInstanceObservation;
  assert.equal(
    componentApplicationReady({
      desired: true,
      essential: false,
      instances: [failed],
      kernelRunning: true,
    }),
    true,
  );
  assert.equal(
    componentApplicationReady({
      desired: true,
      essential: true,
      instances: [failed],
      kernelRunning: true,
    }),
    false,
  );
  assert.equal(
    componentApplicationReady({
      desired: true,
      essential: true,
      instances: [{ lifecycle: "ready", observedGeneration: "2" }],
      kernelRunning: true,
    }),
    true,
  );
});
