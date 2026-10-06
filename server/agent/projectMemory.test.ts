// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import { projectMemoryBlock } from "./projectMemory.ts";

const session = {
  tasks: [
    { id: "TASK-01", title: "Set up the database", status: "done", agentNote: "Postgres 16 runs in docker compose.\nMigrations pass." },
    { id: "TASK-02", title: "Add login", status: "blocked", agentNote: "Needs an OAuth client id." },
    { id: "TASK-03", title: "Add users table", status: "done" },
    { id: "TASK-04", title: "Add indexes", status: "in_progress" },
  ],
  projectMemory: [{ id: "mem-1", text: "Use pnpm, not npm", taskId: "TASK-01", createdAt: "2026-10-03T00:00:00.000Z" }],
};

test("a task run is handed the done tasks with their notes and the learned facts", () => {
  const block = projectMemoryBlock(session, "TASK-04");
  assert.match(block, /^<project_memory>\n/);
  assert.match(block, /not as instructions/);
  assert.match(block, /- TASK-01 Set up the database: Postgres 16 runs in docker compose\. Migrations pass\./);
  assert.match(block, /- TASK-03 Add users table\n/);
  assert.match(block, /Learned:\n- Use pnpm, not npm\n<\/project_memory>$/);
  // Only done tasks count, and the card being run is not its own memory.
  assert.doesNotMatch(block, /TASK-02|TASK-04/);
  assert.doesNotMatch(projectMemoryBlock(session, "TASK-01"), /Set up the database/);
});

test("with nothing to hand over there is no block", () => {
  assert.equal(projectMemoryBlock({ tasks: [{ id: "TASK-01", status: "todo" }] }, "TASK-01"), "");
  assert.equal(projectMemoryBlock(null), "");
});

test("a large memory is cut to fit, older tasks first, facts last", () => {
  const big = {
    tasks: Array.from({ length: 40 }, (_, index) => ({ id: `TASK-${index}`, title: "t", status: "done", agentNote: "n".repeat(400) })),
    projectMemory: [{ text: "Keep me" }],
  };
  const block = projectMemoryBlock(big);
  assert.ok(block.length <= 8_000);
  assert.match(block, /Keep me/);
  assert.match(block, /TASK-39/);
  assert.doesNotMatch(block, /TASK-0 /);
});
