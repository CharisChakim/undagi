import type { FollowUpQuestion } from "../types";
import type { ApprovalAdvice, IntentAdvice } from "./jev";

export type ToolState = "running" | "ok" | "error" | "denied" | "stopped";

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
      decided: boolean;
      approved?: boolean;
      /** Jev's risk read, if it arrived while the approval was open. Advisory only. */
      advice?: ApprovalAdvice;
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
  /** Jev's guess at what a message was for. Lives in the chat only; never stored. */
  | { kind: "intent_hint"; id: string; after: string; intent: HintIntent }
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
    | "approval_advice"
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
  risk?: ApprovalAdvice["risk"];
  score?: number;
  confidence?: number;
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

/** The `approval_advice` event's payload, if it is well formed, and the ids it may name its card by. */
export function parseApprovalAdvice(event: unknown): { ids: string[]; advice: ApprovalAdvice } | null {
  if (!event || typeof event !== "object") return null;
  const { elicitId, approvalId, risk, score, confidence } = event as Record<string, unknown>;
  const ids = [elicitId, approvalId].filter((id): id is string => typeof id === "string" && id !== "");
  if (ids.length === 0 || (risk !== "low" && risk !== "medium" && risk !== "high")) return null;
  if (typeof score !== "number" || !Number.isFinite(score) || typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return { ids, advice: { risk, score, confidence } };
}

/**
 * Attaches Jev's advice to the approval it is about. Advice for a card that is
 * gone, already answered, or unknown changes nothing: a late answer never
 * decorates a decision that has been made.
 */
export function withApprovalAdvice(entries: Entry[], event: unknown): Entry[] {
  const parsed = parseApprovalAdvice(event);
  if (!parsed) return entries;
  const index = entries.findIndex((entry) => entry.kind === "approval" && parsed.ids.includes(entry.elicitId));
  const entry = entries[index];
  if (!entry || entry.kind !== "approval" || entry.decided) return entries;
  const next = [...entries];
  next[index] = { ...entry, advice: parsed.advice };
  return next;
}

/** What a message can be a request for, as far as Jev's hint in the chat goes. */
export type HintIntent = "plan_project" | "generate_prd" | "generate_tasks";

/** What the project already has, which decides which pipeline step still makes sense. */
export interface PipelineProgress {
  hasPlan: boolean;
  hasPrd: boolean;
  hasTasks: boolean;
}

export const INTENT_HINT_MIN_MESSAGE_CHARS = 8;
export const INTENT_HINT_MIN_CONFIDENCE = 0.7;

/** Whether a message is worth asking Jev about: a real chat message, not a task run or a one-word reply. */
export function worthAnIntentHint(message: string, isTaskRun: boolean): boolean {
  return !isTaskRun && message.length >= INTENT_HINT_MIN_MESSAGE_CHARS;
}

/** The pipeline step (Plan 1, PRD 2, tasks 3) each hinted intent opens. */
export const INTENT_HINT_STEP: Record<HintIntent, 1 | 2 | 3> = { plan_project: 1, generate_prd: 2, generate_tasks: 3 };

/** Whether that step is the next one the project is missing. */
export function intentStillApplies(intent: HintIntent, progress: PipelineProgress): boolean {
  if (intent === "plan_project") return !progress.hasPlan;
  if (intent === "generate_prd") return progress.hasPlan && !progress.hasPrd;
  return progress.hasPrd && !progress.hasTasks;
}

/** The hint worth showing for Jev's answer, or null: unsure, not a pipeline request, or the step is not the next one. */
export function intentHintFor(advice: IntentAdvice | null | undefined, progress: PipelineProgress): HintIntent | null {
  if (!advice || !(advice.confidence >= INTENT_HINT_MIN_CONFIDENCE)) return null;
  const { intent } = advice;
  if (intent !== "plan_project" && intent !== "generate_prd" && intent !== "generate_tasks") return null;
  return intentStillApplies(intent, progress) ? intent : null;
}

/** Puts the hint right under the message it is about, once; nothing if that message is gone. */
export function withIntentHint(entries: Entry[], afterUserEntryId: string, intent: HintIntent): Entry[] {
  const index = entries.findIndex((entry) => entry.kind === "user" && entry.id === afterUserEntryId);
  const id = `intent-hint-${afterUserEntryId}`;
  if (index === -1 || entries.some((entry) => entry.id === id)) return entries;
  return [...entries.slice(0, index + 1), { kind: "intent_hint", id, after: afterUserEntryId, intent }, ...entries.slice(index + 1)];
}
