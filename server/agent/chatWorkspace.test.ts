// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// db.ts reads this when it is first imported, so the module is loaded after
// the data directory is disposable.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-chat-workspace-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const {
  adoptChatWorkspace,
  chatWorkspaceDirectory,
  ensureChatWorkspace,
  removeChatWorkspaces,
} = await import("./chatWorkspace.ts");
const { db } = await import("../../db.ts");
// Windows will not delete a database file that is still open.
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("a chat's files move into its project folder, next to what is already there", () => {
  const chat = ensureChatWorkspace("move");
  write(path.join(chat, "README.md"), "from the chat");
  write(path.join(chat, "src", "app.ts"), "chat app");
  fs.symlinkSync("README.md", path.join(chat, "LINK.md"));
  const project = fs.mkdtempSync(path.join(dataDir, "project-"));
  write(path.join(project, "src", "existing.ts"), "project file");

  const result = adoptChatWorkspace("move", project);

  assert.equal(result.status, "moved");
  assert.equal(fs.readFileSync(path.join(project, "README.md"), "utf8"), "from the chat");
  assert.equal(fs.readFileSync(path.join(project, "src", "app.ts"), "utf8"), "chat app");
  assert.equal(fs.readFileSync(path.join(project, "src", "existing.ts"), "utf8"), "project file");
  assert.equal(fs.readlinkSync(path.join(project, "LINK.md")), "README.md");
  assert.equal(fs.existsSync(chat), false);
});

test("nothing moves when one file would replace a file in the project", () => {
  const chat = ensureChatWorkspace("conflict");
  write(path.join(chat, "notes.md"), "chat notes");
  write(path.join(chat, "src", "app.ts"), "chat app");
  const project = fs.mkdtempSync(path.join(dataDir, "project-"));
  write(path.join(project, "src", "app.ts"), "the user's app");

  const result = adoptChatWorkspace("conflict", project);

  assert.equal(result.status, "conflict");
  assert.deepEqual(result.status === "conflict" ? result.conflicts : [], [path.join("src", "app.ts")]);
  assert.equal(fs.readFileSync(path.join(project, "src", "app.ts"), "utf8"), "the user's app");
  assert.equal(fs.existsSync(path.join(project, "notes.md")), false);
  assert.equal(fs.readFileSync(path.join(chat, "notes.md"), "utf8"), "chat notes");
});

test("an empty chat folder is removed and a missing one is left alone", () => {
  const project = fs.mkdtempSync(path.join(dataDir, "project-"));
  const chat = ensureChatWorkspace("empty");

  assert.equal(adoptChatWorkspace("empty", project).status, "none");
  assert.equal(fs.existsSync(chat), false);
  assert.equal(adoptChatWorkspace("never-ran", project).status, "none");
});

test("removing a project removes what is left of its chat folders", () => {
  write(path.join(ensureChatWorkspace("left-over"), "notes.md"), "kept after a conflict");

  removeChatWorkspaces(["left-over", "never-ran"]);

  assert.equal(fs.existsSync(chatWorkspaceDirectory("left-over")), false);
});
