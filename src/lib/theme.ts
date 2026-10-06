// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { prefs } from "./prefs";

export type Theme = "light" | "dark";

const THEME_KEY = "ai_plan_architect_theme";

export function loadTheme(): Theme {
  try {
    const saved = prefs.get(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch (e) {
    console.warn("Failed to load theme:", e);
  }
  // Belum pernah memilih: gelap. Aplikasi ini dipakai berjam-jam di samping
  // terminal, dan tampilan gelap itu yang dirancang lebih dulu.
  return "dark";
}

export function saveTheme(theme: Theme): void {
  try {
    prefs.set(THEME_KEY, theme);
  } catch (e) {
    console.warn("Failed to save theme:", e);
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

// Warna aksen terpisah dari terang/gelap: keduanya bisa dipadukan bebas.
// Nilainya dibaca juga oleh skrip inline di index.html sebelum React mount.
export type Accent = "teal" | "blue" | "violet" | "pink" | "moss" | "ink";
export const ACCENTS: Accent[] = ["teal", "blue", "violet", "pink", "moss", "ink"];

const ACCENT_KEY = "ai_plan_architect_accent";

export function loadAccent(): Accent {
  try {
    const saved = prefs.get(ACCENT_KEY);
    if (ACCENTS.includes(saved as Accent)) return saved as Accent;
  } catch (e) {
    console.warn("Failed to load accent:", e);
  }
  return "teal";
}

export function saveAccent(accent: Accent): void {
  try {
    prefs.set(ACCENT_KEY, accent);
  } catch (e) {
    console.warn("Failed to save accent:", e);
  }
}

export function applyAccent(accent: Accent): void {
  document.documentElement.dataset.accent = accent;
}
