import assert from "node:assert/strict";
import test from "node:test";

import {
  agentHarnessPrompt,
  applyAgentHarness,
  parseAgentHarnessSettings,
} from "./harness.ts";

const ALL_OFF = {
  compactTerminal: false,
  conciseAnswers: false,
  minimalCode: false,
  karpathyGuidelines: false,
};

test("agent harness settings default on and can be disabled independently", () => {
  assert.deepEqual(parseAgentHarnessSettings(undefined), {
    compactTerminal: true,
    conciseAnswers: true,
    minimalCode: true,
    karpathyGuidelines: true,
  });
  assert.deepEqual(parseAgentHarnessSettings({ conciseAnswers: false }), {
    compactTerminal: true,
    conciseAnswers: false,
    minimalCode: true,
    karpathyGuidelines: true,
  });
});

test("agent harness emits only enabled instruction groups", () => {
  const efficiencyOnly = agentHarnessPrompt({ ...ALL_OFF, compactTerminal: true, conciseAnswers: true, minimalCode: true });
  assert.match(efficiencyOnly, /Efficiency stack/);
  assert.doesNotMatch(efficiencyOnly, /Karpathy/);

  assert.equal(agentHarnessPrompt(ALL_OFF), "");
  assert.equal(applyAgentHarness("Keep this exact request", ALL_OFF), "Keep this exact request");
});

test("a run tied to a task card is asked to end with a status line, whatever the layers", () => {
  const task = agentHarnessPrompt(ALL_OFF, { task: true });
  assert.match(task, /TASK_STATUS: done/);
  assert.match(task, /TASK_STATUS: blocked/);
  assert.doesNotMatch(task, /Efficiency stack|Karpathy/);

  const withLayers = agentHarnessPrompt({ ...ALL_OFF, minimalCode: true }, { task: true });
  assert.match(withLayers, /Efficiency stack/);
  assert.match(withLayers, /Task report:/);
});

test("the card's note is asked for in the UI language, and the status line stays literal", () => {
  const id = agentHarnessPrompt(ALL_OFF, { task: true, noteLang: "id" });
  assert.match(id, /Write the note in Indonesian/);
  assert.match(id, /TASK_STATUS line stays exactly as written/);
  assert.match(agentHarnessPrompt(ALL_OFF, { task: true, noteLang: "en" }), /Write the note in English/);
  // No language known (a direct caller): no language instruction at all.
  assert.doesNotMatch(agentHarnessPrompt(ALL_OFF, { task: true }), /Write the note in/);
  // The language only matters for a task run.
  assert.equal(agentHarnessPrompt(ALL_OFF, { noteLang: "id" }), "");
});

test("a run without a task card is not asked to report a status", () => {
  assert.doesNotMatch(agentHarnessPrompt({ ...ALL_OFF, minimalCode: true }), /TASK_STATUS/);
  assert.equal(agentHarnessPrompt(ALL_OFF, {}), "");
  assert.match(applyAgentHarness("Run it", ALL_OFF, { task: true }), /<user_request>\nRun it\n<\/user_request>/);
});

test("each efficiency layer can be enabled on its own", () => {
  const answersOnly = agentHarnessPrompt({ ...ALL_OFF, conciseAnswers: true });
  assert.match(answersOnly, /Efficiency stack/);
  assert.match(answersOnly, /- Answers:/);
  assert.doesNotMatch(answersOnly, /- Terminal:/);
  assert.doesNotMatch(answersOnly, /- Code:/);

  const terminalOnly = agentHarnessPrompt({ ...ALL_OFF, compactTerminal: true });
  assert.match(terminalOnly, /- Terminal:/);
  assert.doesNotMatch(terminalOnly, /- Answers:/);

  const codeOnly = agentHarnessPrompt({ ...ALL_OFF, minimalCode: true });
  assert.match(codeOnly, /- Code:/);
  assert.doesNotMatch(codeOnly, /- Answers:/);
});

test("native runtime request is separated from harness instructions", () => {
  const prompt = applyAgentHarness("Fix <tag> safely", {
    compactTerminal: true,
    conciseAnswers: true,
    minimalCode: true,
    karpathyGuidelines: true,
  });
  assert.match(prompt, /^<agent_harness>/);
  assert.match(prompt, /<user_request>\nFix <tag> safely\n<\/user_request>$/);
});
