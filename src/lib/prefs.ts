// App preferences (theme, language, layout, the open project, the runtime picked
// per chat, ...) are kept in SQLite through /api/preferences. The desktop app
// serves the UI from a new random port on every launch and localStorage belongs
// to one origin, port included, so on its own it came back empty each time.
//
// Reads stay synchronous: they come from a cache the app fills before its first
// render. Until then, or when the server cannot be reached (and in tests), they
// fall back to localStorage, which also keeps a copy of every write.

// Only the app's own key families; another app on the same origin keeps its keys.
const APP_KEY = /^(ai_plan_architect_|undagi_|architech_)/;
// Kept in localStorage only: a draft changes on every keystroke, and the legacy
// LLM config can hold an API key and is being moved into connections.
const LOCAL_ONLY = [/^ai_plan_architect_draft_v1/, /^ai_plan_architect_llm_config/];
// Set once this browser's existing localStorage has been copied to the server.
const IMPORTED_KEY = "undagi_prefs_imported_v1";

const HYDRATE_TIMEOUT_MS = 3_000;
const FLUSH_DELAY_MS = 150;
// A keepalive request may carry at most 64 KB; a larger batch is sent normally.
const KEEPALIVE_LIMIT = 60_000;

let cache: Map<string, string> | null = null;
let pending = new Map<string, string | null>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let writes: Promise<void> = Promise.resolve();
let send: typeof fetch = (input, init) => fetch(input, init);

function local(): Storage | null {
  try {
    const host = globalThis as { window?: { localStorage?: Storage }; localStorage?: Storage };
    return host.window?.localStorage ?? host.localStorage ?? null;
  } catch {
    return null;
  }
}

function localGet(key: string): string | null {
  try {
    return local()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function localSet(key: string, value: string | null): void {
  try {
    if (value === null) local()?.removeItem(key);
    else local()?.setItem(key, value);
  } catch {
    // The server copy, when there is one, is the one that counts.
  }
}

function syncs(key: string): boolean {
  return APP_KEY.test(key) && !LOCAL_ONLY.some((pattern) => pattern.test(key));
}

function queue(key: string, value: string | null): void {
  pending.set(key, value);
  if (flushTimer === undefined) flushTimer = setTimeout(() => void flushPrefs(), FLUSH_DELAY_MS);
}

/** Send every queued write now, after the ones already on their way. */
export function flushPrefs(): Promise<void> {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  if (pending.size === 0) return writes;
  const body = JSON.stringify({ values: Object.fromEntries(pending) });
  pending = new Map();
  writes = writes
    .then(() => send("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: body.length < KEEPALIVE_LIMIT,
    }))
    // A lost write keeps the localStorage copy; the next change sends the key again.
    .then(() => undefined, () => undefined);
  return writes;
}

export const prefs = {
  get(key: string): string | null {
    return cache && syncs(key) ? cache.get(key) ?? null : localGet(key);
  },
  set(key: string, value: string): void {
    localSet(key, value);
    if (cache && syncs(key)) {
      cache.set(key, value);
      queue(key, value);
    }
  },
  remove(key: string): void {
    localSet(key, null);
    if (cache && syncs(key)) {
      cache.delete(key);
      queue(key, null);
    }
  },
};

/**
 * Load the stored preferences before the app renders. The first time a server
 * has none from this browser, its existing localStorage values are copied over
 * (a value the server already has wins). Without a server it does nothing and
 * reads keep using localStorage.
 */
export async function hydratePrefs(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<void> {
  send = fetchImpl;
  cache = null;
  pending = new Map();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HYDRATE_TIMEOUT_MS);
  let stored: Record<string, unknown>;
  try {
    const response = await fetchImpl("/api/preferences", { signal: controller.signal });
    if (!response.ok) return;
    const body = await response.json() as { values?: unknown };
    stored = typeof body.values === "object" && body.values !== null ? body.values as Record<string, unknown> : {};
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }

  const next = new Map<string, string>();
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value === "string" && syncs(key)) next.set(key, value);
  }
  const imports = new Map<string, string>();
  if (!next.has(IMPORTED_KEY)) {
    const storage = local();
    const keys: string[] = [];
    try {
      for (let index = 0; index < (storage?.length ?? 0); index += 1) {
        const key = storage!.key(index);
        if (key) keys.push(key);
      }
    } catch {
      // Nothing to import from a storage that cannot be read.
    }
    for (const key of keys) {
      const value = localGet(key);
      if (value !== null && syncs(key) && !next.has(key)) imports.set(key, value);
    }
    imports.set(IMPORTED_KEY, new Date().toISOString());
  }
  for (const [key, value] of imports) next.set(key, value);
  cache = next;
  // localStorage mirrors the server, so a later load that cannot reach it still
  // starts from the same preferences.
  for (const [key, value] of next) localSet(key, value);
  for (const [key, value] of imports) queue(key, value);
  if (imports.size > 0) await flushPrefs();

  const host = globalThis as { window?: Window };
  host.window?.addEventListener?.("pagehide", () => void flushPrefs());
}
