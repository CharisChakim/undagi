// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { McpServerConfig } from "../types";

export interface McpServerDraft {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpToolSummary {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpTestResult {
  ok: boolean;
  tools: McpToolSummary[];
  error?: string;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorText(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.error === "string" ? body.error : fallback;
}

async function request<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, init);
  const body = await responseBody(response);
  if (!response.ok) throw new Error(errorText(body, fallback));
  return body as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function server(value: unknown): McpServerConfig {
  if (!isRecord(value)) throw new Error("Invalid MCP server response.");
  const transport = value.transport === "http" ? "http" : "stdio";
  const stringMap = (candidate: unknown): Record<string, string> | undefined => {
    if (!isRecord(candidate)) return undefined;
    return Object.fromEntries(Object.entries(candidate).filter(([, item]) => typeof item === "string")) as Record<string, string>;
  };
  return {
    id: typeof value.id === "string" ? value.id : "",
    name: typeof value.name === "string" ? value.name : "",
    transport,
    enabled: value.enabled !== false,
    ...(typeof value.command === "string" ? { command: value.command } : {}),
    ...(Array.isArray(value.args) ? { args: value.args.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(stringMap(value.env) ? { env: stringMap(value.env) } : {}),
    ...(stringMap(value.headers) ? { headers: stringMap(value.headers) } : {}),
  };
}

export async function fetchMcpServers(): Promise<McpServerConfig[]> {
  const body = await request<unknown>("/api/mcp/servers", {}, "Failed to load MCP servers.");
  if (!isRecord(body) || !Array.isArray(body.servers)) return [];
  return body.servers.map(server);
}

export async function createMcpServer(input: McpServerDraft): Promise<McpServerConfig> {
  return server(await request<unknown>("/api/mcp/servers", jsonInit("POST", input), "Failed to create MCP server."));
}

export async function updateMcpServer(id: string, input: Partial<McpServerDraft>): Promise<McpServerConfig> {
  return server(await request<unknown>(`/api/mcp/servers/${encodeURIComponent(id)}`, jsonInit("PUT", input), "Failed to update MCP server."));
}

export async function removeMcpServer(id: string): Promise<void> {
  await request<unknown>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" }, "Failed to delete MCP server.");
}

export async function testMcpServer(input: McpServerDraft): Promise<McpTestResult> {
  const body = await request<unknown>("/api/mcp/test", jsonInit("POST", input), "Failed to test MCP server.");
  if (!isRecord(body)) throw new Error("Invalid MCP test response.");
  const tools = Array.isArray(body.tools)
    ? body.tools.flatMap((value): McpToolSummary[] => {
        if (!isRecord(value) || typeof value.name !== "string") return [];
        return [{
          name: value.name,
          description: typeof value.description === "string" ? value.description : "",
          inputSchema: isRecord(value.inputSchema) ? value.inputSchema : {},
        }];
      })
    : [];
  return {
    ok: body.ok === true,
    tools,
    ...(typeof body.error === "string" ? { error: body.error } : {}),
  };
}
