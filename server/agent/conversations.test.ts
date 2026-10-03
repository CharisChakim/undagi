import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// db.ts reads this when it is first imported, so the module is loaded after
// the data directory is disposable.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-conversations-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const { appendMessage, conversationTitle, createConversation, deleteConversation, getConversation, loadMessages, loadMessagesFor } = await import("./conversations.ts");
const { db } = await import("../../db.ts");
// Windows will not delete a database file that is still open.
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const text = (value: string) => [{ type: "text" as const, text: value }];

test("a task card's turn sees only its own messages; the chat sees them all", () => {
  const { id } = createConversation({ conversationId: "conv-task-history" });
  appendMessage(id, { role: "user", content: text("Use Postgres.") });
  appendMessage(id, { role: "assistant", content: text("Noted.") });
  appendMessage(id, { role: "user", content: text("Do TASK-01.") }, { taskId: "TASK-01" });
  appendMessage(id, { role: "assistant", content: text("TASK-01 done.") }, { taskId: "TASK-01" });
  appendMessage(id, { role: "user", content: text("Do TASK-02.") }, { taskId: "TASK-02" });

  const said = (messages: ReturnType<typeof loadMessagesFor>) => messages.map((message) => (message.content[0] as { text: string }).text);
  assert.deepEqual(said(loadMessagesFor(id, "TASK-01")), ["Do TASK-01.", "TASK-01 done."]);
  assert.deepEqual(said(loadMessagesFor(id, "TASK-02")), ["Do TASK-02."]);
  assert.equal(loadMessagesFor(id).length, 5);
  assert.deepEqual(Object.keys(loadMessagesFor(id, "TASK-01")[0]).sort(), ["content", "role"]);
});

test("a chat is named after the first thing the user wrote, a card run only when nothing else was", () => {
  const chat = createConversation({ conversationId: "conv-title-chat" });
  appendMessage(chat.id, { role: "user", content: text("Run TASK-01.") }, { taskId: "TASK-01" });
  appendMessage(chat.id, { role: "user", content: text("  lanjutkan\n fase 1 besok  ") });
  assert.equal(conversationTitle(chat), "lanjutkan fase 1 besok");

  const cardOnly = createConversation({ conversationId: "conv-title-card" });
  appendMessage(cardOnly.id, { role: "user", content: text("Execute task TASK-02: Add login") }, { taskId: "TASK-02" });
  assert.equal(conversationTitle(cardOnly), "Execute task TASK-02: Add login");

  // Older runtime transcripts did not tag card runs; their prompt gives them away.
  const older = createConversation({ conversationId: "conv-title-older" });
  appendMessage(older.id, { role: "user", content: text("Execute task TASK-01: Create a.txt\n\nTarget files: a.txt") }, { runtime: "codex" });
  appendMessage(older.id, { role: "user", content: text("lanjutkan fase berikutnya") }, { runtime: "codex" });
  assert.equal(conversationTitle(older), "lanjutkan fase berikutnya");

  assert.equal(conversationTitle(createConversation({ conversationId: "conv-title-empty" })), "");
  assert.equal(conversationTitle({ id: "conv-title-chat", title: "Named" }), "Named");

  const long = createConversation({ conversationId: "conv-title-long" });
  appendMessage(long.id, { role: "user", content: text("x".repeat(100)) });
  assert.equal(conversationTitle(long), `${"x".repeat(80)}…`);
});

test("deleting a chat removes its messages and the conversation, and nothing else", () => {
  const keep = createConversation({ conversationId: "conv-delete-keep" });
  const gone = createConversation({ conversationId: "conv-delete-gone" });
  appendMessage(keep.id, { role: "user", content: text("stay") });
  appendMessage(gone.id, { role: "user", content: text("go") });

  deleteConversation(gone.id);

  assert.equal(getConversation(gone.id), null);
  assert.deepEqual(loadMessages(gone.id), []);
  assert.equal(loadMessages(keep.id).length, 1);
});
