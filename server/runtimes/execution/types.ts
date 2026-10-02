/**
 * Provider-neutral execution contract for agent runtimes.
 *
 * Runtime adapters own the provider session and event translation. They do
 * not execute tools; tool/permission decisions stay with the host callback.
 */

export type RuntimeOverride = string | null | undefined;

export interface RuntimeTurnRequest {
  prompt: string;
  /** Existing thread id for a turn that follows a newly-created thread. */
  threadId?: string;
  /** `undefined`, `null`, or the literal `inherit` means omit the field. */
  model?: RuntimeOverride | "inherit";
  /** Native reasoning-effort value; `inherit` is omitted. */
  effort?: RuntimeOverride | "inherit";
  cwd?: string;
}

export interface RuntimeResumeTurnRequest extends RuntimeTurnRequest {
  threadId: string;
}

export type RuntimeApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] };
    }
  | {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: string; action: "allow" | "deny" };
      };
    };

/** One file a file-change approval would touch, as the approval card shows it. */
export interface RuntimeFileChange {
  path: string;
  kind: "add" | "update" | "delete" | "other";
  /** The new path when the change moves the file. */
  movePath?: string;
  /** A unified diff for an update, the full content for an added file. */
  diff: string;
}

export interface RuntimeApprovalRequest {
  requestId: string | number;
  kind: "command" | "file_change" | "other";
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  /** For a file change: the files it touches, when the runtime has said which. */
  files?: RuntimeFileChange[];
  /** Provider fields are retained for rendering, but never executed here. */
  details: Record<string, unknown>;
}

export type RuntimeApprovalHandler = (
  request: RuntimeApprovalRequest,
) => RuntimeApprovalDecision | undefined | Promise<RuntimeApprovalDecision | undefined>;

export interface RuntimeTextEvent {
  type: "text";
  text: string;
  threadId: string;
  turnId: string;
  itemId: string | null;
}

export interface RuntimeToolEvent {
  type: "tool";
  tool: string;
  status: string | null;
  threadId: string;
  turnId: string;
  itemId: string | null;
  /** Delta, input, or output supplied by the provider, when present. */
  data: unknown;
}

export interface RuntimeDoneEvent {
  type: "done";
  status: "completed" | "interrupted" | "failed";
  threadId: string;
  turnId: string;
  error: RuntimeErrorInfo | null;
}

export interface RuntimeErrorInfo {
  code: string;
  message: string;
}

export interface RuntimeErrorEvent {
  type: "error";
  error: RuntimeErrorInfo;
  threadId: string | null;
  turnId: string | null;
  fatal: boolean;
}

export type RuntimeEvent =
  | RuntimeTextEvent
  | RuntimeToolEvent
  | RuntimeApprovalRequest & { type: "approval" }
  | RuntimeDoneEvent
  | RuntimeErrorEvent;

export interface RuntimeExecutor {
  startTurn(request: RuntimeTurnRequest): AsyncIterable<RuntimeEvent>;
  resumeTurn(request: RuntimeResumeTurnRequest): AsyncIterable<RuntimeEvent>;
  interrupt(turnId?: string): Promise<void>;
  close(): Promise<void>;
}
