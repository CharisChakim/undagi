import type { RuntimeDetection } from "../runtimes/types.ts";
import {
  createCodexRuntimeExecutor,
  type CodexRuntimeExecutorOptions,
} from "../runtimes/execution/codex.ts";
import {
  ClaudeExecutionAdapter,
  describeClaudeFailure,
  type ClaudeExecutionEvent,
  type ClaudeExecutionRun,
  type ClaudeSdkQuery,
} from "../runtimes/execution/claude.ts";
import {
  antigravityFailureMessage,
  startAntigravityExecution,
  type AntigravityEvent,
  type AntigravityExecutionHandle,
  type AntigravityExecutionOptions,
} from "../runtimes/execution/antigravity.ts";
import type {
  RuntimeApprovalDecision,
  RuntimeApprovalHandler,
  RuntimeEvent,
  RuntimeExecutor,
  RuntimeErrorEvent,
  RuntimeToolEvent,
} from "../runtimes/execution/types.ts";

export type RuntimeAgentRuntime = "codex" | "claude" | "antigravity";

export interface RuntimeRunnerDependencies {
  createCodexExecutor: (options: CodexRuntimeExecutorOptions) => RuntimeExecutor;
  loadClaudeSdk?: () => Promise<ClaudeSdkModule> | ClaudeSdkModule;
  createAntigravityExecution?: (options: AntigravityExecutionOptions) => AntigravityExecutionHandle;
}

export const defaultRuntimeRunnerDependencies: RuntimeRunnerDependencies = {
  createCodexExecutor: (options) => createCodexRuntimeExecutor(options),
  loadClaudeSdk: loadClaudeSdkModule,
  createAntigravityExecution: (options) => startAntigravityExecution(options),
};

/** Shape of the official Claude SDK module used by the execution boundary. */
export interface ClaudeSdkModule {
  query: (request: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => ClaudeSdkQuery;
  supportedModels?: (executablePath?: string) => Promise<unknown> | unknown;
}

const CLAUDE_SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk";

/** Load the optional official SDK without making it a compile-time dependency. */
export async function loadClaudeSdkModule(): Promise<ClaudeSdkModule> {
  try {
    const loaded = await import(CLAUDE_SDK_SPECIFIER) as Record<string, unknown>;
    const candidate = loaded.query
      ?? (loaded.default && typeof loaded.default === "object" ? (loaded.default as Record<string, unknown>).query : undefined)
      ?? (typeof loaded.default === "function" ? loaded.default : undefined);
    if (typeof candidate !== "function") throw new Error("query export is missing");
    const moduleSupportedModels = typeof loaded.supportedModels === "function"
      ? loaded.supportedModels as () => Promise<unknown> | unknown
      : undefined;
    const supportedModels = moduleSupportedModels ?? (async (executablePath?: string) => {
      // Query exposes supportedModels() only after its control channel is
      // initialized. Keep streaming input open without yielding a user
      // message, so metadata discovery never consumes model quota.
      const abortController = new AbortController();
      const input: AsyncIterable<never> = {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<never>>((resolve) => {
              abortController.signal.addEventListener(
                "abort",
                () => resolve({ value: undefined as never, done: true }),
                { once: true },
              );
            }),
          };
        },
      };
      // The installers leave out the SDK's own Claude binary (build.files in
      // package.json), so without the detected one the SDK finds no CLI and
      // Claude Code shows as unavailable in the desktop app.
      const query = (candidate as ClaudeSdkModule["query"])({
        prompt: input,
        options: { abortController, ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}) },
      }) as ClaudeSdkQuery & { supportedModels?: () => Promise<unknown> };
      try {
        if (typeof query.supportedModels !== "function") {
          throw new Error("supportedModels is unavailable");
        }
        return await query.supportedModels();
      } finally {
        abortController.abort();
        await query.return?.();
      }
    });
    return {
      query: candidate as ClaudeSdkModule["query"],
      supportedModels,
    };
  } catch {
    throw new RuntimeRunnerError(
      "SDK_UNAVAILABLE",
      "Claude Agent SDK is unavailable. Install @anthropic-ai/claude-agent-sdk and restart the server.",
      501,
    );
  }
}

export interface RuntimeRunnerInput {
  runtime: RuntimeAgentRuntime;
  prompt: string;
  model?: string | null;
  effort?: string | null;
  cwd?: string | null;
  externalSessionId?: string | null;
  detection?: RuntimeDetection | null;
  signal: AbortSignal;
  dependencies?: RuntimeRunnerDependencies;
  approvalHandler?: RuntimeApprovalHandler;
  claudeSdk?: ClaudeSdkModule;
  /**
   * Run without the user's own runtime configuration. Only Claude supports it
   * (ClaudeExecutionRequest.isolateSettings); Codex and Antigravity have no
   * verified way to do it and ignore the flag.
   */
  isolateSettings?: boolean;
}

export interface RuntimeRunnerOutput {
  events: AsyncIterable<RuntimeEvent>;
  executor: RuntimeExecutor;
}

export class RuntimeRunnerError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 501) {
    super(message);
    this.name = "RuntimeRunnerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function requiredDetection(input: RuntimeRunnerInput): RuntimeDetection {
  const detection = input.detection;
  // Claude used to be exempt because the SDK vendors its own binary, but the
  // app drives the installation discovery found so the reported version and
  // the one actually executed are the same build.
  if (!detection || detection.status !== "ready" || !detection.binaryPath) {
    const diagnostic = detection?.diagnostic ?? (detection ? detection.status.toUpperCase() : "RUNTIME_NOT_DISCOVERED");
    throw new RuntimeRunnerError(
      "RUNTIME_NOT_READY",
      `${input.runtime} runtime is not ready (${diagnostic}). Run runtime discovery and authenticate the runtime before starting a chat.`,
      503,
    );
  }
  return detection;
}

function sessionThreadId(sessionId: string | null): string {
  return sessionId ?? "runtime-session-unknown";
}

function sessionTurnId(sessionId: string | null): string {
  return `turn:${sessionThreadId(sessionId)}`;
}

function explicitSelection(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() && value.trim() !== "inherit" ? value.trim() : undefined;
}

function claudeErrorEvent(event: Extract<ClaudeExecutionEvent, { type: "error" }>): RuntimeErrorEvent {
  return {
    type: "error",
    error: { code: event.error.code, message: event.error.message },
    threadId: null,
    turnId: null,
    fatal: event.error.code !== "MALFORMED_EVENT",
  };
}

function claudeApprovalEvent(
  event: Extract<ClaudeExecutionEvent, { type: "approval_request" | "input_request" }>,
): RuntimeEvent {
  const request = event.request;
  const blockedPath = "blockedPath" in request ? request.blockedPath : null;
  return {
    type: "approval",
    requestId: request.toolUseId ?? `claude-request-${Date.now()}`,
    kind: "other",
    threadId: null,
    turnId: null,
    itemId: request.toolUseId,
    command: null,
    cwd: blockedPath,
    reason: request.reason,
    details: {
      toolName: request.toolName,
      input: request.input,
      ...(blockedPath ? { blockedPath } : {}),
    },
  };
}

/**
 * Claude's Bash result has no exit code field. A failed command's output
 * starts with "Exit code N" (seen live with Claude Code, September 2026); a
 * command that succeeded says nothing, which means 0. A failure without that
 * line (a denial, a timeout) has no exit code to report.
 */
function claudeBashExitCode(result: unknown, isError: boolean): number | null {
  const text = typeof result === "string"
    ? result
    : Array.isArray(result)
      ? result.map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "")).join("")
      : "";
  const match = /^Exit code (\d+)\b/.exec(text);
  if (match) return Number(match[1]);
  return isError ? null : 0;
}

/**
 * What the approval card shows. Claude asks per tool, not per command: a Bash
 * call carries its command, a file tool its path; the card was empty before.
 */
function claudeApprovalCommand(toolName: string, input: unknown): string {
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (typeof fields.command === "string" && fields.command.trim()) return fields.command;
  const target = fields.file_path ?? fields.notebook_path ?? fields.path ?? fields.url;
  return typeof target === "string" && target ? `${toolName} ${target}` : toolName;
}

/**
 * blockedPath is the file or path a permission-mode rule blocked, not the
 * turn's working folder — Claude reported a file (declined.txt) there, which
 * the approval card then showed as "Working folder". It rides in `details`
 * instead, so the card can name it as what it is.
 */
function claudeApprovalDetails(approval: { toolName: string; input: unknown; blockedPath: string | null }): Record<string, unknown> {
  return {
    toolName: approval.toolName,
    input: approval.input,
    ...(approval.blockedPath ? { blockedPath: approval.blockedPath } : {}),
  };
}

async function claudeDecision(
  handler: RuntimeApprovalHandler,
  request: Parameters<RuntimeApprovalHandler>[0],
): Promise<boolean> {
  const decision = await handler(request);
  return decision === "accept" || decision === "acceptForSession" || typeof decision === "object";
}

async function* mapClaudeEvents(run: ClaudeExecutionRun, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
  let sawPartialText = false;
  let sawText = false;
  let sawResult = false;
  let sawFatal = false;
  const startedTools = new Map<string, { name: string; input: unknown }>();
  let assistantError: string | null = null;
  for await (const event of run) {
    if (event.type === "assistant") {
      // A failed API call arrives as an assistant message whose text is the
      // SDK's own error ("Invalid API key · Please run /login"), not a reply.
      if (event.error) {
        assistantError = event.error;
        if (!event.delta) continue;
      }
      const text = event.delta ?? (sawPartialText ? "" : event.text ?? "");
      if (event.delta) sawPartialText = true;
      if (text) {
        sawText = true;
        const threadId = sessionThreadId(event.sessionId ?? run.sessionId);
        yield {
          type: "text",
          text,
          threadId,
          turnId: sessionTurnId(event.sessionId ?? run.sessionId),
          itemId: event.messageId,
        };
      }
      continue;
    }
    if (event.type === "tool") {
      const threadId = sessionThreadId(run.sessionId);
      if (event.phase === "result") {
        // A result names neither the tool nor its input; the start did.
        const started = event.toolUseId ? startedTools.get(event.toolUseId) : undefined;
        const name = event.toolName ?? started?.name ?? "tool";
        const exitCode = name === "Bash" ? claudeBashExitCode(event.result, event.isError === true) : null;
        yield {
          type: "tool",
          tool: name,
          status: event.isError ? "failed" : "completed",
          threadId,
          turnId: sessionTurnId(run.sessionId),
          itemId: event.toolUseId,
          data: { input: started?.input ?? null, output: event.result ?? null, ...(exitCode !== null ? { exitCode } : {}) },
        } satisfies RuntimeToolEvent;
        continue;
      }
      if (event.phase === "start" && event.toolUseId) {
        if (startedTools.has(event.toolUseId)) continue;
        startedTools.set(event.toolUseId, { name: event.toolName ?? "tool", input: event.input ?? {} });
      }
      yield {
        type: "tool",
        tool: event.toolName ?? "tool",
        status: event.phase,
        threadId,
        turnId: sessionTurnId(run.sessionId),
        itemId: event.toolUseId,
        data: event.inputDelta ?? event.input ?? {},
      } satisfies RuntimeToolEvent;
      continue;
    }
    if (event.type === "progress") {
      // Progress on a running tool is not a new tool call.
      yield {
        type: "tool",
        tool: "progress",
        status: event.phase,
        threadId: sessionThreadId(run.sessionId),
        turnId: sessionTurnId(run.sessionId),
        itemId: event.toolUseId ?? null,
        data: event.data ?? event.message ?? null,
      } satisfies RuntimeToolEvent;
      continue;
    }
    if (event.type === "result") {
      // A turn has one outcome; a repeated result would report it twice.
      if (sawResult) continue;
      sawResult = true;
      const failed = event.status !== "success" || event.isError;
      if (!failed && !sawText && typeof event.result === "string" && event.result) {
        sawText = true;
        yield {
          type: "text",
          text: event.result,
          threadId: sessionThreadId(event.sessionId ?? run.sessionId),
          turnId: sessionTurnId(event.sessionId ?? run.sessionId),
          itemId: null,
        };
      }
      yield {
        type: "done",
        status: failed ? "failed" : "completed",
        threadId: sessionThreadId(event.sessionId ?? run.sessionId),
        turnId: sessionTurnId(event.sessionId ?? run.sessionId),
        error: failed
          ? describeClaudeFailure({
            assistantError,
            apiErrorStatus: event.apiErrorStatus,
            subtype: event.subtype,
            errors: event.errors,
            resultText: event.result,
          })
          : null,
      };
      continue;
    }
    if (event.type === "approval_request" || event.type === "input_request") {
      yield claudeApprovalEvent(event);
      continue;
    }
    if (event.type === "error") {
      const error = claudeErrorEvent(event);
      sawFatal = sawFatal || error.fatal;
      yield error;
    }
  }
  // Without this the run ends as failed with no reason given. A stopped run
  // is reported by the caller as interrupted instead.
  if (!sawResult && !sawFatal && !signal.aborted) {
    yield {
      type: "error",
      error: { code: "CLAUDE_RESULT_MISSING", message: "Claude Agent SDK stream ended before it returned a result." },
      threadId: run.sessionId,
      turnId: null,
      fatal: true,
    };
  }
}

class ClaudeRuntimeExecutor implements RuntimeExecutor {
  private current: ClaudeExecutionRun | null = null;

  constructor(
    private readonly adapter: ClaudeExecutionAdapter,
    private readonly signal: AbortSignal,
    private readonly approvalHandler?: RuntimeApprovalHandler,
    private readonly isolateSettings = false,
  ) {}

  startTurn(request: Parameters<RuntimeExecutor["startTurn"]>[0]): AsyncIterable<RuntimeEvent> {
    this.current = this.adapter.start({
      prompt: request.prompt,
      cwd: request.cwd,
      model: explicitSelection(request.model),
      effort: explicitSelection(request.effort),
      isolateSettings: this.isolateSettings,
      signal: this.signal,
      onApproval: this.approvalHandler ? async (approval) => claudeDecision(this.approvalHandler!, {
        requestId: approval.toolUseId ?? `claude-request-${Date.now()}`,
        kind: "other",
        threadId: this.current?.sessionId ?? null,
        turnId: null,
        itemId: approval.toolUseId,
        command: claudeApprovalCommand(approval.toolName, approval.input),
        cwd: request.cwd ?? null,
        reason: approval.reason,
        details: claudeApprovalDetails(approval),
      }) : undefined,
    });
    return mapClaudeEvents(this.current, this.signal);
  }

  resumeTurn(request: Parameters<RuntimeExecutor["resumeTurn"]>[0]): AsyncIterable<RuntimeEvent> {
    this.current = this.adapter.resume(request.threadId, {
      prompt: request.prompt,
      cwd: request.cwd,
      model: explicitSelection(request.model),
      effort: explicitSelection(request.effort),
      isolateSettings: this.isolateSettings,
      signal: this.signal,
      onApproval: this.approvalHandler ? async (approval) => claudeDecision(this.approvalHandler!, {
        requestId: approval.toolUseId ?? `claude-request-${Date.now()}`,
        kind: "other",
        threadId: this.current?.sessionId ?? request.threadId,
        turnId: null,
        itemId: approval.toolUseId,
        command: claudeApprovalCommand(approval.toolName, approval.input),
        cwd: request.cwd ?? null,
        reason: approval.reason,
        details: claudeApprovalDetails(approval),
      }) : undefined,
    });
    return mapClaudeEvents(this.current, this.signal);
  }

  async interrupt(): Promise<void> { await this.current?.interrupt(); }
  async close(): Promise<void> { await this.current?.close(); }
}

function antigravityErrorEvent(event: Extract<AntigravityEvent, { type: "error" }>): RuntimeErrorEvent {
  return {
    type: "error",
    error: { code: event.error.code, message: event.error.message },
    threadId: event.conversationId,
    turnId: event.conversationId ? sessionTurnId(event.conversationId) : null,
    fatal: true,
  };
}

function antigravityToolResult(input: unknown, output: unknown): Record<string, unknown> {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : null;
  const command = typeof params?.CommandLine === "string" ? params.CommandLine : typeof params?.command === "string" ? params.command : null;
  return { input: input ?? null, output: output ?? null, ...(command ? { command } : {}) };
}

async function* mapAntigravityEvents(run: AntigravityExecutionHandle): AsyncIterable<RuntimeEvent> {
  let denied = false;
  let sawAssistant = false;
  // A finished step reports only its output; the command it ran came with
  // the step when it started, and evidence needs it.
  const toolInputs = new Map<string, unknown>();
  for await (const event of run) {
    if (event.type === "session_started") {
      const threadId = sessionThreadId(event.conversationId);
      yield {
        type: "tool",
        tool: "runtime_session",
        status: "started",
        threadId,
        turnId: sessionTurnId(event.conversationId),
        itemId: null,
        data: { conversationId: event.conversationId, cwd: event.cwd, model: event.model },
      };
    } else if (event.type === "assistant") {
      sawAssistant = sawAssistant || Boolean(event.text);
      yield {
        type: "text",
        text: event.text,
        threadId: sessionThreadId(event.conversationId),
        turnId: sessionTurnId(event.conversationId),
        itemId: null,
      };
    } else if (event.type === "tool_start") {
      if (!toolInputs.has(event.id)) toolInputs.set(event.id, event.input);
      yield {
        type: "tool",
        tool: event.tool,
        status: "started",
        threadId: sessionThreadId(event.conversationId),
        turnId: sessionTurnId(event.conversationId),
        itemId: event.id,
        data: event.input,
      };
    } else if (event.type === "tool_done") {
      denied = denied || event.denied;
      yield {
        type: "tool",
        tool: event.tool,
        status: event.isError || event.denied ? "failed" : "completed",
        threadId: sessionThreadId(event.conversationId),
        turnId: sessionTurnId(event.conversationId),
        itemId: event.id,
        data: antigravityToolResult(toolInputs.get(event.id), event.result),
      };
    } else if (event.type === "progress") {
      yield {
        type: "tool",
        tool: "progress",
        status: event.state ?? "progress",
        threadId: sessionThreadId(event.conversationId),
        turnId: sessionTurnId(event.conversationId),
        itemId: null,
        data: event.text ?? event,
      };
    } else if (event.type === "error") {
      yield antigravityErrorEvent(event);
    } else if (event.type === "result") {
      denied = denied || Boolean(event.deniedActions);
      if (!sawAssistant && event.response) {
        yield {
          type: "text",
          text: event.response,
          threadId: sessionThreadId(event.conversationId),
          turnId: sessionTurnId(event.conversationId),
          itemId: null,
        };
      }
      const failed = denied || event.status === "failed" || event.status === "cancelled" || event.status === "interrupted" || Boolean(event.error);
      yield {
        type: "done",
        status: failed ? (event.status === "interrupted" ? "interrupted" : "failed") : "completed",
        threadId: sessionThreadId(event.conversationId),
        turnId: sessionTurnId(event.conversationId),
        error: failed
          ? { code: denied ? "AGY_PERMISSION_DENIED" : (event.error?.code ?? "AGY_RESULT_ERROR"), message: denied ? antigravityFailureMessage("AGY_PERMISSION_DENIED") : (event.error?.message ?? "Antigravity returned an unsuccessful result.") }
          : null,
      };
    }
  }
}

class AntigravityRuntimeExecutor implements RuntimeExecutor {
  private current: AntigravityExecutionHandle | null = null;

  constructor(
    private readonly command: string,
    private readonly cwd: string | undefined,
    private readonly model: string | null | undefined,
    private readonly effort: string | null | undefined,
    private readonly signal: AbortSignal,
    private readonly factory: (options: AntigravityExecutionOptions) => AntigravityExecutionHandle,
  ) {}

  startTurn(request: Parameters<RuntimeExecutor["startTurn"]>[0]): AsyncIterable<RuntimeEvent> {
    this.current = this.factory({
      command: this.command,
      cwd: this.cwd,
      model: request.model,
      effort: request.effort,
      prompt: request.prompt,
      signal: this.signal,
    });
    return mapAntigravityEvents(this.current);
  }

  resumeTurn(request: Parameters<RuntimeExecutor["resumeTurn"]>[0]): AsyncIterable<RuntimeEvent> {
    this.current = this.factory({
      command: this.command,
      cwd: this.cwd,
      model: request.model,
      effort: request.effort,
      prompt: request.prompt,
      signal: this.signal,
      conversationId: request.threadId,
    });
    return mapAntigravityEvents(this.current);
  }

  async interrupt(): Promise<void> { await this.current?.interrupt(); }
  async close(): Promise<void> { await this.current?.close(); }
}

function approvalFor(
  handler: RuntimeApprovalHandler | undefined,
): RuntimeApprovalHandler {
  return async (request) => {
    if (handler) return handler(request);
    // The first route slice has no approval response endpoint. Declining here
    // prevents the provider process from hanging while keeping the decision
    // visible to the caller through the normalized approval event.
    return "decline" as RuntimeApprovalDecision;
  };
}

/** Create a runtime-owned executor. This boundary is fixture-injectable. */
export function createRuntimeRunner(input: RuntimeRunnerInput): RuntimeRunnerOutput {
  if (input.runtime === "claude") {
    throw new RuntimeRunnerError(
      "SDK_UNAVAILABLE",
      "Claude execution requires the optional SDK loader; use createRuntimeRunnerAsync.",
      501,
    );
  }

  const detection = requiredDetection(input);
  const dependencies = input.dependencies ?? defaultRuntimeRunnerDependencies;
  const options: CodexRuntimeExecutorOptions = {
    executable: detection.binaryPath,
    cwd: input.cwd ?? undefined,
    approvalHandler: approvalFor(input.approvalHandler),
  };
  const executor = input.runtime === "antigravity"
    ? new AntigravityRuntimeExecutor(
        detection.binaryPath!,
        input.cwd ?? undefined,
        input.model,
        input.effort,
        input.signal,
        dependencies.createAntigravityExecution ?? ((executionOptions) => startAntigravityExecution(executionOptions)),
      )
    : dependencies.createCodexExecutor(options);
  const events = input.externalSessionId
    ? executor.resumeTurn({
      threadId: input.externalSessionId,
      prompt: input.prompt,
        model: explicitSelection(input.model),
        effort: explicitSelection(input.effort),
        cwd: input.cwd ?? undefined,
      })
      : executor.startTurn({
        prompt: input.prompt,
        model: explicitSelection(input.model),
        effort: explicitSelection(input.effort),
        cwd: input.cwd ?? undefined,
      });
  return { events, executor };
}

/** Async variant used for Claude's optional dynamic SDK dependency. */
export async function createRuntimeRunnerAsync(input: RuntimeRunnerInput): Promise<RuntimeRunnerOutput> {
  if (input.runtime !== "claude") return createRuntimeRunner(input);
  const detection = requiredDetection(input);
  const dependencies = input.dependencies ?? defaultRuntimeRunnerDependencies;
  const sdk = input.claudeSdk ?? await (dependencies.loadClaudeSdk ?? loadClaudeSdkModule)();
  const adapter = new ClaudeExecutionAdapter({ factory: sdk.query, executablePath: detection.binaryPath });
  const executor = new ClaudeRuntimeExecutor(adapter, input.signal, input.approvalHandler, input.isolateSettings);
  const events = input.externalSessionId
    ? executor.resumeTurn({
        threadId: input.externalSessionId,
        prompt: input.prompt,
        model: explicitSelection(input.model),
        effort: explicitSelection(input.effort),
        cwd: input.cwd ?? undefined,
      })
    : executor.startTurn({
        prompt: input.prompt,
        model: explicitSelection(input.model),
        effort: explicitSelection(input.effort),
        cwd: input.cwd ?? undefined,
      });
  void detection;
  return { events, executor };
}
