import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";

import { getSession } from "../../db.ts";
import { langOf, type Lang } from "../messages.ts";
import { adoptChatWorkspace, chatWorkspaceEvent, ensureChatWorkspace } from "../agent/chatWorkspace.ts";
import {
  appendMessage,
  ensureConversationFor,
  getConversation,
  linkConversationToProject,
  loadMessagesWithMeta,
  recordConversationNote,
} from "../agent/conversations.ts";
import { unseenMessages, withConversationContext, type ConversationContext, type StoredMessage } from "../agent/runtimeContext.ts";
import { validateTransientWorkspaceRoot } from "./agent.ts";
import { autoApproves, parsePermissionMode, runtimeApprovalAction, type PermissionMode } from "../agent/permissionMode.ts";
import { discoverRuntime } from "../runtimes/discovery.ts";
import type { RuntimeDetection, RuntimeId } from "../runtimes/types.ts";
import {
  appendRunEvent,
  addRunEvidence,
  createRunApproval,
  createRun,
  getRun,
  getRunByExternalSession,
  listRunEvents,
  listRuns,
  resolveRunApproval,
  startRun,
  updateRunStatus,
} from "../runs/store.ts";
import type { Run } from "../runs/types.ts";
import type {
  RuntimeApprovalRequest,
  RuntimeEvent,
  RuntimeToolEvent,
} from "../runtimes/execution/types.ts";
import {
  createRuntimeRunnerAsync,
  loadClaudeSdkModule,
  RuntimeRunnerError,
  type ClaudeSdkModule,
  type RuntimeRunnerDependencies,
} from "../runtime-runner/index.ts";
import {
  applyAgentHarness,
  NATIVE_RUNTIME_HARNESS_SETTINGS,
} from "../agent/harness.ts";

const router = express.Router();
const APPROVAL_TIMEOUT_MS = 300_000;

type PendingRuntimeApproval = {
  runId: string;
  settle: (approved: boolean, status?: "approved" | "rejected" | "expired") => void;
};

const pendingRuntimeApprovals = new Map<string, PendingRuntimeApproval>();

export interface RuntimeAgentRouterOptions {
  discover?: typeof discoverRuntime;
  runnerDependencies?: RuntimeRunnerDependencies;
}

interface RuntimeAgentBody {
  runtime: RuntimeId;
  connectionId?: string | null;
  message: string;
  conversationId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  workspaceRoot?: string | null;
  model?: string | null;
  effort?: string | null;
  externalSessionId?: string | null;
  idempotencyKey?: string | null;
  permissionMode: PermissionMode;
  /** The UI language, which the card's note is written in. */
  language: Lang;
}

interface NormalizedUiEvent extends Record<string, unknown> {
  type: string;
}

class RequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "RequestError";
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RequestError(`${field} is required.`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, field);
}

function preference(value: unknown, field: string): string {
  if (value === undefined || value === null || value === "") return "inherit";
  return text(value, field);
}

function runtimeId(value: unknown): RuntimeId {
  if (value === "codex" || value === "claude" || value === "antigravity") return value;
  throw new RequestError("runtime must be codex, claude, or antigravity.");
}

function parseBody(value: unknown): RuntimeAgentBody {
  if (!isRecord(value)) throw new RequestError("A runtime agent request object is required.");
  return {
    runtime: runtimeId(value.runtime),
    connectionId: optionalText(value.connectionId, "connectionId"),
    message: text(value.message, "message"),
    conversationId: optionalText(value.conversationId, "conversationId"),
    taskId: optionalText(value.taskId, "taskId"),
    sessionId: optionalText(value.sessionId, "sessionId"),
    workspaceRoot: optionalText(value.workspaceRoot, "workspaceRoot"),
    model: preference(value.model, "model"),
    effort: preference(value.effort, "effort"),
    externalSessionId: optionalText(value.externalSessionId, "externalSessionId"),
    idempotencyKey: optionalText(value.idempotencyKey, "idempotencyKey"),
    permissionMode: parsePermissionMode(value.permissionMode),
    language: langOf({ body: value }),
  };
}

function sseHeaders(res: Response, statusCode = 200): void {
  res.status(statusCode).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number {
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return 400;
}

function sendJsonError(res: Response, error: unknown): void {
  if (!res.headersSent) res.status(errorStatus(error)).json({ error: errorMessage(error) });
}

function writeEvent(res: Response, value: NormalizedUiEvent): boolean {
  if (res.writableEnded || res.writableFinished) return false;
  try {
    res.write(`data: ${JSON.stringify(value)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function safeError(error: unknown): { code: string; message: string } {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return { code: error.code, message: errorMessage(error) };
  }
  return { code: "RUNTIME_EXECUTION_FAILED", message: errorMessage(error) };
}

function eventIds(runId: string, conversationId: string, event: NormalizedUiEvent): NormalizedUiEvent {
  return {
    ...event,
    runId,
    conversationId: typeof event.conversationId === "string" ? event.conversationId : conversationId,
  };
}

function toolName(data: unknown, fallback: string): string {
  if (isRecord(data) && typeof data.name === "string" && data.name.trim()) return data.name;
  return fallback;
}

function toolInput(data: unknown): unknown {
  if (!isRecord(data)) return data;
  return data.input ?? data.parameters ?? data;
}

function terminalToolStatus(status: string | null): boolean {
  return Boolean(status && /result|completed|complete|done|failed|error|cancelled|denied/i.test(status));
}

// The runner reports session and step progress as a tool named "progress".
// It is not a tool call: shown as one it never finishes, and it is not
// evidence that any work was done.
function isProgress(event: RuntimeToolEvent): boolean {
  return event.tool === "progress";
}

function recordToolEvidence(run: Run, event: RuntimeToolEvent): void {
  if (!run.taskId || isProgress(event) || !terminalToolStatus(event.status)) return;
  const name = event.tool.toLowerCase();
  const kind = /edit|write|patch|file/.test(name)
    ? "diff" as const
    : /shell|exec|command|terminal|bash/.test(name)
      ? "command" as const
      : /test|verify|check|lint|build/.test(name)
        ? "verification" as const
        : "artifact" as const;
  const data = isRecord(event.data) ? event.data : null;
  const input = data && isRecord(data.input) ? data.input : null;
  const command = typeof data?.command === "string"
    ? data.command
    : typeof input?.command === "string" ? input.command : null;
  const rawExitCode = data?.exitCode ?? data?.exit_code;
  const exitCode = typeof rawExitCode === "number" && Number.isInteger(rawExitCode) ? rawExitCode : null;
  addRunEvidence({
    runId: run.id,
    kind,
    summary: `${event.tool}${event.status ? ` · ${event.status}` : ""}`,
    payload: event.data,
    command,
    exitCode,
  });
}

function normalizeRuntimeEvent(event: RuntimeEvent): NormalizedUiEvent[] {
  if (event.type === "text") return [{ type: "text", text: event.text }];
  if (event.type === "tool") {
    const tool = event as RuntimeToolEvent;
    if (tool.tool === "runtime_session") {
      return [{ type: "runtime_session", ...(isRecord(tool.data) ? tool.data : {}) }];
    }
    if (isProgress(tool)) return [];
    if (terminalToolStatus(tool.status)) {
      return [{
        type: "tool_done",
        id: tool.itemId ?? `${tool.turnId}:tool`,
        tool: toolName(tool.data, tool.tool),
        result: tool.data,
        isError: Boolean(tool.status && /failed|error|denied/i.test(tool.status)),
      }];
    }
    return [{
      type: "tool_start",
      id: tool.itemId ?? `${tool.turnId}:tool`,
      tool: toolName(tool.data, tool.tool),
      input: toolInput(tool.data),
    }];
  }
  // The approval handler already showed this request, with an id the chat can
  // answer. The provider's copy in the stream would be a second card whose
  // answer reaches no one.
  if (event.type === "approval") return [];
  // The chat handler sends the one done event, with the status the run
  // actually ends in; forwarding the provider's as well sent two.
  if (event.type === "done") return [];
  return [{
    type: "error",
    message: event.error.message,
    code: event.error.code,
    retryable: !event.fatal,
  }];
}

function waitForRuntimeApproval(
  runId: string,
  approval: RuntimeApprovalRequest,
  send: (event: NormalizedUiEvent) => boolean,
  signal: AbortSignal,
): Promise<"accept" | "decline"> {
  const stored = createRunApproval({
    runId,
    toolCallId: approval.itemId,
    request: approval,
  });
  const current = getRun(runId);
  if (current?.status === "running") updateRunStatus(runId, { status: "waiting_for_approval" });

  send({
    type: "approval_request",
    approvalId: stored.id,
    elicitId: stored.id,
    command: approval.command ?? "",
    kind: approval.kind,
    ...(approval.files?.length ? { files: approval.files } : {}),
    ...(approval.cwd ? { cwd: approval.cwd } : {}),
    message: approval.reason ?? "Runtime meminta izin untuk menjalankan tool ini.",
    details: approval.details,
  });

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (approved: boolean, status: "approved" | "rejected" | "expired" = approved ? "approved" : "rejected") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      pendingRuntimeApprovals.delete(stored.id);
      resolveRunApproval(stored.id, status, { approved });
      const latest = getRun(runId);
      if (latest?.status === "waiting_for_approval") updateRunStatus(runId, { status: "running" });
      send({
        type: "approval_resolved",
        approvalId: stored.id,
        elicitId: stored.id,
        approved,
      });
      resolve(approved ? "accept" : "decline");
    };
    const onAbort = () => finish(false, "expired");
    pendingRuntimeApprovals.set(stored.id, { runId, settle: finish });
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(false, "expired"), APPROVAL_TIMEOUT_MS);
    timer.unref?.();
  });
}

type SettingResolution = { value: string | null; source: "inherit" | "user-override" | "runtime-config" };

function resolveEffective(
  detection: RuntimeDetection | null,
  requested: string,
  field: "model" | "effort",
): SettingResolution {
  if (requested !== "inherit") return { value: requested, source: "user-override" };
  const catalog = detection?.catalog;
  const model = catalog?.models[0];
  const value = field === "model" ? (catalog?.models.find((item) => item.defaultModel)?.defaultModel ?? model?.defaultModel) : (model?.defaultEffort ?? null);
  return { value: value ?? null, source: value ? "runtime-config" : "inherit" };
}

function validateSelection(detection: RuntimeDetection, model: string, effort: string): void {
  const catalog = detection.catalog;
  if (!catalog) return;
  if (model !== "inherit" && catalog.models.length > 0 && !catalog.models.some((entry) => entry.modelId === model)) {
    throw new RuntimeRunnerError("MODEL_UNAVAILABLE", `Model is not listed by the discovered runtime: ${model}`, 409);
  }
  if (effort !== "inherit" && catalog.models.some((entry) => entry.effortOptions.length > 0)
    && !catalog.models.some((entry) => entry.effortOptions.some((option) => option.value === effort))) {
    throw new RuntimeRunnerError("EFFORT_UNAVAILABLE", `Effort is not supported by the discovered runtime: ${effort}`, 409);
  }
}

function appendTranscript(conversationId: string, userMessage: string, assistantText: string, meta: object): void {
  appendMessage(conversationId, { role: "user", content: [{ type: "text", text: userMessage }] }, meta);
  if (assistantText) appendMessage(conversationId, { role: "assistant", content: [{ type: "text", text: assistantText }] }, meta);
}

/**
 * Each runtime keeps its own provider session per conversation. The part of
 * the conversation that session has not seen, said with another runtime or
 * before it existed, goes ahead of the request.
 */
function conversationPrompt(conversationId: string, runtime: string, externalSessionId: string | null, prompt: string): ConversationContext {
  const stored: StoredMessage[] = loadMessagesWithMeta(conversationId).map((message) => ({
    ...message,
    meta: {
      ...(typeof message.meta.runtime === "string" ? { runtime: message.meta.runtime } : {}),
      ...(typeof message.meta.runId === "string" ? { runId: message.meta.runId } : {}),
    },
  }));
  const sessionRunIds = new Set(externalSessionId
    ? listRuns({ conversationId, limit: 100 })
      .filter((run) => run.snapshot.runtime === runtime && run.snapshot.externalSessionId === externalSessionId)
      .map((run) => run.id)
    : []);
  return withConversationContext(prompt, unseenMessages(stored, sessionRunIds));
}

const FOLLOW_POLL_MS = 250;

function isTerminalStatus(status: Run["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

/**
 * A repeated idempotency request streams the run the first request started
 * instead of starting a second provider turn. Events are read back from the
 * store, so this follows a run that is still in progress until it ends.
 */
async function followRun(run: Run, res: Response, ac: AbortController): Promise<void> {
  const send = (event: NormalizedUiEvent): boolean => writeEvent(res, eventIds(run.id, run.conversationId ?? "", event));
  send({ type: "run", status: run.status });
  send({ type: "conversation" });
  let afterSequence = 0;
  let sawDone = false;
  let status = run.status;
  while (!ac.signal.aborted) {
    // The owning request writes its terminal status and its done event in
    // the same synchronous step, so events read after a terminal status
    // include everything that run will ever persist.
    status = getRun(run.id)?.status ?? status;
    let page = listRunEvents(run.id, { afterSequence, limit: 500 });
    while (page.length > 0) {
      for (const stored of page) {
        afterSequence = stored.sequence;
        if (isRecord(stored.payload) && typeof stored.payload.type === "string") {
          if (stored.payload.type === "done") sawDone = true;
          send(stored.payload as NormalizedUiEvent);
        }
      }
      page = listRunEvents(run.id, { afterSequence, limit: 500 });
    }
    if (isTerminalStatus(status)) break;
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
  }
  // A run ended by restart reconciliation never persisted its own done event.
  if (!ac.signal.aborted && isTerminalStatus(status) && !sawDone) {
    send({ type: "done", runStatus: status, stop: status === "completed" ? "other" : "stop" });
  }
  if (!res.writableEnded) res.end();
}

async function chat(req: Request, res: Response, options: RuntimeAgentRouterOptions): Promise<void> {
  let body: RuntimeAgentBody;
  try {
    body = parseBody(req.body);
  } catch (error) {
    sendJsonError(res, error);
    return;
  }

  let conversationId: string;
  try {
    const project = body.sessionId ? getSession(body.sessionId) : null;
    if (body.taskId && (!project || !project.tasks?.some((task) => task.id === body.taskId))) {
      throw new RequestError("taskId does not belong to the selected project.", 409);
    }
    if (body.taskId && project) {
      // A task waits for the tasks it depends on. An id that names no task
      // cannot be satisfied and does not hold the task back.
      const tasks = (project.tasks ?? []) as Array<{ id: string; status?: string; dependencies?: string[] }>;
      const task = tasks.find((item) => item.id === body.taskId);
      const open = (task?.dependencies ?? []).filter((id) => tasks.some((other) => other.id === id && other.status !== "done"));
      if (open.length) {
        throw new RequestError(`Task ${body.taskId} waits on ${open.join(", ")}, which ${open.length === 1 ? "is" : "are"} not done yet.`, 409);
      }
    }
    if (project?.workspaceRoot) {
      // Persisted project configuration is server-owned; do not let a tab
      // replace it with a different execution root for one request.
      if (body.workspaceRoot && body.workspaceRoot !== project.workspaceRoot) {
        throw new RequestError("workspaceRoot does not match the selected project.", 409);
      }
      body.workspaceRoot = project.workspaceRoot;
    } else if (body.workspaceRoot) {
      body.workspaceRoot = validateTransientWorkspaceRoot(body.workspaceRoot);
    }
    // A chat that was not saved yet ran as a standalone conversation. Once it
    // becomes a project (a folder is chosen and the session is saved), the
    // same conversation carries on inside it instead of being refused.
    if (project && body.conversationId) {
      const existing = getConversation(body.conversationId);
      if (existing && !existing.sessionId && !existing.projectId) linkConversationToProject(existing.id, project.id);
    }
    conversationId = ensureConversationFor({
      sessionId: project ? body.sessionId : null,
      projectId: project?.id ?? null,
      conversationId: body.conversationId,
    });
  } catch (error) {
    sendJsonError(res, error);
    return;
  }

  let detection: RuntimeDetection | null = null;
  let discoveryError: unknown = null;
  let sdkError: unknown = null;
  let claudeSdk: ClaudeSdkModule | null = null;
  try {
    if (body.runtime === "claude") {
      try {
        claudeSdk = await (options.runnerDependencies?.loadClaudeSdk ?? loadClaudeSdkModule)();
      } catch (error) {
        // Discovery still runs below so the caller receives the runtime's
        // actual detection result together with SDK_UNAVAILABLE.
        sdkError = error;
      }
    }
    const claudeMetadata = claudeSdk?.supportedModels
      ? { supportedModels: claudeSdk.supportedModels.bind(claudeSdk) }
      : undefined;
    detection = await (options.discover ?? discoverRuntime)(body.runtime, {
      cwd: body.workspaceRoot ?? undefined,
      ...(claudeMetadata ? { claudeSdk: claudeMetadata } : {}),
    });
  } catch (error) {
    discoveryError = error;
  }

  let effectiveModel: SettingResolution = { value: null, source: "inherit" };
  let effectiveEffort: SettingResolution = { value: null, source: "inherit" };
  try {
    if (detection) {
      if (body.connectionId && detection.catalog?.connectionId && body.connectionId !== detection.catalog.connectionId) {
        throw new RuntimeRunnerError("CONNECTION_CHANGED", "The selected runtime connection changed. Refresh runtime discovery and choose it again.", 409);
      }
      validateSelection(detection, body.model ?? "inherit", body.effort ?? "inherit");
      effectiveModel = resolveEffective(detection, body.model ?? "inherit", "model");
      effectiveEffort = resolveEffective(detection, body.effort ?? "inherit", "effort");
    }
  } catch (error) {
    discoveryError = error;
  }

  if (body.externalSessionId) {
    const owner = getRunByExternalSession(body.runtime, body.externalSessionId);
    const requestedConnection = body.connectionId ?? detection?.catalog?.connectionId ?? `runtime:${body.runtime}`;
    if (!owner
      || owner.conversationId !== conversationId
      || owner.snapshot.workspace !== (body.workspaceRoot ?? null)
      || owner.snapshot.connectionId !== requestedConnection) {
      sendJsonError(res, new RequestError("externalSessionId does not belong to this conversation, workspace, and connection.", 409));
      return;
    }
  }

  let createdRun: Run;
  let created: boolean;
  try {
    const result = createRun({
      idempotencyKey: body.idempotencyKey ?? `runtime-agent-${randomUUID()}`,
      conversationId,
      taskId: body.taskId,
      runtime: body.runtime,
      connectionId: body.connectionId ?? detection?.catalog?.connectionId ?? `runtime:${body.runtime}`,
      requestedModel: body.model ?? "inherit",
      effectiveModel: effectiveModel.value,
      modelSource: effectiveModel.source,
      requestedEffort: body.effort ?? "inherit",
      effectiveEffort: effectiveEffort.value,
      effortSource: effectiveEffort.source,
      runtimeVersion: detection?.version ?? null,
      workspace: body.workspaceRoot ?? null,
      externalSessionId: body.externalSessionId ?? null,
    });
    createdRun = result.run;
    created = result.created;
  } catch (error) {
    sendJsonError(res, error);
    return;
  }

  const responseStatus = sdkError
    ? errorStatus(sdkError)
    : discoveryError
      ? errorStatus(discoveryError)
      : detection?.status === "ready" ? 200 : 503;
  sseHeaders(res, responseStatus);
  const ac = new AbortController();
  const onDisconnect = (): void => {
    if (!res.writableEnded && !res.writableFinished && !ac.signal.aborted) ac.abort(new Error("client disconnected"));
  };
  res.on("close", onDisconnect);

  if (!created) {
    await followRun(createdRun, res, ac);
    res.off("close", onDisconnect);
    return;
  }

  const run = createdRun;
  const send = (event: NormalizedUiEvent): boolean => {
    const withIds = eventIds(run.id, conversationId, event);
    appendRunEvent(run.id, { type: withIds.type, payload: withIds });
    const sent = writeEvent(res, withIds);
    if (!sent && !ac.signal.aborted) ac.abort(new Error("client disconnected"));
    return sent;
  };

  send({ type: "run", status: "queued" });
  send({ type: "conversation" });
  if (sdkError || discoveryError || !detection || detection.status !== "ready") {
    const error = safeError(sdkError ?? discoveryError ?? new RuntimeRunnerError(
      "RUNTIME_NOT_READY",
      `${body.runtime} runtime is not ready (${detection?.diagnostic ?? "RUNTIME_NOT_DISCOVERED"}).`,
      503,
    ));
    const failure = eventIds(run.id, conversationId, { type: "error", code: error.code, message: error.message, retryable: false });
    appendRunEvent(run.id, { type: failure.type, payload: failure });
    updateRunStatus(run.id, { status: "failed", error: `${error.code}: ${error.message}` });
    writeEvent(res, failure);
    if (!res.writableEnded) res.end();
    res.off("close", onDisconnect);
    return;
  }
  let executor: { interrupt?: (turnId?: string) => Promise<void>; close: () => Promise<void> } | null = null;
  const interruptExecutor = (): void => { void executor?.interrupt?.().catch(() => undefined); };
  let assistantText = "";
  // Text that resumes after a tool call is a new paragraph in the stored
  // reply, not a run-on of whatever text came before the tool. This only
  // affects what gets appended to assistantText, not the individual "text"
  // events streamed live to the chat.
  let assistantTextNeedsParagraphBreak = false;
  let externalSessionId = body.externalSessionId ?? null;
  let approvalRejected = false;
  // A provider stream that reconnects can deliver a finished item again; the
  // item already has its evidence and its tool_done event.
  const finishedToolItems = new Set<string>();
  // Codex sends an event per chunk of command output and Antigravity repeats
  // an active step; the chat shows the tool once and then its result.
  const startedToolItems = new Set<string>();
  let providerDoneError: { code: string; message: string } | null = null;
  // Whether the user has already been shown why the run failed.
  let failureShown = false;
  let finalStatus: "completed" | "failed" | "interrupted" = "failed";
  let finalError: string | null = null;
  try {
    startRun(run.id);
    // The run now holds the conversation and the workspace, so files this chat
    // made before it had a folder can move there without another run writing.
    if (body.workspaceRoot) {
      const filesEvent = chatWorkspaceEvent(adoptChatWorkspace(conversationId, body.workspaceRoot));
      if (filesEvent) {
        send(filesEvent);
        recordConversationNote(conversationId, filesEvent);
      }
    }
    const context = conversationPrompt(
      conversationId,
      body.runtime,
      body.externalSessionId ?? null,
      applyAgentHarness(body.message, NATIVE_RUNTIME_HARNESS_SETTINGS, { task: Boolean(body.taskId), noteLang: body.language }),
    );
    // The chat says so when a runtime is handed earlier messages: it gets
    // their text, not the tool results or the state of the other session.
    if (context.included > 0) {
      const note = {
        type: "context_carried",
        runtime: body.runtime,
        included: context.included,
        omitted: context.omitted,
        resumed: Boolean(body.externalSessionId),
      };
      send(note);
      recordConversationNote(conversationId, note);
    }
    appendTranscript(conversationId, body.message, "", { runtime: body.runtime, runId: run.id });
    const runner = await createRuntimeRunnerAsync({
      runtime: body.runtime,
      prompt: context.prompt,
      model: body.model,
      effort: body.effort,
      cwd: body.workspaceRoot || ensureChatWorkspace(conversationId),
      externalSessionId: body.externalSessionId,
      detection,
      signal: ac.signal,
      dependencies: options.runnerDependencies,
      claudeSdk: claudeSdk ?? undefined,
      approvalHandler: async (approval) => {
        if (autoApproves(body.permissionMode, runtimeApprovalAction(approval))) return "accept";
        const decision = await waitForRuntimeApproval(run.id, approval, send, ac.signal);
        if (decision === "decline") approvalRejected = true;
        return decision;
      },
    });
    executor = runner.executor;
    ac.signal.addEventListener("abort", interruptExecutor, { once: true });
    for await (const runtimeEvent of runner.events) {
      if (ac.signal.aborted) {
        finalStatus = "interrupted";
        // A dropped network connection and the chat's Stop button both abort
        // the same request the same way, so the server cannot tell which one
        // happened; the stored reason says that honestly instead of naming a
        // fault that may not be there.
        finalError = "The chat stopped this run, or its connection to the server was lost.";
        break;
      }
      const ids = "threadId" in runtimeEvent && typeof runtimeEvent.threadId === "string" ? runtimeEvent.threadId : null;
      if (ids && ids !== "runtime-session-unknown" && ids !== externalSessionId) {
        externalSessionId = ids;
        send({ type: "runtime_session", externalSessionId: ids });
      }
      if (runtimeEvent.type === "text") {
        if (assistantText && assistantTextNeedsParagraphBreak) assistantText += "\n\n";
        assistantTextNeedsParagraphBreak = false;
        assistantText += runtimeEvent.text;
      }
      if (runtimeEvent.type === "tool") assistantTextNeedsParagraphBreak = true;
      if (runtimeEvent.type === "tool" && runtimeEvent.itemId && terminalToolStatus(runtimeEvent.status)) {
        if (finishedToolItems.has(runtimeEvent.itemId)) continue;
        finishedToolItems.add(runtimeEvent.itemId);
      } else if (runtimeEvent.type === "tool" && runtimeEvent.itemId) {
        if (startedToolItems.has(runtimeEvent.itemId) || finishedToolItems.has(runtimeEvent.itemId)) continue;
        startedToolItems.add(runtimeEvent.itemId);
      }
      if (runtimeEvent.type === "tool") recordToolEvidence(run, runtimeEvent);
      for (const event of normalizeRuntimeEvent(runtimeEvent)) send(event);
      if (runtimeEvent.type === "error" && runtimeEvent.fatal) {
        failureShown = true;
        finalStatus = "failed";
        finalError = `${runtimeEvent.error.code}: ${runtimeEvent.error.message}`;
        break;
      }
      if (runtimeEvent.type === "done") {
        providerDoneError = runtimeEvent.error;
        finalStatus = runtimeEvent.status;
        finalError = runtimeEvent.error ? `${runtimeEvent.error.code}: ${runtimeEvent.error.message}` : null;
      }
    }
    if (approvalRejected && finalStatus === "completed") {
      finalStatus = "failed";
      finalError = "RUNTIME_APPROVAL_REJECTED: A requested tool action was rejected.";
    }
    if (ac.signal.aborted) finalStatus = "interrupted";
  } catch (error) {
    const info = safeError(error);
    finalStatus = ac.signal.aborted ? "interrupted" : "failed";
    finalError = `${info.code}: ${info.message}`;
    send({ type: "error", code: info.code, message: info.message, retryable: false });
    failureShown = true;
  } finally {
    if (ac.signal.aborted && executor?.interrupt) await executor.interrupt().catch(() => undefined);
    ac.signal.removeEventListener("abort", interruptExecutor);
    await executor?.close().catch(() => undefined);
    if (assistantText) {
      appendMessage(conversationId, { role: "assistant", content: [{ type: "text", text: assistantText }] }, { runtime: body.runtime, runId: run.id });
    }
    if (run.taskId && assistantText) {
      addRunEvidence({
        runId: run.id,
        kind: "summary",
        summary: "Runtime response summary",
        payload: { response: assistantText },
      });
    }
    const status = finalStatus === "completed" ? "completed" : finalStatus === "interrupted" ? "interrupted" : "failed";
    updateRunStatus(run.id, {
      status,
      ...(finalError ? { error: finalError } : {}),
      result: { status, ...(externalSessionId ? { externalSessionId } : {}), ...(assistantText ? { response: assistantText } : {}) },
      ...(externalSessionId ? { externalSessionId } : {}),
    });
    // A provider can end a turn as failed without a separate error event: an
    // expired login or a spent quota arrives only on its result. The chat
    // shows error events, not the reason carried on done.
    if (status === "failed" && !failureShown) {
      const reason = providerDoneError
        ?? (approvalRejected
          ? { code: "RUNTIME_APPROVAL_REJECTED", message: "A requested tool action was rejected, so the run did not finish." }
          : { code: "RUNTIME_RUN_FAILED", message: "The runtime ended the run without saying why." });
      send({ type: "error", code: reason.code, message: reason.message, retryable: true });
    }
    send({
      type: "done",
      runStatus: status,
      stop: status === "completed" ? "other" : "stop",
      ...(providerDoneError ? { message: providerDoneError.message, code: providerDoneError.code } : {}),
    });
    if (!res.writableEnded) res.end();
    res.off("close", onDisconnect);
  }
}

function decideRuntimeApproval(req: Request, res: Response): void {
  try {
    const body = isRecord(req.body) ? req.body : {};
    const approvalId = text(body.approvalId ?? body.elicitId, "approvalId");
    const runId = text(body.runId, "runId");
    if (typeof body.approved !== "boolean") throw new RequestError("approved must be a boolean.");
    const pending = pendingRuntimeApprovals.get(approvalId);
    if (!pending) throw new RequestError("That runtime approval request is no longer valid.", 404);
    if (pending.runId !== runId) throw new RequestError("Approval does not belong to this run.", 409);
    pending.settle(body.approved);
    res.json({ success: true, runId: pending.runId, approvalId, approved: body.approved });
  } catch (error) {
    sendJsonError(res, error);
  }
}

export function createRuntimeAgentRouter(options: RuntimeAgentRouterOptions = {}): express.Router {
  const scoped = express.Router();
  scoped.post("/api/runtime-agent/chat", (req, res) => void chat(req, res, options));
  scoped.post("/api/runtime-agent/approve", decideRuntimeApproval);
  return scoped;
}

router.post("/api/runtime-agent/chat", (req, res) => void chat(req, res, {}));
router.post("/api/runtime-agent/approve", decideRuntimeApproval);

export { router };
export default router;
