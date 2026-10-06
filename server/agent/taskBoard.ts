// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// The project's task board, for a chat turn. Without it a runtime only sees the
// working folder, so "work on the tasks" reached an agent that knew of no tasks.
// The chat does not do the cards itself: Undagi runs the first unfinished phase
// card by card, each in its own session with its verify command, and moves each
// card as it ends. The agent asks for that run with a marker line that the client acts on.
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
  const lines: string[] = [];
  let phase: string | null = null;
  for (const task of tasks.slice(0, MAX_CARDS)) {
    // Cards are grouped under their phase, which is what one run works through.
    const cardPhase = clip(task.phase);
    if (cardPhase !== phase && cardPhase) lines.push(`${cardPhase}:`);
    phase = cardPhase;
    const after = Array.isArray(task.dependencies) ? task.dependencies.filter((id: unknown) => typeof id === "string") : [];
    lines.push(`- ${task.id} [${task.status || "todo"}] ${clip(task.title)}${after.length ? ` (after ${after.join(", ")})` : ""}`);
  }
  if (tasks.length > MAX_CARDS) lines.push(`- … and ${tasks.length - MAX_CARDS} more cards`);
  return `<task_board>
This project has a task board in Undagi. Its cards, in board order:
${lines.join("\n")}

Undagi runs these cards itself, one phase per run: the first phase that is not finished, its To do cards one at a time in board order, each once its dependencies are done. Each card gets its own session and its verify command, and moves when it ends. The run stops when that phase is done, so the user checks it before the next phase.
When the user asks you to work on, execute, run or continue these tasks or a phase, do not do the work in this chat. Reply with one short sentence naming the phase that will run, and end your message with a line that reads exactly ${RUN_BOARD_MARKER}. If they asked for a later phase while an earlier one is not finished, say the earlier one runs first. Write that line for no other request.
</task_board>`;
}
