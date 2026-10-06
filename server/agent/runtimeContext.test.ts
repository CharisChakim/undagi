// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import { unseenMessages, withConversationContext, type StoredMessage } from "./runtimeContext.ts";

const say = (role: "user" | "assistant", text: string, runId?: string): StoredMessage => ({
  role,
  content: [{ type: "text", text }],
  meta: runId ? { runtime: "codex", runId } : {},
});

test("a new session sees the whole conversation; a resumed one only what came after its own runs", () => {
  const messages = [say("user", "one", "run_a"), say("assistant", "one done", "run_a"), say("user", "two", "run_b"), say("assistant", "two done", "run_b")];

  assert.equal(unseenMessages(messages, new Set()).length, 4);
  assert.deepEqual(unseenMessages(messages, new Set(["run_a"])).map((message) => message.meta.runId), ["run_b", "run_b"]);
  assert.equal(unseenMessages(messages, new Set(["run_b"])).length, 0);
});

test("the context keeps text only, labels speakers, and leaves a prompt alone when there is nothing to add", () => {
  const withTool: StoredMessage = { role: "assistant", content: [{ type: "tool_call", id: "t", name: "read_file", input: {} }, { type: "text", text: "Read it." }], meta: {} };
  const { prompt, included, omitted } = withConversationContext("Now fix it.", [say("user", "Look at a.ts"), withTool]);

  assert.match(prompt, /^<conversation_context>/);
  assert.match(prompt, /User: Look at a\.ts\n\nAssistant: Read it\./);
  assert.doesNotMatch(prompt, /read_file/);
  assert.ok(prompt.endsWith("Now fix it."));
  assert.deepEqual([included, omitted], [2, 0]);
  assert.deepEqual(withConversationContext("Now fix it.", []), { prompt: "Now fix it.", included: 0, omitted: 0 });
});

test("a long history keeps its most recent messages", () => {
  const long = Array.from({ length: 60 }, (_, index) => say(index % 2 ? "assistant" : "user", `message ${index} ${"x".repeat(900)}`));
  const { prompt, included, omitted } = withConversationContext("next", long);

  assert.match(prompt, /message 59 /);
  assert.doesNotMatch(prompt, /message 0 /);
  assert.ok(prompt.length < 26_000);
  assert.equal(included + omitted, 60);
  assert.ok(omitted > 0);
});
