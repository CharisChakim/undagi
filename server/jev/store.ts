import { db } from "../../db.ts";
import { JEV_FEATURES, type JevFeature, type JevSettingsPatch, type JevSettingsPublic } from "./types.ts";

// Satu baris saja (id = 1): Jev hanya punya satu key per mesin, jadi tidak ada
// alasan memakai tabel berkunci banyak seperti connections.
db.exec(`
  CREATE TABLE IF NOT EXISTS jev_settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    enabled    INTEGER NOT NULL DEFAULT 0,
    api_key    TEXT NOT NULL DEFAULT '',
    features   TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );
`);

interface JevSettingsRow {
  enabled: number;
  api_key: string;
  features: string;
}

const getStmt = db.prepare(`SELECT enabled, api_key, features FROM jev_settings WHERE id = 1`);
const upsertStmt = db.prepare(`
  INSERT INTO jev_settings (id, enabled, api_key, features, updated_at)
  VALUES (1, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    enabled = excluded.enabled,
    api_key = excluded.api_key,
    features = excluded.features,
    updated_at = excluded.updated_at
`);

type Features = Record<JevFeature, boolean>;

function readRow(): JevSettingsRow | null {
  return (getStmt.get() as unknown as JevSettingsRow | undefined) ?? null;
}

function parseFeatures(raw: string | undefined): Features {
  let parsed: unknown = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    // Baris rusak tidak boleh mematikan halaman settings; fitur kembali ke default (mati).
  }
  const source = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  return Object.fromEntries(JEV_FEATURES.map((name) => [name, source[name] === true])) as Features;
}

export function getJevSettings(): JevSettingsPublic {
  const row = readRow();
  return {
    enabled: row ? row.enabled === 1 : false,
    hasKey: Boolean(row?.api_key),
    features: parseFeatures(row?.features),
  };
}

/** For the server-side client only: the key never goes into a response or a log. */
export function readJevKey(): string | null {
  return readRow()?.api_key || null;
}

export function updateJevSettings(patch: JevSettingsPatch): JevSettingsPublic {
  const row = readRow();

  // apiKey: omitted/null keeps the saved key, "" (or whitespace) clears it, a string replaces it.
  let apiKey = row?.api_key ?? "";
  if (patch.apiKey !== undefined && patch.apiKey !== null) {
    if (typeof patch.apiKey !== "string") throw new Error("apiKey must be a string or null");
    apiKey = patch.apiKey.trim();
  }

  const enabled = patch.enabled === undefined ? row?.enabled === 1 : Boolean(patch.enabled);

  const features = parseFeatures(row?.features);
  const incoming = typeof patch.features === "object" && patch.features !== null ? patch.features : {};
  for (const name of JEV_FEATURES) {
    const value = (incoming as Record<string, unknown>)[name];
    // Nama fitur yang tidak dikenal diabaikan karena tidak pernah dibaca di atas.
    if (value !== undefined) features[name] = Boolean(value);
  }

  upsertStmt.run(enabled ? 1 : 0, apiKey, JSON.stringify(features), new Date().toISOString());
  return getJevSettings();
}
