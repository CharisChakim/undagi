// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";

import { db } from "../../db.ts";
import { legacyToConnection } from "../llm/legacy.ts";
import type { Connection } from "../llm/types.ts";
import type { Lang } from "../messages.ts";

export interface StoredConnection extends Connection {
  apiKeyEnv: string;
  enabled: boolean;
  createdAt: string;
}

export type Role = "agent" | "plan" | "prd" | "tasks";

export interface PublicConnection extends Omit<StoredConnection, "apiKey"> {
  hasKey: boolean;
}

type ConnectionInput = Partial<StoredConnection> & {
  id?: string;
  apiKey?: string | null;
  apiKeyEnv?: string | null;
};

type ConnectionRow = {
  id: string;
  name: string;
  format: string;
  base_url: string;
  api_key: string;
  api_key_env: string;
  headers: string;
  models: string;
  json_mode: number;
  enabled: number;
  created_at: string;
};

type RoleRow = {
  role: string;
  connection_id: string;
  model: string;
};

const ROLES: readonly Role[] = ["agent", "plan", "prd", "tasks"];

// Tabel dibuat saat modul dipakai agar store tetap mandiri dan tidak bergantung
// pada urutan bootstrap aplikasi atau migrasi terpisah.
db.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    format      TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    api_key     TEXT NOT NULL DEFAULT '',
    api_key_env TEXT NOT NULL DEFAULT '',
    headers     TEXT NOT NULL DEFAULT '{}',
    models      TEXT NOT NULL DEFAULT '[]',
    json_mode   INTEGER NOT NULL DEFAULT 1,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS role_bindings (
    role          TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    model         TEXT NOT NULL
  );
`);

const listConnectionsStmt = db.prepare(
  `SELECT id, name, format, base_url, api_key, api_key_env, headers, models,
          json_mode, enabled, created_at
     FROM connections
    ORDER BY created_at ASC, id ASC`
);
const getConnectionStmt = db.prepare(
  `SELECT id, name, format, base_url, api_key, api_key_env, headers, models,
          json_mode, enabled, created_at
     FROM connections
    WHERE id = ?`
);
const insertConnectionStmt = db.prepare(
  `INSERT INTO connections
    (id, name, format, base_url, api_key, api_key_env, headers, models, json_mode, enabled, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const updateConnectionStmt = db.prepare(
  `UPDATE connections SET
      name = ?, format = ?, base_url = ?, api_key = ?, api_key_env = ?,
      headers = ?, models = ?, json_mode = ?, enabled = ?
    WHERE id = ?`
);
const deleteConnectionStmt = db.prepare(`DELETE FROM connections WHERE id = ?`);
const deleteRolesForConnectionStmt = db.prepare(`DELETE FROM role_bindings WHERE connection_id = ?`);
const listRolesStmt = db.prepare(`SELECT role, connection_id, model FROM role_bindings ORDER BY role ASC`);
const getRoleStmt = db.prepare(`SELECT role, connection_id, model FROM role_bindings WHERE role = ?`);
const upsertRoleStmt = db.prepare(
  `INSERT INTO role_bindings (role, connection_id, model)
   VALUES (?, ?, ?)
   ON CONFLICT(role) DO UPDATE SET
     connection_id = excluded.connection_id,
     model = excluded.model`
);

function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLES.includes(value as Role);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    // Data lama yang rusak tidak boleh membuat seluruh daftar koneksi gagal dibaca.
    return fallback;
  }
}

function parseHeaders(value: string): Record<string, string> {
  const parsed = parseJson<unknown>(value, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function parseModels(value: string): string[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((model): model is string => typeof model === "string") : [];
}

function rawConnection(row: ConnectionRow): StoredConnection {
  return {
    id: row.id,
    name: row.name,
    format: row.format === "anthropic" ? "anthropic" : "openai",
    baseUrl: row.base_url,
    apiKey: row.api_key,
    apiKeyEnv: row.api_key_env,
    headers: parseHeaders(row.headers),
    models: parseModels(row.models),
    jsonMode: Boolean(row.json_mode),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
  };
}

function resolveApiKey(connection: StoredConnection): StoredConnection {
  if (!connection.apiKeyEnv) return connection;

  // Nama env yang tersimpan sengaja mengalahkan key DB agar secret tidak perlu ditulis ulang.
  return { ...connection, apiKey: process.env[connection.apiKeyEnv] ?? "" };
}

function readConnection(row: unknown): StoredConnection | null {
  if (!row) return null;
  return resolveApiKey(rawConnection(row as ConnectionRow));
}

function assertRole(role: Role): void {
  if (!isRole(role)) throw new Error(`Unknown role: ${String(role)}`);
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function serializeHeaders(value: unknown): string {
  if (value === undefined || value === null) return "{}";
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("headers must be an object");
  return JSON.stringify(value);
}

function serializeModels(value: unknown): string {
  if (value === undefined || value === null) return "[]";
  if (!Array.isArray(value) || value.some((model) => typeof model !== "string")) {
    throw new Error("models must be an array of strings");
  }
  return JSON.stringify(value);
}

function connectionFromRow(row: unknown): StoredConnection | null {
  return readConnection(row);
}

export function listConnections(): StoredConnection[] {
  return listConnectionsStmt.all().flatMap((row) => {
    const connection = connectionFromRow(row);
    return connection ? [connection] : [];
  });
}

export function getConnection(id: string): StoredConnection | null {
  if (typeof id !== "string" || !id) return null;
  return connectionFromRow(getConnectionStmt.get(id));
}

export function upsertConnection(input: ConnectionInput): StoredConnection {
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : randomUUID();
  const existingRow = getConnectionStmt.get(id);
  const existing = existingRow ? (existingRow as ConnectionRow) : null;

  const name = requireNonEmpty(input.name ?? existing?.name, "name");
  const baseUrl = requireNonEmpty(input.baseUrl ?? existing?.base_url, "baseUrl");
  const format = input.format ?? existing?.format;
  if (format !== "anthropic" && format !== "openai") throw new Error("format must be anthropic or openai");

  const apiKey = input.apiKey === null
    ? (existing?.api_key ?? "")
    : (input.apiKey ?? existing?.api_key ?? "");
  if (typeof apiKey !== "string") throw new Error("apiKey must be a string or null");

  const apiKeyEnv = input.apiKeyEnv === null
    ? ""
    : (input.apiKeyEnv ?? existing?.api_key_env ?? "");
  if (typeof apiKeyEnv !== "string") throw new Error("apiKeyEnv must be a string or null");

  const headers = serializeHeaders(input.headers ?? (existing ? parseHeaders(existing.headers) : {}));
  const models = serializeModels(input.models ?? (existing ? parseModels(existing.models) : []));
  const jsonMode = input.jsonMode === undefined ? (existing ? Boolean(existing.json_mode) : true) : Boolean(input.jsonMode);
  const enabled = input.enabled === undefined ? (existing ? Boolean(existing.enabled) : true) : Boolean(input.enabled);
  const createdAt = input.createdAt ?? existing?.created_at ?? new Date().toISOString();

  if (existing) {
    updateConnectionStmt.run(
      name,
      format,
      baseUrl,
      apiKey,
      apiKeyEnv,
      headers,
      models,
      jsonMode ? 1 : 0,
      enabled ? 1 : 0,
      id
    );
  } else {
    insertConnectionStmt.run(
      id,
      name,
      format,
      baseUrl,
      apiKey,
      apiKeyEnv,
      headers,
      models,
      jsonMode ? 1 : 0,
      enabled ? 1 : 0,
      createdAt
    );
  }

  const saved = getConnection(id);
  if (!saved) throw new Error("Failed to read saved connection");
  return saved;
}

export function deleteConnection(id: string): void {
  // Binding dihapus bersama koneksi agar resolver tidak menyisakan referensi yatim.
  deleteRolesForConnectionStmt.run(id);
  deleteConnectionStmt.run(id);
}

export function listRoles(): Partial<Record<Role, { connectionId: string; model: string }>> {
  const roles: Partial<Record<Role, { connectionId: string; model: string }>> = {};
  for (const row of listRolesStmt.all() as unknown as RoleRow[]) {
    if (isRole(row.role)) roles[row.role] = { connectionId: row.connection_id, model: row.model };
  }
  return roles;
}

export function setRole(role: Role, connectionId: string, model: string): void {
  assertRole(role);
  const normalizedConnectionId = requireNonEmpty(connectionId, "connectionId");
  const normalizedModel = requireNonEmpty(model, "model");
  if (!getConnection(normalizedConnectionId)) throw new Error(`Connection not found: ${normalizedConnectionId}`);
  upsertRoleStmt.run(role, normalizedConnectionId, normalizedModel);
}

export function resolveRole(role: Role): { conn: Connection; model: string } | null {
  if (!isRole(role)) return null;
  const row = getRoleStmt.get(role) as RoleRow | undefined;
  if (!row || !row.model) return null;

  const connection = getConnection(row.connection_id);
  if (!connection || !connection.enabled) return null;
  return { conn: connection, model: row.model };
}

/**
 * Only the agent stage is chosen in the composer, so the other stages follow it
 * rather than refusing to run: one picked connection governs the whole
 * pipeline, and an unbound stage is no longer a dead end.
 */
export function resolveRoleOrAgent(role: Role): { conn: Connection; model: string } | null {
  const bound = resolveRole(role) ?? resolveRole("agent");
  if (bound) return bound;

  const fallback = listConnections().find((connection) => connection.enabled && connection.models[0]);
  return fallback ? { conn: fallback, model: fallback.models[0] } : null;
}

function resolutionError(role: Role, lang: Lang, detail: string): Error {
  if (lang === "id") return new Error(`Koneksi LLM tidak dapat diselesaikan untuk role ${role}: ${detail}`);
  return new Error(`Could not resolve LLM connection for role ${role}: ${detail}`);
}

function resolutionDetail(lang: Lang, id: string, kind: "missing" | "disabled"): string {
  if (lang === "id") return kind === "missing" ? `connection ${id} tidak ditemukan` : `connection ${id} dinonaktifkan`;
  return kind === "missing" ? `connection ${id} was not found` : `connection ${id} is disabled`;
}

function missingModelDetail(lang: Lang, id: string): string {
  return lang === "id" ? `connection ${id} tidak memiliki model` : `connection ${id} has no model`;
}

function missingPairDetail(lang: Lang): string {
  return lang === "id"
    ? "connectionId dan model wajib diisi atau role binding harus dibuat"
    : "connectionId and model are required, or create a role binding";
}

export function resolveFor(role: Role, body: any, lang: Lang): { conn: Connection; model: string } {
  assertRole(role);
  const request = body && typeof body === "object" ? body : {};
  const requestedConnectionId = typeof request.connectionId === "string" ? request.connectionId.trim() : "";
  const requestedModel = typeof request.model === "string" ? request.model.trim() : "";

  if (requestedConnectionId && requestedModel) {
    const connection = getConnection(requestedConnectionId);
    if (!connection) throw resolutionError(role, lang, resolutionDetail(lang, requestedConnectionId, "missing"));
    if (!connection.enabled) throw resolutionError(role, lang, resolutionDetail(lang, requestedConnectionId, "disabled"));
    return { conn: connection, model: requestedModel };
  }

  const roleResolution = resolveRole(role);
  if (roleResolution) return roleResolution;

  // Binding role harus menang agar klien lama otomatis memakai koneksi tersimpan.
  if (request.llmConfig !== undefined && request.llmConfig !== null) {
    return legacyToConnection(request.llmConfig);
  }

  const enabledConnections = listConnections().filter((connection) => connection.enabled);
  if (enabledConnections.length === 1) {
    const connection = enabledConnections[0];
    const model = connection.models[0];
    if (model) return { conn: connection, model };
    throw resolutionError(role, lang, missingModelDetail(lang, connection.id));
  }

  if (requestedConnectionId && !requestedModel) {
    throw resolutionError(
      role,
      lang,
      lang === "id" ? "model wajib diisi bersama connectionId" : "model is required with connectionId"
    );
  }
  if (enabledConnections.length === 0) {
    throw resolutionError(role, lang, lang === "id" ? "tidak ada connection enabled" : "no enabled connection exists");
  }
  throw resolutionError(role, lang, missingPairDetail(lang));
}

export function toPublicConnection(connection: StoredConnection): PublicConnection {
  const { apiKey, ...withoutApiKey } = connection;
  return { ...withoutApiKey, hasKey: Boolean(apiKey) };
}
