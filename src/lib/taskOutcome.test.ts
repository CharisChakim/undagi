import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTask } from "../types";
import { applyTaskOutcome, TASK_STATUS_INSTRUCTION, taskOutcomeFor, taskStatusMarker } from "./taskOutcome";

function task(id: string, status?: AgentTask["status"]): AgentTask {
  return {
    id,
    phase: "Build",
    title: id,
    priority: "High",
    targetFiles: [],
    dependencies: [],
    promptInstructions: "",
    verificationSteps: "",
    ...(status ? { status } : {}),
  };
}

test("the marker is read whether or not the model dresses it in markdown", () => {
  assert.equal(taskStatusMarker("All good.\nTASK_STATUS: done"), "done");
  assert.equal(taskStatusMarker("Stuck.\n`TASK_STATUS: blocked`"), "blocked");
  assert.equal(taskStatusMarker("**TASK_STATUS: done**"), "done");
  assert.equal(taskStatusMarker("- task_status: Blocked"), "blocked");
});

test("the last marker wins, and a mention inside a sentence is not a marker", () => {
  assert.equal(taskStatusMarker("TASK_STATUS: blocked\nFixed it after all.\nTASK_STATUS: done"), "done");
  assert.equal(taskStatusMarker("I will end with TASK_STATUS: done when it passes."), null);
  assert.equal(taskStatusMarker("TASK_STATUS: maybe"), null);
  assert.equal(taskStatusMarker(""), null);
});

test("the run prompt asks for both verdicts the parser understands", () => {
  assert.ok(TASK_STATUS_INSTRUCTION.includes("TASK_STATUS: done"));
  assert.ok(TASK_STATUS_INSTRUCTION.includes("TASK_STATUS: blocked"));
});

test("a run that finished without a marker counts as done", () => {
  assert.equal(taskOutcomeFor({ aborted: false, failed: false, text: "Implemented and verified." }), "done");
});

test("the marker decides between done and blocked on a run that finished", () => {
  assert.equal(taskOutcomeFor({ aborted: false, failed: false, text: "TASK_STATUS: done" }), "done");
  assert.equal(taskOutcomeFor({ aborted: false, failed: false, text: "Needs an API key.\nTASK_STATUS: blocked" }), "blocked");
});

test("a failed run is blocked even when its text claims done", () => {
  assert.equal(taskOutcomeFor({ aborted: false, failed: true, text: "TASK_STATUS: done" }), "blocked");
  assert.equal(taskOutcomeFor({ aborted: false, failed: true, text: "" }), "blocked");
});

test("a run the user stopped moves nothing, failed or not", () => {
  assert.equal(taskOutcomeFor({ aborted: true, failed: false, text: "TASK_STATUS: done" }), null);
  assert.equal(taskOutcomeFor({ aborted: true, failed: true, text: "" }), null);
});

test("the outcome moves only the card that ran", () => {
  const tasks = [task("TASK-01", "in_progress"), task("TASK-02", "todo")];
  const next = applyTaskOutcome(tasks, "TASK-01", "done");
  assert.deepEqual(next?.map((item) => item.status), ["done", "todo"]);
  assert.equal(tasks[0].status, "in_progress", "the input list is not mutated");
});

test("a card still in To do after a session refresh takes the outcome too", () => {
  assert.equal(applyTaskOutcome([task("TASK-01"), task("TASK-02")], "TASK-01", "blocked")?.[0].status, "blocked");
});

test("a card the user already marked done is left alone", () => {
  assert.equal(applyTaskOutcome([task("TASK-01", "done")], "TASK-01", "blocked"), null);
});

test("nothing changes for a missing card or one already in that column", () => {
  assert.equal(applyTaskOutcome([task("TASK-01", "in_progress")], "TASK-09", "done"), null);
  assert.equal(applyTaskOutcome([task("TASK-01", "blocked")], "TASK-01", "blocked"), null);
});
