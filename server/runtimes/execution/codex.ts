// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import {
  asRecord,
  readString,
  rpcErrorCode,
  rpcErrorMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type MalformedJsonLine,
} from "./protocol.ts";
import {
  CodexAppServerTransport,
  RuntimeTransportError,
  type AppServerTransport,
  type AppServerTransportOptions,
} from "./transport.ts";
import type {
  RuntimeApprovalDecision,
  RuntimeApprovalHandler,
  RuntimeApprovalRequest,
  RuntimeDoneEvent,
  RuntimeErrorEvent,
  RuntimeEvent,
  RuntimeExecutor,
  RuntimeFileChange,
  RuntimeResumeTurnRequest,
  RuntimeToolEvent,
  RuntimeTurnRequest,
} from "./types.ts";

// A turn is stopped for silence, not for length: a fixed five minutes from the
// start cut off a PRD that had written 28,000 characters, and would cut off any
// task run that simply takes a while. Silence is told apart before the first
// event (the model may be reasoning, which reaches us as nothing) and after it.
export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEFAULT_START_TIMEOUT_MS = 15 * 60 * 1_000;

export interface CodexRuntimeExecutorOptions extends Omit<AppServerTransportOptions, "cwd"> {
  cwd?: string;
  transport?: AppServerTransport;
  approvalHandler?: RuntimeApprovalHandler;
  /** The longest silence once the turn has produced an event. */
  turnTimeoutMs?: number;
  /** The longest wait for the turn's first event. */
  startTimeoutMs?: number;
}

interface TurnState {
  threadId: string;
  turnId: string;
  queue: AsyncEventQueue<RuntimeEvent>;
  timer: ReturnType<typeof setTimeout> | undefined;
  finished: boolean;
  /** The turn has produced an event, so a quiet spell is now a stall rather than a slow start. */
  active: boolean;
  /** Approvals waiting on the user. The turn is quiet because of them, so it is not timed out. */
  waitingOnUser: number;
}

interface StartResult {
  threadId: string;
  turnId: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function recordString(record: Record<string, unknown> | null, key: string): string | null {
  return readString(record?.[key]) ?? null;
}

function idsFromParams(params: unknown): { threadId: string | null; turnId: string | null; itemId: string | null } {
  const record = asRecord(params);
  const turn = asRecord(record?.turn);
  const item = asRecord(record?.item);
  return {
    threadId: recordString(record, "threadId") ?? recordString(turn, "threadId"),
    turnId: recordString(record, "turnId") ?? recordString(turn, "id"),
    itemId: recordString(record, "itemId") ?? recordString(item, "id"),
  };
}

function explicitOverride(value: RuntimeTurnRequest["model"] | RuntimeTurnRequest["effort"]): string | undefined {
  return isNonEmptyString(value) && value !== "inherit" ? value : undefined;
}

function optionalParam(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function errorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof RuntimeTransportError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "EXECUTION_ERROR", message: error.message };
  return { code: "EXECUTION_ERROR", message: "Codex runtime execution failed." };
}

function errorEvent(error: unknown, threadId: string | null, turnId: string | null, fatal: boolean): RuntimeErrorEvent {
  return { type: "error", error: errorInfo(error), threadId, turnId, fatal };
}

function turnFromResult(result: unknown): string | null {
  const record = asRecord(result);
  const turn = asRecord(record?.turn);
  return recordString(turn, "id") ?? recordString(record, "turnId");
}

function threadFromResult(result: unknown): string | null {
  const record = asRecord(result);
  const thread = asRecord(record?.thread);
  return recordString(thread, "id") ?? recordString(record, "threadId");
}

function statusFromTurn(value: unknown): RuntimeDoneEvent["status"] {
  if (value === "interrupted" || value === "failed") return value;
  return "completed";
}

function toolType(item: Record<string, unknown> | null): string | null {
  const type = recordString(item, "type");
  if (!type) return null;
  return /command|fileChange|mcp|tool|search|computer/i.test(type) ? type : null;
}

function toolEvent(
  params: Record<string, unknown>,
  method: string,
  context: { threadId: string; turnId: string },
): RuntimeToolEvent | null {
  const item = asRecord(params.item);
  const type = toolType(item) ?? (method.includes("commandExecution") ? "commandExecution" : null);
  if (!type) return null;
  const ids = idsFromParams(params);
  const data = params.delta ?? params.output ?? params.item ?? params;
  return {
    type: "tool",
    tool: type,
    status: recordString(item, "status") ?? recordString(params, "status"),
    threadId: ids.threadId ?? context.threadId,
    turnId: ids.turnId ?? context.turnId,
    itemId: ids.itemId,
    data,
  };
}

function textEvent(
  params: Record<string, unknown>,
  context: { threadId: string; turnId: string },
): RuntimeEvent | null {
  const text = readString(params.delta);
  if (text === null) return null;
  const ids = idsFromParams(params);
  return {
    type: "text",
    text,
    threadId: ids.threadId ?? context.threadId,
    turnId: ids.turnId ?? context.turnId,
    itemId: ids.itemId,
  };
}

function doneEvent(
  params: Record<string, unknown>,
  context: { threadId: string; turnId: string },
): RuntimeDoneEvent {
  const turn = asRecord(params.turn);
  const turnError = asRecord(turn?.error) ?? asRecord(params.error);
  const error = turnError
    ? { code: rpcErrorCode(turnError), message: rpcErrorMessage(turnError) }
    : null;
  return {
    type: "done",
    status: statusFromTurn(turn?.status ?? params.status),
    threadId: recordString(params, "threadId") ?? context.threadId,
    turnId: recordString(params, "turnId") ?? recordString(turn, "id") ?? context.turnId,
    error,
  };
}

/** Translate documented app-server notifications into the small host contract. */
export function normalizeCodexNotification(
  message: JsonRpcNotification,
  context?: { threadId: string; turnId: string },
): RuntimeEvent | null {
  const params = asRecord(message.params) ?? {};
  const ids = idsFromParams(params);
  const resolvedContext = context ?? {
    threadId: ids.threadId ?? "",
    turnId: ids.turnId ?? "",
  };
  if (message.method === "item/agentMessage/delta") return textEvent(params, resolvedContext);
  if (message.method === "turn/completed") return doneEvent(params, resolvedContext);
  if (
    message.method === "item/started" ||
    message.method === "item/completed" ||
    message.method.endsWith("/outputDelta") ||
    message.method.endsWith("/patchUpdated")
  ) {
    return toolEvent(params, message.method, resolvedContext);
  }
  return null;
}

/** The files a fileChange item touches, or null for any other item. */
export function fileChangesOf(item: Record<string, unknown> | null): RuntimeFileChange[] | null {
  if (recordString(item, "type") !== "fileChange" || !Array.isArray(item?.changes)) return null;
  return item.changes.flatMap((value): RuntimeFileChange[] => {
    const change = asRecord(value);
    const path = recordString(change, "path");
    if (!path) return [];
    // `kind` is { type, move_path } in the app-server protocol; a bare string is read too.
    const kindRecord = asRecord(change?.kind);
    const type = recordString(kindRecord, "type") ?? recordString(change, "kind");
    const kind = type === "add" || type === "update" || type === "delete" ? type : "other";
    const movePath = recordString(kindRecord, "move_path");
    return [{ path, kind, ...(movePath ? { movePath } : {}), diff: recordString(change, "diff") ?? "" }];
  });
}

function normalizeApproval(message: JsonRpcRequest, files?: RuntimeFileChange[]): RuntimeApprovalRequest {
  const params = asRecord(message.params) ?? {};
  const ids = idsFromParams(params);
  const kind = message.method === "item/commandExecution/requestApproval"
    ? "command"
    : message.method === "item/fileChange/requestApproval"
      ? "file_change"
      : "other";
  return {
    requestId: message.id,
    kind,
    threadId: ids.threadId,
    turnId: ids.turnId,
    itemId: ids.itemId,
    command: recordString(params, "command"),
    cwd: recordString(params, "cwd"),
    reason: recordString(params, "reason"),
    ...(kind === "file_change" && files?.length ? { files } : {}),
    details: { ...params, method: message.method },
  };
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) return Promise.resolve({ done: false, value: this.values.shift() as T });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

/**
 * Minimal Codex native runtime adapter. The app-server owns its agent loop
 * and tools; this class only starts/resumes turns and translates events.
 */
export class CodexRuntimeExecutor implements RuntimeExecutor {
  private readonly transport: AppServerTransport;
  private readonly options: CodexRuntimeExecutorOptions;
  private readonly pendingByTurn = new Map<string, RuntimeEvent[]>();
  private readonly turns = new Map<string, TurnState>();
  private readonly seenApprovalRequests = new Set<string | number>();
  // A file change's approval request names only its item. The item, announced
  // just before it, says which files it touches.
  private readonly fileChanges = new Map<string, RuntimeFileChange[]>();
  private activeTurn: TurnState | null = null;
  private initialized = false;
  private disposed = false;
  private removeNotificationListener: (() => void) | null = null;
  private removeServerRequestListener: (() => void) | null = null;
  private removeMalformedListener: (() => void) | null = null;
  private removeExitListener: (() => void) | null = null;

  constructor(options: CodexRuntimeExecutorOptions) {
    this.options = options;
    this.transport = options.transport ?? new CodexAppServerTransport({ ...options, cwd: options.cwd });
    this.removeNotificationListener = this.transport.onNotification((message) => this.onNotification(message));
    this.removeServerRequestListener = this.transport.onServerRequest((message) => this.onServerRequest(message));
    this.removeMalformedListener = this.transport.onMalformed((error) => this.onMalformed(error));
    this.removeExitListener = this.transport.onExit((error) => this.onExit(error));
  }

  startTurn(request: RuntimeTurnRequest): AsyncIterable<RuntimeEvent> {
    return this.runTurn("start", request);
  }

  resumeTurn(request: RuntimeResumeTurnRequest): AsyncIterable<RuntimeEvent> {
    return this.runTurn("resume", request);
  }

  async interrupt(turnId?: string): Promise<void> {
    const state = turnId ? this.turns.get(turnId) : this.activeTurn;
    if (!state) throw new RuntimeTransportError("TURN_NOT_FOUND", "No active Codex turn to interrupt.");
    if (state.finished) return;
    await this.ensureReady();
    await this.transport.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId });
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.removeNotificationListener?.();
    this.removeServerRequestListener?.();
    this.removeMalformedListener?.();
    this.removeExitListener?.();
    for (const state of this.turns.values()) {
      if (!state.finished) {
        state.finished = true;
        if (state.timer !== undefined) clearTimeout(state.timer);
        state.queue.push(errorEvent(new RuntimeTransportError("TRANSPORT_CLOSED", "Runtime closed."), state.threadId, state.turnId, true));
        state.queue.end();
      }
    }
    this.activeTurn = null;
    await this.transport.close();
  }

  private async *runTurn(kind: "start" | "resume", request: RuntimeTurnRequest | RuntimeResumeTurnRequest): AsyncIterable<RuntimeEvent> {
    let state: TurnState | null = null;
    try {
      const result = await this.beginTurn(kind, request);
      state = result.state;
      for await (const event of state.queue) yield event;
    } catch (error) {
      const ids = request.threadId ?? null;
      yield errorEvent(error, ids, null, true);
    }
  }

  private async beginTurn(
    kind: "start" | "resume",
    request: RuntimeTurnRequest | RuntimeResumeTurnRequest,
  ): Promise<{ state: TurnState; result: StartResult }> {
    if (this.disposed) throw new RuntimeTransportError("TRANSPORT_CLOSED", "Runtime is closed.");
    if (this.activeTurn && !this.activeTurn.finished) throw new RuntimeTransportError("TURN_ACTIVE", "A Codex turn is already active.");
    if (!isNonEmptyString(request.prompt)) throw new RuntimeTransportError("INVALID_INPUT", "A non-empty prompt is required.");
    await this.ensureReady();

    let threadId = request.threadId;
    const cwd = request.cwd ?? this.options.cwd;
    // Without these the thread takes the user's own Codex config: read-only
    // in a folder Codex does not trust (edits fail and nothing is asked), or
    // whatever a trusted folder allows. The app promises the same everywhere:
    // writes stay in the workspace and commands ask first.
    const policy = cwd ? { sandbox: "workspace-write", approvalPolicy: "untrusted" } : {};
    if (kind === "resume") {
      if (!threadId) throw new RuntimeTransportError("INVALID_INPUT", "A threadId is required to resume a turn.");
      const resumeParams: Record<string, unknown> = { threadId, ...policy };
      optionalParam(resumeParams, "model", explicitOverride(request.model));
      optionalParam(resumeParams, "cwd", cwd);
      const resumed = await this.transport.request("thread/resume", resumeParams);
      threadId = threadFromResult(resumed) ?? threadId;
    } else if (!threadId) {
      const threadParams: Record<string, unknown> = { ...policy };
      optionalParam(threadParams, "model", explicitOverride(request.model));
      optionalParam(threadParams, "cwd", cwd);
      const started = await this.transport.request("thread/start", threadParams);
      threadId = threadFromResult(started);
      if (!threadId) throw new RuntimeTransportError("PROTOCOL_ERROR", "thread/start returned no thread id.");
    }

    const turnParams: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text: request.prompt }],
    };
    optionalParam(turnParams, "model", explicitOverride(request.model));
    optionalParam(turnParams, "effort", explicitOverride(request.effort));
    optionalParam(turnParams, "cwd", cwd);
    const turnResult = await this.transport.request("turn/start", turnParams);
    const turnId = turnFromResult(turnResult);
    if (!turnId) throw new RuntimeTransportError("PROTOCOL_ERROR", "turn/start returned no turn id.");

    const queue = new AsyncEventQueue<RuntimeEvent>();
    const state: TurnState = { threadId, turnId, queue, timer: undefined, finished: false, active: false, waitingOnUser: 0 };
    this.turns.set(turnId, state);
    this.activeTurn = state;
    const buffered = this.pendingByTurn.get(turnId);
    this.pendingByTurn.delete(turnId);
    for (const event of buffered ?? []) this.pushEvent(state, event);
    this.armTimer(state);
    return { state, result: { threadId, turnId } };
  }

  private async ensureReady(): Promise<void> {
    if (this.initialized) return;
    if (this.disposed) throw new RuntimeTransportError("TRANSPORT_CLOSED", "Runtime is closed.");
    await this.transport.connect();
    this.initialized = true;
  }

  private onNotification(message: JsonRpcNotification): void {
    const ids = idsFromParams(message.params);
    const files = fileChangesOf(asRecord(asRecord(message.params)?.item));
    if (files && ids.itemId) {
      if (message.method === "item/completed") this.fileChanges.delete(ids.itemId);
      else this.fileChanges.set(ids.itemId, files);
    }
    const event = normalizeCodexNotification(message);
    if (!event) return;
    const turnId = "turnId" in event ? event.turnId : ids.turnId;
    if (!turnId) return;
    const state = this.turns.get(turnId);
    if (state) {
      this.pushEvent(state, event);
      return;
    }
    const buffered = this.pendingByTurn.get(turnId) ?? [];
    buffered.push(event);
    this.pendingByTurn.set(turnId, buffered);
  }

  private onServerRequest(message: JsonRpcRequest): void {
    if (this.seenApprovalRequests.has(message.id)) return;
    this.seenApprovalRequests.add(message.id);
    const { itemId } = idsFromParams(message.params);
    const approval = normalizeApproval(message, itemId ? this.fileChanges.get(itemId) : undefined);
    const event: RuntimeEvent = { type: "approval", ...approval };
    const state = approval.turnId ? this.turns.get(approval.turnId) : null;
    if (state) this.pushEvent(state, event);
    else if (approval.turnId) {
      const buffered = this.pendingByTurn.get(approval.turnId) ?? [];
      buffered.push(event);
      this.pendingByTurn.set(approval.turnId, buffered);
    }

    const handler = this.options.approvalHandler;
    if (!handler) {
      // App-server waits for every server request. A missing UI bridge must
      // fail closed instead of leaving the native turn hanging indefinitely.
      void this.transport.respond(message.id, { decision: "decline" });
      return;
    }
    if (state) state.waitingOnUser += 1;
    void Promise.resolve(handler(approval)).then(async (decision) => {
      if (decision === undefined) return;
      await this.transport.respond(message.id, { decision });
    }).catch(async (error) => {
      const requestError = errorEvent(error, approval.threadId, approval.turnId, false);
      if (state) state.queue.push(requestError);
      else if (approval.turnId) {
        const buffered = this.pendingByTurn.get(approval.turnId) ?? [];
        buffered.push(requestError);
        this.pendingByTurn.set(approval.turnId, buffered);
      }
      await this.transport.respond(message.id, { decision: "decline" });
    }).finally(() => {
      // The answer is on its way back to Codex: the silence clock starts again from here.
      if (!state) return;
      state.waitingOnUser = Math.max(0, state.waitingOnUser - 1);
      this.armTimer(state);
    });
  }

  private onMalformed(error: MalformedJsonLine): void {
    const runtimeError = errorEvent(
      new RuntimeTransportError(`PROTOCOL_${error.code}`, "Codex app-server emitted a malformed JSONL message."),
      this.activeTurn?.threadId ?? null,
      this.activeTurn?.turnId ?? null,
      false,
    );
    if (this.activeTurn && !this.activeTurn.finished) this.activeTurn.queue.push(runtimeError);
  }

  private onExit(error: RuntimeTransportError): void {
    for (const state of this.turns.values()) {
      if (state.finished) continue;
      state.queue.push(errorEvent(error, state.threadId, state.turnId, true));
      this.finishState(state);
    }
  }

  private pushEvent(state: TurnState, event: RuntimeEvent): void {
    if (state.finished) return;
    state.queue.push(event);
    if (event.type === "done") {
      this.finishState(state);
      return;
    }
    state.active = true;
    this.armTimer(state);
  }

  private timeoutMs(state: TurnState): number {
    const limit = state.active
      ? this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
      : this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    return Math.max(1, limit);
  }

  /** (Re)start the silence timer for the turn. */
  private armTimer(state: TurnState): void {
    if (state.finished) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = setTimeout(() => this.onTurnTimeout(state), this.timeoutMs(state));
  }

  private finishState(state: TurnState): void {
    if (state.finished) return;
    state.finished = true;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.queue.end();
    if (this.activeTurn === state) this.activeTurn = null;
  }

  private onTurnTimeout(state: TurnState): void {
    if (state.finished) return;
    if (state.waitingOnUser > 0) {
      this.armTimer(state);
      return;
    }
    const minutes = Math.max(1, Math.round(this.timeoutMs(state) / 60_000));
    const message = state.active
      ? `Codex turn timed out: nothing came back for ${minutes} minutes.`
      : `Codex turn timed out: no first answer within ${minutes} minutes.`;
    state.queue.push(errorEvent(new RuntimeTransportError("TURN_TIMEOUT", message), state.threadId, state.turnId, true));
    const interrupt = this.interrupt(state.turnId).catch(() => undefined);
    void interrupt.finally(() => {
      if (state.finished) return;
      this.pushEvent(state, {
        type: "done",
        status: "failed",
        threadId: state.threadId,
        turnId: state.turnId,
        error: { code: "TURN_TIMEOUT", message },
      });
    });
  }
}

export function createCodexRuntimeExecutor(options: CodexRuntimeExecutorOptions): RuntimeExecutor {
  return new CodexRuntimeExecutor(options);
}
