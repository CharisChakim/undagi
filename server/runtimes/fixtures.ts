// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Non-secret contract fixtures for parser consumers and future adapter tests. */

export const CODEX_MODEL_LIST_FIXTURE = {
  jsonrpc: "2.0",
  id: 2,
  result: {
    models: [
      {
        id: "gpt-5-codex",
        displayName: "GPT-5 Codex",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5-mini",
        displayName: "GPT-5 Mini",
        supportedReasoningEfforts: [],
      },
    ],
  },
} as const;

export const CODEX_CONFIG_READ_FIXTURE = {
  jsonrpc: "2.0",
  id: 3,
  result: {
    config: {
      model: "gpt-5-codex",
      reasoningEffort: "medium",
      workspace: "fixture-workspace",
    },
  },
} as const;

export const CLAUDE_SUPPORTED_MODELS_FIXTURE = [
  { id: "claude-sonnet", displayName: "Claude Sonnet", effortOptions: ["low", "high"] },
  { id: "claude-haiku", displayName: "Claude Haiku" },
] as const;

export const ANTIGRAVITY_MODELS_JSON_FIXTURE = {
  models: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", supportedEfforts: ["low", "medium", "high"] },
  ],
} as const;

/** @deprecated Use the correctly-spelled ANTIGRAVITY_MODELS_JSON_FIXTURE. */
export const ANTYGRAVITY_MODELS_JSON_FIXTURE = ANTIGRAVITY_MODELS_JSON_FIXTURE;

export const ANTYGRAVITY_MODELS_TABLE_FIXTURE = `
Model ID              Label
gemini-2.5-pro        Gemini 2.5 Pro
gemini-2.5-flash      Gemini 2.5 Flash
`;
