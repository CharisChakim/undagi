import assert from "node:assert/strict";
import test from "node:test";

import { normalizeStoredPlan } from "./sessionStore";

const planWith = (estimation: unknown) => ({ summary: "s", estimation });
const levelOf = (estimation: unknown) => normalizeStoredPlan(planWith(estimation))?.estimation.complexityLevel;

test("legacy Indonesian complexity in a stored plan loads as canonical", () => {
  assert.equal(levelOf({ complexityLevel: "Sangat Tinggi" }), "very_high");
  assert.equal(levelOf({ complexityLevel: "Rendah" }), "low");
});

test("canonical complexity survives a load/save round trip", () => {
  const once = normalizeStoredPlan(planWith({ complexityLevel: "Tinggi", totalTimeWeeks: "8 weeks" }));
  const twice = normalizeStoredPlan(JSON.parse(JSON.stringify(once)));
  assert.equal(once?.estimation.complexityLevel, "high");
  assert.deepEqual(twice, once);
});

test("missing estimation or complexity defaults to low; odd data never throws", () => {
  assert.equal(levelOf(undefined), "low");
  assert.equal(levelOf({}), "low");
  assert.equal(levelOf({ complexityLevel: 42 }), "medium");
  assert.equal(normalizeStoredPlan(null), undefined);
});
