import type { AgentTask } from "../types";

export type TaskOutcome = "done" | "blocked";

/**
 * Closing line of the run prompt. A coding agent reads it, so it stays English
 * whatever language the interface uses. The agent has no tool to move a card,
 * so the last line of its reply is how it says "done" or "stuck".
 */
export const TASK_STATUS_INSTRUCTION =
  "Report the implementation and verification evidence. Then end your final message with one line: " +
  "`TASK_STATUS: done` if the task is complete and its verification steps passed, or " +
  "`TASK_STATUS: blocked` if you could not finish it. If blocked, say what blocked you above that line.";

// Tolerates the markdown a model likes to wrap around it: backticks, bold, a bullet.
const MARKER = /^[\s>*_`-]*task_status\s*:\s*(done|blocked)\b/i;

/** The agent's own verdict: the last marker line in its reply, if it wrote one. */
export function taskStatusMarker(text: string): TaskOutcome | null {
  let found: TaskOutcome | null = null;
  for (const line of text.split("\n")) {
    const match = MARKER.exec(line);
    if (match) found = match[1].toLowerCase() as TaskOutcome;
  }
  return found;
}

export interface RunEnd {
  /** The user pressed Stop, or the run was interrupted. Neither is a verdict on the task. */
  aborted: boolean;
  /** An error event, a failed run, a cut-off answer, or a stream that broke. */
  failed: boolean;
  /** Everything the assistant wrote during the run. */
  text: string;
}

/**
 * Where a card goes when its run ends: null leaves it where it is, so a run the
 * user stopped does not move anything. A run that finished without the marker
 * counts as done; the user sends a new task if something is missing.
 */
export function taskOutcomeFor(end: RunEnd): TaskOutcome | null {
  if (end.aborted) return null;
  if (end.failed) return "blocked";
  return taskStatusMarker(end.text) ?? "done";
}

/**
 * The task list with the outcome applied, or null when nothing should change.
 * A card the user already put in Done stays there, even if the run then failed.
 */
export function applyTaskOutcome(tasks: AgentTask[], taskId: string, outcome: TaskOutcome): AgentTask[] | null {
  const task = tasks.find((item) => item.id === taskId);
  if (!task || task.status === "done" || task.status === outcome) return null;
  return tasks.map((item) => (item.id === taskId ? { ...item, status: outcome } : item));
}
