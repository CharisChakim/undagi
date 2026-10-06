// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAntigravityModels } from "./parse.ts";

// Diambil dari `agy models` pada Antigravity CLI 1.2.8: id dan label dipisah
// satu TAB, dan baris progres ikut ke stdout bersama escape ANSI-nya.
const ESC = "";
const AGY_MODELS_OUTPUT = [
  `${ESC}[?25l⠋ Fetching available models...${ESC}[K\r`,
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
].join("\n");

test("parses the tab-separated model list that agy actually prints", () => {
  const models = parseAntigravityModels(AGY_MODELS_OUTPUT);

  assert.deepEqual(models.map((model) => model.modelId), [
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.1-pro-high",
    "claude-sonnet-4-6",
    "gpt-oss-120b-medium",
  ]);
  // Label ini yang muncul di picker, jadi kurung dan spasinya harus utuh.
  assert.equal(models[0].label, "Gemini 3.8 Flash (High)");
  assert.equal(models[4].label, "GPT-OSS 120B (Medium)");
});

test("the progress line agy prints before the table is not mistaken for a model", () => {
  const models = parseAntigravityModels(AGY_MODELS_OUTPUT);
  assert.ok(!models.some((model) => /fetching/i.test(model.modelId)));
});

test("a two-space or pipe separated table still parses, in case agy changes its output", () => {
  const spaced = parseAntigravityModels("model-a   Model A\nmodel-b | Model B");
  assert.deepEqual(spaced.map((model) => [model.modelId, model.label]), [
    ["model-a", "Model A"],
    ["model-b", "Model B"],
  ]);
});

test("JSON output wins over the table reader when agy returns structured data", () => {
  const models = parseAntigravityModels({ models: [{ id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" }] });
  assert.deepEqual(models.map((model) => model.modelId), ["gemini-3.1-pro-high"]);
});
