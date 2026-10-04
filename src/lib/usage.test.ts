import assert from "node:assert/strict";
import test from "node:test";

import { parseUsageReport, remainingPercent, timeUntil } from "./usage";

const NOW = Date.parse("2026-10-04T00:00:00.000Z");

test("remaining is what is left of the window, rounded and kept within 0 to 100", () => {
  assert.equal(remainingPercent({ usedPercent: 18 }), 82);
  assert.equal(remainingPercent({ usedPercent: 99.6 }), 0);
  assert.equal(remainingPercent({ usedPercent: 140 }), 0);
  assert.equal(remainingPercent({ usedPercent: -5 }), 100);
});

test("time until a reset shows days, or hours, or minutes, and nothing once it is past", () => {
  assert.deepEqual(timeUntil("2026-10-06T05:00:00.000Z", NOW), { days: 2, hours: 5, minutes: 0 });
  assert.deepEqual(timeUntil("2026-10-04T02:14:00.000Z", NOW), { days: 0, hours: 2, minutes: 0 });
  assert.deepEqual(timeUntil("2026-10-04T00:42:00.000Z", NOW), { days: 0, hours: 0, minutes: 42 });
  assert.equal(timeUntil("2026-10-03T23:00:00.000Z", NOW), null);
  assert.equal(timeUntil(null, NOW), null);
  assert.equal(timeUntil("soon", NOW), null);
});

test("a usage response is read defensively: bad rows and windows are dropped", () => {
  const report = parseUsageReport({
    fetchedAt: "2026-10-04T00:00:00.000Z",
    entries: [
      { runtime: "claude", label: "Claude Code", plan: "team", error: null, windows: [{ id: "five_hour", windowMinutes: 300, usedPercent: 18, resetsAt: "x" }, { id: "bad" }] },
      { runtime: "codex", error: "USAGE_UNAVAILABLE", windows: "nope" },
      { label: "no runtime" },
    ],
  });

  assert.deepEqual(report.entries, [
    { runtime: "claude", label: "Claude Code", plan: "team", error: null, windows: [{ id: "five_hour", windowMinutes: 300, usedPercent: 18, resetsAt: "x" }] },
    { runtime: "codex", label: "codex", plan: null, error: "USAGE_UNAVAILABLE", windows: [] },
  ]);
  assert.throws(() => parseUsageReport("nope"));
});

test("a window's own label is kept, so groups of one length can be told apart", () => {
  const report = parseUsageReport({
    entries: [{ runtime: "antigravity", windows: [{ id: "g", label: "Gemini", usedPercent: 20 }, { id: "c", label: "", usedPercent: 5 }] }],
  });

  assert.deepEqual(report.entries[0].windows.map((window) => window.label), ["Gemini", undefined]);
});

test("a stale entry keeps its flag and when it was read", () => {
  const report = parseUsageReport({
    entries: [{ runtime: "claude", stale: true, readAt: "2026-10-04T01:00:00.000Z", windows: [] }, { runtime: "codex", stale: "yes" }],
  });

  assert.equal(report.entries[0].stale, true);
  assert.equal(report.entries[0].readAt, "2026-10-04T01:00:00.000Z");
  assert.equal(report.entries[1].stale, undefined);
});
