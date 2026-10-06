// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * A draft belongs to a stable session or conversation identity, never to a
 * project title. The conversation field is optional so standalone chat can
 * use the same store when it gets its own identity.
 */
export interface DraftScope {
  sessionId?: string;
  conversationId?: string;
  name: string;
}

const DRAFT_STORAGE_PREFIX = "ai_plan_architect_draft_v1";

export function draftStorageKey(scope: DraftScope): string {
  return [scope.sessionId || "", scope.conversationId || "", scope.name]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function storageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function keyFor(scope: DraftScope): string {
  return `${DRAFT_STORAGE_PREFIX}:${draftStorageKey(scope)}`;
}

export function loadDraft<T>(scope: DraftScope, fallback: T): T {
  if (!storageAvailable()) return fallback;

  try {
    const raw = window.localStorage.getItem(keyFor(scope));
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

// Two components can hold the same draft: the home composer hands over to
// the chat composer as the first message is sent. Each change is announced
// so the other copy does not keep showing text that was already sent.
const DRAFT_CHANGE_EVENT = "undagi:draft-change";

interface DraftChange {
  key: string;
  present: boolean;
  value?: unknown;
  source?: unknown;
}

function announce(change: DraftChange): void {
  window.dispatchEvent(new CustomEvent<DraftChange>(DRAFT_CHANGE_EVENT, { detail: change }));
}

export function saveDraft<T>(scope: DraftScope, value: T, source?: unknown): void {
  if (!storageAvailable()) return;

  try {
    window.localStorage.setItem(keyFor(scope), JSON.stringify(value));
    announce({ key: keyFor(scope), present: true, value, source });
  } catch {
    // Draft persistence is best effort. Quota/private mode failures must not
    // interrupt typing or generation.
  }
}

export function clearDraft(scope: DraftScope, source?: unknown): void {
  if (!storageAvailable()) return;

  try {
    window.localStorage.removeItem(keyFor(scope));
    announce({ key: keyFor(scope), present: false, source });
  } catch {
    // See saveDraft: local storage availability must not affect the UI.
  }
}

/**
 * React state backed by localStorage. The setter writes synchronously so a
 * route/layout change immediately after typing cannot lose the latest value.
 */
export function useDraft<T>(
  scope: DraftScope,
  fallback: T,
): [T, Dispatch<SetStateAction<T>>, (resetTo?: T) => void] {
  const storageKey = draftStorageKey(scope);
  const fallbackRef = useRef(fallback);
  const [value, setValue] = useState<T>(() => loadDraft(scope, fallback));
  const valueRef = useRef(value);
  const activeKeyRef = useRef(storageKey);
  const instance = useRef({});

  useEffect(() => {
    if (activeKeyRef.current === storageKey) return;
    activeKeyRef.current = storageKey;
    fallbackRef.current = fallback;
    const restored = loadDraft(scope, fallback);
    valueRef.current = restored;
    setValue(restored);
  }, [fallback, scope, storageKey]);

  useEffect(() => {
    const onChange = (event: Event) => {
      const change = (event as CustomEvent<DraftChange>).detail;
      if (change.source === instance.current || change.key !== `${DRAFT_STORAGE_PREFIX}:${storageKey}`) return;
      const next = change.present ? change.value as T : fallbackRef.current;
      if (Object.is(valueRef.current, next)) return;
      valueRef.current = next;
      setValue(next);
    };
    window.addEventListener(DRAFT_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(DRAFT_CHANGE_EVENT, onChange);
  }, [storageKey]);

  const update = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    const nextValue = typeof next === "function"
      ? (next as (previous: T) => T)(valueRef.current)
      : next;
    valueRef.current = nextValue;
    setValue(nextValue);
    saveDraft(scope, nextValue, instance.current);
  }, [scope, storageKey]);

  const clear = useCallback((resetTo?: T) => {
    clearDraft(scope, instance.current);
    if (resetTo === undefined) return;
    valueRef.current = resetTo;
    setValue(resetTo);
  }, [scope, storageKey]);

  return [value, update, clear];
}
