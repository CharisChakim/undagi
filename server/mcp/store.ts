// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { db } from "../../db.ts";

export interface McpServerRecord {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
}

export type McpServerInput = Partial<McpServerRecord> & { id?: string };

type McpRow = {
  id: string;
  name: string;
  transport: string;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  enabled: number;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    transport TEXT NOT NULL,
    command   TEXT NOT NULL DEFAULT '',
    args      TEXT NOT NULL DEFAULT '[]',
    env       TEXT NOT NULL DEFAULT '{}',
    url       TEXT NOT NULL DEFAULT '',
    headers   TEXT NOT NULL DEFAULT '{}',
    enabled   INTEGER NOT NULL DEFAULT 1
  );
`);

const listStmt = db.prepare(`SELECT id, name, transport, command, args, env, url, headers, enabled FROM mcp_servers ORDER BY name ASC, id ASC`);
const getStmt = db.prepare(`SELECT id, name, transport, command, args, env, url, headers, enabled FROM mcp_servers WHERE id = ?`);
const insertStmt = db.prepare(`INSERT INTO mcp_servers (id, name, transport, command, args, env, url, headers, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const updateStmt = db.prepare(`UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args = ?, env = ?, url = ?, headers = ?, enabled = ? WHERE id = ?`);
const deleteStmt = db.prepare(`DELETE FROM mcp_servers WHERE id = ?`);

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringMap(value: string): Record<string, string> {
  const parsed = parseJson<unknown>(value, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stringList(value: string): string[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function fromRow(row: McpRow): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport === "http" ? "http" : "stdio",
    command: row.command,
    args: stringList(row.args),
    env: stringMap(row.env),
    url: row.url,
    headers: stringMap(row.headers),
    enabled: Boolean(row.enabled),
  };
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function objectOfStrings(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) throw new Error(`${field} values must be strings`);
  return Object.fromEntries(entries) as Record<string, string>;
}

function listOfStrings(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be an array of strings`);
  return value.map((item) => item.trim()).filter(Boolean);
}

export function listMcpServers(): McpServerRecord[] {
  return listStmt.all().map((row) => fromRow(row as McpRow));
}

export function getMcpServer(id: string): McpServerRecord | null {
  const row = getStmt.get(id);
  return row ? fromRow(row as McpRow) : null;
}

export function upsertMcpServer(input: McpServerInput): McpServerRecord {
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : randomUUID();
  const existing = getMcpServer(id);
  const name = required(input.name ?? existing?.name, "name");
  const transport = input.transport ?? existing?.transport;
  if (transport !== "stdio" && transport !== "http") throw new Error("transport must be stdio or http");
  const command = typeof input.command === "string" ? input.command.trim() : existing?.command ?? "";
  const url = typeof input.url === "string" ? input.url.trim() : existing?.url ?? "";
  const args = listOfStrings(input.args ?? existing?.args, "args");
  const env = objectOfStrings(input.env ?? existing?.env, "env");
  const headers = objectOfStrings(input.headers ?? existing?.headers, "headers");
  const enabled = input.enabled === undefined ? existing?.enabled ?? true : Boolean(input.enabled);

  if (transport === "stdio" && !command) throw new Error("command is required for stdio MCP servers");
  if (transport === "http" && !url) throw new Error("url is required for HTTP MCP servers");

  if (existing) {
    updateStmt.run(name, transport, command, JSON.stringify(args), JSON.stringify(env), url, JSON.stringify(headers), enabled ? 1 : 0, id);
  } else {
    insertStmt.run(id, name, transport, command, JSON.stringify(args), JSON.stringify(env), url, JSON.stringify(headers), enabled ? 1 : 0);
  }
  const saved = getMcpServer(id);
  if (!saved) throw new Error("Failed to read saved MCP server");
  return saved;
}

export function deleteMcpServer(id: string): void {
  deleteStmt.run(id);
}
