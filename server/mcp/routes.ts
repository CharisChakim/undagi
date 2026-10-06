// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import express, { type Response } from "express";
import { createMcpClient } from "./client.ts";
import {
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  upsertMcpServer,
  type McpServerInput,
  type McpServerRecord,
} from "./store.ts";
import { forgetMcpServer } from "./registry.ts";

const router = express.Router();

class RequestError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendError(res: Response, error: unknown): void {
  const requestError = error instanceof RequestError ? error : undefined;
  res.status(requestError?.statusCode ?? 500).json({ error: errorText(error) });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RequestError(`${field} is required.`);
  return value.trim();
}

function objectOfStrings(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new RequestError(`${field} must be an object.`);
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) throw new RequestError(`${field} values must be strings.`);
  return Object.fromEntries(entries) as Record<string, string>;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RequestError(`${field} must be an array of strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function serverPayload(value: unknown, partial: boolean): McpServerInput {
  if (!isRecord(value)) throw new RequestError("MCP server body must be an object.");
  const name = value.name === undefined && partial ? undefined : requiredString(value.name, "name");
  const transport = value.transport === undefined && partial
    ? undefined
    : value.transport as "stdio" | "http" | undefined;
  if (transport !== undefined && transport !== "stdio" && transport !== "http") {
    throw new RequestError("transport must be stdio or http.");
  }
  const output: McpServerInput = {
    ...(value.id === undefined ? {} : { id: requiredString(value.id, "id") }),
    ...(name === undefined ? {} : { name }),
    ...(transport === undefined ? {} : { transport }),
    ...(value.command === undefined ? {} : { command: requiredString(value.command, "command") }),
    ...(value.args === undefined ? {} : { args: stringArray(value.args, "args") }),
    ...(value.env === undefined ? {} : { env: objectOfStrings(value.env, "env") }),
    ...(value.url === undefined ? {} : { url: requiredString(value.url, "url") }),
    ...(value.headers === undefined ? {} : { headers: objectOfStrings(value.headers, "headers") }),
    ...(value.enabled === undefined ? {} : { enabled: value.enabled as boolean }),
  };
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new RequestError("enabled must be a boolean.");
  }
  return output;
}

function publicServer(server: McpServerRecord): Record<string, unknown> {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
    enabled: server.enabled,
  };
}

async function testServer(server: McpServerRecord): Promise<{ ok: boolean; tools: unknown[]; error?: string }> {
  const client = createMcpClient(server);
  try {
    const tools = await client.listTools();
    return { ok: true, tools };
  } catch (error) {
    const tail = client.stderrTail.slice(-5);
    const detail = [errorText(error), ...tail].filter(Boolean).join("\n");
    return { ok: false, tools: [], error: detail };
  } finally {
    await client.close();
  }
}

router.get("/api/mcp/servers", (_req, res) => {
  try {
    res.json({ servers: listMcpServers().map(publicServer) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/api/mcp/servers", (req, res) => {
  try {
    const server = upsertMcpServer(serverPayload(req.body, false));
    res.json(publicServer(server));
  } catch (error) {
    sendError(res, error);
  }
});

router.put("/api/mcp/servers/:id", (req, res) => {
  try {
    const id = requiredString(req.params.id, "id");
    if (!getMcpServer(id)) {
      sendError(res, new RequestError(`MCP server not found: ${id}.`, 404));
      return;
    }
    const server = upsertMcpServer({ id, ...serverPayload(req.body, true) });
    forgetMcpServer(id);
    res.json(publicServer(server));
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/api/mcp/servers/:id", (req, res) => {
  try {
    const id = requiredString(req.params.id, "id");
    if (!getMcpServer(id)) {
      sendError(res, new RequestError(`MCP server not found: ${id}.`, 404));
      return;
    }
    forgetMcpServer(id);
    deleteMcpServer(id);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/api/mcp/test", async (req, res) => {
  try {
    const raw = isRecord(req.body) && isRecord(req.body.server) ? req.body.server : req.body;
    const input = serverPayload(raw, false);
    const server = {
      id: typeof input.id === "string" ? input.id : "test",
      name: input.name as string,
      transport: input.transport as "stdio" | "http",
      command: input.command || "",
      args: input.args || [],
      env: input.env || {},
      url: input.url || "",
      headers: input.headers || {},
      enabled: input.enabled !== false,
    } satisfies McpServerRecord;
    res.json(await testServer(server));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/api/mcp/servers/:id/test", async (req, res) => {
  try {
    const id = requiredString(req.params.id, "id");
    const server = getMcpServer(id);
    if (!server) {
      sendError(res, new RequestError(`MCP server not found: ${id}.`, 404));
      return;
    }
    res.json(await testServer(server));
  } catch (error) {
    sendError(res, error);
  }
});

export { router };
export default router;
