// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_LIMIT, forgetFact, rememberFacts } from "./projectMemory";

const now = new Date("2026-10-03T00:00:00.000Z");

test("a run's facts are added once, whatever their case or spacing", () => {
  const first = rememberFacts(undefined, ["Use pnpm, not npm", "use  PNPM, not npm"], "TASK-01", now);
  assert.deepEqual(first?.map((entry) => [entry.text, entry.taskId]), [["Use pnpm, not npm", "TASK-01"]]);
  assert.equal(rememberFacts(first!, ["USE PNPM, NOT NPM"], "TASK-02", now), null, "nothing new, nothing changes");
  assert.equal(rememberFacts(first!, [], "TASK-02", now), null);
});

test("the oldest facts give way once the memory is full", () => {
  const facts = Array.from({ length: MEMORY_LIMIT + 5 }, (_, index) => `Fact ${index}`);
  const memory = rememberFacts(undefined, facts, "TASK-01", now)!;
  assert.equal(memory.length, MEMORY_LIMIT);
  assert.equal(memory[0].text, "Fact 5");
  assert.equal(new Set(memory.map((entry) => entry.id)).size, MEMORY_LIMIT, "every entry has its own id");
});

test("a fact the user deletes is gone, and deleting an unknown one changes nothing", () => {
  const memory = rememberFacts(undefined, ["A", "B"], "TASK-01", now)!;
  assert.deepEqual(forgetFact(memory, memory[0].id)?.map((entry) => entry.text), ["B"]);
  assert.equal(forgetFact(memory, "missing"), null);
});
