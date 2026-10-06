// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import type { SessionSummary } from "../types";
import { folderProject, projectForFolder } from "./workspaceProject";

const project = (id: string, updatedAt: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: id,
  updatedAt,
  currentStep: 1,
  workspaceRoot: "/work/app",
  ...extra,
});

test("a folder's project is the newest one with a plan or tasks, else the newest", () => {
  const empty = project("empty", "2026-10-03T10:00:00Z");
  const planned = project("planned", "2026-10-02T10:00:00Z", { hasPlan: true });
  const tasksOnly = project("tasks", "2026-10-01T10:00:00Z", { taskCount: 3 });

  assert.equal(folderProject([empty, planned, tasksOnly])?.id, "planned");
  assert.equal(folderProject([empty, tasksOnly])?.id, "tasks");
  assert.equal(folderProject([empty, project("older", "2026-09-01T10:00:00Z")])?.id, "empty");
  assert.equal(folderProject([]), null);
});

test("the project for a folder ignores other folders, chats without one, and the chat asking", () => {
  const sessions = [
    project("here", "2026-10-03T10:00:00Z", { hasPlan: true }),
    project("elsewhere", "2026-10-04T10:00:00Z", { hasPlan: true, workspaceRoot: "/work/other" }),
    project("loose", "2026-10-05T10:00:00Z", { hasPlan: true, workspaceRoot: "" }),
  ];

  assert.equal(projectForFolder(sessions, " /work/app ")?.id, "here");
  assert.equal(projectForFolder(sessions, "/work/app", "here"), null);
  assert.equal(projectForFolder(sessions, ""), null);
});
