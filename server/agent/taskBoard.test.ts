// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import { taskBoardBlock } from "./taskBoard.ts";

test("a project without cards gets no board block", () => {
  assert.equal(taskBoardBlock({ id: "s" }), "");
  assert.equal(taskBoardBlock({ id: "s", tasks: [] }), "");
  assert.equal(taskBoardBlock(null), "");
});

test("the board block lists each card with its status and dependencies, and asks for the marker line", () => {
  const block = taskBoardBlock({
    tasks: [
      { id: "TASK-01", title: "Set up the  project", status: "done" },
      { id: "TASK-02", title: "Add login", dependencies: ["TASK-01"] },
    ],
  });

  assert.match(block, /^<task_board>\n/);
  assert.match(block, /- TASK-01 \[done\] Set up the project\n- TASK-02 \[todo\] Add login \(after TASK-01\)/);
  assert.match(block, /do not do the work in this chat/);
  assert.match(block, /end your message with a line that reads exactly RUN_BOARD/);
  assert.match(block, /<\/task_board>$/);
});

test("a large board is cut to 60 cards and says how many more there are", () => {
  const block = taskBoardBlock({ tasks: Array.from({ length: 65 }, (_, i) => ({ id: `T${i}`, title: "x" })) });
  assert.match(block, /- T59 \[todo\] x\n- … and 5 more cards/);
  assert.doesNotMatch(block, /- T60 /);
});

test("cards are grouped under their phase, and the agent is told a run does one phase", () => {
  const block = taskBoardBlock({
    tasks: [
      { id: "T1", title: "Set up", phase: "Phase 1: Setup", status: "done" },
      { id: "T2", title: "Login", phase: "Phase 1: Setup" },
      { id: "T3", title: "Reports", phase: "Phase 2: Reports" },
    ],
  });

  assert.match(block, /Phase 1: Setup:\n- T1 \[done\] Set up\n- T2 \[todo\] Login\nPhase 2: Reports:\n- T3 \[todo\] Reports/);
  assert.match(block, /one phase per run: the first phase that is not finished/);
  assert.match(block, /naming the phase that will run/);
});
