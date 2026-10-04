import assert from "node:assert/strict";
import test from "node:test";

import { moveUsage, orderUsage, toggleUsageHidden, visibleUsage, type UsagePrefs } from "./usagePrefs";

const rows = [{ runtime: "claude" }, { runtime: "codex" }, { runtime: "cursor" }];
const ids = (items: Array<{ runtime: string }>) => items.map((item) => item.runtime);

test("rows follow the arranged order, and a runtime not arranged yet goes last", () => {
  const prefs: UsagePrefs = { order: ["codex", "gone", "claude"], hidden: [] };

  assert.deepEqual(ids(orderUsage(rows, prefs)), ["codex", "claude", "cursor"]);
  assert.deepEqual(ids(orderUsage(rows, { order: [], hidden: [] })), ["claude", "codex", "cursor"]);
});

test("hidden rows are left out of what is shown but stay in the arranged list", () => {
  const prefs: UsagePrefs = { order: ["codex"], hidden: ["claude"] };

  assert.deepEqual(ids(visibleUsage(rows, prefs)), ["codex", "cursor"]);
  assert.deepEqual(ids(orderUsage(rows, prefs)), ["codex", "claude", "cursor"]);
});

test("moving a row swaps it with its neighbour and does nothing past either end", () => {
  const current = ["claude", "codex", "cursor"];
  const start: UsagePrefs = { order: [], hidden: ["cursor"] };

  assert.deepEqual(moveUsage(start, current, "codex", -1), { order: ["codex", "claude", "cursor"], hidden: ["cursor"] });
  assert.deepEqual(moveUsage(start, current, "codex", 1).order, ["claude", "cursor", "codex"]);
  assert.equal(moveUsage(start, current, "claude", -1), start);
  assert.equal(moveUsage(start, current, "cursor", 1), start);
  assert.equal(moveUsage(start, current, "missing", 1), start);
});

test("toggling hides a row and shows it again", () => {
  const hidden = toggleUsageHidden({ order: ["a"], hidden: [] }, "claude");

  assert.deepEqual(hidden, { order: ["a"], hidden: ["claude"] });
  assert.deepEqual(toggleUsageHidden(hidden, "claude"), { order: ["a"], hidden: [] });
});
