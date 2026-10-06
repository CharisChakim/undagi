// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseClaudeSupportedModels, parseCodexConfig, parseCodexModelList } from "./parse.ts";

test("parses Codex app-server reasoning effort objects and configured default", () => {
  const models = parseCodexModelList({
    data: [{
      id: "gpt-6-astra",
      displayName: "GPT-6 Astra",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deep" },
        { reasoningEffort: "xhigh", description: "Deeper" },
        { reasoningEffort: "max", description: "Maximum" },
      ],
      defaultReasoningEffort: "medium",
    }],
  });

  assert.deepEqual(models[0]?.effortOptions.map((option) => option.value), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(models[0]?.defaultEffort, "medium");
  assert.equal(parseCodexConfig({ config: { model: "gpt-6-astra", model_reasoning_effort: "high" } }).defaultEffort, "high");
});

test("parses current Claude Agent SDK ModelInfo values and effort levels", () => {
  const models = parseClaudeSupportedModels([
    {
      value: "default",
      resolvedModel: "claude-opus",
      displayName: "Default (recommended)",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "haiku",
      resolvedModel: "claude-haiku",
      displayName: "Haiku",
    },
  ]);

  assert.deepEqual(models.map((model) => model.modelId), ["default", "haiku"]);
  assert.deepEqual(models[0]?.effortOptions.map((option) => option.value), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(models[1]?.effortOptions, []);
});
