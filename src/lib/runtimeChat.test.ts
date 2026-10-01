import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeDiscoveryReport } from "../types";
import { defaultAwaitsDiscovery, defaultRuntimeSelection, normalizeRuntimeChatEvent } from "./runtimeChat";

test("a run the chat route ends as failed keeps that status on done", () => {
  assert.deepEqual(normalizeRuntimeChatEvent({ type: "done", runStatus: "failed", stop: "stop" }), { type: "done", runStatus: "failed" });
  assert.deepEqual(normalizeRuntimeChatEvent({ type: "done", runStatus: "completed", stop: "other" }), { type: "done", runStatus: "completed" });
});

test("a done event without a run status stays a plain done", () => {
  assert.deepEqual(normalizeRuntimeChatEvent({ type: "done" }), { type: "done" });
});

test("risk advice for an approval passes through with its card's ids, and a malformed one is dropped", () => {
  const advice = { type: "approval_advice", approvalId: "a1", elicitId: "a1", risk: "high", score: 1.7, confidence: 0.9, runId: "run-1" };
  assert.deepEqual(normalizeRuntimeChatEvent(advice), { type: "approval_advice", approvalId: "a1", elicitId: "a1", risk: "high", score: 1.7, confidence: 0.9 });
  assert.deepEqual(
    normalizeRuntimeChatEvent({ ...advice, elicitId: undefined }),
    { type: "approval_advice", approvalId: "a1", elicitId: "a1", risk: "high", score: 1.7, confidence: 0.9 },
  );
  assert.equal(normalizeRuntimeChatEvent({ ...advice, risk: "critical" }), null);
  assert.equal(normalizeRuntimeChatEvent({ ...advice, approvalId: undefined, elicitId: undefined }), null);
});

function report(ready: Array<"codex" | "claude" | "antigravity">): RuntimeDiscoveryReport {
  return {
    checkedAt: new Date(0).toISOString(),
    ttlMs: 900_000,
    runtimes: (["codex", "claude", "antigravity"] as const).map((runtime) => ({
      runtime,
      status: ready.includes(runtime) ? "ready" : "needs_login",
      catalog: ready.includes(runtime) ? { connectionId: `runtime:${runtime}` } : null,
    })),
  } as unknown as RuntimeDiscoveryReport;
}

const legacy = { runtime: "legacy", model: "inherit", effort: "inherit" } as const;

test("a new chat starts on the runtime the user last picked, while it still works", () => {
  const lastClaude = { runtime: "claude" as const, connectionId: "runtime:claude", model: "default", effort: "high" };
  assert.deepEqual(defaultRuntimeSelection({ last: lastClaude, legacyAvailable: true, report: report(["codex", "claude"]) }), lastClaude);
  assert.deepEqual(defaultRuntimeSelection({ last: legacy, legacyAvailable: true, report: report(["codex"]) }), legacy);
  // The last pick is no longer usable: fall back.
  assert.deepEqual(defaultRuntimeSelection({ last: lastClaude, legacyAvailable: true, report: report(["codex"]) }), legacy);
});

test("with no usable last pick, a Legacy API endpoint wins, then the first ready runtime", () => {
  assert.deepEqual(defaultRuntimeSelection({ last: null, legacyAvailable: true, report: report(["codex"]) }), legacy);
  assert.deepEqual(
    defaultRuntimeSelection({ last: legacy, legacyAvailable: false, report: report(["claude", "antigravity"]) }),
    { runtime: "claude", connectionId: "runtime:claude", model: "inherit", effort: "inherit" },
  );
  assert.deepEqual(defaultRuntimeSelection({ last: null, legacyAvailable: false, report: report([]) }), legacy);
  assert.deepEqual(defaultRuntimeSelection({ last: null, legacyAvailable: false, report: null }), legacy);
});

test("the default waits for discovery only while its answer could still change", () => {
  const lastCodex = { runtime: "codex" as const, connectionId: "runtime:codex", model: "inherit", effort: "inherit" };
  // No endpoint: the first ready runtime decides, so wait for it.
  assert.equal(defaultAwaitsDiscovery({ last: null, legacyAvailable: false, report: null, loading: true }), true);
  // A runtime was the last pick: whether it is still ready decides.
  assert.equal(defaultAwaitsDiscovery({ last: lastCodex, legacyAvailable: true, report: null, loading: true }), true);
  // The Legacy API endpoint wins whatever discovery says.
  assert.equal(defaultAwaitsDiscovery({ last: null, legacyAvailable: true, report: null, loading: true }), false);
  assert.equal(defaultAwaitsDiscovery({ last: legacy, legacyAvailable: true, report: null, loading: true }), false);
  // Discovery answered, or failed and stopped: nothing left to wait for.
  assert.equal(defaultAwaitsDiscovery({ last: null, legacyAvailable: false, report: report(["claude"]), loading: false }), false);
  assert.equal(defaultAwaitsDiscovery({ last: null, legacyAvailable: false, report: null, loading: false }), false);
});
