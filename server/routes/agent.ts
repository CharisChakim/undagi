import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";

import { getSession } from "../../db.ts";
import { resolveRole, getConnection } from "../connections/store.ts";
import { LLM_TIMEOUT_MS } from "../llm/call.ts";
import type { Connection } from "../llm/types.ts";
import type { Lang } from "../messages.ts";
import {
  ensureConversationFor,
  getConversation,
  importLegacyHistory,
  linkConversationToProject,
  listConversations,
  loadConversationNotes,
  loadMessages,
  recordConversationNote,
} from "../agent/conversations.ts";
import { adoptChatWorkspace, chatWorkspaceEvent } from "../agent/chatWorkspace.ts";
import { hasActiveRun } from "../runs/store.ts";
import { runAgent } from "../agent/loop.ts";
import { parseAgentHarnessSettings } from "../agent/harness.ts";
import { parsePermissionMode, withPermissionMode } from "../agent/permissionMode.ts";

const router = express.Router();

const DEFAULT_BASE_URL = "http://localhost:20128/v1";
const DEFAULT_MODEL = "claude-combo";
const ELICIT_TIMEOUT_MS = 300_000;

type ElicitRequest =
  | { kind: "approval"; command: string; cwd?: string }
  | { kind: "questions"; questions: unknown[]; round: number };

type ElicitEntry = {
  convId: string;
  settle: (value: unknown) => void;
};

// Nonce ini tidak dimaksudkan sebagai batas keamanan pada aplikasi localhost
// single-user; ia hanya mencegah tab lama menjawab prompt percakapan lain.
const pendingElicitations = new Map<string, ElicitEntry>();
// A native folder dialog is an explicit local authorization. Keep that
// authorization process-local so a browser cannot manufacture it by posting a
// path; typed paths continue to use the configured trusted roots below.
const approvedWorkspaceRoots = new Set<string>();

class RequestError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJsonError(res: Response, error: unknown, fallbackStatus = 500): void {
  const requestError = error instanceof RequestError ? error : undefined;
  if (!res.headersSent) res.status(requestError?.statusCode ?? fallbackStatus).json({ error: errorMessage(error) });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RequestError(`${field} is required.`);
  return value.trim();
}

function legacyConnection(config: unknown): { conn: Connection; model: string } {
  if (!isRecord(config)) throw new RequestError("An agent connection or legacy agentConfig is required.");

  const baseUrl = typeof config.baseUrl === "string" && config.baseUrl.trim()
    ? config.baseUrl.trim()
    : DEFAULT_BASE_URL;
  const key = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const envKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const headers = isRecord(config.headers)
    ? Object.fromEntries(Object.entries(config.headers).filter(([, value]) => typeof value === "string"))
    : {};
  const requestedModel = config.model ?? config.modelName;

  return {
    conn: {
      id: "legacy",
      name: "Legacy",
      // Konfigurasi lama memang berbicara dengan router berformat Anthropic,
      // jadi provider lama tidak boleh ditafsirkan ulang sebagai OpenAI/Gemini.
      format: "anthropic",
      baseUrl,
      ...(key || envKey ? { apiKey: key || envKey } : {}),
      headers,
      models: [],
      jsonMode: false,
    },
    model: typeof requestedModel === "string" && requestedModel.trim()
      ? requestedModel.trim()
      : DEFAULT_MODEL,
  };
}

function resolveAgentConnection(body: Record<string, any>): { conn: Connection; model: string } {
  const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";

  if (connectionId && model) {
    const connection = getConnection(connectionId);
    if (!connection) throw new RequestError(`Connection not found: ${connectionId}.`, 404);
    if (!connection.enabled) throw new RequestError(`Connection is disabled: ${connectionId}.`);
    return { conn: connection, model };
  }

  const binding = resolveRole("agent");
  if (binding) return binding;

  if (body.agentConfig !== undefined && body.agentConfig !== null) {
    return legacyConnection(body.agentConfig);
  }

  throw new RequestError(
    "No LLM endpoint is set up for the agent. Pick a runtime such as Codex in the composer, or add an endpoint in Connections.",
  );
}

function sseHeaders(res: Response): void {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
}

function makeSender(res: Response, ac: AbortController): (event: unknown) => boolean {
  return (event: unknown): boolean => {
    if (res.writableEnded || ac.signal.aborted) return false;
    try {
      // JSON.stringify meng-escape newline di dalam nilai, sehingga satu event
      // tetap satu frame SSE dan tidak dapat memecah parser klien.
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      return true;
    } catch (error) {
      if (!ac.signal.aborted) ac.abort(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  };
}

function makeElicit(
  convId: string,
  ac: AbortController,
  send: (event: unknown) => boolean,
  ownedIds: Set<string>,
): (request: ElicitRequest) => Promise<unknown> {
  return (request: ElicitRequest): Promise<unknown> => {
    const elicitId = randomUUID();
    ownedIds.add(elicitId);

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (value: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        ac.signal.removeEventListener("abort", onAbort);
        pendingElicitations.delete(elicitId);
        ownedIds.delete(elicitId);

        if (request.kind === "approval") {
          send({
            type: "approval_resolved",
            approvalId: elicitId,
            elicitId,
            approved: Boolean(value),
          });
        }
        resolve(value);
      };

      const onAbort = (): void => finish(false);
      pendingElicitations.set(elicitId, { convId, settle: finish });
      ac.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(false), ELICIT_TIMEOUT_MS);

      const event = request.kind === "approval"
        ? {
            type: "approval_request",
            approvalId: elicitId,
            elicitId,
            command: request.command,
            ...(request.cwd ? { cwd: request.cwd } : {}),
          }
        : {
            type: "questions",
            elicitId,
            questions: request.questions,
            round: request.round,
          };

      if (!send(event)) finish(false);
    });
  };
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, field);
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function realpathOrNearestExistingParent(candidate: string): string {
  let current = candidate;
  while (true) {
    try {
      return fs.realpathSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function trustedWorkspaceRoots(): string[] {
  const configured = (process.env.UNDAGI_WORKSPACE_ROOTS || process.env.ARCHITECH_WORKSPACE_ROOTS)
    ?.split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean) ?? [];
  const roots = [process.cwd(), ...configured];
  return roots.flatMap((root) => {
    try {
      return [fs.realpathSync(path.resolve(root))];
    } catch {
      // A configured root that does not exist cannot authorize a client path.
      return [];
    }
  });
}

export function registerApprovedWorkspaceRoot(value: string): string {
  const selected = path.resolve(value.trim());
  const canonical = fs.realpathSync(selected);
  if (!fs.statSync(canonical).isDirectory()) throw new RequestError("Selected path is not a folder.");
  approvedWorkspaceRoots.add(canonical);
  return canonical;
}

export function validateTransientWorkspaceRoot(value: string): string {
  const selected = path.resolve(value.trim());
  let canonicalSelected: string;
  try {
    canonicalSelected = realpathOrNearestExistingParent(selected);
  } catch {
    throw new RequestError("workspaceRoot must be inside a trusted workspace root.");
  }

  const roots = [...trustedWorkspaceRoots(), ...approvedWorkspaceRoots];
  if (!roots.some((root) => isInsideRoot(canonicalSelected, root))) {
    throw new RequestError("workspaceRoot must be inside a trusted workspace root.");
  }
  return value.trim();
}

function transientContext(body: Record<string, any>): { workspaceRoot?: string; allowShell: boolean } {
  const workspaceRoot = typeof body.workspaceRoot === "string" ? body.workspaceRoot.trim() : "";
  const validatedWorkspaceRoot = workspaceRoot ? validateTransientWorkspaceRoot(workspaceRoot) : "";
  return {
    ...(validatedWorkspaceRoot ? { workspaceRoot: validatedWorkspaceRoot } : {}),
    // Shell permission is request-scoped for standalone chat. It never gets
    // persisted as a project setting by this route.
    allowShell: Boolean(workspaceRoot && body.allowShell === true),
  };
}

// `language` is the UI language (it also names UI labels in the prompt);
// `agentLanguage` is "ui" when the user wants the model-facing instructions in
// that same language. A missing or unknown value means English.
export function chatLanguages(body: Record<string, any>): { humanLang: Lang; agentLang: Lang } {
  const humanLang: Lang = body.language === "id" ? "id" : "en";
  return { humanLang, agentLang: body.agentLanguage === "ui" ? humanLang : "en" };
}

async function chat(req: Request, res: Response): Promise<void> {
  const body = isRecord(req.body) ? req.body : {};
  let sessionId: string | null;
  let projectSession: any | null;
  let requestedConversationId: string | null;
  let message: string;
  let resolved: { conn: Connection; model: string };
  let convId: string;
  let transient: { workspaceRoot?: string; allowShell: boolean } | undefined;

  try {
    message = requiredString(body.message, "message");
    const requestedSessionId = optionalString(body.sessionId, "sessionId");
    requestedConversationId = optionalString(body.conversationId, "conversationId");
    resolved = resolveAgentConnection(body);

    // Existing project chat keeps its persisted session. A missing session is
    // a standalone draft from the client and receives a nullable conversation
    // row instead of forcing the client to create a fake project session.
    projectSession = requestedSessionId ? getSession(requestedSessionId) : null;
    sessionId = projectSession ? requestedSessionId : null;

    const existing = requestedConversationId ? getConversation(requestedConversationId) : null;
    // A chat that ran before its session was saved becomes part of the
    // project once it is one, instead of being refused as a stranger.
    if (projectSession && existing && !existing.sessionId && !existing.projectId) {
      linkConversationToProject(existing.id, projectSession.id);
    }
    if (!projectSession && existing?.projectId) {
      // A linked standalone conversation resumes its project context even when
      // the browser still sends the old transient client session id.
      const linkedSession = getSession(existing.projectId);
      if (linkedSession) {
        projectSession = linkedSession;
        sessionId = existing.projectId;
      }
    }

    convId = ensureConversationFor({
      sessionId,
      projectId: projectSession ? projectSession.id : null,
      conversationId: requestedConversationId,
    });

    // Setelah percakapan memiliki pesan, SQLite menjadi sumber kebenaran agar
    // klien lama tidak dapat menimpa transcript hanya karena reload.
    if (loadMessages(convId).length === 0 && Array.isArray(body.history) && body.history.length > 0) {
      importLegacyHistory(convId, body.history);
    }
    if (!projectSession) transient = transientContext(body);
  } catch (error) {
    sendJsonError(res, error);
    return;
  }

  const { humanLang, agentLang } = chatLanguages(body);
  const ac = new AbortController();
  const providerSignal = AbortSignal.any([ac.signal, AbortSignal.timeout(LLM_TIMEOUT_MS)]);
  const send = makeSender(res, ac);
  const ownedIds = new Set<string>();
  const abortForRequestDisconnect = (): void => {
    // Pada Node versi baru, IncomingMessage.close juga terjadi setelah body POST
    // selesai dibaca. req.complete membedakan kondisi normal itu dari putus di
    // tengah request; res.close menangani putus setelah request sudah lengkap.
    if (!req.complete && !ac.signal.aborted) ac.abort(new Error("client disconnected"));
  };
  const abortForResponseDisconnect = (): void => {
    if (!res.writableEnded && !res.writableFinished && !ac.signal.aborted) {
      ac.abort(new Error("client disconnected"));
    }
  };
  const heartbeat = setInterval(() => {
    if (res.writableEnded || ac.signal.aborted) return;
    try {
      res.write(": ping\n\n");
    } catch (error) {
      if (!ac.signal.aborted) ac.abort(error instanceof Error ? error : new Error(String(error)));
    }
  }, 15_000);
  heartbeat.unref?.();

  req.on("aborted", abortForRequestDisconnect);
  req.on("close", abortForRequestDisconnect);
  res.on("close", abortForResponseDisconnect);
  sseHeaders(res);
  send({ type: "conversation", conversationId: convId });
  // Files this chat made before it had a folder move there, unless a runtime
  // run is still working in the chat or the folder.
  const projectRoot = typeof projectSession?.workspaceRoot === "string" ? projectSession.workspaceRoot : "";
  if (projectRoot && !hasActiveRun(convId, projectRoot)) {
    const filesEvent = chatWorkspaceEvent(adoptChatWorkspace(convId, projectRoot));
    if (filesEvent) {
      send(filesEvent);
      recordConversationNote(convId, filesEvent);
    }
  }

  try {
    await runAgent({
      sessionId,
      ...(sessionId ? {} : transient),
      conversationId: convId,
      userMessage: message,
      conn: resolved.conn,
      model: resolved.model,
      harnessSettings: parseAgentHarnessSettings(body.harnessSettings),
      lang: humanLang,
      agentLang,
      limits: (projectSession?.agentLimits || {}) as any,
      onEvent: (event: unknown) => send(event),
      elicit: withPermissionMode(makeElicit(convId, ac, send, ownedIds), parsePermissionMode(body.permissionMode)),
      signal: providerSignal,
    });
  } catch (error) {
    if (!ac.signal.aborted) send({ type: "error", message: errorMessage(error) });
  } finally {
    // Loop yang gagal atau dibatalkan tidak boleh meninggalkan promise elicitation
    // yang masih menahan timer dan referensi ke response yang sudah mati.
    for (const id of [...ownedIds]) pendingElicitations.get(id)?.settle(false);
    clearInterval(heartbeat);
    req.off("aborted", abortForRequestDisconnect);
    req.off("close", abortForRequestDisconnect);
    res.off("close", abortForResponseDisconnect);
    if (!res.writableEnded) res.end();
  }
}

router.post("/api/agent/chat", chat);

router.post("/api/agent/conversations/:conversationId/link", (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  let projectId: string;
  try {
    projectId = requiredString(body.projectId, "projectId");
  } catch (error) {
    sendJsonError(res, error);
    return;
  }
  if (!getSession(projectId)) {
    res.status(404).json({ error: `Session not found: ${projectId}.` });
    return;
  }
  try {
    res.json({ conversation: linkConversationToProject(req.params.conversationId, projectId) });
  } catch (error) {
    sendJsonError(res, error, 404);
  }
});

// A browser that never saw a project's chat (another browser, the desktop app,
// cleared storage) has no conversation id for it; this lets it find one.
router.get("/api/agent/conversations", (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
  if (!projectId) {
    res.status(400).json({ error: "projectId is required." });
    return;
  }
  res.json({ conversations: listConversations({ projectId }) });
});

router.get("/api/agent/conversations/:conversationId/messages", (req, res) => {
  const conversationId = String(req.params.conversationId || "").trim();
  if (!conversationId) {
    res.status(400).json({ error: "conversationId is required." });
    return;
  }
  const conversation = getConversation(conversationId);
  if (!conversation) {
    res.status(404).json({ error: `Conversation not found: ${conversationId}.` });
    return;
  }
  // Message metadata (model, connection id) stays server-side. Content blocks
  // contain only the transcript needed to repaint the local chat pane.
  res.json({ conversation, messages: loadMessages(conversationId), notes: loadConversationNotes(conversationId) });
});

router.post("/api/agent/respond", (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  let elicitId: string;
  let conversationId: string;
  try {
    elicitId = requiredString(body.elicitId, "elicitId");
    conversationId = requiredString(body.conversationId, "conversationId");
  } catch (error) {
    sendJsonError(res, error);
    return;
  }
  if (!("response" in body)) {
    res.status(400).json({ error: "response is required." });
    return;
  }

  const pending = pendingElicitations.get(elicitId);
  if (!pending) {
    res.status(404).json({ error: "That elicitation request is no longer valid." });
    return;
  }
  if (pending.convId !== conversationId) {
    // Ini pemeriksaan korelasi untuk tab basi, bukan otorisasi: nonce yang sulit
    // ditebak adalah pelindung sebenarnya pada aplikasi single-user localhost.
    res.status(409).json({ error: "That elicitation belongs to another conversation." });
    return;
  }

  pending.settle(body.response);
  res.json({ ok: true });
});

router.post("/api/agent/approve", (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  let approvalId: string;
  try {
    approvalId = requiredString(body.approvalId, "approvalId");
  } catch (error) {
    sendJsonError(res, error);
    return;
  }
  if (typeof body.approved !== "boolean") {
    res.status(400).json({ error: "approved must be a boolean." });
    return;
  }

  const pending = pendingElicitations.get(approvalId);
  if (!pending) {
    res.status(404).json({ error: "That approval request is no longer valid." });
    return;
  }
  // Alias ini sengaja tidak meminta conversationId agar ChatPanel lama tetap
  // dapat menyelesaikan approval selama satu rilis kompatibilitas.
  pending.settle(body.approved);
  res.json({ ok: true });
});

export { router, pendingElicitations };
export default router;
