// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTask } from "../types";
import { currentPhase, dependenciesSaved, idleBoardEnd, nextBoardTask, runBoardRequested, shortPhase } from "./boardRun";

const P1 = "Phase 1: Setup";
const P2 = "Phase 2: Reports";

const card = (id: string, status: AgentTask["status"] = "todo", dependencies: string[] = [], phase = P1): AgentTask => ({
  id,
  phase,
  title: id,
  priority: "High",
  targetFiles: [],
  dependencies,
  promptInstructions: "",
  verificationSteps: "",
  status,
});

test("the board marker counts only on a line of its own, markdown around it allowed", () => {
  assert.ok(runBoardRequested("Starting the board run.\nRUN_BOARD"));
  assert.ok(runBoardRequested("Starting.\n`RUN_BOARD`"));
  assert.ok(runBoardRequested("Starting.\n**RUN_BOARD**\n"));
  assert.ok(!runBoardRequested("I will not write RUN_BOARD here."));
  assert.ok(!runBoardRequested("Done.\nTASK_STATUS: done"));
});

test("a run takes the first phase that is not finished, and names it short", () => {
  const tasks = [card("T1", "done"), card("T2", "todo", [], P1), card("T3", "todo", [], P2)];

  assert.equal(currentPhase(tasks), P1);
  assert.equal(currentPhase(tasks, new Set(["T2"])), P2);
  assert.equal(currentPhase([card("T1", "done")]), null);
  // A failed card keeps its phase open: the run does not skip ahead of it.
  assert.equal(currentPhase([card("T1", "failed"), card("T2", "todo", [], P2)]), P1);
  assert.equal(shortPhase(P1), "Phase 1");
  assert.equal(shortPhase("Manual plan"), "Manual plan");
});

test("the next card is the first To do card of the phase, in board order, whose dependencies are done", () => {
  const tasks = [card("T1", "done"), card("T2", "todo", ["T3"]), card("T3"), card("T4", "failed"), card("T5", "todo", [], P2)];

  assert.equal(nextBoardTask(tasks, P1)?.id, "T3");
  // T3 finished in this run before the session shows it, which frees T2.
  assert.equal(nextBoardTask(tasks, P1, new Set(["T3"]), new Set(["T3"]))?.id, "T2");
  // A later phase is not touched while running this one.
  assert.equal(nextBoardTask(tasks, P1, new Set(["T2", "T3"]), new Set(["T2", "T3"])), null);
  // A card the run already started is not started again.
  assert.equal(nextBoardTask([card("T1")], P1, new Set(), new Set(["T1"])), null);
  assert.equal(nextBoardTask([card("T1", "blocked"), card("T2", "in_progress")], P1), null);
});

test("an idle phase says whether it, or the whole board, is done, or why it cannot go on", () => {
  assert.deepEqual(idleBoardEnd([card("T1", "done")], P1), { kind: "all_done" });
  assert.deepEqual(idleBoardEnd([card("T1")], P1, new Set(["T1"])), { kind: "all_done" });
  assert.deepEqual(idleBoardEnd([card("T1"), card("T2", "todo", [], P2)], P1, new Set(["T1"])), { kind: "phase_done", phase: P1 });
  assert.deepEqual(idleBoardEnd([card("T1", "failed"), card("T2", "todo", ["T1"])], P1), { kind: "waiting", remaining: 1 });
  assert.deepEqual(idleBoardEnd([card("T1", "blocked")], P1), { kind: "nothing_to_run" });
});

test("the next card waits until the server has saved its dependencies as done", async () => {
  const seen = [[card("T1", "in_progress")], [card("T1", "done")]];
  let loads = 0;
  const load = async () => seen[Math.min(loads++, seen.length - 1)];

  assert.equal(await dependenciesSaved("s", card("T2", "todo", ["T1"]), { load, intervalMs: 1 }), true);
  assert.equal(loads, 2);
  assert.equal(await dependenciesSaved("s", card("T2", "todo", ["T1"]), { load: async () => [card("T1", "failed")], timeoutMs: 5, intervalMs: 1 }), false);
  assert.equal(await dependenciesSaved("s", card("T1"), { load: async () => { throw new Error("not called"); } }), true);
});
