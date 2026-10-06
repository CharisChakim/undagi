// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { sseFrames } from "../llm/sse.ts";
import type { JsonRpcChannel, JsonRpcRequestOptions } from "./jsonrpc.ts";

function signalFor(options: JsonRpcRequestOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

function errorFromRpc(value: any): Error {
  const message = typeof value?.message === "string" ? value.message : "MCP request failed.";
  return new Error(value?.code === undefined ? message : `${message} (${value.code})`);
}

async function bodyResult(response: Response, requestId?: number, onNotification?: (method: string, params: unknown) => void): Promise<unknown> {
  if (response.status === 202) return undefined;
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    if (!response.body) return undefined;
    for await (const frame of sseFrames(response.body)) {
      if (!frame.data.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (typeof message?.method === "string") onNotification?.(message.method, message.params);
      if (requestId !== undefined && (message?.id === requestId || String(message?.id) === String(requestId))) {
        if (message?.error) throw errorFromRpc(message.error);
        return message?.result;
      }
    }
    throw new Error("MCP stream ended without a matching response.");
  }

  const text = await response.text();
  if (!text.trim()) return undefined;
  let message: any;
  try {
    message = JSON.parse(text);
  } catch (error) {
    throw new Error(`MCP endpoint returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (message?.error) throw errorFromRpc(message.error);
  return Object.prototype.hasOwnProperty.call(message, "result") ? message.result : message;
}

export interface HttpConfig {
  url: string;
  headers: Record<string, string>;
  onNotification?: (method: string, params: unknown) => void;
}

export class StreamableHttpTransport implements JsonRpcChannel {
  private nextId = 1;
  private sessionId: string | undefined;

  constructor(private readonly config: HttpConfig) {}

  async request(method: string, params?: unknown, options: JsonRpcRequestOptions = {}): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const response = await this.post({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }, options);
    return bodyResult(response, id, this.config.onNotification);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const response = await this.post({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    }, {});
    if (response.status >= 400) await bodyResult(response);
  }

  close(): void {}

  private post(body: unknown, options: JsonRpcRequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.config.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    return fetch(this.config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: signalFor(options),
    }).then((response) => {
      const sessionId = response.headers.get("Mcp-Session-Id");
      if (sessionId) this.sessionId = sessionId;
      return response;
    });
  }
}
