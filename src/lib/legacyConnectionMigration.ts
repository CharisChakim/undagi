// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { LLMProvider } from "../types";

export const LEGACY_LLM_CONFIG_KEY = "ai_plan_architect_llm_config";
export const LEGACY_MIGRATION_MARKER_KEY = "ai_plan_architect_llm_config_migrated";

const ROLES = ["agent", "plan", "prd", "tasks"] as const;
type LegacyRole = (typeof ROLES)[number];

interface LegacyConfigPayload {
  provider: LLMProvider;
  modelName: string;
  baseUrl: string;
  apiKey?: string;
}

interface LegacyConnectionResponse {
  id?: unknown;
}

export interface LegacyMigrationResult {
  status: "migrated" | "skipped" | "failed";
  connectionId?: string;
  model?: string;
  reason?:
    | "already-configured"
    | "already-migrated"
    | "no-legacy-config"
    | "invalid-legacy-config"
    | "storage-unavailable";
  error?: string;
}

export interface LegacyMigrationOptions {
  // Context koneksi sudah melakukan GET; jika tidak diberikan, helper mengambilnya.
  connections?: readonly unknown[];
  fetchImpl?: typeof fetch;
  storage?: Storage;
  connectionsUrl?: string;
  rolesUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readLegacyConfig(storage: Storage): LegacyConfigPayload | null {
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_LLM_CONFIG_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;

    const provider = parsed.provider;
    if (provider !== "gemini" && provider !== "ollama" && provider !== "custom") return null;

    const modelName = typeof parsed.modelName === "string" ? parsed.modelName.trim() : "";
    const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
    const apiKey = typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey : undefined;
    return { provider, modelName, baseUrl, ...(apiKey ? { apiKey } : {}) };
  } catch {
    return null;
  }
}

function legacyConnectionPayload(config: LegacyConfigPayload): { connection: Record<string, unknown>; model: string } {
  const defaults: Record<LLMProvider, { name: string; baseUrl: string; model: string; jsonMode: boolean }> = {
    gemini: {
      name: "Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-3.6-flash",
      jsonMode: true,
    },
    ollama: {
      name: "Ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3",
      jsonMode: false,
    },
    custom: {
      name: "Custom",
      baseUrl: "",
      model: "gpt-3.5-turbo",
      jsonMode: true,
    },
  };
  const fallback = defaults[config.provider];
  const model = config.modelName || fallback.model;
  const baseUrl = config.baseUrl || fallback.baseUrl;

  return {
    connection: {
      name: fallback.name,
      format: "openai",
      baseUrl,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      headers: {},
      models: [model],
      jsonMode: fallback.jsonMode,
      enabled: true,
    },
    model,
  };
}

async function readConnectionId(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as LegacyConnectionResponse;
    return typeof body?.id === "string" && body.id.trim() ? body.id.trim() : null;
  } catch {
    return null;
  }
}

async function bindRole(
  fetchImpl: typeof fetch,
  rolesUrl: string,
  role: LegacyRole,
  connectionId: string,
  model: string,
): Promise<boolean> {
  try {
    const response = await fetchImpl(rolesUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, connectionId, model }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function migrateLegacyLLMConfig(
  options: LegacyMigrationOptions = {},
): Promise<LegacyMigrationResult> {
  const storage = options.storage ?? browserStorage();
  if (!storage) return { status: "skipped", reason: "storage-unavailable" };

  let marked = false;
  try {
    marked = storage.getItem(LEGACY_MIGRATION_MARKER_KEY) === "1";
  } catch {
    return { status: "skipped", reason: "storage-unavailable" };
  }
  if (marked) return { status: "skipped", reason: "already-migrated" };

  const fetchImpl = options.fetchImpl ?? fetch;
  const connectionsUrl = options.connectionsUrl ?? "/api/connections";
  const rolesUrl = options.rolesUrl ?? "/api/roles";
  let connections = options.connections;

  if (!connections) {
    try {
      const response = await fetchImpl(connectionsUrl);
      if (!response.ok) return { status: "failed", error: "Failed to load connections." };
      const body = (await response.json()) as { connections?: unknown };
      connections = Array.isArray(body?.connections) ? body.connections : undefined;
      if (!connections) return { status: "failed", error: "Invalid connections response." };
    } catch {
      return { status: "failed", error: "Failed to load connections." };
    }
  }

  if (connections.length > 0) return { status: "skipped", reason: "already-configured" };

  const legacyConfig = readLegacyConfig(storage);
  if (!legacyConfig) return { status: "skipped", reason: "no-legacy-config" };
  if (legacyConfig.provider === "custom" && !legacyConfig.baseUrl) {
    return { status: "skipped", reason: "invalid-legacy-config" };
  }

  const { connection, model } = legacyConnectionPayload(legacyConfig);
  let connectionId: string | null = null;
  try {
    const response = await fetchImpl(connectionsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(connection),
    });
    if (!response.ok) return { status: "failed", error: "Failed to create migrated connection." };
    connectionId = await readConnectionId(response);
  } catch {
    return { status: "failed", error: "Failed to create migrated connection." };
  }
  if (!connectionId) return { status: "failed", error: "Migrated connection has no id." };

  for (const role of ROLES) {
    if (!(await bindRole(fetchImpl, rolesUrl, role, connectionId, model))) {
      return {
        status: "failed",
        connectionId,
        model,
        error: `Failed to bind migrated connection to ${role}.`,
      };
    }
  }

  try {
    storage.setItem(LEGACY_MIGRATION_MARKER_KEY, "1");
  } catch {
    // Migrasi tetap berhasil; marker hanya mencegah pengulangan setelah semua role terikat.
  }

  return { status: "migrated", connectionId, model };
}
