import { useCallback, useEffect, useRef, useState } from "react";
import type { Entry } from "./agentEvents";
import {
  loadExternalRuntimeSession,
  normalizeRuntimeChatEvent,
  type RuntimeChatSelection,
  saveExternalRuntimeSession,
} from "./runtimeChat";
import { toTransportAnswers } from "../components/plan/followups";
import { useT } from "./i18n";
import { agentLanguageFor, type AgentHarnessSettings } from "./agentHarness";
import { taskOutcomeFor, type TaskOutcome } from "./taskOutcome";
import type { PermissionMode } from "../types";

interface AgentRunOptions {
  sessionId: string;
  workspaceRoot: string;
  allowShell: boolean;
  onToolApplied: () => void | Promise<void>;
  runtimeSelection?: RuntimeChatSelection;
  harnessSettings: AgentHarnessSettings;
  permissionMode?: PermissionMode;
}

interface AgentRunResult {
  entries: Entry[];
  busy: boolean;
  error: string | null;
  send: (text: string, options?: AgentSendOptions) => Promise<boolean>;
  retry: () => Promise<void>;
  decideApproval: (elicitId: string, ok: boolean) => Promise<void>;
  respondQuestions: (elicitId: string, answers: Record<string, string>) => Promise<void>;
  stop: () => void;
}

interface AgentSendOptions {
  taskId?: string | null;
  /** Called once the run has ended, with where its task card should go; null when the user stopped it. */
  onOutcome?: (outcome: TaskOutcome | null) => void;
}

function nextEntryId(sequence: { current: number }): string {
  sequence.current += 1;
  return `entry-${Date.now()}-${sequence.current}`;
}

function errorText(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === "string" && value) return value;
  return fallback;
}

// Claude's own blocked-path detail rides in the approval event's `details`,
// not `cwd` — `cwd` is the turn's real working folder now (see
// server/runtime-runner/index.ts), and this can be a file, not a folder.
function approvalBlockedPath(event: Record<string, any>): string | undefined {
  const details = event.details;
  const value = details && typeof details === "object" ? (details as Record<string, unknown>).blockedPath : undefined;
  return typeof value === "string" && value ? value : undefined;
}

const CONVERSATION_STORAGE_PREFIX = "ai_plan_architect_agent_conversation_v1";

function conversationStorageKey(sessionId: string): string {
  return `${CONVERSATION_STORAGE_PREFIX}:${encodeURIComponent(sessionId)}`;
}

function loadConversationId(sessionId: string): string | null {
  try {
    return window.localStorage.getItem(conversationStorageKey(sessionId));
  } catch {
    return null;
  }
}

function saveConversationId(sessionId: string, conversationId: string): void {
  try {
    window.localStorage.setItem(conversationStorageKey(sessionId), conversationId);
  } catch {
    // Conversation persistence is best effort; the server remains authoritative.
  }
}

/**
 * Whether the SSE stream showed the message reached the server, so a failed
 * send does not invite the composer to offer the same text again.
 *
 * The legacy route stores the message before its first "turn" event; every
 * later failure in that turn (denied tool, error, max turns) still follows a
 * "turn". The runtime route stores it before starting the run, which it
 * always finishes with a "done" event, success or failure; only a refusal
 * before the run starts (an unready runtime) skips both, so it correctly
 * counts as not delivered.
 */
export function wasMessageDelivered(nativeRuntime: boolean, sawTurn: boolean, sawDone: boolean): boolean {
  return nativeRuntime ? sawDone : sawTurn;
}

function parseStoredResult(content: unknown): unknown {
  if (typeof content !== "string") return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** A note the chat shows between messages, from a live event or a stored one. */
function noteEntry(event: any, sequence: { current: number }): Entry | null {
  if (!event || typeof event !== "object") return null;
  if (event.type === "context_carried") {
    return {
      kind: "context_carried",
      id: nextEntryId(sequence),
      runtime: typeof event.runtime === "string" ? event.runtime : "",
      included: Number(event.included) || 0,
      omitted: Number(event.omitted) || 0,
      resumed: event.resumed === true,
    };
  }
  if (event.type === "chat_files" && (event.status === "moved" || event.status === "conflict" || event.status === "failed")) {
    const conflicts = Array.isArray(event.conflicts)
      ? event.conflicts.filter((item: unknown): item is string => typeof item === "string")
      : [];
    return {
      kind: "chat_files",
      id: nextEntryId(sequence),
      status: event.status,
      from: String(event.from ?? ""),
      to: String(event.to ?? ""),
      conflicts,
      conflictCount: Number(event.conflictCount) || conflicts.length,
    };
  }
  return null;
}

export function entriesFromStoredMessages(messages: unknown[], sequence: { current: number }, notes: unknown[] = []): Entry[] {
  const restored: Entry[] = [];
  const tools = new Map<string, number>();
  // Notes go where the chat showed them live: after the message they follow.
  const notesAfter = new Map<number, unknown[]>();
  for (const item of notes) {
    const afterMessage = Number((item as any)?.afterMessage);
    if (!Number.isInteger(afterMessage)) continue;
    notesAfter.set(afterMessage, [...(notesAfter.get(afterMessage) ?? []), (item as any).note]);
  }
  const pushNotes = (afterMessage: number): void => {
    for (const note of notesAfter.get(afterMessage) ?? []) {
      const entry = noteEntry(note, sequence);
      if (entry) restored.push(entry);
    }
  };

  for (const [index, message] of messages.entries()) {
    pushNotes(index - 1);
    if (!message || typeof message !== "object") continue;
    const role = (message as any).role;
    const content = (message as any).content;
    if ((role !== "user" && role !== "assistant") || !Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        restored.push({
          kind: role,
          id: nextEntryId(sequence),
          text: block.text,
          ...(role === "assistant" ? { streaming: false } : {}),
        } as Entry);
      } else if (role === "assistant" && block.type === "tool_call" && typeof block.id === "string") {
        tools.set(block.id, restored.length);
        restored.push({
          kind: "tool",
          id: block.id,
          name: typeof block.name === "string" ? block.name : "tool",
          input: block.input,
          state: "ok",
          startedAt: 0,
          endedAt: 0,
        });
      } else if (role === "user" && block.type === "tool_result" && typeof block.toolCallId === "string") {
        const index = tools.get(block.toolCallId);
        if (index === undefined) continue;
        const entry = restored[index];
        if (entry.kind !== "tool") continue;
        restored[index] = {
          ...entry,
          result: parseStoredResult(block.content),
          state: block.isError ? "error" : "ok",
        };
      }
    }
  }
  pushNotes(messages.length - 1);

  return restored;
}

// Satu baris di layar. Bukan bentuk yang dikirim ke model — riwayat untuk model
// disimpan terpisah apa adanya dari server, karena blok tool_use dan tool_result
// harus tetap berpasangan persis atau permintaan berikutnya ditolak.

export function useAgentRun({ sessionId, workspaceRoot, allowShell, onToolApplied, runtimeSelection = { runtime: "legacy", model: "inherit", effort: "inherit" }, harnessSettings, permissionMode = "ask" }: AgentRunOptions): AgentRunResult {
  const { t, lang } = useT();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = useRef<unknown[]>([]);
  const conversationId = useRef<string | null>(loadConversationId(sessionId));
  const lastSend = useRef<{ message: string; options?: AgentSendOptions } | null>(null);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const approvalRunIds = useRef(new Map<string, string>());
  const liveSendStarted = useRef(false);
  const onToolAppliedRef = useRef(onToolApplied);

  onToolAppliedRef.current = onToolApplied;

  useEffect(() => {
    let cancelled = false;
    controller.current?.abort();
    controller.current = null;
    history.current = [];
    approvalRunIds.current.clear();
    conversationId.current = loadConversationId(sessionId);
    liveSendStarted.current = false;
    lastSend.current = null;
    setEntries([]);
    setBusy(false);
    setError(null);

    // This browser may never have seen the chat (another browser, the desktop
    // app, cleared storage). A saved project still has its conversation on the
    // server, so the most recent one is opened instead of an empty chat.
    const findConversationId = async (): Promise<string | null> => {
      if (conversationId.current) return conversationId.current;
      const res = await fetch(`/api/agent/conversations?projectId=${encodeURIComponent(sessionId)}`);
      const data = res.ok ? await res.json() : null;
      const found = data?.conversations?.[0]?.id;
      if (cancelled || liveSendStarted.current || typeof found !== "string" || !found) return null;
      conversationId.current = found;
      saveConversationId(sessionId, found);
      return found;
    };

    findConversationId()
      .then(async (id) => {
        if (!id) return null;
        const res = await fetch(`/api/agent/conversations/${encodeURIComponent(id)}/messages`);
        return res.ok ? res.json() : null;
      })
      .then((data) => {
        if (cancelled || liveSendStarted.current || !Array.isArray(data?.messages)) return;
        setEntries(entriesFromStoredMessages(data.messages, sequence, Array.isArray(data.notes) ? data.notes : []));
      })
      .catch(() => {
        // A missing or temporarily unavailable transcript should not block a
        // new message; the server still has the authoritative history.
      });

    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => () => controller.current?.abort(), []);

  const appendError = useCallback((message: string, retryable: boolean) => {
    setEntries((prev) => [...prev, { kind: "error", id: nextEntryId(sequence), message, retryable }]);
  }, []);

  const decideApproval = useCallback(async (elicitId: string, ok: boolean): Promise<void> => {
    try {
      const res = await fetch(
        runtimeSelection.runtime === "legacy" ? "/api/agent/approve" : "/api/runtime-agent/approve",
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: elicitId,
          approved: ok,
          ...(runtimeSelection.runtime !== "legacy" && approvalRunIds.current.get(elicitId)
            ? { runId: approvalRunIds.current.get(elicitId) }
            : {}),
        }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || t("That approval request is no longer valid."));
      }
    } catch {
      setError(t("That approval request is no longer valid."));
    }
  }, [runtimeSelection.runtime, t]);

  const respondQuestions = useCallback(async (elicitId: string, answers: Record<string, string>): Promise<void> => {
    const questionEntry = entries.find((entry): entry is Extract<Entry, { kind: "questions" }> =>
      entry.kind === "questions" && entry.elicitId === elicitId,
    );
    const currentConversationId = questionEntry?.conversationId || conversationId.current;
    if (!currentConversationId) {
      setError(t("That question card is no longer valid."));
      return;
    }

    try {
      const res = await fetch("/api/agent/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elicitId,
          conversationId: currentConversationId,
          // The UI keys answers by stable question id. The server deliberately
          // stores question-text keys because its prompts use those keys.
          response: questionEntry ? toTransportAnswers(questionEntry.questions, answers) : answers,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || t("That question card is no longer valid."));
        return;
      }
      setEntries((prev) => prev.map((entry) =>
        entry.kind === "questions" && entry.elicitId === elicitId
          ? { ...entry, answered: true }
          : entry,
      ));
    } catch {
      setError(t("That question card is no longer valid."));
    }
  }, [entries, t]);

  const send = useCallback(async (text: string, options?: AgentSendOptions): Promise<boolean> => {
    const message = text.trim();
    if (!message || controller.current) return false;

    lastSend.current = { message, options };
    liveSendStarted.current = true;
    setError(null);
    setBusy(true);
    setEntries((prev) => [...prev, { kind: "user", id: `user-${Date.now()}`, text: message }]);

    const ac = new AbortController();
    controller.current = ac;
    let toolTouchedSession = false;
    let turnStartedAt = Date.now();
    let turnToolCount = 0;
    let sawDone = false;
    let sawTurn = false;
    // What the run amounted to, for the task card it was started from.
    let assistantText = "";
    let runFailed = false;
    let runInterrupted = false;
    const nativeRuntime = runtimeSelection.runtime !== "legacy";
    const runtimeConversationKey = conversationId.current || sessionId;
    const externalSessionId = nativeRuntime
      ? loadExternalRuntimeSession(sessionId, runtimeSelection.runtime, runtimeConversationKey)
      : null;

    const pushStreamError = (message: string, retryable: boolean): void => {
      setError(message);
      appendError(message, retryable);
    };

    try {
      const res = await fetch(nativeRuntime ? "/api/runtime-agent/chat" : "/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Chat memakai endpoint yang sama dengan pengaturan LLM, tapi lewat
        // format Anthropic — router lokal melayani keduanya di base URL itu.
        body: JSON.stringify(nativeRuntime ? {
          sessionId,
          ...(conversationId.current ? { conversationId: conversationId.current } : {}),
          ...(externalSessionId ? { externalSessionId } : {}),
          ...(options?.taskId ? { taskId: options.taskId } : {}),
          runtime: runtimeSelection.runtime,
          connectionId: runtimeSelection.connectionId,
          workspaceRoot,
          allowShell,
          model: runtimeSelection.model,
          effort: runtimeSelection.effort,
          harnessSettings,
          language: lang,
          agentLanguage: agentLanguageFor(harnessSettings),
          permissionMode,
          message,
        } : {
          sessionId,
          ...(conversationId.current ? { conversationId: conversationId.current } : {}),
          workspaceRoot,
          allowShell,
          history: history.current,
          harnessSettings,
          language: lang,
          agentLanguage: agentLanguageFor(harnessSettings),
          permissionMode,
          message,
        }),
        signal: ac.signal,
      });
      // The runtime route answers a runtime that is not ready with an event
      // stream carrying the reason, so a stream is read whatever its status.
      // Any other refusal is JSON with an error message worth showing.
      const isStream = (res.headers.get("Content-Type") ?? "").includes("text/event-stream");
      if (!res.body || (!res.ok && !isStream)) {
        const reason = await res.json().then(
          (body: { error?: unknown }) => (typeof body?.error === "string" && body.error ? body.error : null),
          () => null,
        );
        throw new Error(reason ?? t("The agent is unreachable."));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Satu event SSE berakhir di baris kosong; sisa potongan ditahan sampai
        // bagian berikutnya tiba.
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";

        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const rawEvent = JSON.parse(line.slice(6)) as Record<string, any>;
          const event = nativeRuntime ? normalizeRuntimeChatEvent(rawEvent) : rawEvent;
          if (!event) continue;

          if (nativeRuntime && typeof event.externalSessionId === "string" && event.externalSessionId) {
            const currentKey = conversationId.current || runtimeConversationKey;
            saveExternalRuntimeSession(sessionId, runtimeSelection.runtime, currentKey, event.externalSessionId);
          }

          if (event.type === "runtime_session") {
            continue;
          } else if (event.type === "conversation") {
            if (typeof event.conversationId === "string" && event.conversationId) {
              conversationId.current = event.conversationId;
              saveConversationId(sessionId, event.conversationId);
            }
          } else if (event.type === "text") {
            if (typeof event.text === "string") assistantText += event.text;
            setEntries((prev) => {
              const last = prev[prev.length - 1];
              if (last?.kind === "assistant") {
                return [
                  ...prev.slice(0, -1),
                  { ...last, text: last.text + (typeof event.text === "string" ? event.text : ""), streaming: true },
                ];
              }
              return [
                ...prev,
                { kind: "assistant", id: nextEntryId(sequence), text: event.text || "", streaming: true },
              ];
            });
          } else if (event.type === "tool_start") {
            turnToolCount += 1;
            setEntries((prev) => [
              ...prev,
              {
                kind: "tool",
                id: event.id || nextEntryId(sequence),
                name: event.tool || "tool",
                input: event.input,
                state: "running",
                startedAt: Date.now(),
              },
            ]);
          } else if (event.type === "tool_done") {
            if (!event.isError) toolTouchedSession = true;
            setEntries((prev) => {
              // Fase 3 mengirim id stabil. Fallback ini menjaga kompatibilitas
              // dengan server lama yang belum menyertakan id pada tool_done.
              const keyedIndex = event.id
                ? prev.findIndex((entry) => entry.kind === "tool" && entry.id === event.id)
                : -1;
              const idx = event.id
                ? keyedIndex
                : prev.map((entry) => entry.kind === "tool" && entry.state === "running").lastIndexOf(true);
              if (idx === -1 || prev[idx].kind !== "tool") return prev;
              const next = [...prev];
              const tool = prev[idx];
              next[idx] = {
                ...tool,
                name: event.tool || tool.name,
                result: event.result,
                state: event.isError ? "error" : "ok",
                endedAt: Date.now(),
              };
              return next;
            });
          } else if (event.type === "approval_request") {
            const elicitId = event.elicitId || event.approvalId || nextEntryId(sequence);
            if (nativeRuntime && typeof event.runId === "string" && event.runId) {
              approvalRunIds.current.set(elicitId, event.runId);
            }
            const blockedPath = approvalBlockedPath(event);
            setEntries((prev) => [
              ...prev,
              {
                kind: "approval",
                id: nextEntryId(sequence),
                elicitId,
                command: event.command || "",
                ...(event.cwd ? { cwd: event.cwd } : {}),
                ...(blockedPath ? { blockedPath } : {}),
                decided: false,
              },
            ]);
          } else if (event.type === "approval_resolved") {
            const elicitId = event.elicitId || event.approvalId;
            if (typeof elicitId === "string") approvalRunIds.current.delete(elicitId);
            setEntries((prev) => prev.map((entry) =>
              entry.kind === "approval" && entry.elicitId === elicitId
                ? { ...entry, decided: true, approved: event.approved }
                : entry
            ));
          } else if (event.type === "questions") {
            const currentConversationId =
              typeof event.conversationId === "string" && event.conversationId
                ? event.conversationId
                : conversationId.current || "";
            const questions = Array.isArray(event.questions) ? event.questions : [];
            setEntries((prev) => [
              ...prev,
              {
                kind: "questions",
                id: nextEntryId(sequence),
                elicitId: event.elicitId || event.approvalId || nextEntryId(sequence),
                conversationId: currentConversationId,
                questions,
                round: Number(event.round) || 1,
                answered: false,
              },
            ]);
          } else if (event.type === "chat_files" || event.type === "context_carried") {
            const note = noteEntry(event, sequence);
            if (note) setEntries((prev) => [...prev, note]);
          } else if (event.type === "mcp_status") {
            setEntries((prev) => [
              ...prev,
              {
                kind: "mcp_status",
                id: nextEntryId(sequence),
                server: event.server || "MCP",
                state: event.state || "down",
                tools: Number(event.tools) || 0,
                message: event.message || t("The MCP server is unavailable."),
              },
            ]);
          } else if (event.type === "history") {
            history.current = event.history;
          } else if (event.type === "error") {
            runFailed = true;
            pushStreamError(
              event.message || t("The agent is unreachable."),
              event.retryable !== false,
            );
          } else if (event.type === "turn") {
            sawTurn = true;
            turnStartedAt = Date.now();
            turnToolCount = 0;
          } else if (event.type === "done") {
            sawDone = true;
            if (event.runStatus === "failed" || event.stop === "max_tokens") runFailed = true;
            if (event.runStatus === "interrupted") runInterrupted = true;
            const endedAt = Date.now();
            setEntries((prev) => {
              // A tool the provider never finished, such as a command the user
              // declined, will not report now that the turn is over.
              const next = prev.map((entry) => entry.kind === "tool" && entry.state === "running"
                ? { ...entry, state: "stopped" as const, endedAt }
                : entry);
              const assistantIndex = next
                .map((entry) => entry.kind === "assistant" && entry.streaming)
                .lastIndexOf(true);
              if (assistantIndex !== -1 && next[assistantIndex].kind === "assistant") {
                next[assistantIndex] = { ...next[assistantIndex], streaming: false };
              }
              return [
                ...next,
                {
                  kind: "turn_end",
                  id: event.id || nextEntryId(sequence),
                  toolCount: turnToolCount,
                  ms: Math.max(0, Date.now() - turnStartedAt),
                  ...(event.runStatus === "failed" ? { failed: true } : {}),
                },
              ];
            });
          }
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        runFailed = true;
        pushStreamError(errorText(err, t("The agent is unreachable.")), true);
      }
    } finally {
      // Stop, or a stream that broke, ends the turn with no done event. Settle
      // what was still in progress so nothing keeps looking like it runs.
      if (!sawDone) {
        const stoppedByUser = ac.signal.aborted;
        const endedAt = Date.now();
        setEntries((prev) => {
          const next = prev.map((entry) => {
            if (entry.kind === "assistant" && entry.streaming) return { ...entry, streaming: false };
            if (entry.kind === "tool" && entry.state === "running") return { ...entry, state: "stopped" as const, endedAt };
            return entry;
          });
          return stoppedByUser
            ? [...next, { kind: "turn_end", id: nextEntryId(sequence), toolCount: turnToolCount, ms: Math.max(0, endedAt - turnStartedAt), stopped: true }]
            : next;
        });
      }
      if (controller.current === ac) {
        controller.current = null;
        setBusy(false);
      }
      // The refresh replaces the session with the server's copy, so the card
      // moves only after it, not before.
      if (toolTouchedSession) {
        try { await onToolAppliedRef.current(); } catch { /* the refresh reports its own failure */ }
      }
      options?.onOutcome?.(taskOutcomeFor({
        aborted: ac.signal.aborted || runInterrupted,
        failed: runFailed || !sawDone,
        text: assistantText,
      }));
    }
    // Delivery, not turn success, decides the draft: a message that reached
    // the server shows in the chat, so the composer lets go of it instead of
    // offering it to send again, even when that turn then failed. A turn the
    // user stopped ends without "done", but its message is in the chat too.
    return ac.signal.aborted || wasMessageDelivered(nativeRuntime, sawTurn, sawDone);
  }, [allowShell, appendError, harnessSettings, lang, permissionMode, runtimeSelection, sessionId, t, workspaceRoot]);

  const retry = useCallback(async (): Promise<void> => {
    if (lastSend.current) await send(lastSend.current.message, lastSend.current.options);
  }, [send]);

  const stop = useCallback((): void => {
    controller.current?.abort();
  }, []);

  return { entries, busy, error, send, retry, decideApproval, respondQuestions, stop };
}
