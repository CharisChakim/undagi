// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComplexityLevel } from "../types";

// Label Inggris = kunci kamus i18n; terjemahan dilakukan lewat t() saat tampil.
const LABEL_KEYS: Record<ComplexityLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  very_high: "Very high",
};

// Map (bukan objek biasa) agar "constructor"/"__proto__" tidak ikut terbaca sebagai kunci.
const ALIASES = new Map<string, ComplexityLevel>([
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["very_high", "very_high"],
  // Nilai Indonesia yang tersimpan di sesi lama.
  ["rendah", "low"],
  ["sedang", "medium"],
  ["tinggi", "high"],
  ["sangat_tinggi", "very_high"],
]);

// Tidak pernah melempar. Kosong/hilang → "low" (default lama 'Rendah');
// nilai ada tapi tak dikenali → "medium" (tengah, bukan klaim ekstrem).
export function normalizeComplexity(value: unknown): ComplexityLevel {
  if (value == null) return "low";
  if (typeof value !== "string") return "medium";
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, "_");
  if (!key) return "low";
  return ALIASES.get(key) ?? "medium";
}

export function complexityLabelKey(level: ComplexityLevel): string {
  return LABEL_KEYS[level];
}
