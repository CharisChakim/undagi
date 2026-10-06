// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import { projectNameFromWorkspaceRoot } from "./workspace.ts";

test("uses the selected folder name as the default project name", () => {
  assert.equal(projectNameFromWorkspaceRoot("/work/acme-dashboard"), "acme-dashboard");
  assert.equal(projectNameFromWorkspaceRoot("/work/acme-dashboard/"), "acme-dashboard");
  assert.equal(projectNameFromWorkspaceRoot("C:\\work\\acme-dashboard"), "acme-dashboard");
  assert.equal(projectNameFromWorkspaceRoot(""), "");
});
