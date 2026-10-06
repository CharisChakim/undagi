// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import type { Entry } from "./agentEvents";
import { approvalFiles, entriesFromStoredMessages, settleEndedApprovals, wasMessageDelivered } from "./useAgentRun";

const text = (role: "user" | "assistant", value: string) => ({ role, content: [{ type: "text", text: value }] });

test("stored notes come back after the message they followed", () => {
  const messages = [text("user", "one"), text("assistant", "answer one"), text("user", "two"), text("assistant", "answer two")];
  const notes = [
    { afterMessage: 2, note: { type: "context_carried", runtime: "claude", included: 2, omitted: 0, resumed: false } },
    { afterMessage: 3, note: { type: "chat_files", status: "moved", from: "/data/chat", to: "/work/app" } },
    { afterMessage: 2, note: { type: "unknown" } },
  ];

  const kinds = entriesFromStoredMessages(messages, { current: 0 }, notes).map((entry) => entry.kind);

  assert.deepEqual(kinds, ["user", "assistant", "user", "context_carried", "assistant", "chat_files"]);
});

test("a note before any message, or on a chat with none, is still shown", () => {
  const note = { afterMessage: -1, note: { type: "chat_files", status: "conflict", from: "/data/chat", to: "/work/app", conflicts: ["a.md"] } };

  assert.deepEqual(entriesFromStoredMessages([], { current: 0 }, [note]).map((entry) => entry.kind), ["chat_files"]);
  assert.deepEqual(entriesFromStoredMessages([text("user", "one")], { current: 0 }, [note]).map((entry) => entry.kind), ["chat_files", "user"]);
});

test("legacy chat counts the message delivered once its first turn starts, whatever happens after", () => {
  // The message is stored before the "turn" event, so a later failure (a
  // denied tool, max turns, a thrown error) does not undo delivery.
  assert.equal(wasMessageDelivered(false, true, false), true);
  assert.equal(wasMessageDelivered(false, true, true), true);
  // A refusal before "turn" (session not found) never stored the message.
  assert.equal(wasMessageDelivered(false, false, false), false);
});

test("runtime chat counts the message delivered once the run finishes, success or failure", () => {
  // The message is stored before the run starts, which always ends in
  // "done" — including a turn that failed, such as a declined tool.
  assert.equal(wasMessageDelivered(true, false, true), true);
  // An unready runtime is refused before the run starts, so it never sends
  // "done"; the message never reached the server.
  assert.equal(wasMessageDelivered(true, false, false), false);
});

test("a file-change approval carries its files; a command approval carries none", () => {
  const files = approvalFiles({
    kind: "file_change",
    files: [
      { path: "/w/hello.txt", kind: "add", diff: "hello\n" },
      { path: "/w/old.md", kind: "update", movePath: "/w/new.md", diff: "" },
      { path: "/w/odd", kind: "rename" },
      { kind: "add", diff: "no path" },
      "not a file",
    ],
  });
  assert.deepEqual(files, [
    { path: "/w/hello.txt", kind: "add", diff: "hello\n" },
    { path: "/w/old.md", kind: "update", movePath: "/w/new.md", diff: "" },
    { path: "/w/odd", kind: "other", diff: "" },
  ]);
  // A file change the runtime did not describe is still a file change, with no files to list.
  assert.deepEqual(approvalFiles({ kind: "file_change" }), []);
  assert.equal(approvalFiles({ kind: "command", command: "npm test" }), undefined);
  assert.equal(approvalFiles({ command: "npm test" }), undefined);
});

test("a turn that ended settles its open approval cards as not approved, but leaves local ones and answered ones", () => {
  const card = (elicitId: string, decided: boolean, approved?: boolean): Entry =>
    ({ kind: "approval", id: `entry-${elicitId}`, elicitId, command: "ls", decided, ...(approved === undefined ? {} : { approved }) });
  const entries: Entry[] = [
    card("server-open", false),
    card("server-done", true, true),
    card("local-open", false),
    { kind: "user", id: "u1", text: "hi" },
  ];

  const settled = settleEndedApprovals(entries, new Set(["local-open"]));

  assert.deepEqual(settled[0], { ...entries[0], decided: true, approved: false });
  assert.equal(settled[1], entries[1]);
  assert.equal(settled[2], entries[2]);
  assert.equal(settled[3], entries[3]);
});

test("with no open server approval the entries come back unchanged", () => {
  const entries: Entry[] = [{ kind: "approval", id: "a", elicitId: "x", command: "ls", decided: true, approved: true }];

  assert.equal(settleEndedApprovals(entries, new Set()), entries);
});
