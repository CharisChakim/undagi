import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// db.ts reads this when it is first imported, so the module is loaded after
// the data directory is disposable.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-conversations-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const { appendMessage, createConversation, loadMessagesFor } = await import("./conversations.ts");
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
