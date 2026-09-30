import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const moduleUrl = new URL("./conversations.ts", import.meta.url).href;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The migration runs when the module is loaded, against whichever database
// UNDAGI_DATA_DIR points at. A module is only evaluated once per process, so
// each fixture gets its own child process rather than a shared one.
function loadConversationsAgainst(dataDir: string): void {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", `await import(${JSON.stringify(moduleUrl)})`],
    { cwd: repoRoot, env: { ...process.env, UNDAGI_DATA_DIR: dataDir }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `loading conversations.ts failed:\n${result.stderr}`);
}

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-migration-test-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SESSIONS_SQL = `
  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    updated_at   TEXT NOT NULL,
    current_step INTEGER NOT NULL DEFAULT 1,
    payload      TEXT NOT NULL
  );
`;

// Copied from the pre-migration backup this repo still carries, so the fixture
// is the schema that shipped rather than one reconstructed from the migration.
const V1_CONVERSATIONS_SQL = `
  CREATE TABLE conversations (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_conversations_session ON conversations (session_id, updated_at DESC);
`;

const MESSAGES_SQL = `
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id    TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    meta       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_messages_conv ON messages (conv_id, id);
`;

function seed(dataDir: string, schema: string, rows: (db: DatabaseSync) => void): string {
  const file = path.join(dataDir, "undagi.db");
  const db = new DatabaseSync(file);
  db.exec(schema);
  rows(db);
  db.close();
  return file;
}

function open(file: string): DatabaseSync {
  return new DatabaseSync(file);
}

function columns(db: DatabaseSync, table: string): { name: string; notnull: number }[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string; notnull: number }[];
}

function backups(dataDir: string): string[] {
  return fs.readdirSync(dataDir).filter((name) => name.endsWith(".bak"));
}

test("a v1 database keeps every chat and message, and each chat gains its project", () => {
  const dataDir = freshDataDir();
  const file = seed(dataDir, SESSIONS_SQL + V1_CONVERSATIONS_SQL + MESSAGES_SQL, (db) => {
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)")
      .run("proj-1", "Kanban app for ops", "2026-09-01T00:00:00.000Z", 2, JSON.stringify({ id: "proj-1" }));
    db.prepare("INSERT INTO conversations (id, session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("conv-1", "proj-1", "First chat", "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
    db.prepare("INSERT INTO conversations (id, session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("conv-2", "proj-1", "Second chat", "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
    db.prepare("INSERT INTO messages (conv_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("conv-1", "user", JSON.stringify([{ type: "text", text: "hello" }]), "{}", "2026-09-01T00:00:01.000Z");
    db.prepare("INSERT INTO messages (conv_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("conv-1", "assistant", JSON.stringify([{ type: "text", text: "hi" }]), "{}", "2026-09-01T00:00:02.000Z");
  });

  loadConversationsAgainst(dataDir);

  const db = open(file);
  const conversations = db.prepare("SELECT id, session_id, project_id, title FROM conversations ORDER BY id").all();
  assert.deepEqual(conversations.map((row: any) => row.id), ["conv-1", "conv-2"]);
  // A v1 row's project is the session it belonged to; nothing is orphaned.
  assert.equal((conversations[0] as any).project_id, "proj-1");
  assert.equal((conversations[0] as any).session_id, "proj-1");
  assert.equal((conversations[0] as any).title, "First chat");

  const messages = db.prepare("SELECT conv_id, role, content FROM messages ORDER BY id").all();
  assert.equal(messages.length, 2);
  assert.equal((messages[0] as any).conv_id, "conv-1");
  assert.deepEqual(JSON.parse((messages[0] as any).content), [{ type: "text", text: "hello" }]);

  const schema = columns(db, "conversations");
  assert.equal(schema.find((column) => column.name === "session_id")?.notnull, 0);
  assert.equal(schema.find((column) => column.name === "project_id")?.notnull, 0);

  assert.equal(db.prepare("SELECT version FROM conversation_schema_migrations WHERE name = 'conversations'").get()?.version, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'conversations_v1'").get()?.n, 0);
  db.close();

  assert.equal(backups(dataDir).length, 1, "a rewrite of the table has to leave a backup behind");
});

test("a database that already has the current schema is not rewritten or backed up again", () => {
  const dataDir = freshDataDir();
  const file = seed(dataDir, SESSIONS_SQL + MESSAGES_SQL + `
    CREATE TABLE conversations (
      id         TEXT PRIMARY KEY,
      session_id TEXT,
      project_id TEXT,
      title      TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `, (db) => {
    db.prepare("INSERT INTO conversations (id, session_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("conv-1", null, null, "Loose chat", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  });

  loadConversationsAgainst(dataDir);

  const db = open(file);
  const row = db.prepare("SELECT session_id, project_id, title FROM conversations").get() as any;
  // A chat with no project is the v2 shape, not damage to repair.
  assert.equal(row.session_id, null);
  assert.equal(row.project_id, null);
  assert.equal(row.title, "Loose chat");
  assert.equal(db.prepare("SELECT version FROM conversation_schema_migrations WHERE name = 'conversations'").get()?.version, 2);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_conversations_project'").get()?.n,
    1,
    "an early v2 database still needs the project index",
  );
  db.close();

  assert.deepEqual(backups(dataDir), []);
});

test("an empty database gets the tables without a backup", () => {
  const dataDir = freshDataDir();
  loadConversationsAgainst(dataDir);

  const db = open(path.join(dataDir, "undagi.db"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('conversations','messages')").get()?.n, 2);
  assert.equal(db.prepare("SELECT version FROM conversation_schema_migrations WHERE name = 'conversations'").get()?.version, 2);
  db.close();

  assert.deepEqual(backups(dataDir), []);
});

test("migrating a second time leaves the data and the backup count alone", () => {
  const dataDir = freshDataDir();
  const file = seed(dataDir, SESSIONS_SQL + V1_CONVERSATIONS_SQL + MESSAGES_SQL, (db) => {
    db.prepare("INSERT INTO conversations (id, session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("conv-1", "proj-1", "First chat", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  });

  loadConversationsAgainst(dataDir);
  loadConversationsAgainst(dataDir);

  const db = open(file);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()?.n, 1);
  assert.equal((db.prepare("SELECT project_id FROM conversations").get() as any).project_id, "proj-1");
  db.close();

  assert.equal(backups(dataDir).length, 1, "the second run must not rewrite the table again");
});
