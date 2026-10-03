import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTask } from "../types";
import { dependenciesSaved, idleBoardEnd, nextBoardTask, runBoardRequested } from "./boardRun";

const card = (id: string, status: AgentTask["status"] = "todo", dependencies: string[] = []): AgentTask => ({
  id,
  phase: "Phase 1",
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

test("the next card is the first To do card, in board order, whose dependencies are done", () => {
  const tasks = [card("T1", "done"), card("T2", "todo", ["T3"]), card("T3"), card("T4", "failed")];

  assert.equal(nextBoardTask(tasks)?.id, "T3");
  // T3 finished in this run before the session shows it, which frees T2.
  assert.equal(nextBoardTask(tasks, new Set(["T3"]), new Set(["T3"]))?.id, "T2");
  // A card the run already started is not started again.
  assert.equal(nextBoardTask([card("T1")], new Set(), new Set(["T1"])), null);
  assert.equal(nextBoardTask([card("T1", "blocked"), card("T2", "in_progress")]), null);
});

test("an idle board says whether it is done, waiting on other cards, or has nothing To do", () => {
  assert.deepEqual(idleBoardEnd([card("T1", "done")]), { kind: "all_done" });
  assert.deepEqual(idleBoardEnd([card("T1")], new Set(["T1"])), { kind: "all_done" });
  assert.deepEqual(idleBoardEnd([card("T1", "failed"), card("T2", "todo", ["T1"])]), { kind: "waiting", remaining: 1 });
  assert.deepEqual(idleBoardEnd([card("T1", "blocked")]), { kind: "nothing_to_run" });
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
