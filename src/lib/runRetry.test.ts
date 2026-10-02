import assert from "node:assert/strict";
import test from "node:test";

import { describeClaudeFailure } from "../../server/runtimes/execution/claude.ts";
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

const done: RunReport = { outcome: "done", note: "ok", error: null, errorCode: null };
const failed = (error: string, errorCode: string | null = null): RunReport => ({ outcome: "failed", note: "", error, errorCode });

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

test("Claude's own failure codes decide, and only an overloaded provider is retried", () => {
  // The messages come from the executor itself, so the test follows its wording.
  const cases: Array<[Parameters<typeof describeClaudeFailure>[0], boolean]> = [
    [{ assistantError: "overloaded" }, true],
    [{ apiErrorStatus: 503 }, true],
    [{ assistantError: "authentication_failed" }, false],
    [{ apiErrorStatus: 403 }, false],
    [{ assistantError: "account_on_hold" }, false],
    [{ assistantError: "billing_error" }, false],
    [{ assistantError: "rate_limit" }, false],
    [{ assistantError: "model_not_found" }, false],
    [{ assistantError: "cloud_credential_error" }, false],
    [{ assistantError: "max_output_tokens" }, false],
    [{ subtype: "error_max_turns" }, false],
    [{ subtype: "error_max_budget_usd" }, false],
    // The catch-all names no cause, so its own words still count.
    [{ resultText: "read ECONNRESET while streaming" }, true],
    [{ resultText: "something unexpected" }, false],
  ];
  for (const [failure, expected] of cases) {
    const { code, message } = describeClaudeFailure(failure);
    assert.equal(isTransientRunError(message, code), expected, `${code}: ${message}`);
  }
});

test("Antigravity codes decide the same way, and other runtimes fall back to the words", () => {
  assert.equal(isTransientRunError("AGY exited unexpectedly.", "AGY_PROCESS_ERROR"), true);
  assert.equal(isTransientRunError("Sign in to Antigravity, then try again.", "AGY_AUTH_REQUIRED"), false);
  assert.equal(isTransientRunError("unsupported version", "AGY_UNSUPPORTED_VERSION"), false);
  assert.equal(isTransientRunError("RPC_ERROR: {\"status\":503}", "RPC_ERROR"), true);
  assert.equal(isTransientRunError("The 'x' model is not supported.", "RPC_ERROR"), false);
  assert.equal(isTransientRunError("Codex turn timed out.", "TURN_TIMEOUT"), false);
});

test("a status counts only where an HTTP status stands, and only a dropped fetch is terminated", () => {
  for (const message of [
    "Request failed with status code 502",
    "503 Service Unavailable",
    "HTTP/1.1 504 Gateway Timeout",
    "TypeError: terminated",
    "terminated",
  ]) {
    assert.equal(isTransientRunError(message), true, message);
  }
  for (const message of [
    "Cannot parse src/app.ts:500",
    "Expected at most 500 items, got 502",
    "Process terminated by signal SIGKILL",
    "The command terminated with exit code 1",
  ]) {
    assert.equal(isTransientRunError(message), false, message);
  }
});

test("a sentence that only asks the user to try again is not a reason to retry", () => {
  assert.equal(isTransientRunError("Sign in with /login, then try again."), false);
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

test("a failure the runtime's code calls permanent goes straight to Blocked, whatever its words say", async () => {
  const h = harness([failed("Claude Code is not signed in. Sign in, then try again.", "CLAUDE_AUTH_REQUIRED")]);
  const result = await h.run();
  assert.equal(result.attempts, 1);
  assert.deepEqual(h.notices, []);
});

test("a failure the runtime's code calls transient is retried even with no telltale words", async () => {
  const h = harness([failed("Claude is having a moment.", "CLAUDE_UNAVAILABLE"), done]);
  const result = await h.run();
  assert.equal(result.attempts, 2);
});

test("a permanent failure goes straight to Blocked without a retry", async () => {
  const h = harness([failed("RPC_ERROR: The model is not supported.")]);
  const result = await h.run();
  assert.equal(result.attempts, 1);
  assert.deepEqual(h.notices, []);
});

test("only a failed run is retried; Blocked is the agent's decision and needs a person", async () => {
  const h = harness([{ outcome: "blocked", note: "HTTP 503 from the vendor API; I need another key.", error: null, errorCode: null }]);
  const result = await h.run();
  assert.equal(result.attempts, 1);
  assert.deepEqual(h.notices, []);
});

test("a run the user stopped, or the agent called blocked, is not retried", async () => {
  const stopped = await harness([{ outcome: null, note: "", error: null, errorCode: null }]).run();
  assert.equal(stopped.attempts, 1);
  const agentBlocked = await harness([{ outcome: "blocked", note: "Needs a key.", error: null, errorCode: null }]).run();
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
