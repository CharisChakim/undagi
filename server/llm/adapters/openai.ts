// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { LlmError } from "../../messages.ts";
import { apiUrl } from "../url.ts";
import type {
  Connection,
  ContentBlock,
  LlmRequest,
  LlmResult,
  Message,
  StopReason,
  StreamEvent,
  ToolDef,
} from "../types.ts";
import type { SseFrame } from "../sse.ts";

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiCallAccumulator {
  id: string;
  name: string;
  args: string;
}

function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolDefs(tools: ToolDef[]): OpenAiToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

interface OpenAiToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Pesan hasil tool dipecah karena OpenAI tidak menerima satu pesan user berisi beberapa hasil tool. */
export function openAiMessages(system: string | undefined, messages: Message[]): OpenAiMessage[] {
  const result: OpenAiMessage[] = [];

  if (system !== undefined) {
    result.push({ role: "system", content: system });
  }

  for (const message of messages) {
    if (message.role === "assistant") {
      const text = textFromBlocks(message.content);
      const calls = message.content.filter(
        (block): block is Extract<ContentBlock, { type: "tool_call" }> => block.type === "tool_call"
      );
      const toolCalls = calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input),
        },
      }));

      result.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result"
    );
    for (const toolResult of toolResults) {
      result.push({
        role: "tool",
        tool_call_id: toolResult.toolCallId,
        content: toolResult.content,
      });
    }

    const textBlocks = message.content.filter((block) => block.type === "text");
    if (textBlocks.length || !toolResults.length) {
      result.push({
        role: "user",
        content: textFromBlocks(message.content),
      });
    }
  }

  return result;
}

export function openAiHeaders(conn: Connection): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (conn.apiKey) headers.authorization = `Bearer ${conn.apiKey}`;
  // Router tertentu perlu menimpa Authorization bawaan, jadi header koneksi harus menang paling akhir.
  return { ...headers, ...(conn.headers ?? {}) };
}

export function openAiBody(req: LlmRequest, stream: boolean): Record<string, unknown> {
  return {
    model: req.model,
    messages: openAiMessages(req.system, req.messages),
    max_tokens: req.maxTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    stream,
    ...(req.tools && { tools: toolDefs(req.tools) }),
    ...(req.jsonMode && { response_format: { type: "json_object" } }),
  };
}

export function buildOpenAiRequest(
  conn: Connection,
  req: LlmRequest,
  stream: boolean
): { url: string; init: RequestInit } {
  const headers = openAiHeaders(conn);
  const body = openAiBody(req, stream);
  return {
    url: apiUrl(conn.baseUrl, "chat/completions"),
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    },
  };
}

function parseToolCall(call: any): { id: string; name: string; input: unknown; parseError?: string } {
  const args = typeof call?.function?.arguments === "string" ? call.function.arguments : "";
  let input: unknown = {};
  let parseError: string | undefined;

  try {
    input = JSON.parse(args || "{}");
  } catch (err: any) {
    input = {};
    parseError = err?.message || String(err);
  }

  return {
    id: typeof call?.id === "string" && call.id ? call.id : randomUUID(),
    name: typeof call?.function?.name === "string" ? call.function.name : "",
    input,
    ...(parseError ? { parseError } : {}),
  };
}

function stopReason(finishReason: unknown, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_calls";
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "stop") return "stop";
  return "other";
}

export function parseOpenAiResponse(data: any): LlmResult {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
  const message = choice?.message;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls.map(parseToolCall) : [];

  return {
    text: typeof message?.content === "string" ? message.content : "",
    toolCalls,
    stop: stopReason(choice?.finish_reason, toolCalls.length > 0),
  };
}

function streamErrorMessage(data: string): string {
  try {
    const parsed = JSON.parse(data);
    return parsed?.error?.message || parsed?.message || data;
  } catch {
    return data;
  }
}

function emitToolCalls(acc: Map<number, OpenAiCallAccumulator>): StreamEvent[] {
  return [...acc.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => parseToolCall({ id: call.id, function: { name: call.name, arguments: call.args } }))
    .map((call) => ({ type: "tool_call" as const, ...call }));
}

export async function* openAiStreamEvents(frames: AsyncIterable<SseFrame>): AsyncGenerator<StreamEvent> {
  const acc = { calls: new Map<number, OpenAiCallAccumulator>(), finishReason: undefined as unknown };

  for await (const frame of frames) {
    if (frame.event === "error") {
      throw new LlmError(streamErrorMessage(frame.data));
    }
    if (frame.data.trim() === "[DONE]") {
      for (const event of emitToolCalls(acc.calls)) yield event;
      yield { type: "done", stop: stopReason(acc.finishReason, acc.calls.size > 0) };
      return;
    }
    if (!frame.data.trim()) continue;

    let chunk: any;
    try {
      chunk = JSON.parse(frame.data);
    } catch (err: any) {
      throw new LlmError(err?.message || String(err));
    }

    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
    if (typeof choice?.finish_reason === "string") acc.finishReason = choice.finish_reason;

    const delta = choice?.delta;
    if (typeof delta?.content === "string" && delta.content) {
      yield { type: "text", delta: delta.content };
    }

    if (!Array.isArray(delta?.tool_calls)) continue;
    for (const tc of delta.tool_calls) {
      const idx = typeof tc.index === "number" ? tc.index : 0;   // sebagian gateway tidak mengirim index
      const cur = acc.calls.get(idx) ?? { id: "", name: "", args: "" };
      if (tc.id && !cur.id) cur.id = tc.id;
      if (tc.function?.name && !cur.name) cur.name = tc.function.name;  // assign-once
      if (tc.function?.arguments) cur.args += tc.function.arguments;    // selalu concat
      acc.calls.set(idx, cur);
    }
  }

  for (const event of emitToolCalls(acc.calls)) yield event;
  yield { type: "done", stop: stopReason(acc.finishReason, acc.calls.size > 0) };
}

export const openaiAdapter = {
  format: "openai" as const,
  buildRequest: buildOpenAiRequest,
  parseResponse: parseOpenAiResponse,
  streamEvents: openAiStreamEvents,
};

export const openAiAdapter = openaiAdapter;
export default openaiAdapter;
