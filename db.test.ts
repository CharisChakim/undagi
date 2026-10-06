// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// db.ts reads the data directory when it is first imported, so the fixture rows
// are written before the module loads and the import has to be dynamic.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-db-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const seed = new DatabaseSync(path.join(dataDir, "undagi.db"));
seed.exec(`
  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    updated_at   TEXT NOT NULL,
    current_step INTEGER NOT NULL DEFAULT 1,
    payload      TEXT NOT NULL
  );
`);
const insert = seed.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)");
// A session saved before workspaces existed: no workspaceRoot, no plan, no tasks.
insert.run("legacy", "Old project", "2026-08-01T00:00:00.000Z", 1, JSON.stringify({
  id: "legacy",
  title: "Old project",
  input: { title: "Old project" },
}));
insert.run("planned", "Planned project", "2026-09-01T00:00:00.000Z", 2, JSON.stringify({
  id: "planned",
  workspaceRoot: "/home/ai/code/billing-svc",
  plan: { summary: "something" },
  tasks: [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
}));
// Sessions have been hand-edited and restored from backups, so the list query
// must not assume tasks is an array or that the payload holds every key.
insert.run("odd", "Odd project", "2026-09-02T00:00:00.000Z", 1, JSON.stringify({
  id: "odd",
  workspaceRoot: "   ",
  tasks: "not-an-array",
}));
seed.close();

const { db, listSessions } = await import("./db.ts");
// Windows will not delete a database file that is still open.
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a session saved before workspaces existed still lists, with nothing invented", () => {
  const legacy = listSessions().find((row) => row.id === "legacy");
  assert.ok(legacy);
  assert.equal(legacy.title, "Old project");
  // Empty, not undefined: the sidebar groups on this value and a missing folder
  // is a real answer, not a gap to guess at.
  assert.equal(legacy.workspaceRoot, "");
  assert.equal(legacy.hasPlan, false);
  assert.equal(legacy.taskCount, 0);
});

test("a planned session reports its folder, its plan, and how many tasks it holds", () => {
  const planned = listSessions().find((row) => row.id === "planned");
  assert.ok(planned);
  assert.equal(planned.workspaceRoot, "/home/ai/code/billing-svc");
  assert.equal(planned.hasPlan, true);
  assert.equal(planned.taskCount, 3);
});

test("a payload with the wrong shape counts as no tasks instead of failing the list", () => {
  const odd = listSessions().find((row) => row.id === "odd");
  assert.ok(odd);
  assert.equal(odd.taskCount, 0);
  assert.equal(odd.hasPlan, false);
});

test("the list stays newest first", () => {
  assert.deepEqual(listSessions().map((row) => row.id), ["odd", "planned", "legacy"]);
});
