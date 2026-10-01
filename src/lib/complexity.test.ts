import assert from "node:assert/strict";
import test from "node:test";

import { complexityLabelKey, normalizeComplexity } from "./complexity";

test("canonical values pass through unchanged", () => {
  for (const level of ["low", "medium", "high", "very_high"] as const) {
    assert.equal(normalizeComplexity(level), level);
  }
});

test("legacy Indonesian values saved in old sessions map to canonical", () => {
  assert.equal(normalizeComplexity("Rendah"), "low");
  assert.equal(normalizeComplexity("Sedang"), "medium");
  assert.equal(normalizeComplexity("Tinggi"), "high");
  assert.equal(normalizeComplexity("Sangat Tinggi"), "very_high");
});

test("English labels are accepted in any case and spacing", () => {
  assert.equal(normalizeComplexity("Low"), "low");
  assert.equal(normalizeComplexity("MEDIUM"), "medium");
  assert.equal(normalizeComplexity("High"), "high");
  assert.equal(normalizeComplexity("Very High"), "very_high");
  assert.equal(normalizeComplexity("very high"), "very_high");
  assert.equal(normalizeComplexity("very-high"), "very_high");
  assert.equal(normalizeComplexity("VERY_HIGH"), "very_high");
  assert.equal(normalizeComplexity("  Very   High  "), "very_high");
  assert.equal(normalizeComplexity("sangat tinggi"), "very_high");
  assert.equal(normalizeComplexity("\tTinggi\n"), "high");
});

test("missing or blank input falls back to low (the old default)", () => {
  assert.equal(normalizeComplexity(undefined), "low");
  assert.equal(normalizeComplexity(null), "low");
  assert.equal(normalizeComplexity(""), "low");
  assert.equal(normalizeComplexity("   "), "low");
});

test("unrecognised input falls back to medium and never throws", () => {
  for (const odd of ["extreme", "Sangat", "veryhigh", 3, 0, true, {}, [], ["low"], Symbol("x"), "constructor", "__proto__", "toString"]) {
    assert.equal(normalizeComplexity(odd), "medium", String(typeof odd === "symbol" ? "symbol" : JSON.stringify(odd)));
  }
});

test("label keys are the English dictionary texts", () => {
  assert.equal(complexityLabelKey("low"), "Low");
  assert.equal(complexityLabelKey("medium"), "Medium");
  assert.equal(complexityLabelKey("high"), "High");
  assert.equal(complexityLabelKey("very_high"), "Very high");
});

test("every stored form resolves to a label key", () => {
  assert.equal(complexityLabelKey(normalizeComplexity("Sangat Tinggi")), "Very high");
  assert.equal(complexityLabelKey(normalizeComplexity("Rendah")), "Low");
  assert.equal(complexityLabelKey(normalizeComplexity(undefined)), "Low");
});
