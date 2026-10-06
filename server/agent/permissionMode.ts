// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RuntimeApprovalRequest } from "../runtimes/execution/types.ts";
import type { Elicit } from "./registry.ts";

/**
 * How much a chat run may do without asking:
 *   ask   every file write and every command waits for the user
 *   auto  file writes go ahead; commands and anything else still ask
 *   full  nothing asks
 * The mode only answers approvals; it does not widen any sandbox. Codex stays
 * workspace-write and the native agent still needs "Allow shell commands".
 */
export type PermissionMode = "ask" | "auto" | "full";

export type ApprovalAction = "edit" | "command" | "other";

/** Anything but a known mode is "ask", so an old client never gains access. */
export function parsePermissionMode(value: unknown): PermissionMode {
  return value === "auto" || value === "full" ? value : "ask";
}

export function autoApproves(mode: PermissionMode, action: ApprovalAction): boolean {
  return mode === "full" || (mode === "auto" && action === "edit");
}

// Claude asks per tool; these are the tools that only change files.
const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function runtimeApprovalAction(approval: Pick<RuntimeApprovalRequest, "kind" | "details">): ApprovalAction {
  // A write that asks for a path outside the working folder (Codex grantRoot,
  // Claude blockedPath) is not an ordinary edit; auto mode still asks.
  if (approval.details?.grantRoot || approval.details?.blockedPath) return "other";
  if (approval.kind === "file_change") return "edit";
  if (approval.kind === "command") return "command";
  const toolName = approval.details?.toolName;
  if (typeof toolName === "string" && CLAUDE_EDIT_TOOLS.has(toolName)) return "edit";
  if (toolName === "Bash") return "command";
  return "other";
}

/** The native agent's elicit, answering the approvals the mode allows itself. */
export function withPermissionMode(elicit: Elicit, mode: PermissionMode): Elicit {
  return (request) => {
    if (request.kind === "approval" && autoApproves(mode, request.action ?? "other")) return Promise.resolve(true);
    return elicit(request);
  };
}
