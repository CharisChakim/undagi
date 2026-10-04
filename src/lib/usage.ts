import { useCallback, useEffect, useRef, useState } from "react";

export interface UsageWindow {
  id: string;
  /** Name to show in place of one made from the window length. */
  label?: string;
  windowMinutes: number | null;
  usedPercent: number;
  resetsAt: string | null;
}

export interface RuntimeUsage {
  runtime: string;
  label: string;
  plan: string | null;
  windows: UsageWindow[];
  /** Set when the runtime is connected but its usage could not be read. */
  error: string | null;
  /** The latest read failed; these windows are from the one at `readAt`. */
  stale?: boolean;
  readAt?: string;
}

export interface RuntimeUsageReport {
  fetchedAt: string;
  entries: RuntimeUsage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) return null;
  return {
    id: value.id,
    ...(typeof value.label === "string" && value.label ? { label: value.label } : {}),
    windowMinutes: typeof value.windowMinutes === "number" && value.windowMinutes > 0 ? value.windowMinutes : null,
    usedPercent: Math.min(100, Math.max(0, value.usedPercent)),
    resetsAt: typeof value.resetsAt === "string" ? value.resetsAt : null,
  };
}

function usageEntry(value: unknown): RuntimeUsage | null {
  if (!isRecord(value) || typeof value.runtime !== "string" || !value.runtime) return null;
  return {
    runtime: value.runtime,
    label: typeof value.label === "string" && value.label ? value.label : value.runtime,
    plan: typeof value.plan === "string" && value.plan ? value.plan : null,
    windows: Array.isArray(value.windows) ? value.windows.flatMap((item) => usageWindow(item) ?? []) : [],
    error: typeof value.error === "string" && value.error ? value.error : null,
    ...(value.stale === true ? { stale: true } : {}),
    ...(typeof value.readAt === "string" ? { readAt: value.readAt } : {}),
  };
}

export function parseUsageReport(value: unknown): RuntimeUsageReport {
  if (!isRecord(value)) throw new Error("Invalid usage response.");
  return {
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : new Date().toISOString(),
    entries: Array.isArray(value.entries) ? value.entries.flatMap((item) => usageEntry(item) ?? []) : [],
  };
}

async function requestUsage(method: "GET" | "POST"): Promise<RuntimeUsageReport> {
  const response = await fetch("/api/runtimes/usage", { method });
  if (!response.ok) throw new Error("Failed to read usage.");
  return parseUsageReport(await response.json());
}

export function remainingPercent(window: Pick<UsageWindow, "usedPercent">): number {
  return Math.min(100, Math.max(0, Math.round(100 - window.usedPercent)));
}

/** Whole days, hours or minutes left until `iso`; two units at most, null when it is past or unreadable. */
export function timeUntil(iso: string | null, now: number): { days: number; hours: number; minutes: number } | null {
  const target = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(target) || target <= now) return null;
  const totalMinutes = Math.max(1, Math.round((target - now) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return days > 0 ? { days, hours, minutes: 0 } : { days: 0, hours, minutes: hours > 0 ? 0 : minutes };
}

// Usage moves slowly and each read starts the runtime's CLI, so a few minutes is
// as often as the sidebar asks. The server also reuses an answer for a minute.
// A failed or old row is asked about again soon: a read that times out, often
// the first one after the app starts, usually works the next time.
const POLL_MS = 3 * 60_000;
const RETRY_MS = 30_000;

/** How long to wait before reading again after `report`; no report yet counts as a failure. */
export function nextPollDelay(report: RuntimeUsageReport | null): number {
  return !report || report.entries.some((entry) => entry.error !== null || entry.stale) ? RETRY_MS : POLL_MS;
}

/** Usage of the connected runtimes, kept up to date while the page is visible. */
export function useRuntimeUsage(): { report: RuntimeUsageReport | null; refreshing: boolean; refresh: () => Promise<void> } {
  const [report, setReport] = useState<RuntimeUsageReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Counts finished reads, failed ones too, so each one schedules the next.
  const [reads, setReads] = useState(0);
  const mounted = useRef(true);

  const load = useCallback(async (method: "GET" | "POST") => {
    setRefreshing(true);
    try {
      const next = await requestUsage(method);
      if (mounted.current) setReport(next);
    } catch {
      // Keep what is shown; the next poll tries again.
    } finally {
      if (mounted.current) {
        setRefreshing(false);
        setReads((count) => count + 1);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load("GET");
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // A hidden page skips the read but keeps the schedule going.
  useEffect(() => {
    if (reads === 0) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible") void load("GET");
      else setReads((count) => count + 1);
    }, nextPollDelay(report));
    return () => window.clearTimeout(timer);
  }, [reads, report, load]);

  const refresh = useCallback(() => load("POST"), [load]);
  return { report, refreshing, refresh };
}
