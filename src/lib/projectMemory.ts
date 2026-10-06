// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ProjectMemoryEntry } from "../types";

/** Enough for the facts that matter; the oldest give way to new ones. */
export const MEMORY_LIMIT = 50;

const normalized = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The project's memory with the facts a run wrote added, or null when nothing
 * is new. A fact already remembered, in any case or spacing, is not added again.
 */
export function rememberFacts(
  memory: ProjectMemoryEntry[] | undefined,
  facts: string[] | undefined,
  taskId: string,
  now: Date = new Date(),
): ProjectMemoryEntry[] | null {
  const current = memory ?? [];
  const known = new Set(current.map((entry) => normalized(entry.text)));
  const added: ProjectMemoryEntry[] = [];
  for (const fact of facts ?? []) {
    const key = normalized(fact);
    if (!key || known.has(key)) continue;
    known.add(key);
    added.push({ id: `mem-${now.getTime()}-${added.length}`, text: fact.trim(), taskId, createdAt: now.toISOString() });
  }
  if (added.length === 0) return null;
  return [...current, ...added].slice(-MEMORY_LIMIT);
}

/** The project's memory without one entry, or null when it was not there. */
export function forgetFact(memory: ProjectMemoryEntry[] | undefined, id: string): ProjectMemoryEntry[] | null {
  const current = memory ?? [];
  const next = current.filter((entry) => entry.id !== id);
  return next.length === current.length ? null : next;
}
