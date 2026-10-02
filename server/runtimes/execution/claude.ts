/**
 * Claude Code execution boundary.
 *
 * This file deliberately does not import `@anthropic-ai/claude-agent-sdk`.
 * The application injects the official SDK's `query` function at startup.
 * Keeping that dependency at the boundary lets the runtime contract and its
 * tests work before the SDK is installed, and avoids a second provider loop.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClaudeSdkValue = Record<string, unknown>;

export interface ClaudeSdkQuery {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  interrupt?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
  return?: (value?: unknown) => void | Promise<IteratorResult<unknown>>;
}

/** Structural shape of the official Agent SDK `query({ prompt, options })` API. */
export type ClaudeSdkQueryFactory = (request: {
  prompt: string;
  options?: ClaudeSdkQueryOptions;
}) => ClaudeSdkQuery;

/** Accept either the SDK's named `query` export or an injected query function. */
export interface ClaudeAgentSdkFactory {
  query: ClaudeSdkQueryFactory;
}

export type ClaudeAgentSdkFactoryLike = ClaudeAgentSdkFactory | ClaudeSdkQueryFactory;

export interface ClaudeSdkQueryOptions extends Record<string, unknown> {
  /** The SDK uses this callback for tool permission decisions. */
  canUseTool: ClaudeSdkCanUseTool;
  /** Required for assistant text deltas from `stream_event` messages. */
  includePartialMessages: true;
  cwd?: string;
  model?: string;
  effort?: string;
  resume?: string;
  env?: Record<string, string | undefined>;
  settingSources?: string[];
  settings?: Record<string, unknown>;
}

export interface ClaudeSdkPermissionDetails extends Record<string, unknown> {
  toolUseID?: string;
  toolUseId?: string;
  decisionReason?: string;
  blockedPath?: string;
}

export interface ClaudeSdkPermissionAllow {
  behavior: "allow";
  updatedInput?: unknown;
}

export interface ClaudeSdkPermissionDeny {
  behavior: "deny";
  message: string;
}

export type ClaudeSdkPermissionResult = ClaudeSdkPermissionAllow | ClaudeSdkPermissionDeny;

export type ClaudeSdkCanUseTool = (
  toolName: string,
  input: unknown,
  options?: ClaudeSdkPermissionDetails,
) => ClaudeSdkPermissionResult | Promise<ClaudeSdkPermissionResult>;

export interface ClaudeApprovalRequest {
  kind: "approval";
  toolName: string;
  toolUseId: string | null;
  input: unknown;
  reason: string | null;
  blockedPath: string | null;
}

export interface ClaudeInputRequest {
  kind: "input";
  toolName: string;
  toolUseId: string | null;
  input: unknown;
  reason: string | null;
}

export interface ClaudeInputResponse {
  /** Input sent back to the SDK's tool after the user answers. */
  updatedInput?: unknown;
  /** Convenience shape for question tools. */
  answers?: unknown;
  value?: unknown;
}

export type ClaudeApprovalResponse =
  | boolean
  | ClaudeSdkPermissionResult
  | { approved: boolean; message?: string; updatedInput?: unknown }
  | { decision: "allow" | "deny"; message?: string; updatedInput?: unknown }
  | undefined;

export type ClaudeInputCallbackResponse = ClaudeInputResponse | ClaudeApprovalResponse;

export interface ClaudeExecutionCallbacks {
  /** Called before a normal Claude Code tool is allowed to execute. */
  onApproval?: (request: ClaudeApprovalRequest) => ClaudeApprovalResponse | Promise<ClaudeApprovalResponse>;
  /** Alias useful to callers that name callbacks after SDK requests. */
  onApprovalRequest?: (request: ClaudeApprovalRequest) => ClaudeApprovalResponse | Promise<ClaudeApprovalResponse>;
  /** Called for AskUserQuestion/elicitation-style tool requests. */
  onInput?: (request: ClaudeInputRequest) => ClaudeInputCallbackResponse | Promise<ClaudeInputCallbackResponse>;
  /** Alias useful to callers that name callbacks after SDK requests. */
  onInputRequest?: (request: ClaudeInputRequest) => ClaudeInputCallbackResponse | Promise<ClaudeInputCallbackResponse>;
  /** Receives every normalized event emitted by a run. */
  onEvent?: (event: ClaudeExecutionEvent) => void | Promise<void>;
}

export interface ClaudeExecutionRequest extends ClaudeExecutionCallbacks {
  prompt: string;
  /** A non-empty path explicitly selected for this run. Empty means inherit. */
  cwd?: string | null;
  /** The literal `inherit` (or omission) leaves model resolution to Claude. */
  model?: string | null;
  /** The literal `inherit` (or omission) leaves effort resolution to Claude. */
  effort?: string | null;
  /** Used by `start` only when the caller explicitly wants to resume. */
  resumeSessionId?: string | null;
  /**
   * Read none of the user's settings files, so no CLAUDE.md, hooks, skills,
   * plugins, MCP servers or language reach the run. Only the keys that sign
   * in and pick the default model carry over (see carriedClaudeSettings).
   */
  isolateSettings?: boolean;
  signal?: AbortSignal;
}

export interface ClaudeAssistantContentText {
  type: "text";
  text: string;
}

export interface ClaudeAssistantContentTool {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type ClaudeAssistantContent = ClaudeAssistantContentText | ClaudeAssistantContentTool;

export interface ClaudeAssistantEvent {
  type: "assistant";
  messageId: string | null;
  sessionId: string | null;
  /** Present for a partial text stream event. */
  delta?: string;
  /** Present for a complete assistant message. */
  text?: string;
  content?: ClaudeAssistantContent[];
  parentToolUseId?: string | null;
  /** The SDK's reason when this message reports a failed API call. */
  error?: string;
}

export interface ClaudeToolEvent {
  type: "tool";
  phase: "start" | "update" | "result";
  toolUseId: string | null;
  toolName: string | null;
  input?: unknown;
  inputDelta?: string;
  result?: unknown;
  isError?: boolean;
  parentToolUseId?: string | null;
}

export interface ClaudeProgressEvent {
  type: "progress";
  phase: string;
  message?: string;
  toolUseId?: string | null;
  toolName?: string | null;
  elapsedTimeSeconds?: number;
  data?: unknown;
}

export interface ClaudeResultEvent {
  type: "result";
  subtype: string;
  status: "success" | "error" | "partial";
  sessionId: string | null;
  result?: unknown;
  isError: boolean;
  /** HTTP status of the API call that failed, when the SDK reports one. */
  apiErrorStatus?: number;
  usage?: unknown;
  errors?: unknown;
}

export interface ClaudeInputEvent {
  type: "input_request";
  request: ClaudeInputRequest;
}

export interface ClaudeApprovalEvent {
  type: "approval_request";
  request: ClaudeApprovalRequest;
}

export type ClaudeExecutionErrorCode =
  | "INVALID_REQUEST"
  | "SDK_ERROR"
  | "SDK_UNAVAILABLE"
  | "MALFORMED_EVENT"
  | "ABORTED"
  | "INTERRUPT_UNSUPPORTED"
  | "INTERRUPT_FAILED"
  | "CLOSE_FAILED"
  | "PERMISSION_DENIED";

export interface ClaudeExecutionErrorShape {
  code: ClaudeExecutionErrorCode;
  message: string;
  phase: "request" | "stream" | "permission" | "interrupt" | "close";
  retryable: boolean;
  providerCode?: string;
}

export interface ClaudeErrorEvent {
  type: "error";
  error: ClaudeExecutionErrorShape;
}

export type ClaudeExecutionEvent =
  | ClaudeAssistantEvent
  | ClaudeToolEvent
  | ClaudeProgressEvent
  | ClaudeResultEvent
  | ClaudeInputEvent
  | ClaudeApprovalEvent
  | ClaudeErrorEvent;

export interface ClaudeExecutionRun extends AsyncIterable<ClaudeExecutionEvent> {
  /** Provider session ID, populated as soon as an SDK message reports it. */
  readonly sessionId: string | null;
  /** Resolves when the first session ID is known or the stream ends. */
  readonly sessionReady: Promise<string | null>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface ClaudeExecutionAdapterOptions {
  factory: ClaudeAgentSdkFactoryLike;
  callbacks?: ClaudeExecutionCallbacks;
  /**
   * Claude Code binary to drive. Without it the SDK falls back to the copy it
   * vendors, which is not the installation discovery found and reported the
   * version of — so the app would run a different build than it displays.
   */
  executablePath?: string | null;
}

const INHERIT = "inherit";
const INPUT_TOOL_NAMES = new Set([
  "askuserquestion",
  "ask_user_question",
  "ask-user-question",
  "elicitation",
  "request_input",
  "input_request",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function selected(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.trim().toLowerCase() !== INHERIT;
}

function safeProviderCode(value: unknown): string | undefined {
  if (typeof value === "string" && /^[A-Z0-9_.-]+$/i.test(value)) return value.toUpperCase();
  if (typeof value === "number" && Number.isFinite(value)) return `PROVIDER_${value}`;
  return undefined;
}

function safeMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message.trim()) return fallback;
  // Provider errors can contain a credential or a full request. Keep the
  // useful diagnostic bounded and redact common API-key-shaped substrings.
  return message
    .replace(/(?:sk-ant|sk)-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .slice(0, 1_000);
}

function errorShape(
  code: ClaudeExecutionErrorCode,
  phase: ClaudeExecutionErrorShape["phase"],
  error: unknown,
  fallback: string,
): ClaudeExecutionErrorShape {
  const item = record(error);
  const providerCode = safeProviderCode(item?.code);
  return {
    code,
    message: safeMessage(error, fallback),
    phase,
    retryable: code === "SDK_ERROR" || code === "CLOSE_FAILED" || code === "INTERRUPT_FAILED",
    ...(providerCode ? { providerCode } : {}),
  };
}

function errorEvent(
  code: ClaudeExecutionErrorCode,
  phase: ClaudeExecutionErrorShape["phase"],
  error: unknown,
  fallback: string,
): ClaudeErrorEvent {
  return { type: "error", error: errorShape(code, phase, error, fallback) };
}

function toolUseId(value: Record<string, unknown>): string | null {
  return nonEmptyString(value.toolUseID ?? value.toolUseId ?? value.id ?? value.tool_use_id);
}

function sessionId(value: Record<string, unknown>): string | null {
  return nonEmptyString(value.session_id ?? value.sessionId);
}

function messageId(value: Record<string, unknown>): string | null {
  return nonEmptyString(value.message_id ?? value.messageId ?? value.id);
}

function toolName(value: Record<string, unknown>): string | null {
  return nonEmptyString(value.tool_name ?? value.toolName ?? value.name);
}

function subtype(value: Record<string, unknown>): string {
  return nonEmptyString(value.subtype ?? value.stop_reason ?? value.stopReason) ?? "unknown";
}

function contentBlocks(value: unknown): ClaudeAssistantContent[] {
  if (!Array.isArray(value)) return [];
  const result: ClaudeAssistantContent[] = [];
  for (const block of value) {
    const item = record(block);
    if (!item) continue;
    const type = nonEmptyString(item.type);
    if (type === "text") {
      const text = typeof item.text === "string" ? item.text : "";
      if (text) result.push({ type: "text", text });
      continue;
    }
    if (type === "tool_use" || type === "server_tool_use") {
      const id = nonEmptyString(item.id);
      const name = nonEmptyString(item.name);
      if (id && name) result.push({ type: "tool_use", id, name, input: item.input ?? {} });
    }
  }
  return result;
}

function textFromContent(content: ClaudeAssistantContent[]): string {
  return content.filter((block): block is ClaudeAssistantContentText => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function isInputTool(name: string): boolean {
  return INPUT_TOOL_NAMES.has(name.replace(/\s+/g, "").toLowerCase()) || INPUT_TOOL_NAMES.has(name.toLowerCase());
}

/**
 * Normalize one SDK message. Unknown but valid SDK messages are ignored: the
 * SDK adds message types over time and they must not terminate a run.
 * Malformed objects become a stable error event instead.
 */
const PROVIDER_TEXT_LIMIT = 500;

function providerText(value: unknown): string | null {
  const text = nonEmptyString(Array.isArray(value) ? value.find((item) => nonEmptyString(item)) : value);
  if (!text) return null;
  return text.length > PROVIDER_TEXT_LIMIT ? `${text.slice(0, PROVIDER_TEXT_LIMIT)}…` : text;
}

/**
 * Why a Claude turn failed, worded so the user knows what to do next. The
 * SDK says so on the failed assistant message (`error`), on the result
 * (`api_error_status`, an `error_*` subtype, `errors`), or only in text.
 */
export function describeClaudeFailure(failure: {
  assistantError?: string | null;
  apiErrorStatus?: number | null;
  subtype?: string | null;
  errors?: unknown;
  resultText?: unknown;
}): { code: string; message: string } {
  const reason = failure.assistantError ?? null;
  const status = failure.apiErrorStatus ?? null;
  const detail = providerText(failure.errors) ?? providerText(failure.resultText);
  if (reason === "authentication_failed" || reason === "verification_required" || status === 401) {
    return { code: "CLAUDE_AUTH_REQUIRED", message: "Claude Code is not signed in, or its login expired. Run `claude` in a terminal, sign in with /login, then try again." };
  }
  if (reason === "oauth_org_not_allowed" || status === 403) {
    return { code: "CLAUDE_ACCESS_DENIED", message: "This Claude account is not allowed to use Claude Code. Sign in with another account (`claude`, then /login), then try again." };
  }
  if (reason === "account_on_hold") {
    return { code: "CLAUDE_ACCOUNT_ON_HOLD", message: "The Claude account is on hold. Check the account at claude.ai, then try again." };
  }
  if (reason === "billing_error" || status === 402) {
    return { code: "CLAUDE_BILLING", message: "Claude could not run because of a billing problem on the account. Check its plan or credits, then try again." };
  }
  if (reason === "rate_limit" || status === 429) {
    return { code: "CLAUDE_RATE_LIMITED", message: "Claude's usage limit was reached. Wait for it to reset, or choose another model, then try again." };
  }
  if (reason === "overloaded" || reason === "server_error" || status === 529 || (status !== null && status >= 500)) {
    return { code: "CLAUDE_UNAVAILABLE", message: "Claude is overloaded or failing right now. Try again in a moment." };
  }
  if (reason === "model_not_found" || status === 404) {
    return { code: "CLAUDE_MODEL_UNAVAILABLE", message: "The selected model is not available to this Claude account. Choose another model, then try again." };
  }
  if (reason === "cloud_credential_error") {
    return { code: "CLAUDE_CLOUD_CREDENTIALS", message: "Claude could not use its configured cloud credentials (Bedrock or Vertex). Check them, then try again." };
  }
  if (reason === "max_output_tokens") {
    return { code: "CLAUDE_OUTPUT_LIMIT", message: "Claude's reply hit the output length limit before it finished." };
  }
  if (failure.subtype === "error_max_turns") {
    return { code: "CLAUDE_MAX_TURNS", message: "Claude stopped after reaching its turn limit before finishing the task." };
  }
  if (failure.subtype === "error_max_budget_usd") {
    return { code: "CLAUDE_MAX_BUDGET", message: "Claude stopped after reaching its spending limit for this run." };
  }
  return {
    code: "CLAUDE_RESULT_ERROR",
    message: detail ?? "Claude Agent SDK returned an unsuccessful result.",
  };
}

export function normalizeClaudeSdkMessage(value: unknown): ClaudeExecutionEvent[] {
  const item = record(value);
  if (!item) return [errorEvent("MALFORMED_EVENT", "stream", value, "Claude SDK emitted a malformed event.")];
  const type = nonEmptyString(item.type);
  if (!type) return [errorEvent("MALFORMED_EVENT", "stream", value, "Claude SDK event has no type.")];

  if (type === "assistant") {
    const message = record(item.message) ?? item;
    const content = contentBlocks(message.content);
    const text = textFromContent(content);
    const events: ClaudeExecutionEvent[] = [{
      type: "assistant",
      messageId: messageId(message),
      sessionId: sessionId(item) ?? sessionId(message),
      ...(text ? { text } : {}),
      ...(content.length ? { content } : {}),
      ...(nonEmptyString(item.parent_tool_use_id ?? item.parentToolUseId)
        ? { parentToolUseId: nonEmptyString(item.parent_tool_use_id ?? item.parentToolUseId) }
        : {}),
      ...(nonEmptyString(item.error) ? { error: nonEmptyString(item.error)! } : {}),
    }];
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      events.push({
        type: "tool",
        phase: "start",
        toolUseId: block.id,
        toolName: block.name,
        input: block.input,
        parentToolUseId: nonEmptyString(item.parent_tool_use_id ?? item.parentToolUseId),
      });
    }
    return events;
  }

  if (type === "stream_event") {
    const stream = record(item.event);
    if (!stream) return [errorEvent("MALFORMED_EVENT", "stream", value, "Claude SDK stream event is malformed.")];
    const delta = record(stream.delta);
    if (stream.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
      return [{
        type: "assistant",
        messageId: messageId(stream) ?? messageId(item),
        sessionId: sessionId(item) ?? sessionId(stream),
        delta: delta.text,
      }];
    }
    // Tool calls are taken from the complete assistant message instead: a
    // streamed block has no input yet and its deltas carry no tool id.
    return [];
  }

  if (type === "tool_progress") {
    return [{
      type: "progress",
      phase: "tool",
      toolUseId: toolUseId(item),
      toolName: toolName(item),
      ...(typeof item.elapsed_time_seconds === "number" ? { elapsedTimeSeconds: item.elapsed_time_seconds } : {}),
      ...(item.output !== undefined ? { data: item.output } : {}),
    }];
  }

  if (type === "result") {
    const status = subtype(item) === "success" ? "success" : (item.is_error || item.isError ? "error" : "partial");
    const apiErrorStatus = typeof item.api_error_status === "number" ? item.api_error_status : undefined;
    return [{
      type: "result",
      subtype: subtype(item),
      status,
      sessionId: sessionId(item),
      ...(item.result !== undefined ? { result: item.result } : {}),
      // A failed API call, such as an expired login, still arrives with
      // subtype "success"; is_error is what says it failed.
      isError: status === "error" || item.is_error === true || item.isError === true,
      ...(apiErrorStatus !== undefined ? { apiErrorStatus } : {}),
      ...(item.usage !== undefined ? { usage: item.usage } : {}),
      ...(item.errors !== undefined ? { errors: item.errors } : {}),
    }];
  }

  if (type === "tool_use" || type === "server_tool_use") {
    return [{
      type: "tool",
      phase: "start",
      toolUseId: toolUseId(item),
      toolName: toolName(item),
      input: item.input ?? {},
      parentToolUseId: nonEmptyString(item.parent_tool_use_id ?? item.parentToolUseId),
    }];
  }

  // The SDK returns tool results inside the next user message.
  if (type === "user") {
    const message = record(item.message) ?? item;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const events: ClaudeExecutionEvent[] = [];
    for (const value of blocks) {
      const block = record(value);
      if (block?.type !== "tool_result") continue;
      events.push({
        type: "tool",
        phase: "result",
        toolUseId: nonEmptyString(block.tool_use_id),
        toolName: null,
        result: block.content,
        isError: block.is_error === true,
        parentToolUseId: nonEmptyString(item.parent_tool_use_id ?? item.parentToolUseId),
      });
    }
    return events;
  }

  if (type === "tool_result" || type === "server_tool_result") {
    return [{
      type: "tool",
      phase: "result",
      toolUseId: toolUseId(item),
      toolName: toolName(item),
      ...(item.result !== undefined ? { result: item.result } : { result: item.content }),
      ...(item.is_error !== undefined || item.isError !== undefined
        ? { isError: Boolean(item.is_error ?? item.isError) }
        : {}),
    }];
  }

  if (type === "input_request" || type === "elicitation") {
    const request: ClaudeInputRequest = {
      kind: "input",
      toolName: toolName(item) ?? "input",
      toolUseId: toolUseId(item),
      input: item.input ?? item.request ?? item,
      reason: nonEmptyString(item.reason ?? item.message),
    };
    return [{ type: "input_request", request }];
  }

  if (type === "permission_request" || type === "approval_request") {
    const request: ClaudeApprovalRequest = {
      kind: "approval",
      toolName: toolName(item) ?? "unknown",
      toolUseId: toolUseId(item),
      input: item.input,
      reason: nonEmptyString(item.reason ?? item.message),
      blockedPath: nonEmptyString(item.blockedPath ?? item.blocked_path),
    };
    return [{ type: "approval_request", request }];
  }

  if (type === "system" || type === "rate_limit_event" || type === "hook_response" || type === "task_started") {
    return [{
      type: "progress",
      phase: type,
      ...(nonEmptyString(item.message) ? { message: nonEmptyString(item.message)! } : {}),
      ...(sessionId(item) ? { data: { sessionId: sessionId(item) } } : {}),
    }];
  }

  // ping, user, and future SDK messages carry no Undagi execution event.
  return [];
}

function permissionDetails(value: ClaudeSdkPermissionDetails | undefined): {
  toolUseId: string | null;
  reason: string | null;
  blockedPath: string | null;
} {
  return {
    toolUseId: nonEmptyString(value?.toolUseID ?? value?.toolUseId),
    reason: nonEmptyString(value?.decisionReason),
    blockedPath: nonEmptyString(value?.blockedPath),
  };
}

function approvalResult(
  response: ClaudeApprovalResponse,
  input: unknown,
): ClaudeSdkPermissionResult {
  if (response === true) return { behavior: "allow", updatedInput: input };
  if (response === false || response === undefined) return { behavior: "deny", message: "Permission denied by Undagi." };
  if (response && typeof response === "object" && "behavior" in response) {
    if (response.behavior === "allow") return { behavior: "allow", updatedInput: response.updatedInput ?? input };
    return { behavior: "deny", message: response.message || "Permission denied by Undagi." };
  }
  if (response && typeof response === "object" && "approved" in response) {
    return response.approved
      ? { behavior: "allow", updatedInput: response.updatedInput ?? input }
      : { behavior: "deny", message: response.message || "Permission denied by Undagi." };
  }
  if (response && typeof response === "object" && "decision" in response) {
    return response.decision === "allow"
      ? { behavior: "allow", updatedInput: response.updatedInput ?? input }
      : { behavior: "deny", message: response.message || "Permission denied by Undagi." };
  }
  return { behavior: "deny", message: "Permission denied by Undagi." };
}

function inputResult(response: ClaudeInputCallbackResponse, input: unknown): ClaudeSdkPermissionResult {
  if (typeof response === "boolean" || response === undefined) {
    return approvalResult(response as ClaudeApprovalResponse, input);
  }
  if (response && typeof response === "object") {
    const item = response as Record<string, unknown>;
    if (item.behavior === "allow" || item.behavior === "deny"
      || typeof item.approved === "boolean" || item.decision === "allow" || item.decision === "deny") {
      return approvalResult(response as ClaudeApprovalResponse, input);
    }
    const value = item.updatedInput ?? item.answers ?? item.value;
    return value === undefined
      ? { behavior: "deny", message: "Input was not provided." }
      : { behavior: "allow", updatedInput: value };
  }
  return { behavior: "deny", message: "Input was not provided." };
}

/**
 * Build SDK options while preserving runtime defaults. In particular, this
 * function never sets `permissionMode: bypassPermissions` or an equivalent
 * dangerous flag.
 */
// With settingSources: [] Claude Code reads no settings file, so a user who
// signs in through settings.json (an apiKeyHelper, a cloud credential helper,
// or ANTHROPIC_* variables under env) would be signed out. These keys carry
// over through the SDK's flag settings; `model` keeps "runtime default"
// meaning the model the user chose. Everything else stays behind.
const CARRIED_SETTINGS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "env", "model"];

export function carriedClaudeSettings(
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
): Record<string, unknown> | undefined {
  let settings: unknown;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  const source = settings as Record<string, unknown>;
  const carried = Object.fromEntries(CARRIED_SETTINGS.filter((key) => key in source).map((key) => [key, source[key]]));
  return Object.keys(carried).length > 0 ? carried : undefined;
}

export function buildClaudeSdkOptions(
  request: Pick<ClaudeExecutionRequest, "cwd" | "model" | "effort" | "resumeSessionId" | "isolateSettings">,
  callbacks: ClaudeExecutionCallbacks = {},
): ClaudeSdkQueryOptions {
  const options: ClaudeSdkQueryOptions = {
    includePartialMessages: true,
    // Each turn is its own Claude Code process, closed when the turn ends, so
    // a background command dies with it. Its "stopped" notice then opened the
    // next turn and ended it early: the SDK closed the permission channel and
    // the turn's first tool failed with "Stream closed" (seen live).
    env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    // A missing callback is a safe denial. Leaving the callback out would let
    // the SDK choose a native permission mode unknown to the host application.
    canUseTool: async (name, input, details) => {
      const metadata = permissionDetails(details);
      if (isInputTool(name)) {
        const handler = callbacks.onInput ?? callbacks.onInputRequest;
        if (handler) {
          try {
            const response = await handler({
              kind: "input",
              toolName: name,
              toolUseId: metadata.toolUseId,
              input,
              reason: metadata.reason,
            });
            return inputResult(response, input);
          } catch {
            return { behavior: "deny", message: "Input callback failed; permission denied." };
          }
        }
      }
      const handler = callbacks.onApproval ?? callbacks.onApprovalRequest;
      if (!handler) return { behavior: "deny", message: "Permission denied by Undagi." };
      try {
        return approvalResult(await handler({
          kind: "approval",
          toolName: name,
          toolUseId: metadata.toolUseId,
          input,
          reason: metadata.reason,
          blockedPath: metadata.blockedPath,
        }), input);
      } catch {
        return { behavior: "deny", message: "Approval callback failed; permission denied." };
      }
    },
  };
  if (selected(request.cwd)) options.cwd = request.cwd;
  if (selected(request.model)) options.model = request.model;
  if (selected(request.effort)) options.effort = request.effort;
  if (selected(request.resumeSessionId)) options.resume = request.resumeSessionId;
  if (request.isolateSettings) {
    options.settingSources = [];
    const carried = carriedClaudeSettings();
    if (carried) options.settings = carried;
  }
  return options;
}

function queryFactory(factory: ClaudeAgentSdkFactoryLike): ClaudeSdkQueryFactory {
  if (typeof factory === "function") return factory;
  if (factory && typeof factory.query === "function") return factory.query.bind(factory);
  throw new Error("Claude Agent SDK query factory is not configured.");
}

class ClaudeExecutionRunImpl implements ClaudeExecutionRun {
  private providerSessionId: string | null = null;
  private consumed = false;
  private closed = false;
  private readonly readyPromise: Promise<string | null>;
  private resolveReady!: (value: string | null) => void;
  private readonly abortListener?: () => void;

  constructor(
    private readonly query: ClaudeSdkQuery | null,
    private readonly startupError: ClaudeErrorEvent | null,
    private readonly callbacks: ClaudeExecutionCallbacks,
    signal?: AbortSignal,
  ) {
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
    if (signal) {
      this.abortListener = () => { void this.interrupt(); };
      if (signal.aborted) this.abortListener();
      else signal.addEventListener("abort", this.abortListener, { once: true });
    }
  }

  get sessionId(): string | null { return this.providerSessionId; }
  get sessionReady(): Promise<string | null> { return this.readyPromise; }

  private observe(event: ClaudeExecutionEvent): void {
    const id = event.type === "result"
      ? event.sessionId
      : event.type === "assistant" ? event.sessionId : null;
    if (id && !this.providerSessionId) {
      this.providerSessionId = id;
      this.resolveReady(id);
    }
    if (event.type === "progress" && record(event.data)?.sessionId && !this.providerSessionId) {
      const progressId = nonEmptyString(record(event.data)?.sessionId);
      if (progressId) {
        this.providerSessionId = progressId;
        this.resolveReady(progressId);
      }
    }
  }

  private async notify(event: ClaudeExecutionEvent): Promise<void> {
    this.observe(event);
    if (this.callbacks.onEvent) await this.callbacks.onEvent(event);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ClaudeExecutionEvent> {
    if (this.consumed) {
      yield errorEvent("SDK_ERROR", "stream", undefined, "Claude execution streams can only be consumed once.");
      return;
    }
    this.consumed = true;
    try {
      if (this.startupError) {
        await this.notify(this.startupError);
        yield this.startupError;
        return;
      }
      if (!this.query) {
        const event = errorEvent("SDK_UNAVAILABLE", "request", undefined, "Claude Agent SDK query is unavailable.");
        await this.notify(event);
        yield event;
        return;
      }
      for await (const raw of this.query) {
        const events = normalizeClaudeSdkMessage(raw);
        for (const event of events) {
          await this.notify(event);
          yield event;
        }
      }
    } catch (error) {
      const event = errorEvent(
        this.closed ? "CLOSE_FAILED" : "SDK_ERROR",
        "stream",
        error,
        "Claude Agent SDK execution failed.",
      );
      await this.notify(event);
      yield event;
    } finally {
      this.resolveReady(this.providerSessionId);
    }
  }

  async interrupt(): Promise<void> {
    if (this.closed || !this.query) return;
    if (typeof this.query.interrupt !== "function") {
      throw new ClaudeExecutionError("INTERRUPT_UNSUPPORTED", "Claude Agent SDK query does not support interrupt.", "interrupt");
    }
    try {
      await this.query.interrupt();
    } catch (error) {
      throw new ClaudeExecutionError("INTERRUPT_FAILED", safeMessage(error, "Claude Agent SDK interrupt failed."), "interrupt");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.query?.close) await this.query.close();
      else if (this.query?.return) await this.query.return();
    } catch (error) {
      throw new ClaudeExecutionError("CLOSE_FAILED", safeMessage(error, "Claude Agent SDK close failed."), "close");
    } finally {
      this.resolveReady(this.providerSessionId);
    }
  }
}

export class ClaudeExecutionError extends Error {
  readonly code: ClaudeExecutionErrorCode;
  readonly phase: ClaudeExecutionErrorShape["phase"];

  constructor(code: ClaudeExecutionErrorCode, message: string, phase: ClaudeExecutionErrorShape["phase"]) {
    super(message);
    this.name = "ClaudeExecutionError";
    this.code = code;
    this.phase = phase;
  }
}

export class ClaudeExecutionAdapter {
  private readonly factory: ClaudeSdkQueryFactory;
  private readonly defaultCallbacks: ClaudeExecutionCallbacks;
  private readonly executablePath: string | null;

  constructor(options: ClaudeExecutionAdapterOptions | ClaudeAgentSdkFactoryLike) {
    const config = typeof options === "function" || typeof (options as ClaudeAgentSdkFactory)?.query === "function"
      ? { factory: options as ClaudeAgentSdkFactoryLike }
      : options as ClaudeExecutionAdapterOptions;
    this.factory = queryFactory(config.factory);
    this.defaultCallbacks = config.callbacks ?? {};
    this.executablePath = config.executablePath ?? null;
  }

  /** Start a fresh Claude Code conversation. */
  start(request: ClaudeExecutionRequest): ClaudeExecutionRun {
    return this.open(request, undefined);
  }

  /** Resume an existing provider conversation by its native session ID. */
  resume(sessionIdValue: string, request: Omit<ClaudeExecutionRequest, "resumeSessionId">): ClaudeExecutionRun {
    if (!selected(sessionIdValue)) {
      return new ClaudeExecutionRunImpl(
        null,
        errorEvent("INVALID_REQUEST", "request", undefined, "A non-empty Claude session ID is required to resume."),
        this.defaultCallbacks,
      );
    }
    return this.open({ ...request, resumeSessionId: sessionIdValue }, sessionIdValue);
  }

  private open(request: ClaudeExecutionRequest, _resumedSessionId: string | undefined): ClaudeExecutionRun {
    const callbacks: ClaudeExecutionCallbacks = {
      ...this.defaultCallbacks,
      ...request,
    };
    if (typeof request.prompt !== "string" || !request.prompt.trim()) {
      return new ClaudeExecutionRunImpl(
        null,
        errorEvent("INVALID_REQUEST", "request", undefined, "A non-empty Claude prompt is required."),
        callbacks,
        request.signal,
      );
    }
    let query: ClaudeSdkQuery;
    try {
      query = this.factory({
        prompt: request.prompt,
        options: {
          ...buildClaudeSdkOptions(request, callbacks),
          ...(this.executablePath ? { pathToClaudeCodeExecutable: this.executablePath } : {}),
        },
      });
    } catch (error) {
      return new ClaudeExecutionRunImpl(
        null,
        errorEvent("SDK_ERROR", "request", error, "Claude Agent SDK query failed to start."),
        callbacks,
        request.signal,
      );
    }
    return new ClaudeExecutionRunImpl(query, null, callbacks, request.signal);
  }
}

export function createClaudeExecutionAdapter(
  options: ClaudeExecutionAdapterOptions | ClaudeAgentSdkFactoryLike,
): ClaudeExecutionAdapter {
  return new ClaudeExecutionAdapter(options);
}

/** Convenience one-shot start function for callers that do not need a class. */
export function startClaudeExecution(
  factory: ClaudeAgentSdkFactoryLike,
  request: ClaudeExecutionRequest,
): ClaudeExecutionRun {
  return new ClaudeExecutionAdapter(factory).start(request);
}

/** Convenience resume function for callers that do not need a class. */
export function resumeClaudeExecution(
  factory: ClaudeAgentSdkFactoryLike,
  sessionIdValue: string,
  request: Omit<ClaudeExecutionRequest, "resumeSessionId">,
): ClaudeExecutionRun {
  return new ClaudeExecutionAdapter(factory).resume(sessionIdValue, request);
}
