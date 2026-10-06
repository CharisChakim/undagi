// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTask } from "../types";
import { agentNoteFrom, applyTaskOutcome, markTaskStopped, memoryFactsFrom, runFailedAtDone, taskOutcomeFor, taskStatusMarker } from "./taskOutcome";

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

test("the note is the closing message without the marker line", () => {
  assert.equal(agentNoteFrom("Ran the suite, 12 pass.\nNot sure about the retry path.\n\n`TASK_STATUS: done`"), "Ran the suite, 12 pass.\nNot sure about the retry path.");
  assert.equal(agentNoteFrom("TASK_STATUS: blocked"), "");
  assert.equal(agentNoteFrom("Tests pass.\nMEMORY: Use pnpm, not npm.\nTASK_STATUS: done"), "Tests pass.");
  assert.equal(agentNoteFrom(""), "");
});

test("a long note is cut with an ellipsis, and blank runs are collapsed", () => {
  assert.equal(agentNoteFrom("a\n\n\n\nb"), "a\n\nb");
  const cut = agentNoteFrom("x".repeat(5000));
  assert.equal(cut.length, 2001);
  assert.ok(cut.endsWith("…"));
});

test("a run that finished without a marker counts as done", () => {
  assert.equal(taskOutcomeFor({ aborted: false, failed: false, text: "Implemented and verified." }), "done");
});

test("the marker decides between done and blocked on a run that finished", () => {
  assert.equal(taskOutcomeFor({ aborted: false, failed: false, text: "TASK_STATUS: done" }), "done");
  assert.equal(taskOutcomeFor({ aborted: false, failed: false, text: "Needs an API key.\nTASK_STATUS: blocked" }), "blocked");
});

test("a failed run is failed, even when its text claims done or blocked", () => {
  assert.equal(taskOutcomeFor({ aborted: false, failed: true, text: "TASK_STATUS: done" }), "failed");
  assert.equal(taskOutcomeFor({ aborted: false, failed: true, text: "TASK_STATUS: blocked" }), "failed");
  assert.equal(taskOutcomeFor({ aborted: false, failed: true, text: "" }), "failed");
});

test("blocked is only ever the agent's own word; the run breaking is failed", () => {
  const outcomes = [
    taskOutcomeFor({ aborted: false, failed: false, text: "TASK_STATUS: blocked" }),
    taskOutcomeFor({ aborted: false, failed: true, text: "TASK_STATUS: blocked" }),
  ];
  assert.deepEqual(outcomes, ["blocked", "failed"]);
});

test("a run the user stopped moves nothing, failed or not", () => {
  assert.equal(taskOutcomeFor({ aborted: true, failed: false, text: "TASK_STATUS: done" }), null);
  assert.equal(taskOutcomeFor({ aborted: true, failed: true, text: "" }), null);
});

test("a stopped run marks its card while it is still In progress, and the next outcome clears the mark", () => {
  const stopped = markTaskStopped([task("TASK-01", "in_progress"), task("TASK-02", "in_progress")], "TASK-01");
  assert.deepEqual(stopped?.map((item) => item.runStopped), [true, undefined]);
  assert.equal(markTaskStopped(stopped!, "TASK-01"), null, "an already marked card is left alone");
  // A card the user moved out of In progress during the run says where it stands.
  assert.equal(markTaskStopped([task("TASK-01", "todo")], "TASK-01"), null);
  assert.equal(markTaskStopped([task("TASK-01", "done")], "TASK-01"), null);
  const rerun = applyTaskOutcome(stopped!, "TASK-01", "done", "Finished.");
  assert.equal(rerun?.[0].runStopped, undefined);
});

test("the outcome moves only the card that ran", () => {
  const tasks = [task("TASK-01", "in_progress"), task("TASK-02", "todo")];
  const next = applyTaskOutcome(tasks, "TASK-01", "done");
  assert.deepEqual(next?.map((item) => item.status), ["done", "todo"]);
  assert.equal(tasks[0].status, "in_progress", "the input list is not mutated");
});

test("the agent's note lands on the card and replaces the previous run's", () => {
  const first = applyTaskOutcome([task("TASK-01", "in_progress")], "TASK-01", "blocked", "  Needs an API key.  ");
  assert.equal(first?.[0].agentNote, "Needs an API key.");
  const second = applyTaskOutcome(first!, "TASK-01", "done", "Key added, tests pass.");
  assert.equal(second?.[0].agentNote, "Key added, tests pass.");
  const third = applyTaskOutcome(second!.map((item) => ({ ...item, status: "in_progress" as const })), "TASK-01", "done");
  assert.equal(third?.[0].agentNote, undefined, "a run that wrote nothing clears the old note");
});

test("a rerun that ends the same way with a new note still updates the card", () => {
  const blocked = [{ ...task("TASK-01", "blocked"), agentNote: "Old reason." }];
  assert.equal(applyTaskOutcome(blocked, "TASK-01", "blocked", "Old reason."), null);
  assert.equal(applyTaskOutcome(blocked, "TASK-01", "blocked", "New reason.")?.[0].agentNote, "New reason.");
});

test("a card still in To do after a session refresh takes the outcome too", () => {
  assert.equal(applyTaskOutcome([task("TASK-01"), task("TASK-02")], "TASK-01", "blocked")?.[0].status, "blocked");
});

test("a failed run puts the error on the card as Failed, and a rerun can clear it", () => {
  const failed = applyTaskOutcome([task("TASK-01", "in_progress")], "TASK-01", "failed", "HTTP 503");
  assert.equal(failed?.[0].status, "failed");
  assert.equal(failed?.[0].agentNote, "HTTP 503");
  const rerun = applyTaskOutcome(failed!.map((item) => ({ ...item, status: "in_progress" as const })), "TASK-01", "done", "Fixed.");
  assert.equal(rerun?.[0].status, "done");
});

test("a card the user already marked done is left alone", () => {
  assert.equal(applyTaskOutcome([task("TASK-01", "done")], "TASK-01", "blocked"), null);
});

test("nothing changes for a missing card or one already in that column", () => {
  assert.equal(applyTaskOutcome([task("TASK-01", "in_progress")], "TASK-09", "done"), null);
  assert.equal(applyTaskOutcome([task("TASK-01", "blocked")], "TASK-01", "blocked"), null);
});

test("a run the server ends as completed is not failed by an earlier non-fatal error event", () => {
  // Codex sends fatal: false errors for a malformed line or a failed approval
  // handler and then carries on; the done event has the last word.
  assert.equal(runFailedAtDone(true, { runStatus: "completed" }), false);
  assert.equal(runFailedAtDone(false, { runStatus: "failed" }), true);
  assert.equal(runFailedAtDone(false, { runStatus: "interrupted" }), false);
});

test("without a run status, the stream so far stands, and a cut-off answer always fails", () => {
  assert.equal(runFailedAtDone(true, { stop: "end_turn" }), true);
  assert.equal(runFailedAtDone(false, { stop: "end_turn" }), false);
  assert.equal(runFailedAtDone(false, { stop: "max_tokens" }), true);
  assert.equal(runFailedAtDone(false, { runStatus: "completed", stop: "max_tokens" }), true);
});

test("the facts an agent leaves for later tasks are read from its MEMORY lines, each once", () => {
  const reply = [
    "Added the endpoint.",
    "MEMORY: Tests run with `npm test -- auth`.",
    "- **memory:** Use pnpm, not npm",
    "MEMORY: Use pnpm, not npm",
    "MEMORY:   ",
    "TASK_STATUS: done",
  ].join("\n");
  assert.deepEqual(memoryFactsFrom(reply), ["Tests run with `npm test -- auth`.", "Use pnpm, not npm"]);
  assert.deepEqual(memoryFactsFrom("No facts here.\nTASK_STATUS: done"), []);
  assert.deepEqual(memoryFactsFrom("`MEMORY: Seed with make seed`\nMEMORY: Run `npm test`"), ["Seed with make seed", "Run `npm test`"]);
  assert.ok(memoryFactsFrom(`MEMORY: ${"x".repeat(400)}`)[0].length <= 301);
});

test("a run's Done carries whether its check passed; another outcome or a later one clears it", () => {
  const verified = applyTaskOutcome([task("TASK-01", "in_progress")], "TASK-01", "done", "ok", true);
  assert.equal(verified?.[0].verified, true);
  const unverified = applyTaskOutcome([task("TASK-01", "in_progress")], "TASK-01", "done", "ok", false);
  assert.equal(unverified?.[0].verified, false);
  const failed = applyTaskOutcome([{ ...task("TASK-01", "in_progress"), verified: false }], "TASK-01", "failed", "boom", true);
  assert.equal(failed?.[0].verified, undefined, "only Done is verified or not");
});
