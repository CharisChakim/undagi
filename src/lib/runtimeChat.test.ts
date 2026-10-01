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

test("an error keeps the runtime's code, wherever the runtime put it", () => {
  assert.deepEqual(
    normalizeRuntimeChatEvent({ type: "error", code: "CLAUDE_UNAVAILABLE", message: "Claude is overloaded.", retryable: true }),
    { type: "error", message: "Claude is overloaded.", code: "CLAUDE_UNAVAILABLE", retryable: true },
  );
  assert.deepEqual(
    normalizeRuntimeChatEvent({ type: "error", error: { code: "AGY_PROCESS_ERROR", message: "AGY exited." } }),
    { type: "error", message: "AGY exited.", code: "AGY_PROCESS_ERROR", retryable: true },
  );
  assert.deepEqual(
    normalizeRuntimeChatEvent({ type: "done", status: "failed", error: { code: "CLAUDE_BILLING", message: "Billing." } }),
    { type: "error", message: "Billing.", code: "CLAUDE_BILLING", retryable: false },
  );
  // No code stays no code, so a Legacy or Codex error is judged by its words.
  assert.deepEqual(normalizeRuntimeChatEvent({ type: "error", message: "x" }), { type: "error", message: "x", retryable: true });
});
