import { createStdioTransport } from "./stdio.ts";
import { StreamableHttpTransport } from "./http.ts";
import type { JsonRpcChannel } from "./jsonrpc.ts";
import { resultMessage } from "../../shared/resultMessages.ts";

export type McpState = "ready" | "connecting" | "down" | "crashed";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClientConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<{ content: string; isError: boolean }>;
  close(): Promise<void>;
  readonly state: McpState;
  readonly lastError?: string;
  readonly lastUsedAt: number;
  readonly stderrTail: string[];
}

const INITIALIZE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 100;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    try {
      return JSON.stringify(value) || "";
    } catch {
      return String(value);
    }
  }
  return value.map((item: any) => {
    if (typeof item === "string") return item;
    if (typeof item?.text === "string") return item.text;
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  }).join("\n");
}

function normalizeTools(value: unknown): McpTool[] {
  const rawTools = objectValue(value).tools;
  const tools = Array.isArray(rawTools) ? rawTools : [];
  return tools.flatMap((tool: any) => {
    if (!tool || typeof tool.name !== "string" || !tool.name.trim()) return [];
    return [{
      name: tool.name.trim(),
      description: typeof tool.description === "string" ? tool.description : "MCP tool",
      inputSchema: objectValue(tool.inputSchema),
    }];
  });
}

export class DefaultMcpClient implements McpClient {
  private channel: JsonRpcChannel | undefined;
  private transportClose: (() => void | Promise<void>) | undefined;
  private connection: Promise<void> | undefined;
  private cachedTools: McpTool[] | undefined;
  private stale = true;
  private stateValue: McpState = "down";
  private lastErrorValue: string | undefined;
  private lastUsedAtValue = Date.now();
  private readonly stderrLines: string[] = [];
  private closing = false;

  constructor(private readonly config: McpClientConfig) {}

  get state(): McpState { return this.stateValue; }
  get lastError(): string | undefined { return this.lastErrorValue; }
  get lastUsedAt(): number { return this.lastUsedAtValue; }
  get stderrTail(): string[] { return [...this.stderrLines]; }

  async listTools(): Promise<McpTool[]> {
    this.touch();
    if (this.cachedTools && !this.stale && this.stateValue === "ready") return this.cachedTools;
    await this.ensureConnected();
    const tools = await this.fetchTools();
    this.cachedTools = tools;
    this.stale = false;
    this.touch();
    return tools;
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
    this.touch();
    try {
      await this.ensureConnected();
      const result = objectValue(await this.channel!.request(
        "tools/call",
        { name, arguments: args ?? {} },
        { signal, timeoutMs: REQUEST_TIMEOUT_MS },
      ));
      this.touch();
      return { content: contentText(result.content ?? result), isError: result.isError === true };
    } catch (error) {
      const detail = errorText(error);
      if (this.stateValue !== "crashed") this.fail("down", detail);
      return {
        content: resultMessage("mcpUnreachable", { name: this.config.name, detail }),
        isError: true,
      };
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const channel = this.channel;
    this.channel = undefined;
    const transportClose = this.transportClose;
    this.transportClose = undefined;
    this.cachedTools = undefined;
    this.stale = true;
    this.stateValue = "down";
    if (channel) await channel.close();
    if (transportClose) await transportClose();
  }

  private async ensureConnected(): Promise<void> {
    if (this.closing) throw new Error("MCP client is closed.");
    if (this.channel && this.stateValue === "ready") return;
    if (this.connection) return this.connection;

    this.stateValue = "connecting";
    this.connection = this.connect().finally(() => {
      this.connection = undefined;
    });
    return this.connection;
  }

  private async connect(): Promise<void> {
    const channel = this.makeChannel();
    this.channel = channel;
    try {
      await channel.request(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "undagi", version: "1.0.0" },
        },
        { timeoutMs: INITIALIZE_TIMEOUT_MS },
      );
      await channel.notify("notifications/initialized", {});
      const tools = await this.fetchTools();
      this.cachedTools = tools;
      this.stale = false;
      this.stateValue = "ready";
      this.lastErrorValue = undefined;
      this.touch();
    } catch (error) {
      const detail = errorText(error);
      this.fail(this.stateValue === "crashed" ? "crashed" : "down", detail);
      this.channel = undefined;
      await Promise.resolve(channel.close()).catch(() => undefined);
      if (this.transportClose) {
        const close = this.transportClose;
        this.transportClose = undefined;
        await close();
      }
      throw error;
    }
  }

  private async fetchTools(): Promise<McpTool[]> {
    let cursor: string | undefined;
    const tools: McpTool[] = [];
    do {
      const result = objectValue(await this.channel!.request(
        "tools/list",
        cursor ? { cursor } : {},
        { timeoutMs: REQUEST_TIMEOUT_MS },
      ));
      tools.push(...normalizeTools(result));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (tools.length > PAGE_LIMIT) return tools.slice(0, PAGE_LIMIT);
    } while (cursor);
    return tools;
  }

  private makeChannel(): JsonRpcChannel {
    if (this.config.transport === "http") {
      if (!this.config.url?.trim()) throw new Error("MCP HTTP server URL is required.");
      return new StreamableHttpTransport({
        url: this.config.url.trim(),
        headers: this.config.headers ?? {},
        onNotification: (method) => {
          if (method === "notifications/tools/list_changed") this.stale = true;
        },
      });
    }
    if (!this.config.command?.trim()) throw new Error("MCP stdio server command is required.");
      const transport = createStdioTransport({
      command: this.config.command.trim(),
      args: this.config.args ?? [],
      env: this.config.env ?? {},
      onStderr: (line) => {
        this.stderrLines.push(line);
        if (this.stderrLines.length > 50) this.stderrLines.splice(0, this.stderrLines.length - 50);
      },
      onExit: (error) => {
        if (!this.closing) this.fail("crashed", error.message);
      },
      onNotification: (method) => {
        if (method === "notifications/tools/list_changed") this.stale = true;
      },
      });
    this.transportClose = transport.close;
    return transport.peer;
  }

  private fail(state: McpState, detail: string): void {
    this.stateValue = state;
    this.lastErrorValue = detail;
    this.stale = true;
  }

  private touch(): void {
    this.lastUsedAtValue = Date.now();
  }
}

export function createMcpClient(config: McpClientConfig): McpClient {
  return new DefaultMcpClient(config);
}
