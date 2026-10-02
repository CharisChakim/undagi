import assert from "node:assert/strict";
import test from "node:test";

import { makeT } from "./i18n";
import { RunRecorder } from "./runRecorder";

const recorder = () => new RunRecorder(makeT("en"));

test("a run that ends well goes where its closing line says, with that message as the note", () => {
  const run = recorder();
  run.addText("Reading the files first.");
  run.toolStarted();
  run.addText("Added the route and its test.\nTASK_STATUS: blocked");
  run.done({ runStatus: "completed" });

  assert.deepEqual(run.report(false), {
    outcome: "blocked",
    note: "Added the route and its test.",
    error: null,
    errorCode: null,
  });
  assert.equal(run.sawDone, true);
});

test("a non-fatal error the run recovered from does not fail it", () => {
  const run = recorder();
  run.fail("Codex app-server emitted a malformed JSONL message.", "PROTOCOL_MALFORMED");
  run.addText("Done.\nTASK_STATUS: done");
  run.done({ runStatus: "completed" });

  assert.equal(run.report(false).outcome, "done");
  assert.equal(run.report(false).error, null);
});

test("a failed run carries the runtime's message and code", () => {
  const run = recorder();
  run.fail("Model request failed (503)", "RPC_ERROR");
  run.done({ runStatus: "failed" });

  assert.deepEqual(run.report(false), {
    outcome: "failed",
    note: "",
    error: "Model request failed (503)",
    errorCode: "RPC_ERROR",
  });
});

test("a stream that breaks before done is a failure, with its own reason or a general one", () => {
  const broken = recorder();
  broken.fail("Failed to fetch");
  assert.equal(broken.report(false).outcome, "failed");
  assert.equal(broken.report(false).error, "Failed to fetch");
  assert.equal(broken.sawDone, false);

  const silent = recorder();
  silent.addText("Working on it");
  assert.equal(silent.report(false).error, "The run ended with an error.");
});

test("an answer cut off at the token limit fails, with that as the reason", () => {
  const run = recorder();
  run.addText("TASK_STATUS: done");
  run.done({ stop: "max_tokens" });
  assert.equal(run.report(false).outcome, "failed");
  assert.equal(run.report(false).error, "The model's answer was cut off.");
});

test("without a run status (the Legacy API), an error event still fails the run", () => {
  const run = recorder();
  run.fail("Reached the limit of 30 tool rounds without a final answer.");
  run.done({ stop: "end_turn" });
  assert.equal(run.report(false).outcome, "failed");
});

test("a run the user stopped, or the server interrupted, moves nothing and reports no error", () => {
  const stopped = recorder();
  stopped.fail("The request was cancelled.");
  assert.deepEqual(stopped.report(true), { outcome: null, note: "", error: null, errorCode: null });

  const interrupted = recorder();
  interrupted.done({ runStatus: "interrupted" });
  assert.equal(interrupted.report(false).outcome, null);
  assert.equal(interrupted.report(false).error, null);
});

test("only the final message decides: a marker repeated while working does not", () => {
  const run = recorder();
  run.addText("Plan:\n- `TASK_STATUS: blocked` if I cannot finish\n- run the tests");
  run.toolStarted();
  run.addText("All tests pass.");
  run.done({ runStatus: "completed" });

  assert.equal(run.report(false).outcome, "done");
  assert.equal(run.report(false).note, "All tests pass.");
});
