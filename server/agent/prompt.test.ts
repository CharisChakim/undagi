// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import { STANDALONE_SYSTEM_PROMPT, SYSTEM_PROMPT, standaloneSystemPrompt, systemPromptFor } from "./prompt.ts";

const INDONESIAN_SCAFFOLDING = /\b(Anda|Pengguna|Folder kerja|Semua path|Jawab dalam|Cara kerja|Perencanaan)\b/;
const LANGUAGE_SENTENCE = "Answer in the language the user uses.";

test("the project prompt is English scaffolding that still asks for the user's language", () => {
  assert.match(SYSTEM_PROMPT, /^You are an assistant inside Undagi/);
  assert.doesNotMatch(SYSTEM_PROMPT, INDONESIAN_SCAFFOLDING);
  assert.ok(SYSTEM_PROMPT.includes(LANGUAGE_SENTENCE));
  assert.match(SYSTEM_PROMPT, /Instructions and tool results are in English/);
});

test("the standalone prompt names the planning card as the UI shows it", () => {
  const en = standaloneSystemPrompt("en");
  const id = standaloneSystemPrompt("id");

  for (const prompt of [en, id]) {
    assert.match(prompt, /^You are a general-purpose assistant inside Undagi/);
    assert.doesNotMatch(prompt, INDONESIAN_SCAFFOLDING);
    assert.ok(prompt.includes(LANGUAGE_SENTENCE));
    assert.match(prompt, /Instructions and tool results are in English/);
  }
  assert.ok(en.includes('"Plan a project" card'));
  assert.ok(id.includes('"Susun plan proyek" card'));
  assert.ok(!id.includes("Plan a project"));
  assert.equal(standaloneSystemPrompt(), en);
  assert.equal(STANDALONE_SYSTEM_PROMPT, en);
});

test("systemPromptFor picks the base prompt by session and the card label by language", () => {
  assert.ok(systemPromptFor({}, undefined, "id").includes('"Susun plan proyek"'));
  assert.ok(systemPromptFor({}).includes('"Plan a project"'));
  // A project session has no start screen card to name.
  assert.equal(systemPromptFor({ id: "session-1" }, undefined, "id"), SYSTEM_PROMPT);
});

test("the working folder block is English and follows the shell permission", () => {
  const withShell = systemPromptFor({ workspaceRoot: " /work/app ", allowShell: true });
  assert.match(withShell, /\n\nWorking folder: \/work\/app\n/);
  assert.match(withShell, /run_command runs in that folder\./);
  assert.doesNotMatch(withShell, INDONESIAN_SCAFFOLDING);

  const withoutShell = systemPromptFor({ id: "session-1", workspaceRoot: "/work/app", allowShell: false }, undefined, "id");
  assert.match(withoutShell, /Running commands is not allowed for this project\./);
  assert.doesNotMatch(withoutShell, /run_command runs in that folder/);
  assert.doesNotMatch(withoutShell, INDONESIAN_SCAFFOLDING);
});

test("a task run's system prompt carries the project memory; a chat's does not", () => {
  const session = {
    id: "session-1",
    tasks: [{ id: "TASK-01", title: "Set up the database", status: "done", agentNote: "Postgres runs." }, { id: "TASK-02", title: "Add login" }],
    projectMemory: [{ text: "Use pnpm, not npm" }],
  };
  const settings = { compactTerminal: false, conciseAnswers: false, minimalCode: false, karpathyGuidelines: false };
  const forCard = systemPromptFor(session, settings, "en", { task: true }, "TASK-02");
  assert.match(forCard, /<project_memory>[\s\S]*TASK-01 Set up the database: Postgres runs\.[\s\S]*Use pnpm, not npm/);
  assert.match(forCard, /MEMORY: <fact>/);
  assert.doesNotMatch(systemPromptFor(session, settings, "en", {}), /project_memory/);
});

test("a chat's system prompt carries the task board; a task run's does not", () => {
  const session = { id: "session-1", tasks: [{ id: "TASK-01", title: "Add login", status: "todo" }] };
  assert.match(systemPromptFor(session, undefined, "en", {}), /<task_board>[\s\S]*- TASK-01 \[todo\] Add login[\s\S]*RUN_BOARD/);
  assert.doesNotMatch(systemPromptFor(session, undefined, "en", { task: true }, "TASK-01"), /task_board/);
  assert.doesNotMatch(systemPromptFor({ tasks: session.tasks }, undefined, "en", {}), /task_board/);
});
