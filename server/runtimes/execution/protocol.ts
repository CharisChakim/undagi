// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { StringDecoder } from "node:string_decoder";

export type RpcId = string | number;

export interface JsonRpcRequest {
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: RpcId;
  result?: unknown;
  error?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface MalformedJsonLine {
  code: "MALFORMED_JSON" | "INVALID_MESSAGE" | "LINE_TOO_LARGE" | "INCOMPLETE_LINE";
  byteLength: number;
}

export type JsonlParseResult =
  | { type: "message"; message: JsonRpcMessage }
  | { type: "malformed"; error: MalformedJsonLine };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value));
}

/**
 * Parse the app-server's newline-delimited JSON. App-server currently omits
 * the JSON-RPC 2.0 header on the wire, so both headered and headerless lines
 * are accepted.
 */
export function parseJsonRpcLine(line: string): JsonlParseResult {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!text.trim()) {
    return { type: "malformed", error: { code: "INVALID_MESSAGE", byteLength: 0 } };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      type: "malformed",
      error: { code: "MALFORMED_JSON", byteLength: Buffer.byteLength(text, "utf8") },
    };
  }

  if (!isRecord(value)) {
    return {
      type: "malformed",
      error: { code: "INVALID_MESSAGE", byteLength: Buffer.byteLength(text, "utf8") },
    };
  }

  const method = value.method;
  const hasId = Object.prototype.hasOwnProperty.call(value, "id");
  if (typeof method === "string" && method.length > 0) {
    if (hasId) {
      return isRpcId(value.id)
        ? { type: "message", message: { id: value.id, method, ...(value.params !== undefined ? { params: value.params } : {}) } }
        : { type: "malformed", error: { code: "INVALID_MESSAGE", byteLength: Buffer.byteLength(text, "utf8") } };
    }
    return { type: "message", message: { method, ...(value.params !== undefined ? { params: value.params } : {}) } };
  }

  if (hasId && isRpcId(value.id) && (Object.prototype.hasOwnProperty.call(value, "result") || Object.prototype.hasOwnProperty.call(value, "error"))) {
    return {
      type: "message",
      message: {
        id: value.id,
        ...(Object.prototype.hasOwnProperty.call(value, "result") ? { result: value.result } : {}),
        ...(Object.prototype.hasOwnProperty.call(value, "error") ? { error: value.error } : {}),
      },
    };
  }

  return {
    type: "malformed",
    error: { code: "INVALID_MESSAGE", byteLength: Buffer.byteLength(text, "utf8") },
  };
}

/** Incremental UTF-8 aware parser used by the stdio transport and fixtures. */
export class JsonlParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private oversizedBytes = 0;
  private readonly maxLineBytes: number;

  constructor(maxLineBytes = 512 * 1024) {
    this.maxLineBytes = Math.max(1, Math.floor(maxLineBytes));
  }

  push(chunk: Buffer | Uint8Array | string): JsonlParseResult[] {
    this.buffer += typeof chunk === "string"
      ? chunk
      : this.decoder.write(Buffer.from(chunk));
    return this.readLines();
  }

  end(): JsonlParseResult[] {
    this.buffer += this.decoder.end();
    const results = this.readLines();
    if (this.oversizedBytes > 0) {
      results.push({ type: "malformed", error: { code: "LINE_TOO_LARGE", byteLength: this.oversizedBytes } });
      this.oversizedBytes = 0;
    } else if (this.buffer.trim()) {
      const line = this.buffer;
      this.buffer = "";
      results.push({ type: "malformed", error: { code: "INCOMPLETE_LINE", byteLength: Buffer.byteLength(line, "utf8") } });
    }
    return results;
  }

  private readLines(): JsonlParseResult[] {
    const results: JsonlParseResult[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        const bytes = Buffer.byteLength(this.buffer, "utf8");
        if (bytes > this.maxLineBytes) {
          this.oversizedBytes = bytes;
          this.buffer = "";
        }
        break;
      }

      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (this.oversizedBytes > 0) {
        this.oversizedBytes += Buffer.byteLength(line, "utf8");
        results.push({ type: "malformed", error: { code: "LINE_TOO_LARGE", byteLength: this.oversizedBytes } });
        this.oversizedBytes = 0;
        continue;
      }

      const bytes = Buffer.byteLength(line, "utf8");
      if (bytes > this.maxLineBytes) {
        results.push({ type: "malformed", error: { code: "LINE_TOO_LARGE", byteLength: bytes } });
        continue;
      }
      if (line.trim()) results.push(parseJsonRpcLine(line));
    }
    return results;
  }
}

export function rpcErrorCode(value: unknown): string {
  if (!isRecord(value)) return "RPC_ERROR";
  const code = value.code;
  if (typeof code === "number" && Number.isFinite(code)) return `RPC_${code}`;
  if (typeof code === "string" && /^[A-Za-z0-9_.-]+$/.test(code)) return code.toUpperCase();
  return "RPC_ERROR";
}

export function rpcErrorMessage(value: unknown): string {
  if (!isRecord(value)) return "Codex app-server returned an RPC error.";
  return typeof value.message === "string" && value.message.trim()
    ? value.message
    : "Codex app-server returned an RPC error.";
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
