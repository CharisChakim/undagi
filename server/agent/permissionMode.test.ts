// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import { autoApproves, parsePermissionMode, runtimeApprovalAction, withPermissionMode } from "./permissionMode.ts";

test("an unknown or missing permission mode asks", () => {
  assert.equal(parsePermissionMode(undefined), "ask");
  assert.equal(parsePermissionMode("yolo"), "ask");
  assert.equal(parsePermissionMode("auto"), "auto");
  assert.equal(parsePermissionMode("full"), "full");
});

test("auto answers edits only; full answers everything; ask answers nothing", () => {
  assert.equal(autoApproves("ask", "edit"), false);
  assert.equal(autoApproves("auto", "edit"), true);
  assert.equal(autoApproves("auto", "command"), false);
  assert.equal(autoApproves("auto", "other"), false);
  assert.equal(autoApproves("full", "command"), true);
  assert.equal(autoApproves("full", "other"), true);
});

test("runtime approvals are classified by kind and Claude tool name", () => {
  assert.equal(runtimeApprovalAction({ kind: "file_change", details: {} }), "edit");
  assert.equal(runtimeApprovalAction({ kind: "command", details: {} }), "command");
  assert.equal(runtimeApprovalAction({ kind: "other", details: { toolName: "Edit" } }), "edit");
  assert.equal(runtimeApprovalAction({ kind: "other", details: { toolName: "Bash" } }), "command");
  assert.equal(runtimeApprovalAction({ kind: "other", details: { toolName: "WebFetch" } }), "other");
});

test("a write outside the working folder is never an ordinary edit", () => {
  assert.equal(runtimeApprovalAction({ kind: "file_change", details: { grantRoot: "/elsewhere" } }), "other");
  assert.equal(runtimeApprovalAction({ kind: "other", details: { toolName: "Write", blockedPath: "/elsewhere/a" } }), "other");
});

test("the native agent's elicit only reaches the user when the mode asks", async () => {
  const asked: string[] = [];
  const elicit = async (request: any) => { asked.push(request.kind); return false; };
  const auto = withPermissionMode(elicit, "auto");
  assert.equal(await auto({ kind: "approval", command: "write_file a", action: "edit" }), true);
  assert.equal(await auto({ kind: "approval", command: "ls", action: "command" }), false);
  assert.equal(await auto({ kind: "questions", questions: [], round: 1 }), false);
  assert.deepEqual(asked, ["approval", "questions"]);
});
