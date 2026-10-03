// The project's task board, for a chat turn. Without it a runtime only sees the
// working folder, so "work on the tasks" reached an agent that knew of no tasks.
// The chat does not do the cards itself: Undagi runs them one by one, each in its
// own session with its verify command, and moves each card as it ends. The agent
// asks for that run with a marker line that the client acts on.
// Keep the marker in sync with src/lib/boardRun.ts, which reads it.

export const RUN_BOARD_MARKER = "RUN_BOARD";

const MAX_CARDS = 60;
const TITLE_LIMIT = 120;

const clip = (value: unknown): string => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT).trimEnd()}…` : text;
};

/** The board as a prompt block, or "" for a project without cards. */
export function taskBoardBlock(session: any): string {
  const tasks: any[] = Array.isArray(session?.tasks) ? session.tasks.filter((task: any) => task && typeof task.id === "string") : [];
  if (tasks.length === 0) return "";
  const lines = tasks.slice(0, MAX_CARDS).map((task) => {
    const after = Array.isArray(task.dependencies) ? task.dependencies.filter((id: unknown) => typeof id === "string") : [];
    return `- ${task.id} [${task.status || "todo"}] ${clip(task.title)}${after.length ? ` (after ${after.join(", ")})` : ""}`;
  });
  if (tasks.length > MAX_CARDS) lines.push(`- … and ${tasks.length - MAX_CARDS} more cards`);
  return `<task_board>
This project has a task board in Undagi. Its cards, in board order:
${lines.join("\n")}

Undagi runs these cards itself: the To do cards whose dependencies are done, one at a time in board order. Each card gets its own session and its verify command, and moves when it ends.
When the user asks you to work on, execute, run or continue these tasks, do not do the work in this chat. Reply with one short sentence that the board run is starting, and end your message with a line that reads exactly ${RUN_BOARD_MARKER}. Write that line for no other request.
</task_board>`;
}
