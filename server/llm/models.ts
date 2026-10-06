// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Connection } from "./types.ts";
import { apiUrl } from "./url.ts";

export interface ModelList {
  models: string[];
  source: "remote" | "manual";
  error?: string;
}

function modelHeaders(conn: Connection): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (conn.format === "anthropic") {
    if (conn.apiKey) headers["x-api-key"] = conn.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (conn.apiKey) {
    headers.authorization = `Bearer ${conn.apiKey}`;
  }
  // Header koneksi dipasang terakhir agar endpoint yang memakai nama header khusus tetap bisa bekerja.
  return { ...headers, ...(conn.headers ?? {}) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function listModels(conn: Connection): Promise<ModelList> {
  let manualModels: string[] = [];

  try {
    manualModels = Array.isArray(conn?.models) ? conn.models : [];
    const url = apiUrl(conn.baseUrl, "models");
    const response = await fetch(url, {
      method: "GET",
      headers: modelHeaders(conn),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
    }

    const data = await response.json();
    return {
      models: data.data.map((model: any) => String(model.id)).sort(),
      source: "remote",
    };
  } catch (err: unknown) {
    // Discovery hanya pelengkap; model manual tetap membuat koneksi bisa dipakai saat endpoint ini tidak tersedia.
    return { models: manualModels, source: "manual", error: errorMessage(err) };
  }
}
