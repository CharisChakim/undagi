// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { db } from "../../db.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { ContentBlock, Message } from "../llm/types.ts";

const CONVERSATION_SCHEMA_VERSION = 2;
const CONVERSATION_MIGRATION_NAME = "conversations";

// Tabel dibuat saat modul dimuat supaya endpoint agent tidak bergantung pada
// urutan bootstrap atau migrasi terpisah; tabel sessions sengaja tidak disentuh.
// session_id dipertahankan nullable untuk kompatibilitas data lama, sedangkan
// project_id menjadi hubungan opsional yang dapat dipasang setelah chat dibuat.
const CREATE_CONVERSATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    session_id TEXT,
    project_id TEXT,
    title      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_session
    ON conversations (session_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conversations_project
    ON conversations (project_id, updated_at DESC);
`;

const CREATE_MESSAGES_SQL = `
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id    TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    meta       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conv_id, id);
`;

interface TableColumn {
  name: string;
  notnull: number;
}

function tableExists(name: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(name));
}

function tableColumns(name: string): TableColumn[] {
  return db.prepare(`PRAGMA table_info(${name})`).all() as unknown as TableColumn[];
}

function backupBeforeMigration(): void {
  const location = db.location();
  if (!location || location === ":memory:" || !fs.existsSync(location)) return;

  const backupPath = `${location}.pre-conversations-v${CONVERSATION_SCHEMA_VERSION}-${Date.now()}.bak`;
  try {
    fs.copyFileSync(location, backupPath);
  } catch (error) {
    throw new Error(`Gagal membuat backup database sebelum migrasi percakapan: ${String(error)}`);
  }
}

function recordMigration(): void {
  db.prepare(`
    INSERT INTO conversation_schema_migrations (name, version, applied_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      version = CASE WHEN version > excluded.version THEN version ELSE excluded.version END,
      applied_at = excluded.applied_at
  `).run(CONVERSATION_MIGRATION_NAME, CONVERSATION_SCHEMA_VERSION, new Date().toISOString());
}

function migrateConversationSchema(): void {
  if (!tableExists("conversations")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(CREATE_CONVERSATIONS_SQL);
      recordMigration();
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Error asli lebih berguna daripada error rollback sekunder.
      }
      throw error;
    }
    return;
  }

  const columns = tableColumns("conversations");
  const sessionColumn = columns.find((column) => column.name === "session_id");
  const projectColumn = columns.find((column) => column.name === "project_id");
  const hasProjectColumn = Boolean(projectColumn);
  const migrationRow = db.prepare(
    "SELECT version FROM conversation_schema_migrations WHERE name = ?"
  ).get(CONVERSATION_MIGRATION_NAME) as { version?: number } | undefined;
  const migrationVersion = Number(migrationRow?.version ?? 0);
  const isCurrentSchema = hasProjectColumn
    && sessionColumn?.notnull === 0
    && projectColumn?.notnull === 0;

  if (isCurrentSchema) {
    // Index dibuat ulang secara idempoten agar database yang dibuat oleh
    // eksperimen v2 awal tetap mendapat index project.
    db.exec(CREATE_CONVERSATIONS_SQL);
    if (migrationVersion < CONVERSATION_SCHEMA_VERSION) recordMigration();
    return;
  }

  backupBeforeMigration();
  db.exec("BEGIN IMMEDIATE");
  try {
    // Nama index lama harus dilepas sebelum tabel diganti; SQLite ikut
    // mempertahankan nama index saat ALTER TABLE ... RENAME TO.
    db.exec("DROP INDEX IF EXISTS idx_conversations_session");
    db.exec("DROP INDEX IF EXISTS idx_conversations_project");
    db.exec("ALTER TABLE conversations RENAME TO conversations_v1");
    db.exec(CREATE_CONVERSATIONS_SQL);

    // Data lama tidak kehilangan ID. Untuk baris v1, session adalah project
    // yang sama karena ProjectSession masih disimpan di tabel sessions.
    const projectExpression = hasProjectColumn ? "project_id" : "session_id";
    db.exec(`
      INSERT INTO conversations (id, session_id, project_id, title, created_at, updated_at)
      SELECT id, session_id, ${projectExpression}, title, created_at, updated_at
      FROM conversations_v1
    `);
    db.exec("DROP TABLE conversations_v1");
    db.exec(CREATE_MESSAGES_SQL);
    recordMigration();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Error asli lebih berguna daripada error rollback sekunder.
    }
    throw error;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_schema_migrations (
    name       TEXT PRIMARY KEY,
    version    INTEGER NOT NULL,
    applied_at TEXT NOT NULL
  )
`);
migrateConversationSchema();
db.exec(CREATE_MESSAGES_SQL);
// Notes the chat shows between messages ("context carried", "files moved").
// They are kept apart from messages so they never reach a model's history.
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_notes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id         TEXT NOT NULL,
    last_message_id INTEGER NOT NULL,
    payload         TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_notes_conv ON conversation_notes (conv_id, id);
`);

interface ConversationRow {
  id: string;
  session_id: string | null;
  project_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  sessionId: string | null;
  projectId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationOptions {
  conversationId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  title?: string;
}

export interface ConversationListFilter {
  sessionId?: string | null;
  projectId?: string | null;
}

interface MessageRow {
  id: number;
  role: string;
  content: string;
}

const getConversationStmt = db.prepare(
  `SELECT id, session_id, project_id, title, created_at, updated_at
   FROM conversations WHERE id = ?`
);
const insertConversationStmt = db.prepare(
  `INSERT INTO conversations (id, session_id, project_id, title, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const updateConversationProjectStmt = db.prepare(
  `UPDATE conversations SET project_id = ?, updated_at = ? WHERE id = ?`
);
const listMessagesStmt = db.prepare(
  `SELECT id, role, content FROM messages WHERE conv_id = ? ORDER BY id ASC`
);
const lastMessageIdStmt = db.prepare(
  `SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conv_id = ?`
);
const insertNoteStmt = db.prepare(
  `INSERT INTO conversation_notes (conv_id, last_message_id, payload, created_at) VALUES (?, ?, ?, ?)`
);
const listNotesStmt = db.prepare(
  `SELECT last_message_id, payload FROM conversation_notes WHERE conv_id = ? ORDER BY id ASC`
);
const listMessagesWithMetaStmt = db.prepare(
  `SELECT role, content, meta FROM messages WHERE conv_id = ? ORDER BY id ASC`
);
const insertMessageStmt = db.prepare(
  `INSERT INTO messages (conv_id, role, content, meta, created_at)
   VALUES (?, ?, ?, ?, ?)`
);
const touchConversationStmt = db.prepare(
  `UPDATE conversations SET updated_at = ? WHERE id = ?`
);
const firstUserMessagesStmt = db.prepare(
  `SELECT content, meta FROM messages WHERE conv_id = ? AND role = 'user' ORDER BY id ASC LIMIT 20`
);
const deleteMessagesStmt = db.prepare(`DELETE FROM messages WHERE conv_id = ?`);
const deleteNotesStmt = db.prepare(`DELETE FROM conversation_notes WHERE conv_id = ?`);
const deleteConversationStmt = db.prepare(`DELETE FROM conversations WHERE id = ?`);

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredId(value, field);
}

function conversationIdFor(sessionId: string | null, conversationId?: string | null): string {
  if (conversationId === undefined || conversationId === null || conversationId.trim() === "") {
    if (!sessionId) return `conv_${randomUUID()}`;
    return `conv_${sessionId}_default`;
  }
  return requiredId(conversationId, "conversationId");
}

function requireConversation(convId: string): ConversationRow {
  const id = requiredId(convId, "conversationId");
  const row = getConversationStmt.get(id) as unknown as ConversationRow | undefined;
  if (!row) throw new Error(`Conversation ${id} not found`);
  return row;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    projectId: row.project_id ?? null,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertLinkMatches(row: ConversationRow, options: ConversationOptions): void {
  const sessionId = optionalId(options.sessionId, "sessionId");
  const projectId = optionalId(options.projectId, "projectId");
  const requestedIds = [sessionId, projectId].filter((value): value is string => Boolean(value));
  const storedIds = [row.session_id, row.project_id].filter((value): value is string => Boolean(value));

  if (requestedIds.length === 0 && storedIds.length > 0) {
    throw new Error(`Conversation ${row.id} does not belong to a standalone conversation`);
  }
  if (requestedIds.length > 0 && storedIds.length === 0) {
    throw new Error(`Conversation ${row.id} does not belong to the requested project`);
  }
  if (sessionId && projectId && sessionId !== projectId) {
    throw new Error(`Conversation ${row.id} does not belong to the requested project`);
  }

  if (sessionId && row.session_id && row.session_id !== sessionId) {
    throw new Error(`Conversation ${row.id} does not belong to session ${sessionId}`);
  }
  if (projectId && row.project_id && row.project_id !== projectId) {
    throw new Error(`Conversation ${row.id} does not belong to project ${projectId}`);
  }
  if (sessionId && row.project_id && row.project_id !== sessionId) {
    throw new Error(`Conversation ${row.id} does not belong to session ${sessionId}`);
  }
  if (projectId && row.session_id && row.session_id !== projectId) {
    throw new Error(`Conversation ${row.id} does not belong to project ${projectId}`);
  }
  if (storedIds.some((id) => !requestedIds.includes(id))) {
    throw new Error(`Conversation ${row.id} does not belong to the requested project`);
  }
}

function isRole(value: unknown): value is Message["role"] {
  return value === "user" || value === "assistant";
}

function isToolCall(block: ContentBlock): block is Extract<ContentBlock, { type: "tool_call" }> {
  return block.type === "tool_call";
}

function isToolResult(block: ContentBlock): block is Extract<ContentBlock, { type: "tool_result" }> {
  return block.type === "tool_result";
}

function cloneMessage(message: Message): Message {
  return { role: message.role, content: [...message.content] };
}

function toolResultContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function legacyBlock(block: any): ContentBlock | null {
  if (!block || typeof block !== "object") return null;

  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }

  if (
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    block.id &&
    typeof block.name === "string" &&
    block.name
  ) {
    return { type: "tool_call", id: block.id, name: block.name, input: block.input ?? {} };
  }

  if (block.type === "tool_result" && typeof block.tool_use_id === "string" && block.tool_use_id) {
    return {
      type: "tool_result",
      toolCallId: block.tool_use_id,
      content: toolResultContent(block.content),
      ...(block.is_error !== undefined ? { isError: Boolean(block.is_error) } : {}),
    };
  }

  return null;
}

function legacyMessage(entry: any): Message | null {
  if (!entry || !isRole(entry.role)) return null;

  const content: ContentBlock[] = [];
  if (typeof entry.content === "string") {
    content.push({ type: "text", text: entry.content });
  } else if (Array.isArray(entry.content)) {
    for (const block of entry.content) {
      const converted = legacyBlock(block);
      if (converted) content.push(converted);
    }
  } else {
    return null;
  }

  return { role: entry.role, content };
}

export function createConversation(options: ConversationOptions = {}): Conversation {
  const sessionId = optionalId(options.sessionId, "sessionId");
  const projectId = optionalId(options.projectId, "projectId");
  const id = conversationIdFor(sessionId, options.conversationId);
  const existing = getConversationStmt.get(id) as unknown as ConversationRow | undefined;
  if (existing) throw new Error(`Conversation ${id} already exists`);

  const title = options.title === undefined
    ? ""
    : typeof options.title === "string"
      ? options.title.trim()
      : requiredId(options.title, "title");
  const now = new Date().toISOString();
  insertConversationStmt.run(id, sessionId, projectId, title, now, now);
  return toConversation(requireConversation(id));
}

export function ensureConversationFor(options: ConversationOptions = {}): string {
  const sessionId = optionalId(options.sessionId, "sessionId");
  const projectId = optionalId(options.projectId, "projectId");
  const id = conversationIdFor(sessionId, options.conversationId);
  const existing = getConversationStmt.get(id) as unknown as ConversationRow | undefined;

  if (existing) {
    // ID percakapan boleh dikirim ulang oleh tab, tetapi tidak boleh dipakai
    // untuk membaca project/sesi lain; ini mencegah transcript tercampur.
    assertLinkMatches(existing, { sessionId, projectId });
    return id;
  }

  const title = options.title === undefined
    ? ""
    : typeof options.title === "string"
      ? options.title.trim()
      : requiredId(options.title, "title");
  const now = new Date().toISOString();
  insertConversationStmt.run(id, sessionId, projectId, title, now, now);
  return id;
}

// Signature lama dipertahankan untuk route agent v1. Pemanggil baru dapat
// mengirim null tanpa membuat session palsu atau mengubah ID percakapan lama.
export function ensureConversation(
  sessionId: string | null | undefined,
  conversationId?: string | null,
  projectId?: string | null,
): string {
  if (sessionId !== null && sessionId !== undefined) requiredId(sessionId, "sessionId");
  return ensureConversationFor({ sessionId, conversationId, projectId });
}

export function getConversation(convId: string): Conversation | null {
  const id = requiredId(convId, "conversationId");
  const row = getConversationStmt.get(id) as unknown as ConversationRow | undefined;
  return row ? toConversation(row) : null;
}

export function listConversations(filter: ConversationListFilter = {}): Conversation[] {
  const where: string[] = [];
  const values: (string | null)[] = [];

  for (const [column, value] of [["session_id", filter.sessionId], ["project_id", filter.projectId]] as const) {
    if (value === undefined) continue;
    if (value === null) {
      where.push(`${column} IS NULL`);
    } else {
      where.push(`${column} = ?`);
      values.push(requiredId(value, column === "session_id" ? "sessionId" : "projectId"));
    }
  }

  const query = `
    SELECT id, session_id, project_id, title, created_at, updated_at
    FROM conversations
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC
  `;
  const rows = db.prepare(query).all(...values) as unknown as ConversationRow[];
  return rows.map(toConversation);
}

const TITLE_LIMIT = 80;

/**
 * What the sidebar calls a chat: its own title, else the first thing the user
 * wrote in it. A card run's prompt names it only when the user wrote nothing.
 */
export function conversationTitle(conversation: Pick<Conversation, "id" | "title">): string {
  if (conversation.title.trim()) return conversation.title.trim();
  const rows = firstUserMessagesStmt.all(conversation.id) as unknown as Array<{ content: string; meta: string }>;
  let fallback = "";
  for (const row of rows) {
    let text = "";
    let fromTask = false;
    try {
      const content = JSON.parse(row.content);
      text = Array.isArray(content)
        ? content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join(" ")
        : "";
      // Transcripts saved before runtime card runs carried their card are told
      // apart by the prompt the board sends (src/components/shell/Workbench.tsx).
      fromTask = Boolean(JSON.parse(row.meta || "{}")?.taskId) || /^Execute task \S+:/.test(text.trim());
    } catch {
      continue;
    }
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const title = line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT).trimEnd()}…` : line;
    if (!fromTask) return title;
    fallback ||= title;
  }
  return fallback;
}

/** Removes one chat: its messages, its notes and the conversation itself. The project stays. */
export function deleteConversation(convId: string): void {
  const id = requiredId(convId, "conversationId");
  db.exec("BEGIN IMMEDIATE");
  try {
    deleteMessagesStmt.run(id);
    deleteNotesStmt.run(id);
    deleteConversationStmt.run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function linkConversationToProject(convId: string, projectId: string): Conversation {
  const conversation = requireConversation(convId);
  const project = requiredId(projectId, "projectId");

  if (conversation.project_id && conversation.project_id !== project) {
    throw new Error(`Conversation ${conversation.id} already belongs to project ${conversation.project_id}`);
  }
  if (conversation.project_id === project) return toConversation(conversation);

  const now = new Date().toISOString();
  updateConversationProjectStmt.run(project, now, conversation.id);
  // Hanya metadata hubungan yang berubah. Messages tetap memakai conv_id yang
  // sama, sehingga linking tidak menggandakan atau mengurutkan ulang transcript.
  return toConversation(requireConversation(conversation.id));
}

function loadMessageRows(convId: string): Array<{ id: number; message: Message }> {
  const id = requiredId(convId, "conversationId");
  const rows = listMessagesStmt.all(id) as unknown as MessageRow[];

  return rows.flatMap((row) => {
    if (!isRole(row.role)) return [];

    try {
      const content = JSON.parse(row.content);
      return Array.isArray(content) ? [{ id: row.id, message: { role: row.role, content } as Message }] : [];
    } catch {
      // Satu baris rusak tidak boleh membuat percakapan lain atau pesan valid
      // sesudahnya ikut tidak dapat dipakai oleh provider.
      return [];
    }
  });
}

export function loadMessages(convId: string): Message[] {
  return loadMessageRows(convId).map((row) => row.message);
}

/**
 * A note is sent as a turn starts, just before its user message is stored.
 * It is kept with the last message stored so far and shown after the next
 * one, which is where the chat showed it live.
 */
export function recordConversationNote(convId: string, note: Record<string, unknown>): void {
  const conversation = requireConversation(convId);
  const last = lastMessageIdStmt.get(conversation.id) as { id: number };
  insertNoteStmt.run(conversation.id, last.id, JSON.stringify(note), new Date().toISOString());
}

/** Each note with the index, in loadMessages, of the message it follows (-1: before all). */
export function loadConversationNotes(convId: string): Array<{ afterMessage: number; note: Record<string, unknown> }> {
  const rows = loadMessageRows(convId);
  const notes = listNotesStmt.all(requiredId(convId, "conversationId")) as unknown as Array<{ last_message_id: number; payload: string }>;
  return notes.flatMap((row) => {
    try {
      const note = JSON.parse(row.payload);
      if (!note || typeof note !== "object" || Array.isArray(note)) return [];
      const next = rows.findIndex((message) => message.id > row.last_message_id);
      // No message came after the note (the turn failed before it was stored).
      return [{ afterMessage: next === -1 ? rows.length - 1 : next, note }];
    } catch {
      return [];
    }
  });
}

/** Like loadMessages, with the meta each message was written with. */
export function loadMessagesWithMeta(convId: string): Array<Message & { meta: Record<string, unknown> }> {
  const id = requiredId(convId, "conversationId");
  const rows = listMessagesWithMetaStmt.all(id) as unknown as Array<MessageRow & { meta: string }>;
  return rows.flatMap((row) => {
    if (!isRole(row.role)) return [];
    try {
      const content = JSON.parse(row.content);
      const meta = JSON.parse(row.meta || "{}");
      return Array.isArray(content)
        ? [{ role: row.role, content, meta: meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {} } as Message & { meta: Record<string, unknown> }]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * What a model turn is given. A task card's run gets only its own earlier
 * messages, tagged with its taskId, so neither the chat nor another card's
 * mistakes reach it. The chat gets the whole conversation, card runs included.
 */
export function loadMessagesFor(convId: string, taskId?: string): Message[] {
  if (!taskId) return loadMessages(convId);
  return loadMessagesWithMeta(convId)
    .filter((message) => message.meta.taskId === taskId)
    .map(({ role, content }) => ({ role, content }));
}

export function appendMessage(convId: string, message: Message, meta: object = {}): void {
  const conversation = requireConversation(convId);
  if (!isRole(message?.role)) throw new Error("message role must be user or assistant");
  if (!Array.isArray(message.content)) throw new Error("message content must be an array");

  const serializedMeta = JSON.stringify(meta ?? {});
  const serializedContent = JSON.stringify(message.content);
  const now = new Date().toISOString();
  insertMessageStmt.run(
    conversation.id,
    message.role,
    serializedContent,
    serializedMeta === undefined ? "{}" : serializedMeta,
    now
  );
  touchConversationStmt.run(now, conversation.id);
}

export function importLegacyHistory(convId: string, anthropicHistory: any[]): void {
  requireConversation(convId);
  if (!Array.isArray(anthropicHistory)) return;

  for (const entry of anthropicHistory) {
    const message = legacyMessage(entry);
    if (message) appendMessage(convId, message);
  }
}

function missingToolCalls(assistant: Message, next: Message | undefined) {
  const calls = assistant.content.filter(isToolCall);
  if (!calls.length) return [];

  const available = new Map<string, number>();
  if (next?.role === "user") {
    for (const result of next.content.filter(isToolResult)) {
      available.set(result.toolCallId, (available.get(result.toolCallId) ?? 0) + 1);
    }
  }

  const missing: Extract<ContentBlock, { type: "tool_result" }>[] = [];
  for (const call of calls) {
    const count = available.get(call.id) ?? 0;
    if (count > 0) {
      available.set(call.id, count - 1);
    } else {
      missing.push({
        type: "tool_result",
        toolCallId: call.id,
        content: '{"error":"The turn was interrupted."}',
        isError: true,
      });
    }
  }
  return missing;
}

export function sanitize(messages: Message[]): Message[] {
  const forNextUser = new Map<number, Extract<ContentBlock, { type: "tool_result" }>[] >();
  const afterMessage = new Map<number, Extract<ContentBlock, { type: "tool_result" }>[] >();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;

    const next = messages[index + 1];
    const missing = missingToolCalls(message, next);
    if (!missing.length) continue;

    if (next?.role === "user") {
      forNextUser.set(index + 1, missing);
    } else {
      afterMessage.set(index, missing);
    }
  }

  const sanitized: Message[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = cloneMessage(messages[index]);
    const missing = forNextUser.get(index);

    if (missing && message.role === "user") {
      const results = message.content.filter(isToolResult);
      const otherBlocks = message.content.filter((block) => !isToolResult(block));
      // Hasil diletakkan di depan agar pesan tetap memenuhi kontrak provider;
      // blok teks user tetap dipertahankan untuk prompt berikutnya.
      sanitized.push({ ...message, content: [...results, ...missing, ...otherBlocks] });
    } else {
      sanitized.push(message);
    }

    const inserted = afterMessage.get(index);
    if (inserted) {
      // Tanpa pesan user sesudahnya, blok hasil perlu punya pesan pembungkus
      // sendiri agar assistant tool call selalu dijawab secara struktural.
      sanitized.push({ role: "user", content: inserted });
    }
  }

  return sanitized;
}
