import { db } from "../../db.ts";

// App preferences (theme, language, layout, the open project, the runtime picked
// per chat, ...) live here rather than in the browser's localStorage. The
// desktop app serves the UI from a new random port on every launch, and
// localStorage belongs to one origin, port included, so it came back empty each
// time the app opened.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_preferences (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const listStmt = db.prepare(`SELECT key, value FROM app_preferences`);
const upsertStmt = db.prepare(`
  INSERT INTO app_preferences (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare(`DELETE FROM app_preferences WHERE key = ?`);

// The client's own key families only, never another app's keys on the same
// origin. Composite keys join URI-encoded parts with ":".
const KEY_PATTERN = /^(ai_plan_architect_|undagi_|architech_)[A-Za-z0-9_.!~*'()%:-]{0,400}$/;
const MAX_VALUE_LENGTH = 64 * 1024;
const MAX_KEYS_PER_WRITE = 500;

export class PreferenceInputError extends Error {
  constructor(readonly code: "PREFERENCES_INVALID" | "PREFERENCE_KEY_INVALID" | "PREFERENCE_VALUE_INVALID" | "PREFERENCES_TOO_MANY") {
    super(code);
    this.name = "PreferenceInputError";
  }
}

export function listPreferences(): Record<string, string> {
  const rows = listStmt.all() as unknown as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/** `{ values: { key: string | null } }`; null removes the key. */
export function parsePreferenceWrite(body: unknown): Record<string, string | null> {
  const values = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { values?: unknown }).values
    : undefined;
  if (typeof values !== "object" || values === null || Array.isArray(values)) throw new PreferenceInputError("PREFERENCES_INVALID");
  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length > MAX_KEYS_PER_WRITE) throw new PreferenceInputError("PREFERENCES_TOO_MANY");
  for (const [key, value] of entries) {
    if (!KEY_PATTERN.test(key)) throw new PreferenceInputError("PREFERENCE_KEY_INVALID");
    if (value !== null && (typeof value !== "string" || value.length > MAX_VALUE_LENGTH)) {
      throw new PreferenceInputError("PREFERENCE_VALUE_INVALID");
    }
  }
  return values as Record<string, string | null>;
}

/** All writes of one request land together or not at all. */
export function writePreferences(values: Record<string, string | null>): void {
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) deleteStmt.run(key);
      else upsertStmt.run(key, value, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const THEME_KEY = "ai_plan_architect_theme";
const ACCENT_KEY = "ai_plan_architect_accent";

/**
 * A classic script the page loads before anything is drawn, so the saved theme
 * and accent are on <html> from the first frame. The page's own inline script
 * reads localStorage, which the desktop app loses on every launch (a new port is
 * a new origin); this one reads the same preferences the app does. A value it
 * does not know is left to that fallback, which marks nothing here.
 */
export function bootScript(values: Record<string, string>): string {
  const theme = values[THEME_KEY];
  const accent = values[ACCENT_KEY];
  const lines: string[] = ["(function(){var r=document.documentElement;"];
  if (theme === "dark" || theme === "light") {
    lines.push(`r.dataset.prefsTheme=${JSON.stringify(theme)};`);
    lines.push(theme === "dark" ? 'r.classList.add("dark");' : "");
  }
  if (typeof accent === "string" && /^[a-z]{1,16}$/.test(accent)) lines.push(`r.dataset.accent=${JSON.stringify(accent)};`);
  lines.push("})();");
  return lines.filter(Boolean).join("\n");
}
