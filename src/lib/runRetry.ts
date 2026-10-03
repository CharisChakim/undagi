import type { TaskOutcome } from "./taskOutcome";

/** How a run ended, for the task card it was started from. */
export interface RunReport {
  /** Where the card goes; null when the user stopped the run. */
  outcome: TaskOutcome | null;
  /** The agent's closing note (empty when it wrote none). */
  note: string;
  /** Why the run failed; null when it did not. */
  error: string | null;
  /** The runtime's own code for that failure, when it sent one. */
  errorCode: string | null;
  /** Facts the agent left for later tasks on MEMORY lines. */
  memory?: string[];
  /** A chat turn whose agent asked Undagi to run the board (src/lib/boardRun.ts). */
  runBoard?: boolean;
}

/** Retries after the first attempt, so a card gets at most MAX_RETRIES + 1 tries. */
export const MAX_RETRIES = 3;

// The Claude and Antigravity executors sort their failures into codes of their
// own, so their words are not guessed at. Of those, only a provider that is
// overloaded or a crashed process is worth another try; a login, a billing
// problem, a usage limit that needs time to reset or a missing model fail the
// same way on every attempt.
const TRANSIENT_CODES = new Set(["CLAUDE_UNAVAILABLE", "AGY_PROCESS_ERROR"]);
const CLASSIFIED_CODE = /^(CLAUDE|AGY)_/;
// The catch-alls say nothing about the cause, so the words still decide.
const NO_VERDICT_CODES = new Set(["CLAUDE_RESULT_ERROR", "CLAUDE_RESULT_MISSING"]);

// A turn timeout is deliberately not here: it has already cost the whole turn
// limit, usually because an approval sat unanswered, and the next try would too.
const TURN_TIMEOUT = /TURN_TIMEOUT|turn timed out/i;
const STATUS = "(?:429|500|502|503|504|529)";
const TRANSIENT = new RegExp([
  // A number counts where an HTTP status stands: after "status", "HTTP" or "code",
  // in parentheses, or before its reason phrase. A bare one ("file.ts:500",
  // "at most 500 items") says nothing about the provider.
  `\\b(?:status(?:\\s*code)?|http(?:/[\\d.]+)?|code)\\W{0,3}${STATUS}\\b`,
  `\\(${STATUS}\\)`,
  `\\b${STATUS} (?:too many requests|internal server error|bad gateway|service unavailable|gateway time-?out)\\b`,
  "overloaded",
  "rate.?limit",
  "temporarily unavailable",
  "failed to fetch",
  "fetch failed",
  "network ?error",
  "socket hang up",
  // Node's fetch says just this when the connection drops ("TypeError: terminated").
  // A process or command that was terminated is not a hiccup of the provider.
  "(?:^|:\\s*)terminated\\b",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
].join("|"), "i");

/**
 * Whether a failed run is worth trying again: the provider or the network
 * hiccuped. A rejected request, a missing login, a runtime that is not ready, or
 * a declined approval fail the same way every time, so those go straight to Failed.
 * A runtime's code decides when it has one the executors classify; otherwise the
 * words do (Legacy API and Codex send text, with a status in it).
 */
export function isTransientRunError(message: string, code?: string | null): boolean {
  if (code && TRANSIENT_CODES.has(code)) return true;
  if (code && CLASSIFIED_CODE.test(code) && !NO_VERDICT_CODES.has(code)) return false;
  return !TURN_TIMEOUT.test(message) && TRANSIENT.test(message);
}

/** A provider error often arrives as `CODE: {json}`; keep the code and the sentence inside. */
export function readableRunError(raw: string): string {
  const text = raw.trim();
  const start = text.indexOf("{");
  if (start < 0) return text;
  try {
    const body = JSON.parse(text.slice(start)) as { error?: { message?: unknown }; message?: unknown };
    const inner = body?.error?.message ?? body?.message;
    if (typeof inner !== "string" || !inner.trim()) return text;
    const prefix = text.slice(0, start).replace(/[:\s]+$/, "");
    return prefix ? `${prefix}: ${inner.trim()}` : inner.trim();
  } catch {
    return text;
  }
}

/** Pause before retry number `attempt` (1-based): short, and longer each time. */
export function retryDelayMs(attempt: number): number {
  return 3000 * attempt;
}

/** The follow-up message for a retry. The agent reads it, so it stays English. */
export function retryContinuationPrompt(error: string): string {
  return [
    `The previous attempt stopped with an error: ${error}`,
    "Whatever it already changed is still in the folder. Check the current state, continue the task from there, and end with the task report.",
  ].join("\n");
}

export interface RetryNotice {
  /** The attempt that just failed, starting at 1. */
  attempt: number;
  /** Attempts in all, the first one included. */
  total: number;
  error: string;
  delayMs: number;
}

export interface RetryOptions {
  /** The message of the first attempt. */
  message: string;
  /** Run one attempt to its end. */
  send: (message: string) => Promise<RunReport>;
  /** False once the card has left In progress or the project has changed: nothing is retried then. */
  stillWanted: () => boolean;
  /** Called before each retry, so the user hears about it. */
  onRetry: (notice: RetryNotice) => void;
  /** Aborted when the user presses Stop: a pause ends at once and nothing more is sent. */
  signal?: AbortSignal;
  /** The pause before a retry; it ends early once `signal` aborts. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxRetries?: number;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const finish = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener("abort", finish, { once: true });
});

/**
 * Runs a task, trying again after a transient failure. A run the agent itself
 * called blocked, or the user stopped, is never retried.
 */
export async function runWithRetries(options: RetryOptions): Promise<{ report: RunReport; attempts: number }> {
  const { send, stillWanted, onRetry, signal, wait = sleep, maxRetries = MAX_RETRIES } = options;
  const wanted = (): boolean => !signal?.aborted && stillWanted();
  let message = options.message;
  for (let attempt = 1; ; attempt += 1) {
    const report = await send(message);
    const error = report.outcome === "failed" ? report.error : null;
    if (!error || !isTransientRunError(error, report.errorCode) || attempt > maxRetries || !wanted()) {
      return { report, attempts: attempt };
    }
    const delayMs = retryDelayMs(attempt);
    onRetry({ attempt, total: maxRetries + 1, error, delayMs });
    await wait(delayMs, signal);
    // Stopped during the pause: the last failure is how the run ended.
    if (!wanted()) return { report, attempts: attempt };
    message = retryContinuationPrompt(error);
  }
}
