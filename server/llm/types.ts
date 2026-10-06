// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export type LlmFormat = "anthropic" | "openai";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export interface Message { role: "user" | "assistant"; content: ContentBlock[] }

/** JSON Schema polos. Adapter hanya mengganti nama fieldnya, tidak menulis ulang skemanya. */
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }

export interface Connection {
  id: string;
  name: string;
  format: LlmFormat;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models: string[];
  jsonMode: boolean;
}

export interface LlmRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens: number;
  temperature?: number;
  jsonMode?: boolean;
  signal: AbortSignal;
}

export type StopReason = "stop" | "tool_calls" | "max_tokens" | "other";

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; parseError?: string }
  | { type: "done"; stop: StopReason };

export interface LlmResult {
  text: string;
  toolCalls: { id: string; name: string; input: unknown; parseError?: string }[];
  stop: StopReason;
}

/** Kontrak ini menyatukan URL, body, dan decoder supaya caller tidak perlu tahu format provider. */
export interface LlmAdapter {
  format: LlmFormat;
  buildRequest(conn: Connection, req: LlmRequest, stream: boolean): { url: string; init: RequestInit };
  parseResponse(data: unknown): LlmResult;
  streamEvents(frames: AsyncIterable<{ event?: string; data: string }>): AsyncGenerator<StreamEvent>;
}
