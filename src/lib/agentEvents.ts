// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { FollowUpQuestion } from "../types";

export type ToolState = "running" | "ok" | "error" | "denied" | "stopped";

/** One file a file-change approval would touch. */
export interface ApprovalFile {
  path: string;
  kind: "add" | "update" | "delete" | "other";
  /** The new path when the change moves the file. */
  movePath?: string;
  /** A unified diff for an update, the full content for an added file. */
  diff: string;
}

export type Entry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      result?: unknown;
      state: ToolState;
      startedAt: number;
      endedAt?: number;
    }
  | {
      kind: "approval";
      id: string;
      elicitId: string;
      command: string;
      cwd?: string;
      /** Set for a file-change approval: the files it touches, empty when the runtime did not say. */
      files?: ApprovalFile[];
      decided: boolean;
      approved?: boolean;
    }
  | {
      kind: "questions";
      id: string;
      elicitId: string;
      conversationId: string;
      questions: FollowUpQuestion[];
      round: number;
      answered: boolean;
    }
  | { kind: "mcp_status"; id: string; server: string; state: string; tools: number; message: string }
  | { kind: "context_carried"; id: string; runtime: string; included: number; omitted: number; resumed: boolean }
  | { kind: "chat_files"; id: string; status: "moved" | "conflict" | "failed"; from: string; to: string; conflicts: string[]; conflictCount: number }
  | { kind: "turn_end"; id: string; toolCount: number; ms: number; failed?: boolean; stopped?: boolean }
  | { kind: "error"; id: string; message: string; retryable: boolean };

export type AgentEvent = {
  type:
    | "conversation"
    | "turn"
    | "text"
    | "tool_start"
    | "tool_done"
    | "approval_request"
    | "approval_resolved"
    | "questions"
    | "mcp_status"
    | "context_carried"
    | "chat_files"
    | "done"
    | "error"
    | "abort"
    | "history";
  conversationId?: string;
  turn?: number;
  maxTurns?: number;
  text?: string;
  id?: string;
  tool?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  cwd?: string;
  approvalId?: string;
  elicitId?: string;
  approved?: boolean;
  command?: string;
  questions?: FollowUpQuestion[];
  round?: number;
  server?: string;
  tools?: number;
  state?: string;
  message?: string;
  retryable?: boolean;
  stop?: "stop" | "tool_calls" | "max_tokens" | "other";
  history?: unknown[];
};
