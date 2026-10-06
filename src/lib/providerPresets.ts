// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export type ProviderConnectionFormat = "anthropic" | "openai";
export type ProviderPresetId =
  | "router-local"
  | "ollama"
  | "lm-studio"
  | "openrouter"
  | "anthropic"
  | "gemini"
  | "openai-compatible"
  | "custom";
export type ApiKeyRequirement = "required" | "optional" | "none";

export interface ProviderPreset {
  id: ProviderPresetId;
  name: string;
  format?: ProviderConnectionFormat;
  baseUrl: string;
  apiKeyRequirement: ApiKeyRequirement;
  /** Safe, non-secret default for the environment variable field. */
  defaultApiKeyEnv?: string;
  defaultModel?: string;
}

// Preset menyimpan nilai yang aman untuk ditampilkan; secret selalu diisi pengguna
// pada form koneksi dan tidak pernah menjadi bagian dari preset.
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "router-local",
    name: "Router lokal (Anthropic)",
    format: "anthropic",
    baseUrl: "http://localhost:20128/v1",
    apiKeyRequirement: "optional",
    defaultModel: "claude-combo",
  },
  {
    id: "ollama",
    name: "Ollama",
    format: "openai",
    baseUrl: "http://localhost:11434",
    apiKeyRequirement: "none",
    defaultModel: "llama3",
  },
  {
    id: "lm-studio",
    name: "LM Studio",
    format: "openai",
    baseUrl: "http://localhost:1234/v1",
    apiKeyRequirement: "none",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    format: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyRequirement: "required",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    format: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyRequirement: "required",
  },
  {
    id: "gemini",
    name: "Gemini (OpenAI-compat)",
    format: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyRequirement: "required",
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible endpoint",
    format: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyRequirement: "required",
    defaultApiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
  },
  {
    id: "custom",
    name: "Kustom",
    baseUrl: "",
    apiKeyRequirement: "optional",
  },
];

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export interface ProviderConnectionDraft {
  name: string;
  format?: ProviderConnectionFormat;
  baseUrl: string;
  apiKeyEnv?: string;
  headers: Record<string, string>;
  models: string[];
  jsonMode: boolean;
  enabled: boolean;
}

export function createProviderDraft(preset: ProviderPreset): ProviderConnectionDraft {
  return {
    name: preset.name,
    ...(preset.format ? { format: preset.format } : {}),
    baseUrl: preset.baseUrl,
    ...(preset.defaultApiKeyEnv ? { apiKeyEnv: preset.defaultApiKeyEnv } : {}),
    headers: {},
    models: preset.defaultModel ? [preset.defaultModel] : [],
    jsonMode: true,
    enabled: true,
  };
}
