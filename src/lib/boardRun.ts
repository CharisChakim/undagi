import type { AgentTask } from "../types";
import { openDependencies } from "./taskDependencies";

/**
 * The next card a board run takes: the first To do card, in board order, whose
 * dependencies are done. `finished` holds the cards this board run completed,
 * which the session may not show yet; `tried` holds every card it started.
 */
export function nextBoardTask(
  tasks: AgentTask[],
  finished: ReadonlySet<string> = new Set(),
  tried: ReadonlySet<string> = new Set(),
): AgentTask | null {
  const board = tasks.map((task) => (finished.has(task.id) ? { ...task, status: "done" as const } : task));
  return board.find((task) => task.status === "todo" && !tried.has(task.id) && openDependencies(task, board).length === 0) ?? null;
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
  end: BoardRunEnd | null;
}

/** Why a board run ended, for the line under its button. */
export type BoardRunEnd =
  | { kind: "all_done" }
  | { kind: "waiting"; remaining: number }
  | { kind: "nothing_to_run" }
  | { kind: "stopped" }
  | { kind: "card_ended"; taskId: string; outcome: "blocked" | "failed" }
  | { kind: "moved_by_hand"; taskId: string };

/**
 * Why there is no next card: every card is done, the To do cards left wait on
 * cards that are not, or no card is To do (the rest are blocked, failed or in progress).
 */
export function idleBoardEnd(tasks: AgentTask[], finished: ReadonlySet<string> = new Set()): BoardRunEnd {
  const open = tasks.filter((task) => task.status !== "done" && !finished.has(task.id));
  const remaining = open.filter((task) => task.status === "todo").length;
  if (remaining > 0) return { kind: "waiting", remaining };
  return open.length === 0 ? { kind: "all_done" } : { kind: "nothing_to_run" };
}
