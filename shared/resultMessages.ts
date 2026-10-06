// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// Messages the agent's loop and tools write with a value spliced in. They stay
// English because the model reads them; the chat shows them translated. The
// server builds them from these templates and the UI reads the values back out
// with the same templates, so a wording changed here changes on both sides. Each
// template is also a key in src/lib/i18n.tsx, with the same {name} placeholders.
//
// Both the browser bundle and the server bundle include this file, so it imports
// nothing.

export const RESULT_MESSAGES = {
  sessionNotFound: "Session {id} not found.",
  toolRoundLimit: "Reached the limit of {count} tool rounds without a final answer.",
  toolUnavailable: "Tool {name} is not available for this session.",
  toolUnknown: "Tool {name} is not recognized.",
  commandStopped: "Stopped after {seconds} seconds.",
  taskMissing: "Task {id} does not exist. Call get_project to see the available ids.",
  statusUnknown: 'Status "{status}" is not recognized. Use one of: {allowed}.',
  noConnection: "There is no active LLM connection for the {role} stage.",
  tasksGenerated: "Tasks generated: {count}.",
  answersSaved: "Follow-up answers saved: {count}.",
  mcpUnreachable: "MCP server '{name}' could not be reached: {detail}",
} as const;

export type ResultMessage = keyof typeof RESULT_MESSAGES;

export function resultMessage(key: ResultMessage, values: Record<string, unknown>): string {
  return RESULT_MESSAGES[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
}

/** The line a command's output ends with when it was cut. */
export const TRUNCATED_NOTE = "...[truncated]";
