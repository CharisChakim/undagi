import type { RuntimeDiscoveryReport, RuntimeId } from "../types";
import { prefs } from "./prefs";

export type RuntimeChatSelection =
  | { runtime: "legacy"; model: "inherit"; effort: "inherit" }
  | { runtime: RuntimeId; connectionId: string; model: string; effort: string };

const SELECTION_PREFIX = "ai_plan_architect_runtime_selection_v1";
const LAST_SELECTION_KEY = "ai_plan_architect_runtime_selection_last_v1";
const EXTERNAL_SESSION_PREFIX = "ai_plan_architect_runtime_session_v1";
const PIPELINE_SELECTION_PREFIX = "ai_plan_architect_pipeline_selection_v1";

const isRuntimeId = (value: unknown): value is RuntimeId =>
  value === "codex" || value === "claude" || value === "antigravity";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const storageKey = (prefix: string, ...parts: string[]) =>
  `${prefix}:${parts.map((part) => encodeURIComponent(part)).join(":")}`;

export const legacyRuntimeSelection = (): RuntimeChatSelection => ({
  runtime: "legacy",
  model: "inherit",
  effort: "inherit",
});

function parseSelection(raw: string | null): RuntimeChatSelection | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.runtime === "legacy") return legacyRuntimeSelection();
  if (!isRuntimeId(value.runtime) || !text(value.connectionId)) return null;
  return {
    runtime: value.runtime,
    connectionId: value.connectionId as string,
    model: text(value.model) ?? "inherit",
    effort: text(value.effort) ?? "inherit",
  };
}

/** Whether the user has picked a runtime for this chat. */
export function hasRuntimeSelection(sessionId: string): boolean {
  try {
    return prefs.get(storageKey(SELECTION_PREFIX, sessionId)) !== null;
  } catch {
    return false;
  }
}

/** The runtime the user last picked in any chat, for a chat that has none yet. */
export function loadLastRuntimeSelection(): RuntimeChatSelection | null {
  try {
    return parseSelection(prefs.get(LAST_SELECTION_KEY));
  } catch {
    return null;
  }
}

const RUNTIME_ORDER: RuntimeId[] = ["codex", "claude", "antigravity"];

/**
 * A new chat starts where the user last was, if that still works; otherwise
 * on the Legacy API when it has an endpoint, otherwise on the first runtime
 * that is ready. Starting every chat on a Legacy API with no endpoint made
 * a fresh install fail its first message.
 */
export function defaultRuntimeSelection(input: {
  last: RuntimeChatSelection | null;
  legacyAvailable: boolean;
  report: RuntimeDiscoveryReport | null;
}): RuntimeChatSelection {
  const ready = (runtime: RuntimeId) => input.report?.runtimes.find((item) => item.runtime === runtime && item.status === "ready");
  const last = input.last;
  if (last?.runtime === "legacy" && input.legacyAvailable) return last;
  if (last && last.runtime !== "legacy" && ready(last.runtime)) return last;
  if (input.legacyAvailable) return legacyRuntimeSelection();
  for (const runtime of RUNTIME_ORDER) {
    const detection = ready(runtime);
    if (detection) {
      return { runtime, connectionId: detection.catalog?.connectionId ?? `runtime:${runtime}`, model: "inherit", effort: "inherit" };
    }
  }
  return legacyRuntimeSelection();
}

/**
 * Whether the default above can still change once discovery answers. Until
 * then its Legacy API fallback is only a placeholder, and the chat shows that
 * it is detecting instead of offering a pick that is about to switch.
 */
export function defaultAwaitsDiscovery(input: {
  last: RuntimeChatSelection | null;
  legacyAvailable: boolean;
  report: RuntimeDiscoveryReport | null;
  loading: boolean;
}): boolean {
  if (input.report || !input.loading) return false;
  const legacySettled = input.legacyAvailable && (!input.last || input.last.runtime === "legacy");
  return !legacySettled;
}

export function loadRuntimeSelection(sessionId: string): RuntimeChatSelection {
  try {
    const raw = prefs.get(storageKey(SELECTION_PREFIX, sessionId));
    if (!raw) return legacyRuntimeSelection();
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.runtime === "legacy") return legacyRuntimeSelection();
    if (!isRuntimeId(value.runtime) || !text(value.connectionId)) return legacyRuntimeSelection();
    return {
      runtime: value.runtime,
      connectionId: value.connectionId as string,
      model: text(value.model) ?? "inherit",
      effort: text(value.effort) ?? "inherit",
    };
  } catch {
    return legacyRuntimeSelection();
  }
}

export function saveRuntimeSelection(sessionId: string, selection: RuntimeChatSelection): void {
  try {
    prefs.set(storageKey(SELECTION_PREFIX, sessionId), JSON.stringify(selection));
    prefs.set(LAST_SELECTION_KEY, JSON.stringify(selection));
  } catch {
    // Runtime selection is a convenience; a storage failure must not block chat.
  }
}

/**
 * The runtime the user picked to write this project's Plan, PRD, and tasks,
 * or null until they pick one; the caller then follows the chat's runtime.
 */
export function loadPipelineSelection(sessionId: string): RuntimeChatSelection | null {
  try {
    return parseSelection(prefs.get(storageKey(PIPELINE_SELECTION_PREFIX, sessionId)));
  } catch {
    return null;
  }
}

export function savePipelineSelection(sessionId: string, selection: RuntimeChatSelection): void {
  try {
    prefs.set(storageKey(PIPELINE_SELECTION_PREFIX, sessionId), JSON.stringify(selection));
  } catch {
    // Like the chat's pick, this is a convenience; generation still runs.
  }
}

export function loadExternalRuntimeSession(
  sessionId: string,
  runtime: RuntimeId,
  conversationId: string,
): string | null {
  try {
    return text(prefs.get(storageKey(EXTERNAL_SESSION_PREFIX, sessionId, runtime, conversationId)));
  } catch {
    return null;
  }
}

export function saveExternalRuntimeSession(
  sessionId: string,
  runtime: RuntimeId,
  conversationId: string,
  externalSessionId: string,
): void {
  try {
    prefs.set(
      storageKey(EXTERNAL_SESSION_PREFIX, sessionId, runtime, conversationId),
      externalSessionId,
    );
  } catch {
    // Provider session resume is best effort; the server can create a new one.
  }
}

export interface RuntimeChatEvent {
  type: string;
  [key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Normalize runtime adapter events to the event names already rendered by the chat UI. */
export function normalizeRuntimeChatEvent(value: unknown): RuntimeChatEvent | null {
  const source = record(value);
  if (!source) return null;
  const nested = record(source.payload) ?? record(source.event);
  const event = nested && !text(source.type) ? nested : source;
  const kind = text(event.type) ?? text(event.event) ?? text(event.name);
  if (!kind) return null;

  if (kind === "session_started" || kind === "session_start" || kind === "thread_started" || kind === "runtime_session") {
    const externalSessionId = text(event.externalSessionId)
      ?? text(event.sessionId)
      ?? text(event.threadId)
      ?? text(event.conversationId);
    return externalSessionId ? { type: "runtime_session", externalSessionId } : null;
  }
  if (kind === "assistant") {
    const assistantText = text(event.text) ?? text(event.delta);
    return assistantText ? { type: "text", text: assistantText } : null;
  }
  if (kind === "tool") {
    const phase = text(event.phase) ?? text(event.status);
    if (phase === "start" || phase === "started" || phase === "running") {
      return {
        type: "tool_start",
        id: text(event.id) ?? text(event.toolUseId) ?? undefined,
        tool: text(event.tool) ?? text(event.toolName) ?? "tool",
        input: event.input ?? event.data,
      };
    }
    return {
      type: "tool_done",
      id: text(event.id) ?? text(event.toolUseId) ?? undefined,
      tool: text(event.tool) ?? text(event.toolName) ?? "tool",
      result: event.result ?? event.data,
      isError: event.isError === true || phase === "error" || phase === "failed",
    };
  }
  if (kind === "approval") {
    return {
      type: "approval_request",
      elicitId: text(event.elicitId) ?? text(event.requestId) ?? undefined,
      approvalId: text(event.approvalId) ?? undefined,
      command: text(event.command) ?? "",
      cwd: text(event.cwd) ?? undefined,
    };
  }
  if (kind === "error") {
    const error = record(event.error);
    const code = text(event.code) ?? text(error?.code);
    return {
      type: "error",
      message: text(event.message) ?? text(error?.message) ?? "The runtime is unreachable.",
      ...(code ? { code } : {}),
      retryable: event.retryable !== false && event.fatal !== true,
    };
  }
  if (kind === "result") {
    const error = record(event.error);
    if (error || event.status === "error" || event.status === "failed") {
      const code = text(error?.code);
      return {
        type: "error",
        message: text(error?.message) ?? text(event.response) ?? "The runtime failed.",
        ...(code ? { code } : {}),
        retryable: false,
      };
    }
    return { type: "done" };
  }
  if (kind === "done" || kind === "completed" || kind === "turn_completed") {
    const error = record(event.error);
    if (event.status === "failed" || event.status === "error" || error) {
      const code = text(error?.code);
      return {
        type: "error",
        message: text(error?.message) ?? "The runtime failed.",
        ...(code ? { code } : {}),
        retryable: false,
      };
    }
    // The chat route ends every run with done and says how it ended; the
    // reason for a failure has already arrived as its own error event.
    const runStatus = text(event.runStatus);
    return runStatus ? { type: "done", runStatus } : { type: "done" };
  }
  return { ...event, type: kind };
}
