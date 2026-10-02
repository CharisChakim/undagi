import { getSession } from "../../db.ts";
import { resultMessage } from "../../shared/resultMessages.ts";
import { appendMessage, loadMessages, sanitize } from "./conversations.ts";
import { systemPromptFor } from "./prompt.ts";
import type { AgentHarnessSettings } from "./harness.ts";
import { resolveInsideRoot } from "./sandbox.ts";
import { streamLlm } from "../llm/stream.ts";
import type { Lang } from "../messages.ts";
import type { Connection, ContentBlock, StopReason } from "../llm/types.ts";
import {
  DEFAULT_LIMITS,
  dispatch,
  type AgentLimits,
  type Elicit,
  toolsForTurn,
  type ToolSpec,
} from "./registry.ts";

export type { AgentLimits, Elicit } from "./registry.ts";

export type AgentEventType =
  | "conversation"
  | "turn"
  | "text"
  | "tool_start"
  | "tool_done"
  | "approval_request"
  | "approval_resolved"
  | "done"
  | "error"
  | "mcp_status"
  | "abort";

export interface AgentEvent {
  type: AgentEventType;
  conversationId?: string;
  turn?: number;
  maxTurns?: number;
  text?: string;
  id?: string;
  tool?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: string;
  stop?: StopReason;
  approvalId?: string;
  elicitId?: string;
  command?: string;
  approved?: boolean;
  server?: string;
  tools?: number;
  state?: string;
}

export interface AgentRunOptions {
  /** Persisted project session id, or null for a standalone conversation. */
  sessionId: string | null;
  /** Request-scoped context used only when sessionId is null. */
  workspaceRoot?: string;
  allowShell?: boolean;
  conversationId: string;
  userMessage: string;
  conn: Connection;
  model: string;
  harnessSettings: AgentHarnessSettings;
  /** The turn was started from a task card, so the model reports back to the board. */
  taskRun?: boolean;
  /** UI language; names UI labels in the prompt and the language of generated artifacts. Missing means "en". */
  lang?: Lang;
  /** Language of model-facing instructions in tools that pass one on. Missing means "en". */
  agentLang?: Lang;
  limits: AgentLimits;
  onEvent: (event: AgentEvent) => void;
  elicit: Elicit;
  signal: AbortSignal;
}

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  parseError?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch (error) {
    return JSON.stringify({ error: errorMessage(error) });
  }
}

function isErrorResult(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "error" in value && (value as any).error);
}

function numericLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function limitsFor(session: any, supplied: Partial<AgentLimits> = {}): AgentLimits {
  const configured = session?.agentLimits && typeof session.agentLimits === "object"
    ? session.agentLimits
    : {};
  return {
    maxTurns: numericLimit(configured.maxTurns ?? supplied.maxTurns, DEFAULT_LIMITS.maxTurns),
    maxTokens: numericLimit(configured.maxTokens ?? supplied.maxTokens, DEFAULT_LIMITS.maxTokens),
    maxReadChars: numericLimit(configured.maxReadChars ?? supplied.maxReadChars, DEFAULT_LIMITS.maxReadChars),
    maxOutputChars: numericLimit(configured.maxOutputChars ?? supplied.maxOutputChars, DEFAULT_LIMITS.maxOutputChars),
    commandTimeoutMs: numericLimit(
      configured.commandTimeoutMs ?? supplied.commandTimeoutMs,
      DEFAULT_LIMITS.commandTimeoutMs,
    ),
  };
}

async function workspaceRoot(session: any): Promise<string | undefined> {
  const configuredRoot = session?.workspaceRoot?.trim();
  if (!configuredRoot) return undefined;
  try {
    return await resolveInsideRoot(configuredRoot, ".");
  } catch {
    // Tool itu sendiri akan mengembalikan pesan path yang aman; root invalid
    // tidak boleh menggagalkan request provider sebelum model menerima konteksnya.
    return undefined;
  }
}

function transientSession(opts: AgentRunOptions): any {
  const root = typeof opts.workspaceRoot === "string" ? opts.workspaceRoot.trim() : "";
  return {
    // No id is intentional: registry uses it to keep project and pipeline
    // tools out of standalone conversations.
    ...(root ? { workspaceRoot: root } : {}),
    allowShell: Boolean(root && opts.allowShell === true),
  };
}

function sessionFor(opts: AgentRunOptions): any | null {
  return opts.sessionId ? getSession(opts.sessionId) : transientSession(opts);
}

function emitAbort(onEvent: (event: AgentEvent) => void): void {
  onEvent({ type: "abort" });
}

export async function runAgent(opts: AgentRunOptions): Promise<void> {
  try {
    const initialSession = sessionFor(opts);
    if (!initialSession) {
      opts.onEvent({ type: "error", message: resultMessage("sessionNotFound", { id: opts.sessionId }) });
      return;
    }
    if (opts.signal.aborted) {
      emitAbort(opts.onEvent);
      return;
    }

    appendMessage(opts.conversationId, {
      role: "user",
      content: [{ type: "text", text: opts.userMessage }],
    });

    const limits = limitsFor(initialSession, opts.limits);
    for (let turn = 0; turn < limits.maxTurns; turn += 1) {
      if (opts.signal.aborted) {
        emitAbort(opts.onEvent);
        return;
      }

      opts.onEvent({ type: "turn", turn, maxTurns: limits.maxTurns });

      // Sesi dibaca ulang tiap giliran agar gating dan prompt mencerminkan
      // perubahan yang dibuat tool pada sesi selama giliran sebelumnya.
      const session = sessionFor(opts);
      if (!session) {
        opts.onEvent({ type: "error", message: resultMessage("sessionNotFound", { id: opts.sessionId }) });
        return;
      }
      const specs = await toolsForTurn(session, opts.signal, (status) => {
        opts.onEvent({ type: "mcp_status", ...status });
      });
      const root = await workspaceRoot(session);
      const toolContext = {
        sessionId: opts.sessionId,
        session,
        root,
        limits,
        elicit: opts.elicit,
        signal: opts.signal,
        lang: opts.lang,
        agentLang: opts.agentLang,
      };
      const assistantContent: ContentBlock[] = [];
      const toolCalls: ToolCall[] = [];
      let pendingText = "";
      const flushText = () => {
        if (!pendingText) return;
        assistantContent.push({ type: "text", text: pendingText });
        pendingText = "";
      };

      const request = streamLlm(opts.conn, {
        model: opts.model,
        system: systemPromptFor(session, opts.harnessSettings, opts.lang, { task: opts.taskRun, noteLang: opts.lang }),
        messages: sanitize(loadMessages(opts.conversationId)),
        tools: specs.map((spec: ToolSpec) => spec.def),
        maxTokens: limits.maxTokens,
        signal: opts.signal,
      });

      let stop: StopReason = "other";
      for await (const event of request) {
        if (event.type === "text") {
          opts.onEvent({ type: "text", text: event.delta });
          pendingText += event.delta;
        } else if (event.type === "tool_call") {
          flushText();
          const call: ToolCall = {
            id: event.id,
            name: event.name,
            input: event.input,
            ...(event.parseError ? { parseError: event.parseError } : {}),
          };
          toolCalls.push(call);
          assistantContent.push({ type: "tool_call", id: call.id, name: call.name, input: call.input });
        } else if (event.type === "done") {
          stop = event.stop;
        }
      }
      flushText();

      // Pesan assistant harus tersimpan sebelum tool berjalan. Saat command
      // panjang dibatalkan, giliran model tetap utuh dan sanitize dapat
      // menjawab tool call yang belum sempat mendapat hasil pada request berikutnya.
      appendMessage(opts.conversationId, {
        role: "assistant",
        content: assistantContent,
      }, { model: opts.model, connectionId: opts.conn.id, stop });

      if (stop !== "tool_calls") {
        opts.onEvent({ type: "done", stop });
        return;
      }

      const results: ContentBlock[] = [];
      for (const call of toolCalls) {
        if (opts.signal.aborted) {
          emitAbort(opts.onEvent);
          return;
        }

        opts.onEvent({ type: "tool_start", id: call.id, tool: call.name, input: call.input });
        let result: unknown;
        if (call.parseError) {
          result = { error: `Arguments were not valid JSON: ${call.parseError}` };
        } else {
          result = await dispatch(call.name, call.input, toolContext, specs);
        }
        const isError = isErrorResult(result);
        opts.onEvent({ type: "tool_done", id: call.id, tool: call.name, result, isError });

        if (opts.signal.aborted) {
          emitAbort(opts.onEvent);
          return;
        }
        results.push({
          type: "tool_result",
          toolCallId: call.id,
          content: safeJson(result),
          ...(isError ? { isError: true } : {}),
        });
      }

      // Semua tool_result dari satu giliran harus pulang dalam SATU pesan user.
      // Dipecah jadi beberapa pesan, model belajar berhenti memanggil paralel.
      appendMessage(opts.conversationId, { role: "user", content: results });
    }

    opts.onEvent({
      type: "error",
      message: resultMessage("toolRoundLimit", { count: limits.maxTurns }),
    });
  } catch (error) {
    if (opts.signal.aborted) {
      emitAbort(opts.onEvent);
      return;
    }
    opts.onEvent({ type: "error", message: errorMessage(error) });
  }
}
