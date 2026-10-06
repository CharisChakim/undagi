// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export type JsonRpcId = string | number;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface JsonRpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface JsonRpcChannel {
  request(method: string, params?: unknown, options?: JsonRpcRequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): void | Promise<void>;
  close(reason?: Error): void | Promise<void>;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

function errorValue(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" && value ? value : fallback);
}

export function jsonRpcLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** Korelasi id dan framing ini sengaja kecil; transport stdio memakai satu JSON per baris, bukan Content-Length LSP. */
export class JsonRpcPeer implements JsonRpcChannel {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private closedError: Error | null = null;

  constructor(
    private readonly write: (line: string) => void,
    private readonly onNotification?: (method: string, params: unknown) => void,
  ) {}

  request(method: string, params?: unknown, options: JsonRpcRequestOptions = {}): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);

    const id = this.nextId;
    this.nextId += 1;
    const key = String(id);
    const timeoutMs = options.timeoutMs ?? 30_000;

    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject, signal: options.signal };
      const cleanup = (): void => {
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
        this.pending.delete(key);
      };
      pending.onAbort = () => {
        cleanup();
        reject(errorValue(options.signal?.reason, "MCP request aborted."));
      };
      if (options.signal?.aborted) {
        pending.onAbort();
        return;
      }
      options.signal?.addEventListener("abort", pending.onAbort, { once: true });
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          cleanup();
          reject(new Error(`MCP request timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }
      this.pending.set(key, pending);

      try {
        this.write(jsonRpcLine({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }));
      } catch (error) {
        cleanup();
        reject(errorValue(error, "Could not write to the MCP server."));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedError) return;
    this.write(jsonRpcLine({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    }));
  }

  receive(line: string): void {
    if (this.closedError || !line.trim()) return;

    let message: JsonRpcResponse & { method?: string; params?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch (error) {
      this.close(errorValue(error, "MCP server sent invalid JSON."));
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      if (message.error) {
        const detail = message.error.message || "MCP request failed.";
        const suffix = message.error.code === undefined ? "" : ` (${message.error.code})`;
        this.finish(String(message.id), undefined, new Error(`${detail}${suffix}`));
      } else {
        this.finish(String(message.id), message.result, undefined);
      }
      return;
    }

    if (typeof message.method === "string") this.onNotification?.(message.method, message.params);
  }

  close(reason = new Error("MCP connection closed.")): void {
    if (this.closedError) return;
    this.closedError = reason;
    for (const [key, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(reason);
      this.pending.delete(key);
    }
  }

  private finish(key: string, value: unknown, error?: Error): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    this.pending.delete(key);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }
}
