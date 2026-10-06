// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RunCreateInput } from "./store.ts";

// db.ts reads this when it is first imported, so the store below has to be
// loaded dynamically, after the data directory is pointed somewhere disposable.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-store-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const store = await import("./store.ts");
const { db } = await import("../../db.ts");
// Windows will not delete a database file that is still open.
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Reloading the module re-runs its startup reconciliation against the same
// database file, which is what a server restart does to runs left behind by
// workers that did not survive it. The connection is shared rather than
// reopened, so this covers the persisted rows, not the connection lifecycle.
async function restartServer(): Promise<typeof store> {
  return await import(`./store.ts?restart=${randomSuffix()}`);
}

let counter = 0;
function randomSuffix(): string {
  counter += 1;
  return String(counter);
}

function createInput(overrides: Partial<RunCreateInput> = {}): RunCreateInput {
  return {
    idempotencyKey: `key-${randomSuffix()}`,
    runtime: "codex",
    requestedModel: "inherit",
    requestedEffort: "inherit",
    ...overrides,
  };
}

test("a restart interrupts every run a worker left unfinished and leaves finished ones alone", async () => {
  const queued = store.createRun(createInput()).run;
  const running = store.createRun(createInput()).run;
  store.startRun(running.id);
  const completed = store.createRun(createInput()).run;
  store.startRun(completed.id);
  store.updateRunStatus(completed.id, { status: "completed", result: { ok: true } });

  const restarted = await restartServer();

  const queuedAfter = restarted.getRun(queued.id);
  const runningAfter = restarted.getRun(running.id);
  const completedAfter = restarted.getRun(completed.id);

  assert.equal(queuedAfter?.status, "interrupted");
  assert.equal(runningAfter?.status, "interrupted");
  assert.match(String(runningAfter?.error), /server restarted/i);
  assert.ok(runningAfter?.finishedAt, "an interrupted run needs a finish time so it stops looking live");

  assert.equal(completedAfter?.status, "completed");
  assert.equal(completedAfter?.error, null);
  assert.deepEqual(completedAfter?.result, { ok: true });
});

test("a restart expires the pending approvals of a run it interrupts, so they stop waiting forever", async () => {
  const waiting = store.createRun(createInput()).run;
  store.startRun(waiting.id);
  const pendingApproval = store.createRunApproval({ runId: waiting.id, request: { command: "rm -rf /tmp/x" } });

  const completed = store.createRun(createInput()).run;
  store.startRun(completed.id);
  const settledApproval = store.createRunApproval({ runId: completed.id, request: { command: "echo hi" } });
  store.resolveRunApproval(settledApproval.id, "approved");
  store.updateRunStatus(completed.id, { status: "completed", result: { ok: true } });

  const restarted = await restartServer();

  const pendingAfter = restarted.getRunApproval(pendingApproval.id);
  assert.equal(pendingAfter?.status, "expired");
  assert.ok(pendingAfter?.decidedAt, "an expired approval needs a decision time like any other resolution");

  const settledAfter = restarted.getRunApproval(settledApproval.id);
  assert.equal(settledAfter?.status, "approved", "a restart must not touch an approval already decided");
});

test("an interrupted run cannot be resumed in place, so a reconnect cannot revive a dead worker", async () => {
  const run = store.createRun(createInput()).run;
  store.startRun(run.id);
  const restarted = await restartServer();

  assert.equal(restarted.getRun(run.id)?.status, "interrupted");
  assert.throws(
    () => restarted.updateRunStatus(run.id, { status: "running" }),
    /Invalid run transition: interrupted -> running/,
  );
  assert.throws(
    () => restarted.updateRunStatus(run.id, { status: "completed" }),
    /Invalid run transition: interrupted -> completed/,
  );
});

test("repeating a start request returns the original run instead of starting a second one", () => {
  const input = createInput({ workspace: "/tmp/undagi-idempotent" });

  const first = store.createRun(input);
  const second = store.createRun(input);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.run.id, first.run.id);
  assert.equal(store.listRuns({ workspace: "/tmp/undagi-idempotent" }).length, 1);
});

test("reusing a key for a different request is refused rather than silently answered with the old run", () => {
  const input = createInput({ runtime: "codex" });
  store.createRun(input);

  assert.throws(
    () => store.createRun({ ...input, runtime: "claude" }),
    store.IdempotencyConflictError,
  );
});

test("a second run cannot start in a workspace another run is already writing to", () => {
  const workspace = "/tmp/undagi-single-writer";
  const first = store.createRun(createInput({ workspace })).run;
  const second = store.createRun(createInput({ workspace })).run;

  store.startRun(first.id);
  assert.throws(() => store.startRun(second.id), store.RunConflictError);

  store.updateRunStatus(first.id, { status: "completed" });
  assert.equal(store.startRun(second.id).status, "running");
});
