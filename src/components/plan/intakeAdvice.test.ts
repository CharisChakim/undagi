import assert from "node:assert/strict";
import test from "node:test";

import { intakeAnswerLines, intakeNote, shouldAskIntakeOnBlur } from "./intakeAdvice";

test("readiness is shown as a rounded percent, 75 and up reads as clear enough", () => {
  assert.deepEqual(intakeNote({ ready: 0.9 }), { percent: 90, clearEnough: true });
  assert.deepEqual(intakeNote({ ready: 0.75 }), { percent: 75, clearEnough: true });
  assert.deepEqual(intakeNote({ ready: 0.74 }), { percent: 74, clearEnough: false });
  assert.deepEqual(intakeNote({ ready: 0.4 }), { percent: 40, clearEnough: false });
  assert.deepEqual(intakeNote({ ready: 0 }), { percent: 0, clearEnough: false });
});

test("wording never contradicts the shown figure at the threshold", () => {
  assert.deepEqual(intakeNote({ ready: 0.746 }), { percent: 75, clearEnough: true });
  assert.deepEqual(intakeNote({ ready: 0.744 }), { percent: 74, clearEnough: false });
});

test("out-of-range readiness is clamped and unusable advice shows nothing", () => {
  assert.deepEqual(intakeNote({ ready: 1.4 }), { percent: 100, clearEnough: true });
  assert.deepEqual(intakeNote({ ready: -0.2 }), { percent: 0, clearEnough: false });
  assert.equal(intakeNote(null), null);
  assert.equal(intakeNote(undefined), null);
  assert.equal(intakeNote({ ready: Number.NaN }), null);
  assert.equal(intakeNote({ ready: "0.8" as unknown as number }), null);
});

test("blur asks only for a long enough description that changed since the last request", () => {
  const text = "A tool that reviews pull requests";
  assert.equal(shouldAskIntakeOnBlur(text, null), true);
  assert.equal(shouldAskIntakeOnBlur(`  ${text}  `, text), false);
  assert.equal(shouldAskIntakeOnBlur(`${text} and comments`, text), true);
  assert.equal(shouldAskIntakeOnBlur("too short", null), false);
  assert.equal(shouldAskIntakeOnBlur(`   ${"x".repeat(19)}   `, null), false);
  assert.equal(shouldAskIntakeOnBlur("x".repeat(20), null), true);
  assert.equal(shouldAskIntakeOnBlur("", null), false);
});

test("answers become question: answer lines, skipping unanswered ones", () => {
  assert.deepEqual(
    intakeAnswerLines({ "Who uses it?": " Tech leads ", "Which stack?": "", "Deadline?": "  " }),
    ["Who uses it?: Tech leads"],
  );
  assert.deepEqual(intakeAnswerLines({}), []);
});
