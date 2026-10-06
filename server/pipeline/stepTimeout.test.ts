// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import { StepTimeoutError, stepDeadline, stepTimeoutMessage, stepTimeoutOf } from "./stepTimeout.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a step that never writes is stopped after the start limit", async () => {
  const deadline = stepDeadline(undefined, { startMs: 20, stallMs: 1_000, maxMs: 1_000 });
  await wait(60);

  const timeout = stepTimeoutOf(deadline.signal);
  assert.equal(timeout?.kind, "start");
  assert.equal(deadline.signal.reason instanceof StepTimeoutError, true);
  deadline.dispose();
});

test("output keeps a step alive past the start limit, and silence afterwards stops it", async () => {
  const deadline = stepDeadline(undefined, { startMs: 40, stallMs: 40, maxMs: 1_000 });
  // Five touches 20 ms apart outlast both limits, which are 40 ms each.
  for (let i = 0; i < 5; i += 1) {
    await wait(20);
    deadline.touch();
  }
  assert.equal(deadline.signal.aborted, false);

  await wait(90);
  assert.equal(stepTimeoutOf(deadline.signal)?.kind, "stall");
  deadline.dispose();
});

test("a step that keeps writing still stops at the overall ceiling", async () => {
  const deadline = stepDeadline(undefined, { startMs: 1_000, stallMs: 1_000, maxMs: 60 });
  for (let i = 0; i < 8; i += 1) {
    await wait(15);
    deadline.touch();
  }

  assert.equal(stepTimeoutOf(deadline.signal)?.kind, "max");
  deadline.dispose();
});

test("the caller's own cancel passes through and is not reported as a timeout", () => {
  const parent = new AbortController();
  const deadline = stepDeadline(parent.signal, { startMs: 1_000, stallMs: 1_000, maxMs: 1_000 });
  const reason = new Error("client disconnected");

  parent.abort(reason);

  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.signal.reason, reason);
  assert.equal(stepTimeoutOf(deadline.signal), null);
  deadline.dispose();
});

test("an already-cancelled caller gives an already-cancelled deadline", () => {
  const parent = new AbortController();
  parent.abort();

  const deadline = stepDeadline(parent.signal);

  assert.equal(deadline.signal.aborted, true);
  deadline.dispose();
});

test("each timeout says what happened, in the user's language, with minutes", () => {
  const start = stepTimeoutMessage(new StepTimeoutError("start", 15 * 60_000), "en");
  assert.match(start, /did not start writing within 15 minutes/);
  assert.match(start, /lower the effort/);
  assert.match(stepTimeoutMessage(new StepTimeoutError("stall", 3 * 60_000), "id"), /berhenti menulis selama 3 menit/);
  assert.match(stepTimeoutMessage(new StepTimeoutError("max", 30 * 60_000), "en"), /more than 30 minutes in total/);
});
