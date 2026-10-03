import type { AgentTask } from "../types";
import { openDependencies } from "./taskDependencies";

// The chat's agent ends its reply with this line to have Undagi run the board.
// server/agent/taskBoard.ts asks for it; keep them in sync. Tolerates the
// markdown a model likes to wrap around a line: backticks, bold, a bullet.
const RUN_BOARD = /^[\s>*_`-]*run_board[\s*_`.]*$/i;

/** Whether the agent's final message asks for a board run. */
export function runBoardRequested(text: string): boolean {
  return text.split("\n").some((line) => RUN_BOARD.test(line));
}

const phaseOf = (task: Pick<AgentTask, "phase">): string => task.phase ?? "";

/**
 * The phase a board run works through: that of the first card, in board order,
 * that is not done. A run does one phase and stops, so the user checks it before
 * the next one starts. Null when every card is done.
 */
export function currentPhase(tasks: AgentTask[], finished: ReadonlySet<string> = new Set()): string | null {
  const open = tasks.find((task) => task.status !== "done" && !finished.has(task.id));
  return open ? phaseOf(open) : null;
}

/** A phase as a button names it: "Phase 1" from "Phase 1: Setup & Database". */
export function shortPhase(phase: string): string {
  const head = phase.split(":")[0].trim();
  return head.length > 40 ? `${head.slice(0, 40).trimEnd()}…` : head;
}

/**
 * The next card a board run takes: the first To do card of `phase`, in board
 * order, whose dependencies are done. `finished` holds the cards this board run
 * completed, which the session may not show yet; `tried` holds every card it started.
 */
export function nextBoardTask(
  tasks: AgentTask[],
  phase: string,
  finished: ReadonlySet<string> = new Set(),
  tried: ReadonlySet<string> = new Set(),
): AgentTask | null {
  const board = tasks.map((task) => (finished.has(task.id) ? { ...task, status: "done" as const } : task));
  return board.find((task) => (
    phaseOf(task) === phase && task.status === "todo" && !tried.has(task.id) && openDependencies(task, board).length === 0
  )) ?? null;
}

type TaskStates = Array<Pick<AgentTask, "id" | "status">>;

const loadServerTasks = async (sessionId: string): Promise<TaskStates> => {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const stored = await res.json();
  return Array.isArray(stored?.tasks) ? stored.tasks : [];
};

export interface SavedWaitOptions {
  load?: (sessionId: string) => Promise<TaskStates>;
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Waits until the server's copy of the project shows the card's dependencies
 * done. The board moves a card in the client and saves the project a moment
 * later; the server refuses a card whose dependencies it still sees open, so the
 * card after one that just finished would fail without this. False on timeout
 * or Stop; the server then gives its own reason.
 */
export async function dependenciesSaved(
  sessionId: string,
  task: Pick<AgentTask, "dependencies">,
  { load = loadServerTasks, timeoutMs = 10_000, intervalMs = 250, signal }: SavedWaitOptions = {},
): Promise<boolean> {
  if (!task.dependencies?.length) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return false;
    try {
      if (openDependencies(task, await load(sessionId)).length === 0) return true;
    } catch {
      // The next look may get through; the deadline still holds.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A board run in flight (`end` null), or how the last one ended. */
export interface BoardRunState {
  running: boolean;
  /** The phase the run works through. */
  phase?: string;
  end: BoardRunEnd | null;
}

/** Why a board run ended, for the line under its button. */
export type BoardRunEnd =
  | { kind: "all_done" }
  | { kind: "phase_done"; phase: string }
  | { kind: "waiting"; remaining: number }
  | { kind: "nothing_to_run" }
  | { kind: "stopped" }
  | { kind: "card_ended"; taskId: string; outcome: "blocked" | "failed" }
  | { kind: "moved_by_hand"; taskId: string };

/**
 * Why `phase` has no next card: it is done (and maybe the whole board), its To
 * do cards left wait on cards that are not, or none of its cards is To do (the
 * rest are blocked, failed or in progress).
 */
export function idleBoardEnd(tasks: AgentTask[], phase: string, finished: ReadonlySet<string> = new Set()): BoardRunEnd {
  const open = tasks.filter((task) => phaseOf(task) === phase && task.status !== "done" && !finished.has(task.id));
  const remaining = open.filter((task) => task.status === "todo").length;
  if (remaining > 0) return { kind: "waiting", remaining };
  if (open.length > 0) return { kind: "nothing_to_run" };
  return currentPhase(tasks, finished) === null ? { kind: "all_done" } : { kind: "phase_done", phase };
}
