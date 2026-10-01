import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientRunError,
  MAX_RETRIES,
  readableRunError,
  retryContinuationPrompt,
  retryDelayMs,
  runWithRetries,
  type RetryNotice,
  type RunReport,
} from "./runRetry";

const done: RunReport = { outcome: "done", note: "ok", error: null };
const failed = (error: string): RunReport => ({ outcome: "blocked", note: "", error });

test("provider and network hiccups are worth retrying", () => {
  for (const message of [
    "Model request failed (503)",
    "HTTP 429: rate limit reached",
    "The model is overloaded, try again",
    "fetch failed",
    "Failed to fetch",
    "read ECONNRESET",
    "connect ETIMEDOUT 10.0.0.1:443",
    "socket hang up",
  ]) {
    assert.equal(isTransientRunError(message), true, message);
  }
});

test("a rejected request, a missing login or a declined approval is not retried", () => {
  for (const message of [
    "RPC_ERROR: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
    "RUNTIME_NOT_READY: Codex is not signed in.",
    "A requested tool action was rejected, so the run did not finish.",
    "invalid_request_error: bad schema",
    "",
  ]) {
    assert.equal(isTransientRunError(message), false, message);
  }
});

test("a turn timeout is not retried, even though it contains the word timed out", () => {
  assert.equal(isTransientRunError("TURN_TIMEOUT: Codex turn timed out."), false);
  assert.equal(isTransientRunError("Codex turn timed out."), false);
});

test("a provider error shows its sentence, not the JSON around it", () => {
  const raw = 'RPC_ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported."}}';
  assert.equal(readableRunError(raw), "RPC_ERROR: The model is not supported.");
  assert.equal(readableRunError('{"message":"Only a message."}'), "Only a message.");
});

test("an error that is plain text, or JSON without a sentence, is left as it is", () => {
  assert.equal(readableRunError("  Codex turn timed out.  "), "Codex turn timed out.");
  assert.equal(readableRunError("CODE: {not json"), "CODE: {not json");
  assert.equal(readableRunError('CODE: {"status":500}'), 'CODE: {"status":500}');
});

test("the pause grows with each retry", () => {
  assert.deepEqual([1, 2, 3].map(retryDelayMs), [3000, 6000, 9000]);
});

test("the retry message carries the error and asks to continue from the current state", () => {
  const prompt = retryContinuationPrompt("HTTP 503");
  assert.match(prompt, /HTTP 503/);
  assert.match(prompt, /continue the task from there/);
});

function harness(reports: RunReport[], stillWanted: () => boolean = () => true) {
  const sent: string[] = [];
  const notices: RetryNotice[] = [];
  const waits: number[] = [];
  const queue = [...reports];
  const run = () => runWithRetries({
    message: "first",
    send: async (message) => {
      sent.push(message);
      const next = queue.shift();
      assert.ok(next, "the loop sent more attempts than the test planned");
      return next;
    },
    stillWanted,
    onRetry: (notice) => notices.push(notice),
    wait: async (ms) => { waits.push(ms); },
  });
  return { run, sent, notices, waits };
}

test("a run that works the first time is not retried", async () => {
  const h = harness([done]);
  const result = await h.run();
  assert.equal(result.attempts, 1);
  assert.equal(result.report.outcome, "done");
  assert.deepEqual(h.notices, []);
});

test("a transient failure is retried, with a warning each time, until it works", async () => {
  const h = harness([failed("HTTP 503"), failed("HTTP 503"), done]);
  const result = await h.run();
  assert.equal(result.attempts, 3);
  assert.equal(result.report.outcome, "done");
  assert.deepEqual(h.notices.map((n) => [n.attempt, n.total, n.delayMs]), [[1, MAX_RETRIES + 1, 3000], [2, MAX_RETRIES + 1, 6000]]);
  assert.deepEqual(h.waits, [3000, 6000]);
  assert.equal(h.sent[0], "first");
  assert.match(h.sent[1], /previous attempt stopped with an error: HTTP 503/);
});

test("it gives up after the retry limit and reports the last failure", async () => {
  const h = harness(Array.from({ length: MAX_RETRIES + 1 }, (_, i) => failed(`HTTP 503 #${i}`)));
  const result = await h.run();
  assert.equal(result.attempts, MAX_RETRIES + 1);
  assert.equal(result.report.error, `HTTP 503 #${MAX_RETRIES}`);
  assert.equal(h.notices.length, MAX_RETRIES);
});

test("a permanent failure goes straight to Blocked without a retry", async () => {
  const h = harness([failed("RPC_ERROR: The model is not supported.")]);
  const result = await h.run();
  assert.equal(result.attempts, 1);
  assert.deepEqual(h.notices, []);
});

test("a run the user stopped, or the agent called blocked, is not retried", async () => {
  const stopped = await harness([{ outcome: null, note: "", error: null }]).run();
  assert.equal(stopped.attempts, 1);
  const agentBlocked = await harness([{ outcome: "blocked", note: "Needs a key.", error: null }]).run();
  assert.equal(agentBlocked.attempts, 1);
});

test("nothing is retried once the card has left In progress", async () => {
  let wanted = true;
  let sends = 0;
  const result = await runWithRetries({
    message: "first",
    send: async () => { sends += 1; return failed("HTTP 503"); },
    stillWanted: () => wanted,
    // The user accepts the card during the pause.
    onRetry: () => { wanted = false; },
    wait: async () => undefined,
  });
  assert.equal(sends, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.report.error, "HTTP 503");
});
