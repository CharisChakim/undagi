import assert from "node:assert/strict";
import test from "node:test";

import type { RunReport } from "./runRetry";
import { MAX_VERIFY_RETRIES, verifyDone, verifyOutputForNote, verifyRetryPrompt, type VerifyLoopDeps, type VerifyResult } from "./taskVerify";

const failed = { command: "npm test -- auth", exitCode: 1, passed: false, output: `${"x".repeat(5000)}\n1 failing: login rejects a bad password`, durationMs: 900 };

test("a failed check goes back to the agent with its command, exit code and the end of its output", () => {
  const prompt = verifyRetryPrompt(failed);
  assert.match(prompt, /Command: npm test -- auth\nExit code: 1\n/);
  assert.match(prompt, /1 failing: login rejects a bad password\n```/);
  assert.match(prompt, /without changing or weakening the check/);
  assert.ok(prompt.length < 4_400, "the output is cut to its end");
  assert.match(verifyRetryPrompt({ ...failed, output: "  " }), /\(no output\)/);
});

test("a card note keeps only the last part of the output", () => {
  const note = verifyOutputForNote(failed);
  assert.ok(note.startsWith("…"));
  assert.ok(note.length <= 601);
  assert.match(note, /login rejects a bad password$/);
});

const done: RunReport = { outcome: "done", note: "Implemented.", error: null, errorCode: null };
const result = (passed: boolean, exitCode = passed ? 0 : 1): VerifyResult => ({ command: "npm test", exitCode, passed, output: passed ? "ok" : "1 failing", durationMs: 5 });

function deps(overrides: Partial<VerifyLoopDeps> & { results?: VerifyResult[] } = {}) {
  const calls = { approve: 0, run: 0, retries: [] as string[] };
  const results = [...(overrides.results ?? [result(true)])];
  const stop = new AbortController();
  const value: VerifyLoopDeps = {
    command: () => "npm test",
    approve: async () => { calls.approve += 1; return true; },
    run: async () => { calls.run += 1; return results.shift() ?? result(false); },
    retry: async (message) => { calls.retries.push(message); return { report: done, attempts: 1 }; },
    stillWanted: () => true,
    movedByUser: () => false,
    signal: stop.signal,
    onRunning: () => {},
    onRetrying: () => {},
    couldNotRun: (reason) => `could not run: ${reason}`,
    stillFailed: (failed) => `still failed: exit ${failed.exitCode}`,
    ...overrides,
  };
  return { value, calls, stop };
}

test("a done card whose command passes is verified", async () => {
  const { value, calls } = deps();
  assert.deepEqual(await verifyDone({ report: done, attempts: 1 }, value), { report: done, attempts: 1, verified: true });
  assert.equal(calls.approve, 1);
});

test("without a command, or when the user declines, the agent's word stands, unverified", async () => {
  const none = deps({ command: () => "  " });
  assert.equal((await verifyDone({ report: done, attempts: 1 }, none.value)).verified, false);
  assert.equal(none.calls.run, 0);
  const declined = deps({ approve: async () => false });
  const ended = await verifyDone({ report: done, attempts: 1 }, declined.value);
  assert.deepEqual([ended.report.outcome, ended.verified, declined.calls.run], ["done", false, 0]);
});

test("a failed check goes back to the card's session, and a later pass verifies it", async () => {
  const { value, calls } = deps({ results: [result(false), result(true)] });
  const ended = await verifyDone({ report: done, attempts: 1 }, value);
  assert.deepEqual([ended.report.outcome, ended.verified, ended.attempts], ["done", true, 2]);
  assert.equal(calls.retries.length, 1);
  assert.match(calls.retries[0], /1 failing/);
});

test("a check that keeps failing ends Failed after the retries, with its note", async () => {
  const { value, calls } = deps({ results: [result(false, 2), result(false, 2), result(false, 2)] });
  const ended = await verifyDone({ report: done, attempts: 1 }, value);
  assert.equal(ended.report.outcome, "failed");
  assert.equal(ended.report.error, "still failed: exit 2");
  assert.equal(ended.verified, undefined);
  assert.equal(calls.retries.length, MAX_VERIFY_RETRIES);
  assert.equal(calls.run, MAX_VERIFY_RETRIES + 1);
});

test("an agent that says blocked, or a retry that ends blocked, is not checked further", async () => {
  const blocked: RunReport = { ...done, outcome: "blocked" };
  const first = deps();
  assert.equal((await verifyDone({ report: blocked, attempts: 1 }, first.value)).report.outcome, "blocked");
  assert.equal(first.calls.approve, 0);
  const later = deps({ results: [result(false)], retry: async () => ({ report: blocked, attempts: 1 }) });
  const ended = await verifyDone({ report: done, attempts: 1 }, later.value);
  assert.deepEqual([ended.report.outcome, ended.verified, later.calls.run], ["blocked", undefined, 1]);
});

test("Stop while the check waits leaves a stopped run; a command that cannot run fails the card", async () => {
  const stopping = deps();
  stopping.value.approve = async () => { stopping.stop.abort(); return false; };
  assert.equal((await verifyDone({ report: done, attempts: 1 }, stopping.value)).report.outcome, null);
  const broken = deps({ run: async () => { throw new Error("This project has no working folder to run the command in."); } });
  const ended = await verifyDone({ report: done, attempts: 1 }, broken.value);
  assert.equal(ended.report.outcome, "failed");
  assert.match(ended.report.error ?? "", /could not run: This project has no working folder/);
});
