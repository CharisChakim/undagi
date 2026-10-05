import { prefs as store } from "./prefs";

// Which usage rows the sidebar shows and in what order. Ids are the runtime
// ids the server reports, kept as plain strings so a runtime added later needs
// no change here. A runtime the user never arranged follows the arranged ones.

const USAGE_PREFS_KEY = "undagi_usage_prefs";

export interface UsagePrefs {
  /** Runtime ids in the order the user arranged them. */
  order: string[];
  /** Runtime ids the user chose not to show. */
  hidden: string[];
}

export const DEFAULT_USAGE_PREFS: UsagePrefs = { order: [], hidden: [] };

function ids(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
}

export function loadUsagePrefs(): UsagePrefs {
  try {
    const raw = store.get(USAGE_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      return { order: ids(parsed?.order), hidden: ids(parsed?.hidden) };
    }
  } catch (e) {
    console.warn("Failed to load usage preferences:", e);
  }
  return DEFAULT_USAGE_PREFS;
}

export function saveUsagePrefs(prefs: UsagePrefs): void {
  try {
    store.set(USAGE_PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn("Failed to save usage preferences:", e);
  }
}

/** Every item in the user's order; items the order does not name keep their own order, after it. */
export function orderUsage<T extends { runtime: string }>(items: T[], prefs: UsagePrefs): T[] {
  const rank = new Map(prefs.order.map((id, index) => [id, index]));
  const known = items.filter((item) => rank.has(item.runtime)).sort((a, b) => rank.get(a.runtime)! - rank.get(b.runtime)!);
  return [...known, ...items.filter((item) => !rank.has(item.runtime))];
}

export function visibleUsage<T extends { runtime: string }>(items: T[], prefs: UsagePrefs): T[] {
  return orderUsage(items, prefs).filter((item) => !prefs.hidden.includes(item.runtime));
}

/** Move one row up or down among `current` (the ids as they are shown now). */
export function moveUsage(prefs: UsagePrefs, current: string[], id: string, direction: -1 | 1): UsagePrefs {
  const from = current.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= current.length) return prefs;
  const order = [...current];
  [order[from], order[to]] = [order[to], order[from]];
  return { ...prefs, order };
}

export function toggleUsageHidden(prefs: UsagePrefs, id: string): UsagePrefs {
  return {
    ...prefs,
    hidden: prefs.hidden.includes(id) ? prefs.hidden.filter((item) => item !== id) : [...prefs.hidden, id],
  };
}
