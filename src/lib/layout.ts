import { prefs } from "./prefs";

export type LayoutMode = "agent" | "split" | "board";

const LAYOUT_KEY = "undagi_layout";
// Key lama sebelum rename. Hanya dibaca; tidak dihapus supaya versi app lama
// tetap bisa membacanya kalau user rollback.
const LEGACY_LAYOUT_KEY = "architech_layout";
const DEFAULT_RATIO = 0.42;
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;
const SPLIT_BREAKPOINT = 1100;

type StoredLayout = {
  mode?: unknown;
  ratio?: unknown;
  lastMode?: unknown;
};

function isLayoutMode(value: unknown): value is LayoutMode {
  return value === "agent" || value === "split" || value === "board";
}

function isSinglePaneMode(value: unknown): value is "agent" | "board" {
  return value === "agent" || value === "board";
}

function clampRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

function defaultMode(): LayoutMode {
  // Chat is the primary surface. Users can still opt into Split or Board;
  // new sessions should open in the focused conversation view on every size.
  return "agent";
}

// Load dan save harus melihat nilai yang sama, jadi keduanya lewat sini.
function readStoredLayout(): string | null {
  return prefs.get(LAYOUT_KEY) ?? prefs.get(LEGACY_LAYOUT_KEY);
}

export function loadLayout(): { mode: LayoutMode; ratio: number } {
  const fallback = defaultMode();

  try {
    const raw = readStoredLayout();
    if (!raw) return { mode: fallback, ratio: DEFAULT_RATIO };

    const stored = JSON.parse(raw) as StoredLayout;
    const mode = isLayoutMode(stored.mode) ? stored.mode : fallback;
    const ratio = clampRatio(stored.ratio);

    if (mode === "split" && typeof window !== "undefined" && window.innerWidth <= SPLIT_BREAKPOINT) {
      return {
        mode: isSinglePaneMode(stored.lastMode) ? stored.lastMode : "agent",
        ratio,
      };
    }

    return { mode, ratio };
  } catch (e) {
    console.warn("Failed to load layout:", e);
    return { mode: fallback, ratio: DEFAULT_RATIO };
  }
}

export function saveLayout(value: { mode: LayoutMode; ratio: number }): void {
  let lastMode: "agent" | "board" = "agent";

  try {
    const previous = readStoredLayout();

    if (previous) {
      const stored = JSON.parse(previous) as StoredLayout;
      if (isSinglePaneMode(stored.lastMode)) lastMode = stored.lastMode;
      else if (isSinglePaneMode(stored.mode)) lastMode = stored.mode;
    }
  } catch (e) {
    console.warn("Failed to read saved layout:", e);
  }

  if (isSinglePaneMode(value.mode)) lastMode = value.mode;

  try {
    prefs.set(
      LAYOUT_KEY,
      JSON.stringify({
        mode: isLayoutMode(value.mode) ? value.mode : defaultMode(),
        ratio: clampRatio(value.ratio),
        lastMode,
      }),
    );
  } catch (e) {
    console.warn("Failed to save layout:", e);
  }
}
