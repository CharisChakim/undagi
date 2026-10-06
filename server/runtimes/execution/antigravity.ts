// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const INHERIT = "inherit";
const DEFAULT_COMMAND = "agy";
const DEFAULT_MAX_LINE_BYTES = 512 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const STOP_GRACE_MS = 750;

export type AntigravityResultStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "waiting"
  | "running";

export type AntigravityErrorCode =
  | "AGY_UNAVAILABLE"
  | "AGY_UNSUPPORTED_VERSION"
  | "AGY_AUTH_REQUIRED"
  | "AGY_PERMISSION_DENIED"
  | "AGY_PROTOCOL_ERROR"
  | "AGY_OUTPUT_LIMIT"
  | "AGY_PROCESS_ERROR"
  | "AGY_PROCESS_EXITED"
  | "AGY_RESULT_MISSING"
  | "AGY_INTERRUPTED"
  | "AGY_APPROVAL_UNAVAILABLE";

export interface AntigravityErrorInfo {
  code: AntigravityErrorCode;
  message: string;
  retryable: boolean;
}

export interface AntigravityUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

export interface AntigravitySessionStartedEvent {
  type: "session_started";
  conversationId: string | null;
  cwd: string | null;
  model: string | null;
  permissionMode: string | null;
}

export interface AntigravityAssistantEvent {
  type: "assistant";
  conversationId: string | null;
  stepIndex: number | null;
  text: string;
}

export interface AntigravityToolStartEvent {
  type: "tool_start";
  id: string;
  conversationId: string | null;
  stepIndex: number | null;
  tool: string;
  input: unknown;
}

export interface AntigravityToolDoneEvent {
  type: "tool_done";
  id: string;
  conversationId: string | null;
  stepIndex: number | null;
  tool: string;
  result?: unknown;
  isError: boolean;
  denied: boolean;
}

export interface AntigravityProgressEvent {
  type: "progress";
  conversationId: string | null;
  kind: "step" | "unknown_event";
  eventName?: string;
  stepIndex?: number | null;
  stepType?: string;
  state?: string;
  text?: string;
  usage?: AntigravityUsage;
  durationSeconds?: number;
}

export interface AntigravityResultEvent {
  type: "result";
  conversationId: string | null;
  status: AntigravityResultStatus;
  providerStatus: string;
  response: string;
  usage?: AntigravityUsage;
  structuredOutput?: unknown;
  durationSeconds?: number;
  numTurns?: number;
  error?: AntigravityErrorInfo;
  /** Tools headless mode refused because it cannot ask; the result still says SUCCESS. */
  deniedActions?: number;
}

export interface AntigravityErrorEvent {
  type: "error";
  conversationId: string | null;
  error: AntigravityErrorInfo;
}

export type AntigravityEvent =
  | AntigravitySessionStartedEvent
  | AntigravityAssistantEvent
  | AntigravityToolStartEvent
  | AntigravityToolDoneEvent
  | AntigravityProgressEvent
  | AntigravityResultEvent
  | AntigravityErrorEvent;

export interface AntigravityPreferenceSelection {
  model?: string | null;
  effort?: string | null;
}

export interface AntigravityExecutionOptions extends AntigravityPreferenceSelection {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  conversationId?: string | null;
  prompt?: string;
  /** Discovery may pass an explicit version gate without making the adapter guess one. */
  versionSupported?: boolean;
  maxLineBytes?: number;
  maxOutputBytes?: number;
  spawn?: AntigravitySpawn;
  signal?: AbortSignal;
}

export interface AntigravityChild {
  stdin: {
    write(data: string): boolean;
    end(): unknown;
    on(event: "error", listener: (error: unknown) => void): unknown;
  };
  stdout: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  };
  stderr: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  };
  once(event: "error", listener: (error: unknown) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type AntigravitySpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => AntigravityChild;

interface ParserContext {
  conversationId: string | null;
}

interface ParserLimits {
  maxLineBytes: number;
  maxOutputBytes: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedText(value: string, maxBytes = MAX_TEXT_BYTES): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8") + "…";
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return boundedText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 6) return "[value omitted]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => boundedValue(item, depth + 1));
  const item = record(value);
  if (!item) return "[value omitted]";
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(item).slice(0, 200)) {
    output[key] = boundedValue(nested, depth + 1);
  }
  return output;
}

function usage(value: unknown): AntigravityUsage | undefined {
  const item = record(value);
  if (!item) return undefined;
  const output: AntigravityUsage = {};
  const fields: Array<[keyof AntigravityUsage, string[]]> = [
    ["inputTokens", ["input_tokens", "inputTokens"]],
    ["outputTokens", ["output_tokens", "outputTokens"]],
    ["thinkingTokens", ["thinking_tokens", "thinkingTokens"]],
    ["cacheReadTokens", ["cache_read_tokens", "cacheReadTokens"]],
    ["totalTokens", ["total_tokens", "totalTokens"]],
  ];
  for (const [key, aliases] of fields) {
    const found = aliases.map((alias) => finiteNumber(item[alias])).find((entry) => entry !== undefined);
    if (found !== undefined) output[key] = found;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function stepIndex(value: unknown): number | null {
  return finiteNumber(value) ?? null;
}

function toolId(step: Record<string, unknown>, info: Record<string, unknown> | null, conversationId: string | null): string {
  const explicit = [info?.id, info?.tool_call_id, info?.toolCallId, step.id]
    .map(stringValue)
    .find(Boolean);
  return explicit ?? "agy:" + (conversationId ?? "session") + ":step:" + (stepIndex(step.step_index) ?? "unknown");
}

function permissionDenied(value: unknown): boolean {
  const item = record(value);
  const text = [item?.type, item?.message, item?.reason, value]
    .map((entry) => typeof entry === "string" ? entry : "")
    .join(" ");
  return /permission|approval|not allowed|soft.denied|denied/i.test(text);
}

function protocolError(conversationId: string | null, message: string): AntigravityErrorEvent {
  return {
    type: "error",
    conversationId,
    error: { code: "AGY_PROTOCOL_ERROR", message, retryable: false },
  };
}

function resultStatus(value: string): AntigravityResultStatus {
  switch (value.toUpperCase()) {
    case "SUCCESS": return "completed";
    case "CANCELED":
    case "CANCELLED": return "cancelled";
    case "INTERRUPTED": return "interrupted";
    case "WAITING": return "waiting";
    case "RUNNING": return "running";
    default: return "failed";
  }
}

function resultError(value: unknown, providerStatus: string): AntigravityErrorInfo | undefined {
  const item = record(value);
  const message = stringValue(item?.message) ?? stringValue(value) ?? "AGY returned an error.";
  if (providerStatus.toUpperCase() === "SUCCESS") return undefined;
  const lower = message.toLowerCase();
  const code: AntigravityErrorCode = /auth|log(?:ged)? ?in|sign(?:ed)?[ -]?in|credential|unauthori|forbidden|token/.test(lower)
    ? "AGY_AUTH_REQUIRED"
    : /version|unsupported/.test(lower)
      ? "AGY_UNSUPPORTED_VERSION"
      : permissionDenied(value)
        ? "AGY_PERMISSION_DENIED"
        : "AGY_PROCESS_ERROR";
  // A recognised cause gets the steps to fix it; anything else keeps AGY's own words.
  return {
    code,
    message: code === "AGY_PROCESS_ERROR" ? boundedText(message, 2_048) : antigravityFailureMessage(code),
    retryable: code === "AGY_PROCESS_ERROR",
  };
}

function normalizeResult(value: unknown, context: ParserContext): AntigravityEvent[] {
  const item = record(value);
  if (!item) return [protocolError(context.conversationId, "AGY result event is not an object.")];
  const providerStatus = stringValue(item.status);
  if (!providerStatus) return [protocolError(context.conversationId, "AGY result event has no status.")];
  const conversationId = stringValue(item.conversation_id) ?? context.conversationId;
  context.conversationId = conversationId;
  const error = resultError(item.error, providerStatus);
  const itemUsage = usage(item.usage);
  const duration = finiteNumber(item.duration_seconds);
  const turns = finiteNumber(item.num_turns);
  const deniedActions = Array.isArray(item.denied_actions) ? item.denied_actions.length : 0;
  return [{
    type: "result",
    conversationId,
    status: resultStatus(providerStatus),
    providerStatus,
    response: boundedText(typeof item.response === "string" ? item.response : ""),
    ...(itemUsage ? { usage: itemUsage } : {}),
    ...(item.structured_output !== undefined ? { structuredOutput: boundedValue(item.structured_output) } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    ...(turns !== undefined ? { numTurns: turns } : {}),
    ...(error ? { error } : {}),
    ...(deniedActions ? { deniedActions } : {}),
  }];
}

function normalizeStep(value: unknown, context: ParserContext): AntigravityEvent[] {
  const step = record(value);
  if (!step) return [protocolError(context.conversationId, "AGY step_update event is not an object.")];
  const conversationId = stringValue(step.conversation_id) ?? context.conversationId;
  context.conversationId = conversationId;
  const index = stepIndex(step.step_index);
  const stepType = stringValue(step.step_type) ?? "unknown";
  const state = stringValue(step.state)?.toUpperCase() ?? "UNKNOWN";
  const stepText = typeof step.text_delta === "string" ? boundedText(step.text_delta) : undefined;
  const stepUsage = usage(step.usage);
  const duration = finiteNumber(step.duration_seconds);
  const events: AntigravityEvent[] = [{
    type: "progress",
    conversationId,
    kind: "step",
    stepIndex: index,
    stepType,
    state,
    ...(stepText ? { text: stepText } : {}),
    ...(stepUsage ? { usage: stepUsage } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
  }];
  if (stepType === "agent_response" && stepText) {
    events.push({ type: "assistant", conversationId, stepIndex: index, text: stepText });
  }

  const info = record(step.tool_info);
  if (stepType === "tool" || info) {
    const tool = stringValue(step.tool_name) ?? stringValue(info?.name) ?? "tool";
    const id = toolId(step, info, conversationId);
    if (state === "ACTIVE") {
      events.push({ type: "tool_start", id, conversationId, stepIndex: index, tool, input: boundedValue(info?.parameters ?? {}) });
    } else if (state === "DONE" || state === "ERROR") {
      // A refused or failed tool ends its step as ERROR, with the reason in
      // tool_info.error (seen live with AGY 1.2.9); it never reaches DONE.
      const toolError = info?.error ?? (state === "ERROR" ? "AGY reported the step as failed." : undefined);
      events.push({
        type: "tool_done",
        id,
        conversationId,
        stepIndex: index,
        tool,
        ...(info?.output !== undefined ? { result: boundedValue(info.output) } : {}),
        ...(toolError !== undefined ? { result: boundedValue(toolError) } : {}),
        isError: toolError !== undefined,
        denied: permissionDenied(toolError),
      });
    }
  }
  return events;
}

/** Normalize one documented AGY stream-json object into application events. */
export function normalizeAntigravityEvent(value: unknown, context: ParserContext = { conversationId: null }): AntigravityEvent[] {
  const root = record(value);
  if (!root || typeof root.event !== "string") return [protocolError(context.conversationId, "AGY stream event has no event name.")];
  switch (root.event) {
    case "init": {
      const init = record(root.init);
      if (!init) return [protocolError(context.conversationId, "AGY init event is malformed.")];
      const conversationId = stringValue(root.conversation_id) ?? stringValue(init.conversation_id);
      context.conversationId = conversationId;
      return [{
        type: "session_started",
        conversationId,
        cwd: stringValue(init.cwd),
        model: stringValue(init.model),
        permissionMode: stringValue(init.permission_mode),
      }];
    }
    case "step_update": return normalizeStep(root.step_update, context);
    case "result": return normalizeResult(root.result, context);
    default: return [{ type: "progress", conversationId: context.conversationId, kind: "unknown_event", eventName: root.event }];
  }
}

/** Parse one JSONL line. Raw line content is never returned in an error. */
export function parseAntigravityJsonLine(line: string, context: ParserContext = { conversationId: null }): AntigravityEvent[] {
  try {
    return normalizeAntigravityEvent(JSON.parse(line), context);
  } catch {
    return [protocolError(context.conversationId, "AGY stream line is not valid JSON.")];
  }
}

export const parseAntigravityLine = parseAntigravityJsonLine;

/** Incremental UTF-8/JSONL parser with bounded line and stream output. */
export class AntigravityStreamParser {
  private readonly decoder = new StringDecoder("utf8");
  private readonly context: ParserContext = { conversationId: null };
  private readonly limits: ParserLimits;
  private buffer = "";
  private bytesSeen = 0;
  private stopped = false;

  constructor(options: Partial<ParserLimits> = {}) {
    this.limits = {
      maxLineBytes: Math.max(1, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES),
      maxOutputBytes: Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
    };
  }

  get conversationId(): string | null {
    return this.context.conversationId;
  }

  push(chunk: Buffer | string): AntigravityEvent[] {
    if (this.stopped) return [];
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.bytesSeen += bytes.byteLength;
    if (this.bytesSeen > this.limits.maxOutputBytes) {
      this.stopped = true;
      return [{ type: "error", conversationId: this.context.conversationId, error: { code: "AGY_OUTPUT_LIMIT", message: "AGY output exceeded the configured limit.", retryable: false } }];
    }
    this.buffer += this.decoder.write(bytes);
    if (Buffer.byteLength(this.buffer, "utf8") > this.limits.maxLineBytes && !this.buffer.includes("\n")) {
      this.stopped = true;
      return [{ type: "error", conversationId: this.context.conversationId, error: { code: "AGY_OUTPUT_LIMIT", message: "AGY JSONL line exceeded the configured limit.", retryable: false } }];
    }
    const events: AntigravityEvent[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.limits.maxLineBytes) {
        this.stopped = true;
        events.push({ type: "error", conversationId: this.context.conversationId, error: { code: "AGY_OUTPUT_LIMIT", message: "AGY JSONL line exceeded the configured limit.", retryable: false } });
        break;
      }
      if (line.trim()) events.push(...parseAntigravityJsonLine(line, this.context));
      newline = this.buffer.indexOf("\n");
    }
    return events;
  }

  end(): AntigravityEvent[] {
    if (this.stopped) return [];
    this.buffer += this.decoder.end();
    if (!this.buffer.trim()) return [];
    if (Buffer.byteLength(this.buffer, "utf8") > this.limits.maxLineBytes) {
      this.stopped = true;
      return [{ type: "error", conversationId: this.context.conversationId, error: { code: "AGY_OUTPUT_LIMIT", message: "AGY JSONL line exceeded the configured limit.", retryable: false } }];
    }
    const line = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    return parseAntigravityJsonLine(line, this.context);
  }
}

function explicitSelection(value: string | null | undefined): string | null {
  if (!value || value.trim() === "" || value.trim() === INHERIT) return null;
  return value.trim();
}

/** Build safe AGY args. No prompt flag or dangerous permission bypass is added. */
export function buildAntigravityArgs(options: AntigravityExecutionOptions = {}): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  const model = explicitSelection(options.model);
  const effort = explicitSelection(options.effort);
  const conversationId = stringValue(options.conversationId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (conversationId) args.push("--conversation", conversationId);
  return args;
}

export class AntigravityExecutionError extends Error {
  readonly code: AntigravityErrorCode;
  readonly retryable: boolean;

  constructor(code: AntigravityErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.name = "AntigravityExecutionError";
  }
}

class AsyncEventQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

export interface AntigravityExecutionHandle extends AsyncIterable<AntigravityEvent> {
  readonly args: readonly string[];
  readonly result: Promise<AntigravityResultEvent>;
  sendPrompt(prompt: string): void;
  close(): Promise<void>;
  interrupt(): Promise<void>;
}

function errorCodeFromUnknown(error: unknown): string | null {
  const item = record(error);
  return typeof item?.code === "string" ? item.code : null;
}

/** Classify bounded process diagnostics without returning stderr to callers. */
export function classifyAntigravityFailure(stderr: string, processCode?: string | null): AntigravityErrorCode {
  if (processCode === "ENOENT") return "AGY_UNAVAILABLE";
  const lower = stderr.toLowerCase();
  if (/unsupported version|requires.*version|version.*unsupported/.test(lower)) return "AGY_UNSUPPORTED_VERSION";
  if (/auth|log(?:ged)? ?in|sign(?:ed)?[ -]?in|credential|unauthori|forbidden|token/.test(lower)) return "AGY_AUTH_REQUIRED";
  if (/permission|approval|not allowed|soft.denied|denied/.test(lower)) return "AGY_PERMISSION_DENIED";
  return "AGY_PROCESS_EXITED";
}

/** Why an AGY run failed, worded so the user knows what to do next. */
export function antigravityFailureMessage(code: AntigravityErrorCode): string {
  switch (code) {
    case "AGY_UNAVAILABLE": return "Antigravity CLI (`agy`) was not found. Install it or set its path in Connections, then try again.";
    case "AGY_UNSUPPORTED_VERSION": return "This Antigravity CLI version is not supported. Update it with `agy update`, then try again.";
    case "AGY_AUTH_REQUIRED": return "Antigravity CLI is not signed in, or its sign-in expired. Run `agy` in a terminal and sign in (use /login if it does not ask), then try again.";
    case "AGY_PERMISSION_DENIED":
    case "AGY_APPROVAL_UNAVAILABLE":
      return "Antigravity refused a tool that needs approval, because it cannot ask for it here, so the run is incomplete. Allow the tool under permissions.allow in Antigravity's settings.json (for example `command(npm test)`), or use Codex or Claude Code for this work.";
    case "AGY_PROTOCOL_ERROR": return "Antigravity CLI sent output this app could not read. Update it with `agy update`, then try again.";
    case "AGY_OUTPUT_LIMIT": return "Antigravity CLI produced more output than this app accepts. Ask for a smaller change or split the task, then try again.";
    case "AGY_PROCESS_ERROR": return "The Antigravity CLI process failed. Try again; if it keeps failing, run `agy` in a terminal to see why.";
    case "AGY_PROCESS_EXITED": return "Antigravity CLI exited before the run finished. Try again; if it keeps failing, run `agy` in a terminal to see why.";
    case "AGY_RESULT_MISSING": return "Antigravity CLI closed without reporting a result. Try again; if it keeps failing, run `agy` in a terminal to see why.";
    case "AGY_INTERRUPTED": return "Antigravity run interrupted.";
  }
}

const defaultSpawn: AntigravitySpawn = (command, args, options) => nodeSpawn(command, [...args], options) as unknown as AntigravityChild;

/** Start one AGY stream session. The process remains open for follow-up turns. */
export class AntigravityExecution implements AntigravityExecutionHandle {
  readonly args: readonly string[];
  readonly result: Promise<AntigravityResultEvent>;
  private readonly queue = new AsyncEventQueue<AntigravityEvent>();
  private readonly parser: AntigravityStreamParser;
  private readonly child: AntigravityChild | null;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private resolveResult!: (result: AntigravityResultEvent) => void;
  private resultResolved = false;
  private failed: AntigravityErrorInfo | null = null;
  private interrupted = false;
  private closed = false;
  private stdinEnded = false;
  private stderr = "";
  private readonly options: AntigravityExecutionOptions;

  constructor(options: AntigravityExecutionOptions = {}) {
    this.options = options;
    this.args = buildAntigravityArgs(options);
    this.parser = new AntigravityStreamParser(options);
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.result = new Promise((resolve) => { this.resolveResult = resolve; });

    if (options.versionSupported === false) {
      this.child = null;
      this.fail("AGY_UNSUPPORTED_VERSION", antigravityFailureMessage("AGY_UNSUPPORTED_VERSION"), false);
      this.finishClosed();
      return;
    }

    const command = stringValue(options.command) ?? DEFAULT_COMMAND;
    try {
      this.child = (options.spawn ?? defaultSpawn)(command, this.args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.child = null;
      const code = errorCodeFromUnknown(error) === "ENOENT" ? "AGY_UNAVAILABLE" : "AGY_PROCESS_ERROR";
      this.fail(code, antigravityFailureMessage(code), code === "AGY_PROCESS_ERROR");
      this.finishClosed();
      return;
    }

    this.child.stdout.on("data", (chunk) => this.handleEvents(this.parser.push(chunk)));
    this.child.stderr.on("data", (chunk) => this.captureStderr(chunk));
    // Writing the prompt to a CLI that already closed its stdin emits EPIPE
    // here; unhandled, that kills the whole server.
    this.child.stdin.on("error", (error) => this.handleChildError(error));
    this.child.once("error", (error) => this.handleChildError(error));
    this.child.once("close", (code, signal) => this.handleClose(code, signal));
    if (options.signal) {
      if (options.signal.aborted) void this.interrupt();
      else options.signal.addEventListener("abort", () => void this.interrupt(), { once: true });
    }
    if (options.prompt !== undefined) this.sendPrompt(options.prompt);
  }

  private captureStderr(chunk: Buffer | string): void {
    if (Buffer.byteLength(this.stderr, "utf8") >= MAX_STDERR_BYTES) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const remaining = MAX_STDERR_BYTES - Buffer.byteLength(this.stderr, "utf8");
    this.stderr += Buffer.byteLength(text, "utf8") <= remaining
      ? text
      : Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
  }

  private handleEvents(events: AntigravityEvent[]): void {
    for (const event of events) {
      this.queue.push(event);
      if (event.type === "result" && !this.resultResolved) {
        this.resultResolved = true;
        this.resolveResult(event);
        // One process represents one streamed turn. Closing the event queue
        // lets the runner persist terminal state before close() stops the CLI.
        this.queue.close();
      } else if (event.type === "error" && !this.resultResolved) {
        this.fail(event.error.code, event.error.message, event.error.retryable);
        void this.stopProcess("SIGTERM");
      }
    }
  }

  private handleChildError(error: unknown): void {
    if (this.closed || this.resultResolved) return;
    const code = classifyAntigravityFailure(this.stderr, errorCodeFromUnknown(error));
    this.fail(code, antigravityFailureMessage(code), code === "AGY_PROCESS_EXITED" || code === "AGY_PROCESS_ERROR");
  }

  private handleClose(code: number | null, _signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    if (!this.resultResolved) {
      this.handleEvents(this.parser.end());
      if (!this.resultResolved) {
        const failureCode: AntigravityErrorCode = this.interrupted
          ? "AGY_INTERRUPTED"
          : code === 0
            ? "AGY_RESULT_MISSING"
            : classifyAntigravityFailure(this.stderr);
        this.fail(failureCode, antigravityFailureMessage(failureCode), failureCode === "AGY_PROCESS_EXITED");
      }
    }
    this.finishClosed();
  }

  private finishClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
    this.resolveClosed();
  }

  private fail(code: AntigravityErrorCode, message: string, retryable: boolean): void {
    if (!this.failed) this.failed = { code, message, retryable };
    if (this.resultResolved) return;
    this.resultResolved = true;
    const result: AntigravityResultEvent = {
      type: "result",
      conversationId: this.parser.conversationId,
      status: code === "AGY_INTERRUPTED" ? "interrupted" : "failed",
      providerStatus: code === "AGY_INTERRUPTED" ? "INTERRUPTED" : "ERROR",
      response: "",
      error: this.failed,
    };
    this.queue.push(result);
    this.resolveResult(result);
  }

  private async stopProcess(signal: NodeJS.Signals): Promise<void> {
    if (this.closed || !this.child) return;
    if (!this.stdinEnded) {
      this.stdinEnded = true;
      try { this.child.stdin.end(); } catch { /* process may already be gone */ }
    }
    try { this.child.kill(signal); } catch { /* close handler reports process state */ }
    await Promise.race([
      this.closedPromise,
      new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS)),
    ]);
    if (!this.closed) {
      try { this.child.kill("SIGKILL"); } catch { /* close handler reports process state */ }
      await Promise.race([
        this.closedPromise,
        new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS)),
      ]);
    }
    if (!this.closed) this.finishClosed();
  }

  sendPrompt(prompt: string): void {
    if (this.closed || !this.child || this.stdinEnded) {
      throw new AntigravityExecutionError("AGY_PROCESS_ERROR", "Antigravity stream is closed.");
    }
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new AntigravityExecutionError("AGY_PROTOCOL_ERROR", "A non-empty prompt is required.");
    }
    try {
      this.child.stdin.write(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n");
    } catch {
      throw new AntigravityExecutionError("AGY_PROCESS_ERROR", antigravityFailureMessage("AGY_PROCESS_ERROR"), true);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.stopProcess("SIGTERM");
    if (!this.resultResolved) this.fail("AGY_RESULT_MISSING", antigravityFailureMessage("AGY_RESULT_MISSING"), false);
  }

  async interrupt(): Promise<void> {
    if (this.closed) return;
    this.interrupted = true;
    await this.stopProcess("SIGINT");
    if (!this.resultResolved) this.fail("AGY_INTERRUPTED", antigravityFailureMessage("AGY_INTERRUPTED"), false);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<AntigravityEvent> {
    return this.queue;
  }
}

export function startAntigravityExecution(options: AntigravityExecutionOptions = {}): AntigravityExecution {
  return new AntigravityExecution(options);
}

export function resumeAntigravityExecution(
  conversationId: string,
  options: Omit<AntigravityExecutionOptions, "conversationId"> = {},
): AntigravityExecution {
  const id = stringValue(conversationId);
  if (!id) throw new AntigravityExecutionError("AGY_PROTOCOL_ERROR", "A conversation ID is required to resume AGY.");
  return new AntigravityExecution({ ...options, conversationId: id });
}

export const startAntigravity = startAntigravityExecution;
export const resumeAntigravity = resumeAntigravityExecution;
