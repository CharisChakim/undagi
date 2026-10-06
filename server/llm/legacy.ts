// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Connection } from "./types.ts";

const GEMINI_OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

function connection(baseUrl: string, jsonMode: boolean, apiKey?: string): Connection {
  return {
    id: "legacy",
    name: "Legacy",
    format: "openai",
    baseUrl,
    apiKey,
    models: [],
    jsonMode,
  };
}

export function legacyToConnection(cfg: any): { conn: Connection; model: string } {
  const provider = cfg?.provider || "gemini";

  if (provider === "ollama") {
    const model = cfg?.modelName || "llama3";
    return {
      conn: connection(cfg?.baseUrl || "http://localhost:11434", false),
      model,
    };
  }

  if (provider === "custom") {
    const model = cfg?.modelName || "gpt-3.5-turbo";
    return {
      conn: connection(cfg?.baseUrl || "", true, cfg?.apiKey),
      model,
    };
  }

  const requestedKey = typeof cfg?.apiKey === "string" ? cfg.apiKey.trim() : "";
  const apiKey = requestedKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Peringatan dipertahankan karena key boleh disediakan oleh environment setelah proses berjalan.
    console.warn("Warning: no Gemini API key from the request and GEMINI_API_KEY is unset.");
  }

  const model = cfg?.modelName || "gemini-3.6-flash";
  return {
    conn: connection(GEMINI_OPENAI_URL, true, apiKey),
    model,
  };
}
