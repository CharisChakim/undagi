import express from "express";
import path from "path";
import dotenv from "dotenv";
import { listSessions, getSession, saveSession, deleteSession } from "./db.ts";
import { Lang, langOf, msg } from "./server/messages.ts";
import { parseJsonFromLlm } from "./server/llm/json.ts";
import { callLlm as callLlmCore } from "./server/llm/call.ts";
import { resolveFor, type Role } from "./server/connections/store.ts";
import connectionsRouter from "./server/connections/routes.ts";
import agentRouter from "./server/routes/agent.ts";
import folderPickerRouter from "./server/routes/folder-picker.ts";
import runtimesRouter from "./server/routes/runtimes.ts";
import runtimePreferencesRouter from "./server/routes/runtime-preferences.ts";
import runsRouter from "./server/routes/runs.ts";
import runtimeAgentRouter from "./server/routes/runtime-agent.ts";
import mcpRouter from "./server/mcp/routes.ts";
import { listConversations } from "./server/agent/conversations.ts";
import { removeChatWorkspaces } from "./server/agent/chatWorkspace.ts";
import { generateFollowups } from "./server/pipeline/followups.ts";
import { generatePlan } from "./server/pipeline/plan.ts";
import { generatePrd } from "./server/pipeline/prd.ts";
import { generateTasks } from "./server/pipeline/tasks.ts";
import { agentLangOf } from "./server/pipeline/language.ts";
import { RUNTIME_CONNECTION, type PipelineOptions } from "./server/pipeline/llm.ts";
import { parseRuntimeTarget } from "./server/pipeline/runtimeText.ts";
import type { Connection } from "./server/llm/types.ts";
import { acceptsEventStream, streamGeneration } from "./server/streaming.ts";

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(connectionsRouter);
app.use(agentRouter);
app.use(folderPickerRouter);
app.use(runtimesRouter);
app.use(runtimePreferencesRouter);
app.use(runsRouter);
app.use(runtimeAgentRouter);
app.use(mcpRouter);

// Port 0 membuat OS memilih port bebas; paket desktop memakainya supaya tidak
// bentrok dengan apa pun yang sudah memakai 3000, lalu membaca port sebenarnya
// dari nilai yang di-resolve startServer().
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const PRODUCTION = process.env.NODE_ENV === "production" || process.argv.includes("--production");

// Route lama tetap memakai signature ini supaya klien dan keempat generator tidak
// perlu berubah saat transport provider dipindahkan ke layer netral.
async function callLlm(
  prompt: string,
  systemInstruction: string,
  llmConfig?: any,
  lang: Lang = "en",
  role: Role = "plan",
  requestBody: any = {},
): Promise<string> {
  const { conn, model } = resolveFor(role, { ...requestBody, llmConfig }, lang);
  if (!conn.baseUrl) throw new Error(msg(lang, "baseUrlRequired"));
  return callLlmCore({ prompt, system: systemInstruction, conn, model, lang, jsonMode: conn.jsonMode });
}

// A step the user sent to a runtime (runtimeTarget) skips the HTTP connection;
// every other request resolves its role's connection as before. Text written for
// coding agents stays English unless the request asks for the UI language.
function pipelineModel(role: Role, body: any, lang: Lang): { conn: Connection; model: string; options: PipelineOptions } {
  const agentLang = agentLangOf({ body }, lang);
  const runtime = parseRuntimeTarget(body?.runtimeTarget);
  if (runtime) return { conn: RUNTIME_CONNECTION, model: runtime.model, options: { runtime, agentLang } };
  return { ...resolveFor(role, body, lang), options: { agentLang } };
}

// API Routes

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Riwayat Proyek (SQLite) — daftar, buka, simpan, hapus
app.get("/api/sessions", (req, res) => {
  try {
    res.json({ sessions: listSessions() });
  } catch (err: any) {
    console.error("Error GET /api/sessions:", err);
    res.status(500).json({ error: err.message || msg(langOf(req), "historyLoadFailed") });
  }
});

app.get("/api/sessions/:id", (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: msg(langOf(req), "sessionNotFound") });
      return;
    }
    res.json(session);
  } catch (err: any) {
    console.error("Error GET /api/sessions/:id:", err);
    res.status(500).json({ error: err.message || msg(langOf(req), "sessionLoadFailed") });
  }
});

app.put("/api/sessions/:id", (req, res) => {
  try {
    const session = req.body;
    if (!session || session.id !== req.params.id) {
      res.status(400).json({ error: msg(langOf(req), "sessionIdMismatch") });
      return;
    }
    saveSession(session);
    res.json({ success: true });
  } catch (err: any) {
    console.error("Error PUT /api/sessions/:id:", err);
    res.status(500).json({ error: err.message || msg(langOf(req), "sessionSaveFailed") });
  }
});

app.delete("/api/sessions/:id", (req, res) => {
  try {
    deleteSession(req.params.id);
    // The chat folders of a project that never got its files moved are not
    // reachable once the project is gone.
    removeChatWorkspaces(listConversations({ projectId: req.params.id }).map((conversation) => conversation.id));
    res.json({ success: true });
  } catch (err: any) {
    console.error("Error DELETE /api/sessions/:id:", err);
    res.status(500).json({ error: err.message || msg(langOf(req), "sessionDeleteFailed") });
  }
});

// Test LLM Connection
app.post("/api/test-llm", async (req, res) => {
  try {
    const { llmConfig } = req.body;
    const lang = langOf(req);
    const testPrompt = "Kirim pesan JSON singkat {\"status\": \"connected\", \"message\": \"Koneksi LLM Berhasil\"}";
    const sys = "Respon dalam format JSON valid.";
    const result = await callLlm(testPrompt, sys, llmConfig, lang);
    const parsed = parseJsonFromLlm(result, lang);
    res.json({ success: true, response: parsed });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fitur 1: Follow-up Questions (Mengklarifikasi Ide & Spesifikasi Proyek)
app.post("/api/followup-questions", async (req, res) => {
  if (acceptsEventStream(req)) {
    await streamGeneration(req, res, ({ signal, onProgress }) => {
      const lang = langOf(req);
      const { conn, model, options } = pipelineModel("plan", req.body, lang);
      return generateFollowups(req.body, conn, model, lang, { signal, onProgress, ...options });
    });
    return;
  }
  try {
    const lang = langOf(req);
    const { conn, model, options } = pipelineModel("plan", req.body, lang);
    const data = await generateFollowups(req.body, conn, model, lang, options);
    res.json(data);
  } catch (err: any) {
    console.error("Error /api/followup-questions:", err);
    res.status(500).json({ error: err.message || msg(langOf(req), "followUpFailed") });
  }
});

// Fitur 1: Generate Plan (Arsitektur, Roadmap, Estimasi, Diagram Horizontal)
app.post("/api/generate-plan", async (req, res) => {
  if (acceptsEventStream(req)) {
    await streamGeneration(req, res, ({ signal, onProgress }) => {
      const lang = langOf(req);
      const { conn, model, options } = pipelineModel("plan", req.body, lang);
      return generatePlan(req.body, conn, model, lang, req.body?.lockedFeatures, { signal, onProgress, ...options });
    });
    return;
  }
  try {
    const lang = langOf(req);
    const { conn, model, options } = pipelineModel("plan", req.body, lang);
    const data = await generatePlan(req.body, conn, model, lang, req.body?.lockedFeatures, options);
    res.json(data);
  } catch (err: any) {
    console.error("Error /api/generate-plan:", err);
    res.status(500).json({ error: err.message || msg(langOf(req), "planFailed") });
  }
});

// Fitur 2: Generate PRD Sesuai Standar 7 Poin & Diagram Horizontal
app.post("/api/generate-prd", async (req, res) => {
  if (acceptsEventStream(req)) {
    await streamGeneration(req, res, ({ signal, onProgress }) => {
      const { title, plan, description } = req.body;
      const lang = langOf(req);
      const { conn, model, options } = pipelineModel("prd", req.body, lang);
      return generatePrd(title, plan, conn, model, lang, { signal, onProgress, ...options }, description);
    });
    return;
  }
  try {
    const { title, plan, description } = req.body;
    const lang = langOf(req);
    const { conn, model, options } = pipelineModel("prd", req.body, lang);
    const data = await generatePrd(title, plan, conn, model, lang, options, description);
    res.json(data);
  } catch (err: any) {
    console.error("Error /api/generate-prd:", err);
    res.status(500).json({ error: err.message || msg(langOf(req), "prdFailed") });
  }
});

app.post("/api/generate-tasks", async (req, res) => {
  if (acceptsEventStream(req)) {
    await streamGeneration(req, res, async ({ signal, onProgress }) => {
      const { title, plan, prd } = req.body;
      const lang = langOf(req);
      const { conn, model, options } = pipelineModel("tasks", req.body, lang);
      // The same { tasks } shape as the JSON answer below; the client reads .tasks.
      return { tasks: await generateTasks(title, plan, prd, conn, model, lang, { signal, onProgress, ...options }) };
    });
    return;
  }
  try {
    const { title, plan, prd } = req.body;
    const lang = langOf(req);
    const { conn, model, options } = pipelineModel("tasks", req.body, lang);
    const tasks = await generateTasks(title, plan, prd, conn, model, lang, options);
    res.json({ tasks });
  } catch (err: any) {
    console.error("Error /api/generate-tasks:", err);
    res.status(500).json({ error: err.message || msg(langOf(req), "tasksFailed") });
  }
});

// Start Express + Vite integration
async function startServer() {
  if (!PRODUCTION) {
    // Diimpor di sini, bukan di puncak berkas, supaya Vite tidak ikut terbawa
    // ke dalam paket desktop yang tidak pernah menjalankan cabang ini.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = process.env.UNDAGI_DIST_DIR || process.env.ARCHITECH_DIST_DIR || path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  return new Promise<number>((resolve, reject) => {
    const server = app.listen(PORT, HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : PORT;
      console.log(`Undagi server listening on http://localhost:${port}`);
      resolve(port);
    });
    server.on("error", reject);
  });
}

// Di-export supaya shell desktop bisa menunggu server siap dan tahu port yang
// benar-benar dipakai sebelum membuka jendela.
export const serverReady = startServer();
