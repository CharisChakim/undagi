import type { AgentTask } from "../types";

/**
 * Where a card goes when its run ends. Blocked is the agent's own verdict: it needs
 * something a person has to supply. Failed is the run breaking: an error, a timeout,
 * or a stream that stopped. They need different things from the user, so they are kept apart.
 */
export type TaskOutcome = "done" | "blocked" | "failed";

/** What the agent can say itself in its closing line. */
export type AgentVerdict = "done" | "blocked";

// The agent has no tool to move a card, so the last line of its reply is how it
// says "done" or "stuck". server/agent/harness.ts asks for it; keep them in sync.
// Tolerates the markdown a model likes to wrap around it: backticks, bold, a bullet.
const MARKER = /^[\s>*_`-]*task_status\s*:\s*(done|blocked)\b/i;

/** The agent's own verdict: the last marker line in its reply, if it wrote one. */
export function taskStatusMarker(text: string): AgentVerdict | null {
  let found: AgentVerdict | null = null;
  for (const line of text.split("\n")) {
    const match = MARKER.exec(line);
    if (match) found = match[1].toLowerCase() as AgentVerdict;
  }
  return found;
}

const NOTE_LIMIT = 2000;

// A fact the agent wants later tasks in this project to know, one per line.
// server/agent/harness.ts asks for it; keep them in sync.
const MEMORY = /^[\s>*_`-]*memory[*_`]*\s*:[\s*_`]*(.*?)[\s*_]*$/i;
const FACT_LIMIT = 300;

/** The facts the agent wrote on MEMORY lines, each once. */
export function memoryFactsFrom(text: string): string[] {
  const facts = new Set<string>();
  for (const line of text.split("\n")) {
    let fact = MEMORY.exec(line)?.[1]?.trim() ?? "";
    // A line wrapped in backticks leaves its closing one; code inside the fact keeps its pair.
    if (fact.endsWith("`") && (fact.match(/`/g)?.length ?? 0) % 2 === 1) fact = fact.slice(0, -1).trimEnd();
    if (fact) facts.add(fact.length > FACT_LIMIT ? `${fact.slice(0, FACT_LIMIT).trimEnd()}…` : fact);
  }
  return [...facts];
}

/** The agent's closing words for the card: its final message without the marker and MEMORY lines. */
export function agentNoteFrom(text: string): string {
  const note = text
    .split("\n")
    .filter((line) => !MARKER.test(line) && !MEMORY.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return note.length > NOTE_LIMIT ? `${note.slice(0, NOTE_LIMIT).trimEnd()}…` : note;
}

export interface RunEnd {
  /** The user pressed Stop, or the run was interrupted. Neither is a verdict on the task. */
  aborted: boolean;
  /** An error event, a failed run, a cut-off answer, or a stream that broke. */
  failed: boolean;
  /**
   * The assistant's final message: its words after the last tool call. The marker
   * counts only there, so a model that repeats the instruction while it works
   * ("- `TASK_STATUS: blocked` if I cannot finish") does not decide the card.
   */
  text: string;
}

/**
 * Whether the run failed, once its done event has arrived. A run that ends with a
 * status settles it: an error event before it can be a warning the run recovered
 * from (Codex sends non-fatal ones), and that run still finished its work. Without
 * a status (the Legacy API route sends none), what the stream showed so far stands.
 * An answer cut off at the token limit is a failure either way.
 */
export function runFailedAtDone(failedSoFar: boolean, done: { runStatus?: unknown; stop?: unknown }): boolean {
  const failed = typeof done.runStatus === "string" ? done.runStatus === "failed" : failedSoFar;
  return failed || done.stop === "max_tokens";
}

/**
 * Where a card goes when its run ends: null leaves it where it is, so a run the
 * user stopped does not move anything. A run that finished without the marker
 * counts as done; the user sends a new task if something is missing.
 */
export function taskOutcomeFor(end: RunEnd): TaskOutcome | null {
  if (end.aborted) return null;
  if (end.failed) return "failed";
  return taskStatusMarker(end.text) ?? "done";
}

/**
 * The task list with the outcome and the agent's note applied, or null when
 * nothing should change. A card the user already put in Done stays there, even
 * if the run then failed. The note replaces the last run's, empty or not.
 * `verified` says, for Done only, whether a verify command passed.
 */
export function applyTaskOutcome(tasks: AgentTask[], taskId: string, outcome: TaskOutcome, note = "", verified?: boolean): AgentTask[] | null {
  const task = tasks.find((item) => item.id === taskId);
  const agentNote = note.trim() || undefined;
  const check = outcome === "done" ? verified : undefined;
  if (!task || task.status === "done") return null;
  if (task.status === outcome && task.agentNote === agentNote && task.verified === check) return null;
  return tasks.map((item) => (item.id === taskId ? { ...item, status: outcome, agentNote, runStopped: undefined, verified: check } : item));
}

/**
 * The task list with the card marked as stopped, or null when nothing should
 * change. A stopped run moves nothing, so without the mark an In progress card
 * looks like one still being worked on. A card the user moved out of In
 * progress during the run already says where it stands.
 */
export function markTaskStopped(tasks: AgentTask[], taskId: string): AgentTask[] | null {
  const task = tasks.find((item) => item.id === taskId);
  if (!task || task.status !== "in_progress" || task.runStopped) return null;
  return tasks.map((item) => (item.id === taskId ? { ...item, runStopped: true } : item));
}
