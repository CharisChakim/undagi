import assert from "node:assert/strict";
import test from "node:test";

import {
  intentHintFor,
  intentStillApplies,
  withApprovalAdvice,
  withIntentHint,
  worthAnIntentHint,
  type Entry,
  type PipelineProgress,
} from "./agentEvents";

const approval = (elicitId: string, patch: Partial<Extract<Entry, { kind: "approval" }>> = {}): Entry => ({
  kind: "approval",
  id: `entry-${elicitId}`,
  elicitId,
  command: "rm -rf build",
  decided: false,
  ...patch,
});

const advice = { type: "approval_advice", approvalId: "a1", elicitId: "a1", risk: "medium", score: 0.9, confidence: 0.64 };

test("risk advice lands on the open approval it names, and decides nothing", () => {
  const entries: Entry[] = [{ kind: "user", id: "u1", text: "clean up" }, approval("a1"), approval("a2")];

  const next = withApprovalAdvice(entries, advice);

  assert.deepEqual((next[1] as Extract<Entry, { kind: "approval" }>).advice, { risk: "medium", score: 0.9, confidence: 0.64 });
  assert.equal((next[1] as Extract<Entry, { kind: "approval" }>).decided, false);
  assert.equal((next[1] as Extract<Entry, { kind: "approval" }>).approved, undefined);
  // The other card and the input are untouched.
  assert.equal(next[2], entries[2]);
  assert.equal((entries[1] as Extract<Entry, { kind: "approval" }>).advice, undefined);
});

test("risk advice finds its card by either id", () => {
  const entries: Entry[] = [approval("a1")];
  const byApprovalId = withApprovalAdvice(entries, { ...advice, elicitId: undefined });
  assert.equal((byApprovalId[0] as Extract<Entry, { kind: "approval" }>).advice?.risk, "medium");
  const byElicitId = withApprovalAdvice(entries, { ...advice, approvalId: undefined });
  assert.equal((byElicitId[0] as Extract<Entry, { kind: "approval" }>).advice?.risk, "medium");
});

test("risk advice for an answered, unknown or malformed approval changes nothing", () => {
  const answered: Entry[] = [approval("a1", { decided: true, approved: true })];
  assert.equal(withApprovalAdvice(answered, advice), answered);

  const open: Entry[] = [approval("a1")];
  assert.equal(withApprovalAdvice(open, { ...advice, approvalId: "other", elicitId: "other" }), open);
  assert.equal(withApprovalAdvice(open, { ...advice, risk: "critical" }), open);
  assert.equal(withApprovalAdvice(open, { ...advice, score: "0.9" }), open);
  assert.equal(withApprovalAdvice(open, { ...advice, confidence: Number.NaN }), open);
  assert.equal(withApprovalAdvice(open, { ...advice, approvalId: "", elicitId: undefined }), open);
  assert.equal(withApprovalAdvice(open, null), open);
});

const none: PipelineProgress = { hasPlan: false, hasPrd: false, hasTasks: false };
const withPlan: PipelineProgress = { hasPlan: true, hasPrd: false, hasTasks: false };
const withPrd: PipelineProgress = { hasPlan: true, hasPrd: true, hasTasks: false };

test("a hint needs a pipeline intent, at least 0.7 confidence, and the step to be the next one missing", () => {
  assert.equal(intentHintFor({ intent: "plan_project", confidence: 0.7 }, none), "plan_project");
  assert.equal(intentHintFor({ intent: "plan_project", confidence: 0.69 }, none), null);
  assert.equal(intentHintFor({ intent: "plan_project", confidence: Number.NaN }, none), null);
  assert.equal(intentHintFor(null, none), null);
  assert.equal(intentHintFor(undefined, none), null);

  assert.equal(intentHintFor({ intent: "generate_prd", confidence: 0.95 }, withPlan), "generate_prd");
  assert.equal(intentHintFor({ intent: "generate_tasks", confidence: 0.95 }, withPrd), "generate_tasks");

  // A chat message or a task run is never turned into a hint, however sure Jev is.
  assert.equal(intentHintFor({ intent: "chat", confidence: 0.99 }, none), null);
  assert.equal(intentHintFor({ intent: "run_task", confidence: 0.99 }, withPrd), null);
  assert.equal(intentHintFor({ intent: "banana" as never, confidence: 0.99 }, none), null);
});

test("each hint only applies while its own step is the one the project is missing", () => {
  assert.equal(intentStillApplies("plan_project", none), true);
  assert.equal(intentStillApplies("plan_project", withPlan), false);

  assert.equal(intentStillApplies("generate_prd", none), false, "no plan yet: the Plan comes first");
  assert.equal(intentStillApplies("generate_prd", withPlan), true);
  assert.equal(intentStillApplies("generate_prd", withPrd), false);

  assert.equal(intentStillApplies("generate_tasks", withPlan), false, "no PRD yet");
  assert.equal(intentStillApplies("generate_tasks", withPrd), true);
  assert.equal(intentStillApplies("generate_tasks", { ...withPrd, hasTasks: true }), false);
  // A PRD with no plan behind it (the PRD step can start from the brief) still wants its tasks.
  assert.equal(intentStillApplies("generate_tasks", { hasPlan: false, hasPrd: true, hasTasks: false }), true);
  assert.equal(intentHintFor({ intent: "generate_prd", confidence: 0.9 }, none), null);
});

test("only a real chat message of at least 8 characters is worth asking Jev about", () => {
  assert.equal(worthAnIntentHint("plan a todo app", false), true);
  assert.equal(worthAnIntentHint("12345678", false), true);
  assert.equal(worthAnIntentHint("1234567", false), false);
  assert.equal(worthAnIntentHint("yes", false), false);
  assert.equal(worthAnIntentHint("Execute task t1: build the login form", true), false);
});

test("the hint goes right under the message it is about, once, and not at all if that message is gone", () => {
  const entries: Entry[] = [
    { kind: "user", id: "u1", text: "plan a todo app" },
    { kind: "assistant", id: "as1", text: "On it", streaming: true },
  ];

  const next = withIntentHint(entries, "u1", "plan_project");

  assert.deepEqual(next.map((entry) => entry.kind), ["user", "intent_hint", "assistant"]);
  assert.deepEqual(next[1], { kind: "intent_hint", id: "intent-hint-u1", after: "u1", intent: "plan_project" });
  // The streaming reply is still last, so text that keeps arriving keeps extending it.
  assert.equal(next.at(-1), entries[1]);

  assert.equal(withIntentHint(next, "u1", "plan_project"), next);
  assert.equal(withIntentHint(entries, "someone-else", "plan_project"), entries);
  assert.equal(withIntentHint([], "u1", "plan_project").length, 0);
});
