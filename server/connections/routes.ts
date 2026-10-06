// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import express, { type Response } from "express";
import { langOf, msg } from "../messages.ts";
import { parseJsonFromLlm } from "../llm/json.ts";
import { legacyToConnection } from "../llm/legacy.ts";
import type { Connection } from "../llm/types.ts";
import {
  deleteConnection,
  getConnection,
  listConnections,
  listRoles,
  setRole,
  upsertConnection,
} from "./store.ts";
import type { Role, StoredConnection } from "./store.ts";
import { testConnection } from "./test.ts";
import { listModels } from "../llm/models.ts";

const router = express.Router();

const ROLES: readonly Role[] = ["agent", "plan", "prd", "tasks"];
const FORMATS = ["anthropic", "openai"] as const;

class RequestError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendError(res: Response, error: unknown, status = 500): void {
  const requestError = error instanceof RequestError ? error : undefined;
  res.status(requestError ? requestError.statusCode : status).json({ error: errorMessage(error) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestError(`${field} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RequestError(`${field} must be a string.`);
  return value.trim();
}

function validateFormat(value: unknown): "anthropic" | "openai" {
  if (!FORMATS.includes(value as (typeof FORMATS)[number])) {
    throw new RequestError("format must be either anthropic or openai.");
  }
  return value as "anthropic" | "openai";
}

function validateHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new RequestError("headers must be an object.");
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item !== "string") throw new RequestError(`headers.${key} must be a string.`);
      return [key, item];
    }),
  );
}

function validateModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((model) => typeof model !== "string")) {
    throw new RequestError("models must be an array of strings.");
  }
  return value.map((model) => model.trim()).filter(Boolean);
}

function connectionPayload(body: unknown, partial: boolean): Record<string, unknown> {
  if (!isRecord(body)) throw new RequestError("Connection body must be an object.");

  const output: Record<string, unknown> = {};
  const name = partial ? optionalString(body.name, "name") : requiredString(body.name, "name");
  const baseUrl = partial
    ? optionalString(body.baseUrl, "baseUrl")
    : requiredString(body.baseUrl, "baseUrl");

  if (name !== undefined) {
    if (!name) throw new RequestError("name is required.");
    output.name = name;
  }
  if (body.format !== undefined || !partial) output.format = validateFormat(body.format);
  if (baseUrl !== undefined) {
    if (!baseUrl) throw new RequestError("baseUrl is required.");
    output.baseUrl = baseUrl;
  }

  if (body.id !== undefined) output.id = requiredString(body.id, "id");
  if (body.apiKey !== undefined) {
    if (body.apiKey !== null && typeof body.apiKey !== "string") {
      throw new RequestError("apiKey must be a string or null.");
    }
    // Null hanya bermakna "pertahankan" pada update; store menerapkan semantik itu.
    output.apiKey = body.apiKey === null ? null : body.apiKey;
  }
  if (body.apiKeyEnv !== undefined) {
    output.apiKeyEnv = body.apiKeyEnv === null ? null : optionalString(body.apiKeyEnv, "apiKeyEnv");
  }
  if (body.headers !== undefined) output.headers = validateHeaders(body.headers);
  if (body.models !== undefined) output.models = validateModels(body.models);
  if (body.jsonMode !== undefined) {
    if (typeof body.jsonMode !== "boolean") throw new RequestError("jsonMode must be a boolean.");
    output.jsonMode = body.jsonMode;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new RequestError("enabled must be a boolean.");
    output.enabled = body.enabled;
  }

  return output;
}

function publicConnection(connection: StoredConnection): Record<string, unknown> {
  const { apiKey: _apiKey, ...withoutKey } = connection;
  // Key disembunyikan dengan menghapus field-nya, bukan mengirim string kosong yang
  // mudah disalahartikan klien sebagai key yang benar-benar tersimpan.
  return { ...withoutKey, hasKey: Boolean(connection.apiKey) };
}

function connectionForTest(body: unknown): { conn: Connection; model: string } {
  if (!isRecord(body)) throw new RequestError("Connection body must be an object.");
  const raw = isRecord(body.connection) ? body.connection : body;
  const payload = connectionPayload(raw, false);
  const apiKeyEnv = typeof payload.apiKeyEnv === "string" ? payload.apiKeyEnv : "";
  const configuredKey = typeof payload.apiKey === "string" ? payload.apiKey : undefined;
  const apiKey = apiKeyEnv && process.env[apiKeyEnv] !== undefined
    ? process.env[apiKeyEnv]
    : configuredKey;
  const models = Array.isArray(payload.models) ? (payload.models as string[]) : [];
  const model = requiredString(body.model ?? raw.model ?? models[0], "model");

  return {
    conn: {
      id: typeof payload.id === "string" ? payload.id : "draft",
      name: typeof payload.name === "string" ? payload.name : "Draft",
      format: payload.format as Connection["format"],
      baseUrl: payload.baseUrl as string,
      ...(apiKey ? { apiKey } : {}),
      headers: (payload.headers as Record<string, string> | undefined) ?? {},
      models,
      jsonMode: typeof payload.jsonMode === "boolean" ? payload.jsonMode : true,
    },
    model,
  };
}

function modelForStoredConnection(connection: StoredConnection, body: unknown): string {
  const requested = isRecord(body) ? body.model : undefined;
  if (requested !== undefined) return requiredString(requested, "model");
  if (connection.models.length > 0) return requiredString(connection.models[0], "model");
  throw new RequestError("model is required when the connection has no saved models.");
}

function requireBaseUrl(conn: Connection, lang: "en" | "id"): void {
  if (!conn.baseUrl.trim()) throw new RequestError(msg(lang, "baseUrlRequired"));
}

router.get("/api/connections", (req, res) => {
  try {
    res.json({
      connections: listConnections().map(publicConnection),
      roles: listRoles(),
    });
  } catch (error) {
    console.error("Error GET /api/connections:", error);
    sendError(res, error);
  }
});

router.post("/api/connections", (req, res) => {
  try {
    const connection = upsertConnection(connectionPayload(req.body, false) as any);
    res.json(publicConnection(connection));
  } catch (error) {
    console.error("Error POST /api/connections:", error);
    sendError(res, error);
  }
});

router.put("/api/connections/:id", (req, res) => {
  try {
    const existing = getConnection(req.params.id);
    if (!existing) {
      sendError(res, new RequestError(`Connection not found: ${req.params.id}.`, 404));
      return;
    }
    const patch = connectionPayload(req.body, true);
    const connection = upsertConnection({ id: req.params.id, ...patch } as any);
    res.json(publicConnection(connection));
  } catch (error) {
    console.error("Error PUT /api/connections/:id:", error);
    sendError(res, error);
  }
});

router.delete("/api/connections/:id", (req, res) => {
  try {
    if (!getConnection(req.params.id)) {
      sendError(res, new RequestError(`Connection not found: ${req.params.id}.`, 404));
      return;
    }
    // Store menghapus binding dalam operasi yang sama agar role tidak menunjuk ke key yatim.
    deleteConnection(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error("Error DELETE /api/connections/:id:", error);
    sendError(res, error);
  }
});

router.post("/api/connections/:id/models", async (req, res) => {
  try {
    const connection = getConnection(req.params.id);
    if (!connection) {
      sendError(res, new RequestError(`Connection not found: ${req.params.id}.`, 404));
      return;
    }
    const discovered = await listModels(connection);
    upsertConnection({ id: connection.id, models: discovered.models } as any);
    const response = { models: discovered.models, source: discovered.source, ...(discovered.error ? { error: discovered.error } : {}) };
    res.json(response);
  } catch (error) {
    console.error("Error POST /api/connections/:id/models:", error);
    sendError(res, error);
  }
});

router.post("/api/connections/:id/test", async (req, res) => {
  try {
    const connection = getConnection(req.params.id);
    if (!connection) {
      sendError(res, new RequestError(`Connection not found: ${req.params.id}.`, 404));
      return;
    }
    const result = await testConnection(connection, modelForStoredConnection(connection, req.body), langOf(req));
    res.json(result);
  } catch (error) {
    console.error("Error POST /api/connections/:id/test:", error);
    sendError(res, error);
  }
});

router.post("/api/connections/test", async (req, res) => {
  try {
    const { conn, model } = connectionForTest(req.body);
    requireBaseUrl(conn, langOf(req));
    res.json(await testConnection(conn, model, langOf(req)));
  } catch (error) {
    console.error("Error POST /api/connections/test:", error);
    sendError(res, error);
  }
});

router.put("/api/roles", (req, res) => {
  try {
    const body = req.body;
    if (!isRecord(body) || !ROLES.includes(body.role as Role)) {
      throw new RequestError("role must be one of agent, plan, prd, or tasks.");
    }
    const role = body.role as Role;
    const connectionId = requiredString(body.connectionId, "connectionId");
    const model = requiredString(body.model, "model");
    const connection = getConnection(connectionId);
    if (!connection) throw new RequestError(`Connection not found: ${connectionId}.`, 404);
    if (!connection.enabled) throw new RequestError(`Connection is disabled: ${connectionId}.`);
    setRole(role, connectionId, model);
    res.json({ success: true });
  } catch (error) {
    console.error("Error PUT /api/roles:", error);
    sendError(res, error);
  }
});

router.post("/api/test-llm", async (req, res) => {
  try {
    const { conn, model } = legacyToConnection(req.body?.llmConfig);
    const lang = langOf(req);
    requireBaseUrl(conn, lang);
    const result = await testConnection(conn, model, lang);
    if (!result.ok) {
      const failedProbe = result.probes.find((probe) => probe.name === "chat" && !probe.ok);
      throw new Error(failedProbe?.detail || "The LLM connection test failed.");
    }

    // Modal lama hanya memahami payload JSON ini; probe baru tetap dijalankan di server.
    const response = parseJsonFromLlm(
      JSON.stringify({ status: "connected", message: "Koneksi LLM Berhasil" }),
      lang,
    );
    res.json({ success: true, response });
  } catch (error) {
    console.error("Error POST /api/test-llm:", error);
    res.status(500).json({ success: false, error: errorMessage(error) });
  }
});

export { router };
export { resolveFor } from "./store.ts";
export default router;
