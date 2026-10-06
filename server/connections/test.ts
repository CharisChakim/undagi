// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Lang } from "../messages.ts";
import { listModels } from "../llm/models.ts";
import { streamLlm } from "../llm/stream.ts";
import type { Connection, LlmRequest, Message, ToolDef } from "../llm/types.ts";

const PROBE_TIMEOUT_MS = 30_000;
const CHAT_PROMPT = "Reply with the single word: ok";
const TOOLS_PROMPT = "You must call the ping tool now. Do not reply with text.";

const PING_TOOL: ToolDef = {
  name: "ping",
  description: "Reply by calling this tool.",
  parameters: { type: "object", properties: {}, required: [] },
};

export interface Probe {
  name: "models" | "chat" | "tools";
  ok: boolean;
  ms: number;
  detail?: string;
}

interface StreamProbeResult {
  ok: boolean;
  detail?: string;
}

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutDetail(lang: Lang): string {
  return lang === "id" ? "Probe melewati batas waktu 30 detik." : "Probe timed out after 30 seconds.";
}

function failureDetail(lang: Lang, english: string, indonesian: string): string {
  return lang === "id" ? indonesian : english;
}

function probeSignal(): AbortSignal {
  return AbortSignal.timeout(PROBE_TIMEOUT_MS);
}

async function streamProbe(
  conn: Connection,
  model: string,
  lang: Lang,
  messages: Message[],
  tools?: ToolDef[],
): Promise<StreamProbeResult> {
  const signal = probeSignal();
  let sawText = false;
  let sawDone = false;
  let sawToolCall = false;

  const request: LlmRequest = {
    model,
    messages,
    ...(tools ? { tools } : {}),
    maxTokens: 64,
    signal,
  };

  try {
    for await (const event of streamLlm(conn, request)) {
      if (event.type === "text") sawText = true;
      if (event.type === "done") sawDone = true;
      if (event.type === "tool_call" && event.name === "ping" && !event.parseError) {
        sawToolCall = true;
      }
    }
  } catch (error: unknown) {
    return { ok: false, detail: signal.aborted ? timeoutDetail(lang) : errorDetail(error) };
  }

  if (tools) {
    if (!sawToolCall) {
      return {
        ok: false,
        detail: failureDetail(
          lang,
          "The stream did not contain a parsed ping tool call.",
          "Stream tidak berisi tool call ping yang berhasil diparse.",
        ),
      };
    }
    return { ok: true };
  }

  if (!sawText || !sawDone) {
    return {
      ok: false,
      detail: failureDetail(
        lang,
        !sawText ? "The stream did not contain a text event." : "The stream did not contain a done event.",
        !sawText ? "Stream tidak berisi event text." : "Stream tidak berisi event done.",
      ),
    };
  }
  return { ok: true };
}

async function runProbe(
  name: Probe["name"],
  lang: Lang,
  probe: () => Promise<StreamProbeResult>,
): Promise<Probe> {
  const started = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<StreamProbeResult>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(timeoutDetail(lang))), PROBE_TIMEOUT_MS);
  });

  try {
    // listModels fase 1 belum menerima AbortSignal, jadi batas luar ini mencegah probe menggantungkan test.
    const result = await Promise.race([probe(), deadline]);
    return { name, ok: result.ok, ms: Date.now() - started, ...(result.detail ? { detail: result.detail } : {}) };
  } catch (error: unknown) {
    return { name, ok: false, ms: Date.now() - started, detail: errorDetail(error) };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function testConnection(conn: Connection, model: string, lang: Lang): Promise<{
  ok: boolean;
  toolsSupported: boolean;
  models: string[];
  probes: Probe[];
}> {
  const probes: Probe[] = [];
  let discoveredModels: string[] = Array.isArray(conn.models) ? conn.models : [];

  const modelsProbe = await runProbe("models", lang, async () => {
    const discovery = await listModels(conn);
    discoveredModels = discovery.models;
    return {
      ok: !discovery.error,
      ...(discovery.error ? { detail: discovery.error } : {}),
    };
  });
  probes.push(modelsProbe);

  const chatProbe = await runProbe("chat", lang, () => streamProbe(conn, model, lang, [userMessage(CHAT_PROMPT)]));
  probes.push(chatProbe);

  // Chat harus lulus dulu karena probe tools hanya bermakna setelah jalur stream dasarnya hidup.
  if (!chatProbe.ok) {
    return { ok: false, toolsSupported: false, models: discoveredModels, probes };
  }

  const toolsProbe = await runProbe("tools", lang, () =>
    streamProbe(conn, model, lang, [userMessage(TOOLS_PROMPT)], [PING_TOOL]),
  );
  probes.push(toolsProbe);

  return {
    ok: true,
    toolsSupported: toolsProbe.ok,
    models: discoveredModels,
    probes,
  };
}
