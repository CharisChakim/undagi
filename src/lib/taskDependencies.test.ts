// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import { openDependencies } from "./taskDependencies";

test("only dependencies on tasks that exist and are not done hold a task back", () => {
  const tasks = [{ id: "A", status: "done" as const }, { id: "B", status: "todo" as const }, { id: "C", status: "in_progress" as const }];
  assert.deepEqual(openDependencies({ dependencies: ["A", "B", "C", "missing"] }, tasks), ["B", "C"]);
  assert.deepEqual(openDependencies({ dependencies: [] }, tasks), []);
  assert.deepEqual(openDependencies({ dependencies: undefined as unknown as string[] }, tasks), []);
});
