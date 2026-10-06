// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describeFetchError, Lang, LlmError, msg } from "../messages.ts";
import type { Connection, LlmRequest } from "./types.ts";
import { getAdapter } from "./adapters/index.ts";

export const LLM_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_TOKENS = 8192;

async function readErrorBody(response: Response): Promise<string> {
  return response.text();
}

function makeRequest(
  model: string,
  prompt: string,
  system: string,
  signal: AbortSignal,
  maxTokens: number,
  jsonMode: boolean,
): LlmRequest {
  return {
    model,
    system,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    maxTokens,
    temperature: 0.2,
    jsonMode,
    signal,
  };
}

export async function callLlm(opts: {
  prompt: string;
  system: string;
  conn: Connection;
  model: string;
  lang: Lang;
  jsonMode?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { conn } = opts;
  const adapter = getAdapter(conn.format);
  const signal = AbortSignal.any(
    [opts.signal, AbortSignal.timeout(LLM_TIMEOUT_MS)].filter(Boolean) as AbortSignal[],
  );
  const jsonMode = opts.jsonMode ?? conn.jsonMode;
  const baseRequest = makeRequest(
    opts.model,
    opts.prompt,
    opts.system,
    signal,
    opts.maxTokens ?? MAX_OUTPUT_TOKENS,
    jsonMode,
  );
  let url = "";

  try {
    let request = adapter.buildRequest(conn, baseRequest, false);
    url = request.url;
    let response = await fetch(request.url, request.init);
    let errorBody = "";

    if (!response.ok) {
      errorBody = await readErrorBody(response);
      // Beberapa server lama menolak response_format walau endpoint chat-nya
      // berfungsi; satu retry tanpa field ini mempertahankan kompatibilitas.
      if (response.status === 400 && jsonMode && errorBody.toLowerCase().includes("response_format")) {
        const retryRequest = { ...baseRequest, jsonMode: false };
        request = adapter.buildRequest(conn, retryRequest, false);
        response = await fetch(request.url, request.init);
        if (!response.ok) errorBody = await readErrorBody(response);
      }
    }

    if (!response.ok) {
      throw new LlmError(
        msg(opts.lang, "customEndpointError", {
          status: response.status,
          detail: errorBody,
        }),
      );
    }

    const result = adapter.parseResponse(await response.json());
    if (result.stop === "max_tokens") {
      throw new LlmError(msg(opts.lang, "outputTruncated"));
    }
    return result.text;
  } catch (err: any) {
    // Error yang sudah aman ditampilkan harus tetap utuh agar status HTTP,
    // truncation, dan pesan SSE provider tidak berubah menjadi error jaringan.
    if (err instanceof LlmError) throw err;

    const chain: string[] = [];
    for (let cause = err, depth = 0; cause && depth < 4; cause = cause.cause, depth++) {
      chain.push(`${cause.name || "Error"}/${cause.code || "-"}: ${cause.message}`);
    }
    console.error(
      [
        "--- Panggilan LLM gagal ---",
        `format=${conn.format} connection=${conn.id || conn.name} model=${opts.model} url=${url}`,
        `promptChars=${opts.prompt.length} systemChars=${opts.system.length}`,
        ...chain.map((line, index) => `  [${index}] ${line}`),
        "--- akhir ---",
      ].join("\n"),
    );

    if (err?.name === "TimeoutError") {
      throw new Error(
        msg(opts.lang, "llmTimeout", {
          minutes: Math.round(LLM_TIMEOUT_MS / 60000),
          url,
        }),
      );
    }
    throw new Error(
      msg(opts.lang, "customUnreachable", {
        url,
        detail: describeFetchError(err),
      }),
    );
  }
}
