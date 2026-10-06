// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

// db.ts reads this when it is first imported, so the module is loaded after
// the data directory is disposable.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "undagi-verify-test-"));
process.env.UNDAGI_DATA_DIR = dataDir;

const express = (await import("express")).default;
const { db, saveSession } = await import("../../db.ts");
const verifyRouter = (await import("./verify.ts")).default;
// Windows will not delete a database file that is still open.
process.on("exit", () => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const workspaceRoot = fs.mkdtempSync(path.join(dataDir, "workspace-"));
saveSession({
  id: "verify-session",
  title: "verify",
  workspaceRoot,
  tasks: [
    { id: "PASS", title: "Passes", verifyCommand: "echo verified > proof.txt && cat proof.txt" },
    { id: "FAIL", title: "Fails", verifyCommand: "echo broken >&2; exit 3" },
    { id: "NONE", title: "No command" },
  ],
});
saveSession({ id: "no-folder", title: "no folder", tasks: [{ id: "PASS", title: "Passes", verifyCommand: "echo ok" }] });

async function verify(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const app = express();
  app.use(express.json());
  app.use(verifyRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tasks/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a task's verify command runs in the project folder, and exit 0 passes", { skip: process.platform === "win32" }, async () => {
  const { status, json } = await verify({ sessionId: "verify-session", taskId: "PASS" });
  assert.equal(status, 200);
  assert.equal(json.passed, true);
  assert.equal(json.exitCode, 0);
  assert.match(json.output, /verified/);
  assert.equal(fs.readFileSync(path.join(workspaceRoot, "proof.txt"), "utf8").trim(), "verified");
});

test("a failing verify command reports its exit code and output", { skip: process.platform === "win32" }, async () => {
  const { json } = await verify({ sessionId: "verify-session", taskId: "FAIL" });
  assert.equal(json.passed, false);
  assert.equal(json.exitCode, 3);
  assert.match(json.output, /broken/);
});

test("only the saved task's command runs, never one from the request", { skip: process.platform === "win32" }, async () => {
  const { json } = await verify({ sessionId: "verify-session", taskId: "PASS", command: "echo injected", verifyCommand: "echo injected" });
  assert.equal(json.command, "echo verified > proof.txt && cat proof.txt");
  assert.doesNotMatch(json.output, /injected/);
});

test("a task without a command, an unknown task, or a project without a folder runs nothing", async () => {
  assert.equal((await verify({ sessionId: "verify-session", taskId: "NONE" })).status, 409);
  assert.equal((await verify({ sessionId: "verify-session", taskId: "MISSING" })).status, 404);
  assert.equal((await verify({ sessionId: "no-folder", taskId: "PASS" })).status, 409);
});
