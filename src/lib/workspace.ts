// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export function projectNameFromWorkspaceRoot(root: string): string {
  const normalized = root.trim().replace(/[\\/]+$/, "");
  if (!normalized) return "";
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  const name = segments.at(-1) ?? "";
  return /^[A-Za-z]:$/.test(name) ? name.slice(0, 1) : name;
}
