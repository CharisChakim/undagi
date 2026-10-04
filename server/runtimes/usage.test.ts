import assert from "node:assert/strict";
import test from "node:test";

import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectRuntimeUsage, parseAntigravityUsage, parseClaudeUsage, parseCodexRateLimits, readAntigravityUsage } from "./usage.ts";
import { unknownCapabilities, type RuntimeDetection, type RuntimeId, type RuntimeStatus } from "./types.ts";

function detection(runtime: RuntimeId, status: RuntimeStatus): RuntimeDetection {
  return {
    runtime,
    status,
    authStatus: "unknown",
    binaryPath: `/bin/${runtime}`,
    version: "1.0.0",
    checkedAt: "2026-10-04T00:00:00.000Z",
    capabilities: unknownCapabilities(),
    catalog: null,
    diagnostic: null,
  };
}

test("Claude usage keeps the five-hour and weekly windows and drops the rest", () => {
  const parsed = parseClaudeUsage({
    subscription_type: "team",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 18, resets_at: "2026-10-04T06:59:59.603490+00:00" },
      seven_day: { utilization: 19.4, resets_at: "2026-10-05T05:59:59.603512+00:00" },
      seven_day_opus: { utilization: 90, resets_at: null },
      extra_usage: { is_enabled: true },
    },
  });

  assert.deepEqual(parsed, {
    plan: "team",
    windows: [
      { id: "five_hour", windowMinutes: 300, usedPercent: 18, resetsAt: "2026-10-04T06:59:59.603Z" },
      { id: "seven_day", windowMinutes: 10_080, usedPercent: 19, resetsAt: "2026-10-05T05:59:59.603Z" },
    ],
  });
});

test("Claude usage is absent without plan limits, and a window with no utilization is skipped", () => {
  assert.equal(parseClaudeUsage({ rate_limits_available: false, rate_limits: null }), null);
  assert.equal(parseClaudeUsage("nope"), null);
  assert.deepEqual(
    parseClaudeUsage({
      subscription_type: null,
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 120, resets_at: "bad" } },
    }),
    { plan: null, windows: [{ id: "seven_day", windowMinutes: 10_080, usedPercent: 100, resetsAt: null }] },
  );
});

test("Codex usage reads the primary and secondary windows and nothing about the account", () => {
  const parsed = parseCodexRateLimits({
    accountId: "secret-account",
    rateLimits: {
      planType: "pro",
      primary: { usedPercent: 1, windowDurationMins: 10_080, resetsAt: 1_791_619_304 },
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: "12" },
    },
  });

  assert.deepEqual(parsed, {
    plan: "pro",
    windows: [{ id: "primary", windowMinutes: 10_080, usedPercent: 1, resetsAt: "2026-10-10T08:01:44.000Z" }],
  });
  assert.equal(JSON.stringify(parsed).includes("secret-account"), false);
  assert.equal(parseCodexRateLimits({}), null);
});

test("only connected runtimes with a reader are listed, and a failed read keeps its row", async () => {
  const report = {
    checkedAt: "2026-10-04T00:00:00.000Z",
    ttlMs: 1,
    runtimes: [
      detection("codex", "ready"),
      detection("claude", "ready"),
      detection("antigravity", "ready"),
    ],
  };

  const result = await collectRuntimeUsage(
    report,
    {
      codex: async () => { throw new Error("boom"); },
      claude: async () => ({ plan: "max", windows: [{ id: "five_hour", windowMinutes: 300, usedPercent: 40, resetsAt: null }] }),
    },
    () => new Date("2026-10-04T01:00:00.000Z"),
  );

  assert.equal(result.fetchedAt, "2026-10-04T01:00:00.000Z");
  assert.deepEqual(result.entries.map((entry) => [entry.runtime, entry.label, entry.error]), [
    ["codex", "Codex", "USAGE_UNAVAILABLE"],
    ["claude", "Claude Code", null],
  ]);
});

test("a runtime that is not connected is not read, and one without plan limits is left out", async () => {
  let reads = 0;
  const reader = async () => { reads += 1; return null; };
  const result = await collectRuntimeUsage(
    {
      checkedAt: "2026-10-04T00:00:00.000Z",
      ttlMs: 1,
      runtimes: [detection("codex", "needs_login"), detection("claude", "ready")],
    },
    { codex: reader, claude: reader },
  );

  assert.equal(reads, 1);
  assert.deepEqual(result.entries, []);
});

const AGY_USAGE = {
  status: "SUCCESS",
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        { name: "Gemini Models", buckets: [{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.8, reset_time: "2026-10-11T03:03:27Z" }] },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-daily", window: "daily", remaining_fraction: 0.9, reset_time: "2026-10-05T00:00:00Z" },
            { id: "3p-weekly", window: "weekly", remaining_fraction: 0.25, reset_time: "2026-10-11T03:03:27Z" },
          ],
        },
      ],
    },
  },
};

test("Antigravity usage gives one window per group, named after it, from the bucket with least left", () => {
  assert.deepEqual(parseAntigravityUsage(AGY_USAGE), {
    plan: null,
    windows: [
      { id: "gemini-weekly", label: "Gemini", windowMinutes: 10_080, usedPercent: 20, resetsAt: "2026-10-11T03:03:27.000Z" },
      { id: "3p-weekly", label: "Claude & GPT", windowMinutes: 10_080, usedPercent: 75, resetsAt: "2026-10-11T03:03:27.000Z" },
    ],
  });
});

test("an Antigravity answer that is not a /usage result is not read as usage", () => {
  assert.equal(parseAntigravityUsage({ status: "SUCCESS", response: "Hello" }), null);
  assert.equal(parseAntigravityUsage({ command: { name: "help", data: {} } }), null);
  assert.deepEqual(parseAntigravityUsage({ command: { name: "usage", data: { groups: [] } } }), { plan: null, windows: [] });
});

function fakeAgy(): { path: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "undagi-agy-"));
  const path = join(dir, "agy");
  const marker = join(dir, "ran");
  writeFileSync(path, `#!/bin/sh\ntouch "${marker}"\nprintf '%s' '${JSON.stringify(AGY_USAGE)}'\n`);
  chmodSync(path, 0o755);
  return { path, marker };
}

test("Antigravity usage is read through /usage in print mode when the CLI is new enough", { skip: process.platform === "win32" }, async () => {
  const agy = fakeAgy();

  const usage = await readAntigravityUsage(agy.path, "1.2.16");

  assert.equal(existsSync(agy.marker), true);
  assert.deepEqual(usage?.windows.map((window) => window.label), ["Gemini", "Claude & GPT"]);
});

test("an Antigravity CLI older than its print-mode /usage is never run", { skip: process.platform === "win32" }, async () => {
  for (const version of ["1.1.10", "0.9.0", null, "dev"]) {
    const agy = fakeAgy();

    assert.equal(await readAntigravityUsage(agy.path, version), null);
    assert.equal(existsSync(agy.marker), false, `ran for ${String(version)}`);
  }
});
