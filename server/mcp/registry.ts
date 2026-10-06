// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createMcpClient, type McpClient } from "./client.ts";
import { listMcpServers, type McpServerRecord } from "./store.ts";
import type { ToolContext, ToolSpec } from "../agent/registry.ts";

const LIST_BUDGET_MS = 1_500;
const CRASH_BACKOFF_MS = 30_000;
const IDLE_REAP_MS = 10 * 60_000;
const MAX_TOOLS = 100;

export interface McpStatus {
  server: string;
  state: string;
  tools: number;
  message: string;
}

const clients = new Map<string, McpClient>();
const crashedAt = new Map<string, number>();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clientError(client: McpClient, fallback: unknown): string {
  return [client.lastError || errorText(fallback), ...client.stderrTail.slice(-5)].filter(Boolean).join("\n");
}

function safePart(value: string, fallback: string): string {
  const result = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return result || fallback;
}

function serverPrefix(name: string, used: Set<string>): string {
  const base = safePart(name, "server");
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function toolName(prefix: string, remoteName: string, used: Set<string>): string {
  const base = `mcp__${prefix}__${safePart(remoteName, "tool")}`;
  let suffix = "";
  let candidate = base.slice(0, 64);
  let number = 2;
  while (used.has(candidate)) {
    suffix = `_${number}`;
    number += 1;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function clientFor(server: McpServerRecord): McpClient {
  const current = clients.get(server.id);
  const failed = crashedAt.get(server.id);
  if (current && current.state === "crashed") {
    if (!failed) {
      crashedAt.set(server.id, Date.now());
      return current;
    }
    if (Date.now() - failed < CRASH_BACKOFF_MS) return current;
    void current.close();
    clients.delete(server.id);
    crashedAt.delete(server.id);
  }
  if (current) return current;

  const client = createMcpClient(server);
  clients.set(server.id, client);
  return client;
}

async function listWithBudget(client: McpClient, signal: AbortSignal): Promise<Awaited<ReturnType<McpClient["listTools"]>>> {
  if (signal.aborted) throw new Error("The request was cancelled.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP tools/list timed out after ${LIST_BUDGET_MS}ms.`)), LIST_BUDGET_MS);
  });
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(new Error("The request was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([client.listTools(), timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mcpSpec(
  client: McpClient,
  remoteName: string,
  exposedName: string,
  description: string,
  inputSchema: Record<string, unknown>,
): ToolSpec {
  return {
    def: { name: exposedName, description, parameters: inputSchema },
    available: () => true,
    async run(input: unknown, ctx: ToolContext): Promise<unknown> {
      const result = await client.callTool(remoteName, input, ctx.signal);
      return result.isError ? { error: result.content } : { content: result.content };
    },
  };
}

export async function mcpToolsFor(
  signal: AbortSignal,
  reservedNames: ReadonlySet<string>,
  onStatus?: (status: McpStatus) => void,
): Promise<ToolSpec[]> {
  const servers = listMcpServers().filter((server) => server.enabled);
  if (!servers.length) return [];

  const results = await Promise.all(servers.map(async (server) => {
    const client = clientFor(server);
    const crashed = crashedAt.get(server.id);
    if (client.state === "crashed" && crashed && Date.now() - crashed < CRASH_BACKOFF_MS) {
      onStatus?.({
        server: server.name,
        state: client.state,
        tools: 0,
        message: `${client.lastError || "MCP server crashed."} Retry after ${CRASH_BACKOFF_MS / 1000}s.`,
      });
      return null;
    }
    try {
      const tools = await listWithBudget(client, signal);
      return { server, client, tools };
    } catch (error) {
      if (client.state === "crashed") crashedAt.set(server.id, Date.now());
      onStatus?.({
        server: server.name,
        state: client.state,
        tools: 0,
        message: clientError(client, error),
      });
      return null;
    }
  }));

  const output: ToolSpec[] = [];
  const usedNames = new Set(reservedNames);
  const usedPrefixes = new Set<string>();
  for (const result of results) {
    if (!result) continue;
    const prefix = serverPrefix(result.server.name, usedPrefixes);
    for (const tool of result.tools) {
      if (output.length >= Math.max(0, MAX_TOOLS - reservedNames.size)) {
        onStatus?.({
          server: result.server.name,
          state: result.client.state,
          tools: output.length,
          message: "Tool limit of 100 reached; some MCP tools were dropped from this turn.",
        });
        break;
      }
      const exposedName = toolName(prefix, tool.name, usedNames);
      // Prefix mcp__ membuat tabrakan dengan built-in tidak mungkin, tetapi
      // assertion ini menjaga kontrak bila daftar tool bawaan bertambah nanti.
      if (reservedNames.has(exposedName)) throw new Error(`MCP tool namespace collision: ${exposedName}`);
      output.push(mcpSpec(result.client, tool.name, exposedName, tool.description, tool.inputSchema));
    }
  }
  return output;
}

export function forgetMcpServer(id: string): void {
  const client = clients.get(id);
  clients.delete(id);
  crashedAt.delete(id);
  if (client) void client.close();
}

const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (client.state === "ready" && now - client.lastUsedAt >= IDLE_REAP_MS) {
      clients.delete(id);
      crashedAt.delete(id);
      void client.close();
    }
  }
}, 60_000);
reaper.unref?.();
