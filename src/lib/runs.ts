// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface Run {
  id: string;
  conversationId: string | null;
  taskId: string | null;
  status: RunStatus;
  snapshot?: {
    runtime?: string;
    connectionId?: string | null;
    requestedModel?: string;
    effectiveModel?: string | null;
    requestedEffort?: string;
    effectiveEffort?: string | null;
    workspace?: string | null;
  };
  result?: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface RunEvidence {
  id: string;
  runId: string;
  kind: "diff" | "command" | "verification" | "artifact" | "summary";
  summary: string | null;
  payload: unknown;
  command: string | null;
  exitCode: number | null;
  createdAt: string;
}

export interface TaskRunReview {
  runs: Run[];
  evidenceByRunId: Record<string, RunEvidence[]>;
  evidenceErrors: Record<string, string>;
}

async function readError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return new Error(body.error);
  } catch {
    // Keep the stable fallback for non-JSON and unavailable responses.
  }
  return new Error(fallback);
}

export async function fetchRunsForTask(taskId: string, signal?: AbortSignal): Promise<Run[]> {
  const response = await fetch(`/api/runs?taskId=${encodeURIComponent(taskId)}`, { signal });
  if (!response.ok) throw await readError(response, "Could not load run history for this task.");
  const body = await response.json() as { runs?: unknown };
  if (!Array.isArray(body.runs)) throw new Error("Run history returned an invalid response.");
  return body.runs as Run[];
}

export async function fetchRunEvidence(runId: string, signal?: AbortSignal): Promise<RunEvidence[]> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/evidence`, { signal });
  if (!response.ok) throw await readError(response, "Could not load evidence for this run.");
  const body = await response.json() as { evidence?: unknown };
  if (!Array.isArray(body.evidence)) throw new Error("Run evidence returned an invalid response.");
  return body.evidence as RunEvidence[];
}

/** Load the run list even when one evidence endpoint is temporarily unavailable. */
export async function fetchTaskRunReview(taskId: string, signal?: AbortSignal): Promise<TaskRunReview> {
  const runs = await fetchRunsForTask(taskId, signal);
  const evidenceByRunId: Record<string, RunEvidence[]> = {};
  const evidenceErrors: Record<string, string> = {};
  const results = await Promise.allSettled(runs.map(async (run) => [run.id, await fetchRunEvidence(run.id, signal)] as const));

  results.forEach((result, index) => {
    const run = runs[index];
    if (!run) return;
    if (result.status === "fulfilled") evidenceByRunId[run.id] = result.value[1];
    else if (result.reason?.name !== "AbortError") {
      evidenceErrors[run.id] = result.reason instanceof Error ? result.reason.message : "Could not load evidence for this run.";
    }
  });

  return { runs, evidenceByRunId, evidenceErrors };
}

// Readable aliases for consumers that treat this module as the runs API client.
export const getRunsForTask = fetchRunsForTask;
export const getRunEvidence = fetchRunEvidence;
