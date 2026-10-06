// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { db } from "../../db.ts";
import { RUNTIME_IDS, type RuntimeId } from "./types.ts";

export const INHERIT = "inherit" as const;
export type RuntimePreferenceValue = typeof INHERIT | string;
export type RuntimePreferenceScope = "global" | "workspace" | "role";
export type RuntimePreferenceSource = "inherit" | "user-override";

export interface RuntimePreferenceKey {
  runtime: RuntimeId;
  connectionId: string;
  scope?: RuntimePreferenceScope;
  scopeKey?: string | null;
}

export interface RuntimePreferenceInput extends RuntimePreferenceKey {
  /** Model yang diminta; `inherit` menyerahkan resolusi ke koneksi/runtime. */
  model?: RuntimePreferenceValue;
  /** Nilai effort native; `inherit` menyerahkan resolusi ke koneksi/runtime. */
  effort?: RuntimePreferenceValue;
}

export interface RuntimePreference {
  runtime: RuntimeId;
  connectionId: string;
  scope: RuntimePreferenceScope;
  scopeKey: string | null;
  requestedModel: RuntimePreferenceValue;
  requestedEffort: RuntimePreferenceValue;
  modelSource: RuntimePreferenceSource;
  effortSource: RuntimePreferenceSource;
  /** Null berarti belum ada baris tersimpan untuk kunci ini. */
  updatedAt: string | null;
}

export interface RuntimePreferenceFilter {
  runtime?: RuntimeId;
  connectionId?: string;
  scope?: RuntimePreferenceScope;
  scopeKey?: string | null;
}

interface RuntimePreferenceRow {
  runtime: RuntimeId;
  connection_id: string;
  scope: RuntimePreferenceScope;
  scope_key: string;
  requested_model: string;
  requested_effort: string;
  updated_at: string;
}

// Scope key memakai string kosong untuk global supaya kombinasi scope menjadi
// primary key SQLite yang benar-benar unik; API tetap menampilkan null.
db.exec(`
  CREATE TABLE IF NOT EXISTS runtime_preferences (
    runtime          TEXT NOT NULL,
    connection_id    TEXT NOT NULL,
    scope            TEXT NOT NULL DEFAULT 'global',
    scope_key        TEXT NOT NULL DEFAULT '',
    requested_model  TEXT NOT NULL DEFAULT 'inherit',
    requested_effort TEXT NOT NULL DEFAULT 'inherit',
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (runtime, connection_id, scope, scope_key),
    CHECK (scope IN ('global', 'workspace', 'role')),
    CHECK ((scope = 'global' AND scope_key = '') OR
           (scope IN ('workspace', 'role') AND length(trim(scope_key)) > 0)),
    CHECK (length(trim(requested_model)) > 0),
    CHECK (length(trim(requested_effort)) > 0)
  );
  CREATE INDEX IF NOT EXISTS idx_runtime_preferences_connection
    ON runtime_preferences (connection_id, runtime, scope, scope_key);
`);

const getPreferenceStmt = db.prepare(`
  SELECT runtime, connection_id, scope, scope_key,
         requested_model, requested_effort, updated_at
    FROM runtime_preferences
   WHERE runtime = ? AND connection_id = ? AND scope = ? AND scope_key = ?
`);
const upsertPreferenceStmt = db.prepare(`
  INSERT INTO runtime_preferences
    (runtime, connection_id, scope, scope_key, requested_model, requested_effort, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(runtime, connection_id, scope, scope_key) DO UPDATE SET
    requested_model = excluded.requested_model,
    requested_effort = excluded.requested_effort,
    updated_at = excluded.updated_at
`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === "string" && RUNTIME_IDS.includes(value as RuntimeId);
}

function isScope(value: unknown): value is RuntimePreferenceScope {
  return value === "global" || value === "workspace" || value === "role";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function runtime(value: unknown): RuntimeId {
  if (!isRuntimeId(value)) throw new Error(`runtime must be one of: ${RUNTIME_IDS.join(", ")}`);
  return value;
}

function connectionId(value: unknown): string {
  return requiredString(value, "connectionId");
}

function scope(value: unknown): RuntimePreferenceScope {
  if (value === undefined || value === null) return "global";
  if (!isScope(value)) throw new Error("scope must be global, workspace, or role");
  return value;
}

function scopeKey(value: unknown, selectedScope: RuntimePreferenceScope): string {
  if (selectedScope === "global") {
    if (value !== undefined && value !== null && value !== "") {
      throw new Error("scopeKey must be empty for global scope");
    }
    return "";
  }
  return requiredString(value, "scopeKey");
}

function preferenceValue(value: unknown, field: string): RuntimePreferenceValue {
  if (typeof value !== "string") throw new Error(`${field} must be a string or inherit`);
  // Nilai native disimpan persis. trim() hanya dipakai untuk menolak isian
  // kosong, sehingga huruf besar dan tanda baca provider tidak dinormalisasi.
  if (!value.trim()) throw new Error(`${field} must be a non-empty string or inherit`);
  return value;
}

function sourceFor(value: RuntimePreferenceValue): RuntimePreferenceSource {
  return value === INHERIT ? "inherit" : "user-override";
}

function rowToPreference(row: RuntimePreferenceRow): RuntimePreference {
  return {
    runtime: row.runtime,
    connectionId: row.connection_id,
    scope: row.scope,
    scopeKey: row.scope_key || null,
    requestedModel: row.requested_model,
    requestedEffort: row.requested_effort,
    modelSource: sourceFor(row.requested_model),
    effortSource: sourceFor(row.requested_effort),
    updatedAt: row.updated_at,
  };
}

function normalizeKey(input: RuntimePreferenceKey): {
  runtime: RuntimeId;
  connectionId: string;
  scope: RuntimePreferenceScope;
  scopeKey: string;
} {
  const selectedScope = scope(input.scope);
  return {
    runtime: runtime(input.runtime),
    connectionId: connectionId(input.connectionId),
    scope: selectedScope,
    scopeKey: scopeKey(input.scopeKey, selectedScope),
  };
}

function defaultPreference(key: ReturnType<typeof normalizeKey>): RuntimePreference {
  return {
    runtime: key.runtime,
    connectionId: key.connectionId,
    scope: key.scope,
    scopeKey: key.scopeKey || null,
    requestedModel: INHERIT,
    requestedEffort: INHERIT,
    modelSource: "inherit",
    effortSource: "inherit",
    updatedAt: null,
  };
}

export function getRuntimePreference(input: RuntimePreferenceKey): RuntimePreference | null {
  const key = normalizeKey(input);
  const row = getPreferenceStmt.get(
    key.runtime,
    key.connectionId,
    key.scope,
    key.scopeKey,
  ) as unknown as RuntimePreferenceRow | undefined;
  return row ? rowToPreference(row) : null;
}

export function getRuntimePreferenceOrDefault(input: RuntimePreferenceKey): RuntimePreference {
  const key = normalizeKey(input);
  return getRuntimePreference(key) ?? defaultPreference(key);
}

export function listRuntimePreferences(filter: RuntimePreferenceFilter = {}): RuntimePreference[] {
  const where: string[] = [];
  const values: string[] = [];

  if (filter.runtime !== undefined) {
    where.push("runtime = ?");
    values.push(runtime(filter.runtime));
  }
  if (filter.connectionId !== undefined) {
    where.push("connection_id = ?");
    values.push(connectionId(filter.connectionId));
  }
  if (filter.scope !== undefined) {
    const selectedScope = scope(filter.scope);
    where.push("scope = ?");
    values.push(selectedScope);
    if (filter.scopeKey !== undefined) {
      where.push("scope_key = ?");
      values.push(scopeKey(filter.scopeKey, selectedScope));
    }
  } else if (filter.scopeKey !== undefined) {
    throw new Error("scope is required when filtering by scopeKey");
  }

  const query = `
    SELECT runtime, connection_id, scope, scope_key,
           requested_model, requested_effort, updated_at
      FROM runtime_preferences
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY updated_at DESC, runtime ASC, connection_id ASC, scope ASC, scope_key ASC
  `;
  const rows = db.prepare(query).all(...values) as unknown as RuntimePreferenceRow[];
  return rows.map(rowToPreference);
}

export function saveRuntimePreference(input: RuntimePreferenceInput): RuntimePreference {
  const key = normalizeKey(input);
  const existing = getRuntimePreference(key);
  const requestedModel = input.model === undefined
    ? (existing?.requestedModel ?? INHERIT)
    : preferenceValue(input.model, "model");
  const requestedEffort = input.effort === undefined
    ? (existing?.requestedEffort ?? INHERIT)
    : preferenceValue(input.effort, "effort");
  const now = new Date().toISOString();

  upsertPreferenceStmt.run(
    key.runtime,
    key.connectionId,
    key.scope,
    key.scopeKey,
    requestedModel,
    requestedEffort,
    now,
  );
  return getRuntimePreferenceOrDefault(key);
}

export function parseRuntimePreferenceInput(value: unknown): RuntimePreferenceInput {
  if (!isRecord(value)) throw new Error("A runtime preference object is required");
  return {
    runtime: runtime(value.runtime),
    connectionId: connectionId(value.connectionId),
    scope: scope(value.scope),
    scopeKey: value.scopeKey === undefined ? null : value.scopeKey as string | null,
    ...(value.model !== undefined ? { model: preferenceValue(value.model, "model") } : {}),
    ...(value.effort !== undefined ? { effort: preferenceValue(value.effort, "effort") } : {}),
  };
}
