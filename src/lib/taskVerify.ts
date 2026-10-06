// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RunReport } from "./runRetry";

/** How a task's verify command ended, as POST /api/tasks/verify reports it. */
export interface VerifyResult {
  command: string;
  exitCode: number;
  passed: boolean;
  /** The end of what the command printed. */
  output: string;
  durationMs: number;
}

/** Times a failed check goes back to the agent before the card is Failed. */
export const MAX_VERIFY_RETRIES = 2;
const PROMPT_OUTPUT_CHARS = 4_000;
const NOTE_OUTPUT_CHARS = 600;

const tail = (text: string, limit: number): string => {
  const trimmed = text.trim();
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
};

/** Runs the saved task's verify command in its project folder. Throws when it could not run. */
export async function runVerifyCommand(sessionId: string, taskId: string, signal?: AbortSignal): Promise<VerifyResult> {
  const res = await fetch("/api/tasks/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, taskId }),
    signal,
  });
  const body = await res.json().catch(() => ({})) as Partial<VerifyResult> & { error?: unknown };
  if (!res.ok) throw new Error(typeof body.error === "string" && body.error ? body.error : `HTTP ${res.status}`);
  return body as VerifyResult;
}

/** The follow-up sent to the task's own session. The agent reads it, so it stays English. */
export function verifyRetryPrompt(result: VerifyResult): string {
  return [
    "Undagi ran this task's verify command and it failed, so the task is not done yet.",
    `Command: ${result.command}`,
    `Exit code: ${result.exitCode}`,
    "Last output:",
    "```",
    tail(result.output, PROMPT_OUTPUT_CHARS) || "(no output)",
    "```",
    "Fix the cause without changing or weakening the check, then end with the task report.",
  ].join("\n");
}

/** The end of the output, short enough for a card note. */
export function verifyOutputForNote(result: VerifyResult): string {
  return tail(result.output, NOTE_OUTPUT_CHARS);
}

export interface VerifyLoopDeps {
  /** The card's saved verify command as it is now; empty when it has none. */
  command: () => string;
  /** Whether the command may run: true on Full access, otherwise the user's answer. */
  approve: (command: string) => Promise<boolean>;
  run: () => Promise<VerifyResult>;
  /** Sends a follow-up to the card's own session, retrying transient failures. */
  retry: (message: string) => Promise<{ report: RunReport; attempts: number }>;
  /** False once the card has left In progress or the project has changed. */
  stillWanted: () => boolean;
  movedByUser: () => boolean;
  signal: AbortSignal;
  onRunning: (command: string) => void;
  onRetrying: (failure: { exitCode: number; attempt: number; total: number }) => void;
  /** The card note when the command could not run at all, in the UI language. */
  couldNotRun: (reason: string) => string;
  /** The card note when the check still failed, in the UI language. */
  stillFailed: (result: VerifyResult) => string;
}

export interface VerifiedRun {
  report: RunReport;
  attempts: number;
  /** For a run that ends Done: whether its verify command passed. */
  verified?: boolean;
}

/**
 * After the agent says done: run the card's verify command, and on a failure
 * send its output back to the card's session, up to MAX_VERIFY_RETRIES times,
 * before the card is Failed. Without a command, or when the user declines, the
 * agent's word stands, unverified. Stop leaves the card as a stopped run.
 */
export async function verifyDone(first: { report: RunReport; attempts: number }, deps: VerifyLoopDeps): Promise<VerifiedRun> {
  let { report, attempts } = first;
  const stopped = (): VerifiedRun => ({ report: { ...report, outcome: null }, attempts });
  for (let round = 0; ; round += 1) {
    if (report.outcome !== "done" || deps.movedByUser()) return { report, attempts };
    const command = deps.command().trim();
    if (!command) return { report, attempts, verified: false };
    const approved = await deps.approve(command);
    if (deps.signal.aborted) return stopped();
    if (!approved) return { report, attempts, verified: false };
    deps.onRunning(command);
    let result: VerifyResult;
    try {
      result = await deps.run();
    } catch (error) {
      if (deps.signal.aborted) return stopped();
      const reason = error instanceof Error ? error.message : String(error);
      return { report: { ...report, outcome: "failed", error: deps.couldNotRun(reason) }, attempts };
    }
    if (result.passed) return { report, attempts, verified: true };
    if (round >= MAX_VERIFY_RETRIES || !deps.stillWanted()) {
      return { report: { ...report, outcome: "failed", error: deps.stillFailed(result) }, attempts };
    }
    deps.onRetrying({ exitCode: result.exitCode, attempt: round + 1, total: MAX_VERIFY_RETRIES });
    const next = await deps.retry(verifyRetryPrompt(result));
    report = next.report;
    attempts += next.attempts;
  }
}
