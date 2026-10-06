// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { LlmError } from "../../messages.ts";
import { apiUrl } from "../url.ts";
import type { LlmAdapter, Connection, LlmRequest, LlmResult, Message, StreamEvent, StopReason } from "../types.ts";

type AnthropicBlock = Record<string, any>;

function mapBlock(block: Message["content"][number]): AnthropicBlock | undefined {
  if (block.type === "text") {
    // Anthropic menolak blok teks kosong, sedangkan blok netral boleh muncul dari hasil akumulasi stream.
    return block.text ? { type: "text", text: block.text } : undefined;
  }
  if (block.type === "tool_call") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  return {
    type: "tool_result",
    tool_use_id: block.toolCallId,
    content: block.content,
    ...(block.isError ? { is_error: true } : {}),
  };
}

export function mapAnthropicMessages(messages: Message[]): AnthropicBlock[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(mapBlock).filter((block): block is AnthropicBlock => Boolean(block)),
  }));
}

export function buildAnthropicBody(req: LlmRequest, stream: boolean): Record<string, unknown> {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: mapAnthropicMessages(req.messages),
    tools: (req.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    stream,
  };
}

export function buildAnthropicHeaders(conn: Connection): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": conn.apiKey ?? "",
    "anthropic-version": "2023-06-01",
    // Router tertentu perlu menimpa header standar, jadi merge ini harus paling akhir.
    ...(conn.headers ?? {}),
  };
}

export function buildAnthropicRequest(conn: Connection, req: LlmRequest, stream: boolean): { url: string; init: RequestInit } {
  return {
    url: apiUrl(conn.baseUrl, "messages"),
    init: {
      method: "POST",
      headers: buildAnthropicHeaders(conn),
      body: JSON.stringify(buildAnthropicBody(req, stream)),
      signal: req.signal,
    },
  };
}

function stopReason(reason: unknown): StopReason {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  return "other";
}

function parseToolInput(json: string): { input: unknown; parseError?: string } {
  if (!json) return { input: {} };
  try {
    return { input: JSON.parse(json) };
  } catch (err: any) {
    return { input: {}, parseError: err?.message || String(err) };
  }
}

export function parseAnthropicResponse(data: unknown): LlmResult {
  const response = (data && typeof data === "object" ? data : {}) as AnthropicBlock;
  const textParts: string[] = [];
  const toolCalls: LlmResult["toolCalls"] = [];

  for (const block of Array.isArray(response.content) ? response.content : []) {
    if (block?.type === "text" && typeof block.text === "string") textParts.push(block.text);
    if (block?.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        input: block.input ?? {},
      });
    }
  }

  return { text: textParts.join(""), toolCalls, stop: stopReason(response.stop_reason) };
}

interface BlockAccumulator {
  type?: string;
  id: string;
  name: string;
  json: string;
}

function streamError(data: string): LlmError {
  try {
    const parsed = JSON.parse(data) as AnthropicBlock;
    const message = parsed.error?.message ?? parsed.message;
    return new LlmError(String(message ?? data));
  } catch {
    return new LlmError(data);
  }
}

export async function* streamAnthropicEvents(
  frames: AsyncIterable<{ event?: string; data: string }>
): AsyncGenerator<StreamEvent> {
  const blocks = new Map<number, BlockAccumulator>();
  let stop: StopReason = "other";

  for await (const frame of frames) {
    if (frame.event === "error") throw streamError(frame.data);
    if (frame.event === "message_stop") {
      yield { type: "done", stop };
      continue;
    }
    if (!frame.data.trim()) continue;
    if (frame.data.trim() === "[DONE]") return;

    let data: AnthropicBlock;
    try {
      data = JSON.parse(frame.data) as AnthropicBlock;
    } catch {
      // Frame non-JSON bukan event Anthropic yang bisa diproses; event error tetap
      // ditangani di atas supaya kegagalan setelah HTTP 200 tidak menggantungkan loop.
      continue;
    }

    const event = frame.event ?? data.type;
    if (event === "error" || data.type === "error") throw streamError(frame.data);

    if (event === "content_block_start") {
      const block = data.content_block ?? {};
      blocks.set(Number(data.index), {
        type: block.type,
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        json: "",
      });
      continue;
    }

    if (event === "content_block_delta") {
      const delta = data.delta ?? {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        yield { type: "text", delta: delta.text };
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const block = blocks.get(Number(data.index));
        if (block) block.json += delta.partial_json;
      }
      continue;
    }

    if (event === "content_block_stop") {
      const index = Number(data.index);
      const block = blocks.get(index);
      if (block?.type === "tool_use") {
        const parsed = parseToolInput(block.json);
        yield { type: "tool_call", id: block.id, name: block.name, ...parsed };
      }
      continue;
    }

    if (event === "message_delta") {
      stop = stopReason(data.delta?.stop_reason);
      continue;
    }

  }
}

export const anthropicAdapter: LlmAdapter = {
  format: "anthropic",
  buildRequest: buildAnthropicRequest,
  parseResponse: parseAnthropicResponse,
  streamEvents: streamAnthropicEvents,
};

export default anthropicAdapter;
