import { describeFetchError, LlmError, msg, type Lang } from "../messages.ts";
import { callLlm as callLlmCore, LLM_TIMEOUT_MS, MAX_OUTPUT_TOKENS } from "../llm/call.ts";
import { getAdapter } from "../llm/adapters/index.ts";
import { streamLlm } from "../llm/stream.ts";
import type { Connection, LlmRequest } from "../llm/types.ts";
import { generateRuntimeText, type RuntimeTextTarget } from "./runtimeText.ts";

export interface PipelineOptions {
  signal?: AbortSignal;
  onProgress?: (chars: number) => void;
  /** Write the step with a local runtime instead of the HTTP connection. */
  runtime?: RuntimeTextTarget;
  /** Language of text meant for coding agents (task instructions); defaults to English. */
  agentLang?: Lang;
}

/**
 * Passed as the connection of a step a runtime writes. The generators only
 * check that a connection has an endpoint; generateLlmText never calls it.
 */
export const RUNTIME_CONNECTION: Connection = {
  id: "runtime",
  name: "Runtime",
  format: "openai",
  baseUrl: "runtime:",
  models: [],
  jsonMode: false,
};

interface PipelineLlmOptions extends PipelineOptions {
  prompt: string;
  system: string;
  conn: Connection;
  model: string;
  lang: Lang;
}

function pipelineSignal(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any(
    [signal, AbortSignal.timeout(LLM_TIMEOUT_MS)].filter(Boolean) as AbortSignal[],
  );
}

function streamRequest(opts: PipelineLlmOptions, signal: AbortSignal): LlmRequest {
  return {
    model: opts.model,
    system: opts.system,
    messages: [{ role: "user", content: [{ type: "text", text: opts.prompt }] }],
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    jsonMode: opts.conn.jsonMode,
    signal,
  };
}

function providerUrl(opts: PipelineLlmOptions, request: LlmRequest): string {
  return getAdapter(opts.conn.format).buildRequest(opts.conn, request, true).url;
}

function normalizedStreamError(error: unknown, opts: PipelineLlmOptions, request: LlmRequest): Error {
  const url = providerUrl(opts, request);
  if (error instanceof LlmError) {
    // streamLlm belum menerima bahasa sebagai argumen. Samakan pesan status
    // HTTP yang dibuatnya dengan callLlm agar jalur stream tetap konsisten.
    const match = /^The custom LLM endpoint returned an error \(([^)]+)\): ([\s\S]*)$/.exec(error.message);
    if (match) return new LlmError(msg(opts.lang, "customEndpointError", { status: match[1], detail: match[2] }));
    return error;
  }

  const err = error as any;
  if (err?.name === "TimeoutError") {
    return new Error(
      msg(opts.lang, "llmTimeout", {
        minutes: Math.round(LLM_TIMEOUT_MS / 60000),
        url,
      }),
    );
  }

  return new Error(
    msg(opts.lang, "customUnreachable", {
      url,
      detail: describeFetchError(error),
    }),
  );
}

function canRetryWithoutJson(error: unknown, opts: PipelineLlmOptions): boolean {
  return opts.conn.jsonMode
    && error instanceof LlmError
    && /\(400\)/.test(error.message)
    && error.message.toLowerCase().includes("response_format");
}

async function collectStream(
  opts: PipelineLlmOptions,
  request: LlmRequest,
): Promise<string> {
  let text = "";
  for await (const event of streamLlm(opts.conn, request)) {
    if (event.type === "text") {
      text += event.delta;
      opts.onProgress?.(text.length);
    } else if (event.type === "done" && event.stop === "max_tokens") {
      throw new LlmError(msg(opts.lang, "outputTruncated"));
    }
  }
  return text;
}

export async function generateLlmText(opts: PipelineLlmOptions): Promise<string> {
  if (opts.runtime) {
    return generateRuntimeText({
      target: opts.runtime,
      prompt: opts.prompt,
      system: opts.system,
      signal: pipelineSignal(opts.signal),
      onProgress: opts.onProgress,
    });
  }

  // Tanpa opsi, tetap melalui callLlm lama agar jalur JSON non-streaming tidak
  // berubah: retry response_format, timeout, salvage, dan error handling tetap sama.
  if (opts.signal === undefined && opts.onProgress === undefined) {
    return callLlmCore({
      prompt: opts.prompt,
      system: opts.system,
      conn: opts.conn,
      model: opts.model,
      lang: opts.lang,
      jsonMode: opts.conn.jsonMode,
    });
  }

  const signal = pipelineSignal(opts.signal);
  const request = streamRequest(opts, signal);

  try {
    try {
      return await collectStream(opts, request);
    } catch (error) {
      // Router lama kadang menerima streaming tetapi menolak response_format;
      // samakan retry kompatibilitas yang sudah dimiliki callLlm non-stream.
      if (!canRetryWithoutJson(error, opts)) throw error;
      const retryRequest = { ...request, jsonMode: false };
      return await collectStream(opts, retryRequest);
    }
  } catch (error) {
    if (error instanceof LlmError && error.message === msg(opts.lang, "outputTruncated")) throw error;
    throw normalizedStreamError(error, opts, request);
  }
}
